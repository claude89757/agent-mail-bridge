/**
 * Authentication-Results parser and DKIM alignment verdict (decision
 * D-P3P-1, security control C2, spec §3.3 control 2): the deterministic half
 * of the provider-authentication factor. A forged `From: you@example.com`
 * from an external sender cannot obtain a valid DKIM signature for
 * `example.com`; checking `Authentication-Results: ... dkim=pass
 * header.d=example.com` (or the equivalent `header.i=` identity) is how the
 * bridge verifies that claim itself — many providers (e.g. Gmail) publish
 * DMARC `p=none`, so the provider will not reject the forgery for us and
 * this check must be done ourselves.
 *
 * Split like `identity.ts` (control C1): PARSING is tolerant — malformed
 * fragments are dropped, this module never throws. `Authentication-Results`
 * is written by the receiving MTA, but attacker-influenced envelope/header
 * data shapes its content, so the raw header value is treated as hostile
 * input. The VERDICT (`checkDkimFactor`) is fail closed.
 *
 * OUT OF SCOPE here (deliberately, per D-P3P-1): validating `authservId`
 * itself — i.e. whose header this is, and whether it was written by a
 * trusted MTA hop versus injected earlier in a forwarding chain. That trust
 * question belongs to Phase 3 proper, decided together with P0-3's
 * measurement of the real self-to-self internal-delivery header shape. This
 * module only extracts `authservId` as a value for the caller; it never
 * compares it against an expected/allowlisted value.
 *
 * No IO, no dependencies (not even sibling `domain/` files): pure string
 * parsing in, plain data out.
 *
 * SECURITY NOTE on regex use: this parser runs on attacker-influenced input,
 * so no nested-quantifier / catastrophic-backtracking regex appears anywhere
 * in this file. Comment-stripping and resinfo/property splitting are manual
 * character scans and literal (non-regex) splits; the one regex used
 * (`/\s+/`, to split whitespace-separated tokens) has a single non-nested
 * quantifier and cannot backtrack.
 */

/** One parsed `dkim=` resinfo from an `Authentication-Results` header. */
export interface DkimResinfo {
  /**
   * The DKIM method result, lowercased (e.g. `'pass'`, `'fail'`,
   * `'neutral'`, `'none'`, `'temperror'`, `'permerror'`, `'policy'`).
   * Intentionally not narrowed to a result union — callers compare against
   * the literal they care about (`checkDkimFactor` only ever tests for
   * `'pass'`).
   */
  readonly result: string;
  /**
   * The signing domain, lowercased. Preferred source is the `header.d=`
   * property; if absent or empty, falls back to the part of `header.i=`
   * AFTER its `@` (the identity's domain, not its local-part). `null` when
   * neither property is present/usable — the resinfo still counts as a
   * parsed `dkim=` entry, it just carries no comparable domain (which can
   * never equal a real `selfDomain` in `checkDkimFactor`, so it fails closed
   * without any special-casing).
   */
  readonly domain: string | null;
}

/** Result of parsing one `Authentication-Results` header value. */
export interface ParsedAuthResults {
  /**
   * The header's leading `authserv-id` token (before the first `;`),
   * trimmed; `null` when blank/absent. NOT validated against any expected
   * value — see the module doc comment's "out of scope" note.
   */
  readonly authservId: string | null;
  /** Every `dkim=` resinfo found in the header, in header order. */
  readonly dkim: readonly DkimResinfo[];
}

/**
 * Strips RFC 5322/8601 CFWS `(...)` comments from `input` in a single
 * left-to-right character scan that tracks paren nesting depth — nested
 * comments (`(outer (nested) outer)`) are stripped correctly in that same
 * pass, depth simply goes 0→1→2→1→0. An unclosed `(` (depth never returns to
 * 0) is treated as a comment extending to the end of the string, so
 * everything from that `(` onward is dropped: a deliberate
 * simplicity/tolerance choice — the alternative (backtracking to
 * reinterpret the `(` as a literal character once no matching `)` is found)
 * needs lookahead this single forward pass intentionally avoids. A stray `)`
 * encountered at depth 0 is likewise dropped rather than emitted literally.
 *
 * NOTE for the Phase 3 `authservId`-filtering implementer: removing a
 * comment splices its neighbors together (`header.d=exa(hidden)mple.com`
 * parses as `example.com`). This only matters for an attacker who already
 * controls the raw header bytes — exactly the authservId-trust gap the
 * module doc comment defers to Phase 3 proper; such an attacker could write
 * `header.d=example.com` directly anyway, so splicing adds no new power.
 */
function stripComments(input: string): string {
  let out = '';
  let depth = 0;

  for (const ch of input) {
    if (ch === '(') {
      depth += 1;
      continue;
    }
    if (ch === ')') {
      if (depth > 0) {
        depth -= 1;
      }
      continue;
    }
    if (depth === 0) {
      out += ch;
    }
  }

  return out;
}

/** Trims `seg` and returns it, or `null` if blank/absent. */
function normalizeAuthservId(seg: string | undefined): string | null {
  const trimmed = (seg ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Extracts the domain (lowercased) after the first `@` in a `header.i=`
 * value. Returns `null` when there is no `@` or nothing follows it —
 * `header.i` without a domain part is malformed and unusable as a fallback.
 */
function domainAfterAt(headerI: string): string | null {
  const at = headerI.indexOf('@');
  if (at === -1) {
    return null;
  }
  const domain = headerI.slice(at + 1).trim();
  return domain.length > 0 ? domain.toLowerCase() : null;
}

/**
 * Parses one whitespace-delimited `resinfo` segment (the text between two
 * `;` in the header, comments already stripped). Returns `null` when the
 * segment is not a usable `dkim=` resinfo: empty, not `method=result`
 * shaped, a non-`dkim` method, or a `dkim` result with nothing after the
 * `=`. An empty `header.d=`/`header.i=` value is treated as if the property
 * were absent (falls through to the next source), rather than as a literal
 * empty-string domain.
 */
function parseDkimResinfo(segment: string): DkimResinfo | null {
  const tokens = segment
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  const first = tokens[0];
  if (first === undefined) {
    return null;
  }

  const eqIdx = first.indexOf('=');
  if (eqIdx === -1) {
    return null;
  }

  const method = first.slice(0, eqIdx).trim().toLowerCase();
  if (method !== 'dkim') {
    return null;
  }

  const result = first.slice(eqIdx + 1).trim().toLowerCase();
  if (result.length === 0) {
    return null;
  }

  let headerD: string | null = null;
  let headerI: string | null = null;
  for (const token of tokens.slice(1)) {
    const propEq = token.indexOf('=');
    if (propEq === -1) {
      continue;
    }
    const prop = token.slice(0, propEq).trim().toLowerCase();
    const value = token.slice(propEq + 1).trim();
    if (value.length === 0) {
      continue;
    }
    if (prop === 'header.d') {
      headerD = value.toLowerCase();
    } else if (prop === 'header.i') {
      headerI = value;
    }
  }

  const domain = headerD ?? (headerI === null ? null : domainAfterAt(headerI));
  return { result, domain };
}

/**
 * Parses one `Authentication-Results` header value (RFC 8601 §2.2,
 * simplified subset). Never throws: unparseable/malformed fragments are
 * silently dropped rather than surfaced as partial data or exceptions, so
 * the caller always gets back whatever the parser could confidently
 * extract.
 *
 * Algorithm (tokenize, do not regex-match the whole header):
 * 1. Strip comments via {@link stripComments}.
 * 2. Split on `;` (literal, not regex). The first segment, trimmed, is
 *    `authservId` (empty/whitespace-only → `null`). Each later segment is
 *    one `resinfo`.
 * 3. Parse each `resinfo` via {@link parseDkimResinfo}: split on runs of
 *    whitespace, require `method=result` as the first token, keep only
 *    `dkim` (case-insensitive) methods with a non-empty result, and scan
 *    later tokens for `header.d=` / `header.i=` (case-insensitive property
 *    name; any other property — `header.s=`, `header.b=`,
 *    `smtp.mailfrom=`, ... — is ignored).
 *
 * Only the `dkim` method is extracted (per D-P3P-1); `spf`/`dmarc`/`arc`/etc.
 * resinfos are tokenized (so they cannot corrupt neighboring segments) but
 * never appear in the returned `dkim` array.
 */
export function parseAuthenticationResults(raw: string): ParsedAuthResults {
  const stripped = stripComments(raw);
  const segments = stripped.split(';');

  const authservId = normalizeAuthservId(segments[0]);

  const dkim: DkimResinfo[] = [];
  for (const segment of segments.slice(1)) {
    const resinfo = parseDkimResinfo(segment);
    if (resinfo !== null) {
      dkim.push(resinfo);
    }
  }

  return { authservId, dkim };
}

/**
 * Parses every raw `Authentication-Results` header value found on a
 * message — a message may carry more than one (e.g. each forwarding hop's
 * MTA can add its own alongside the original). Order is preserved; each
 * entry is parsed independently via {@link parseAuthenticationResults}.
 */
export function parseAllAuthenticationResults(
  raws: readonly string[],
): readonly ParsedAuthResults[] {
  return raws.map(parseAuthenticationResults);
}

/**
 * Reasons `checkDkimFactor` can reject for, in fixed priority order
 * (D-P3P-1): no parseable `Authentication-Results` header at all →
 * `NO_AUTH_RESULTS`; headers present but no `dkim=pass` anywhere →
 * `NO_DKIM_PASS`; a `dkim=pass` exists but its domain does not exactly equal
 * `selfDomain` → `DOMAIN_MISMATCH`. These become `commands.status_reason`
 * values once this gate is wired into ingest (mirroring `IdentityReason` in
 * `identity.ts`) — do not rename them.
 */
export type DkimFactorReason = 'NO_AUTH_RESULTS' | 'NO_DKIM_PASS' | 'DOMAIN_MISMATCH';

/**
 * Checks control C2's deterministic verdict: DKIM alignment. Pass iff at
 * least one parsed header's `dkim` array contains a resinfo with
 * `result === 'pass'` AND `domain` EXACTLY equal to `selfDomain`
 * (case-insensitive — `domain` is already lowercased by the parser,
 * `selfDomain` is lowercased here before comparing).
 *
 * Exact equality only: subdomain or organizational-domain alignment (e.g.
 * `mail.example.com` vs `example.com`) is NOT accepted in v0.1 — better to
 * reject genuine mail than accept a forged one (spec §3.3 control 2; threat
 * model §5 C2). If P0-3 measurement later shows the real self-to-self path
 * needs looser alignment, that is a deliberate, evidenced relaxation via
 * ADR, not a default here.
 *
 * Comparison is byte-wise after lowercasing; as in `identity.ts` (C1) there
 * is deliberately NO Unicode/NFC normalization or locale-sensitive folding —
 * homograph or NFC-variant domains (fullwidth chars, Turkish dotted `İ`,
 * combining marks) simply never compare equal to an ASCII `selfDomain` and
 * are rejected (fail closed).
 *
 * `parsed` may contain multiple entries — forwarding chains can carry more
 * than one `Authentication-Results` header (see
 * {@link parseAllAuthenticationResults}) — and ANY entry containing a
 * qualifying resinfo is sufficient, per D-P3P-1. `authservId` trust is NOT
 * considered; see the module doc comment.
 *
 * `selfDomain` is trimmed and lowercased but not otherwise validated. An
 * empty or malformed `selfDomain` cannot accidentally match: this parser
 * never produces an empty-string `domain` (empty extractions become `null`
 * instead), so `resinfo.domain === self` can only be true for a genuine,
 * non-empty, exact match — unlike `checkIdentityC1`'s blank-config guard, no
 * explicit throw is needed here for the same fail-open shape to be
 * impossible.
 */
export function checkDkimFactor(
  parsed: readonly ParsedAuthResults[],
  selfDomain: string,
): { ok: true; matchedDomain: string } | { ok: false; reason: DkimFactorReason } {
  if (parsed.length === 0) {
    return { ok: false, reason: 'NO_AUTH_RESULTS' };
  }

  const self = selfDomain.trim().toLowerCase();

  let sawPass = false;
  for (const entry of parsed) {
    for (const resinfo of entry.dkim) {
      if (resinfo.result !== 'pass') {
        continue;
      }
      sawPass = true;
      if (resinfo.domain !== null && resinfo.domain === self) {
        return { ok: true, matchedDomain: resinfo.domain };
      }
    }
  }

  return { ok: false, reason: sawPass ? 'DOMAIN_MISMATCH' : 'NO_DKIM_PASS' };
}
