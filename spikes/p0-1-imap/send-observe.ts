/**
 * P0-1 spike — send-visibility half + P0-3 Authentication-Results collection.
 *
 * SENDS MAIL. Runs only under the explicit opt-in gate AMB_SEND_PROBE=1, and
 * only as the red-line-3 approved action class: authenticated SMTP from the
 * dedicated test mailbox TO ITSELF (approval "方案 A", 2026-07-19). Hard cap
 * 5 mails per run, default 3. Never any other recipient.
 *
 * Measures (spec §5 P0-1 send half + P0-3):
 *   1. does a self-sent SMTP mail appear in INBOX, and how fast (send → EXISTS)?
 *   2. is a sender-supplied Message-ID preserved end-to-end?
 *   3. does Gmail thread a reply (In-Reply-To/References) with its parent
 *      (X-GM-THRID via the X-GM-EXT-1 `threadId` fetch item)?
 *   4. the REAL shape of self-to-self Authentication-Results headers
 *      (dkim/spf/dmarc verdicts + authserv-id) feeding the identity-gate
 *      wiring of `checkDkimFactor`.
 *
 * Leak rules (red line 2), enforced at print time, not by reviewer diligence:
 *   - every printed string passes sanitize(): the real address and its bare
 *     local part are replaced with placeholders;
 *   - DKIM/ARC signature blobs (b=, bh=) are NEVER printed — only low-entropy
 *     tag params (v/a/c/d/s/t/i/cv) survive; today's gitleaks incident showed
 *     high-entropy blobs must not reach committed evidence even as fakes;
 *   - credentials are read at runtime from ~/.secrets/amb-test.env and never
 *     printed.
 *
 * Usage:
 *   AMB_SEND_PROBE=1 node spikes/p0-1-imap/send-observe.ts            # 3 probes
 *   AMB_SEND_PROBE=1 node spikes/p0-1-imap/send-observe.ts --count 2
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';

interface Creds {
  user: string;
  pass: string;
}

interface ProbePlan {
  n: number;
  subject: string;
  messageId: string;
  inReplyTo: string | null;
}

interface ProbeResult {
  n: number;
  sentAtMs: number;
  visibleAtMs: number | null;
  visibilityLatencyMs: number | null;
  uid: number | null;
  fetchedMessageId: string | null;
  messageIdPreserved: boolean | null;
  threadId: string | null;
  internalDate: string | null;
  authHeaders: Record<string, string[]>;
}

const HARD_CAP = 5;

function readCreds(): Creds {
  const envPath = join(homedir(), '.secrets', 'amb-test.env');
  const content = readFileSync(envPath, 'utf8');
  const entries = new Map<string, string>();
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    entries.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
  }
  const user = entries.get('AMB_TEST_IMAP_USER');
  const pass = entries.get('AMB_TEST_IMAP_PASS');
  if (!user || !pass) {
    throw new Error('AMB_TEST_IMAP_USER / AMB_TEST_IMAP_PASS missing in ~/.secrets/amb-test.env');
  }
  return { user, pass };
}

/** Built once from the loaded creds; applied to EVERY printed string. */
function buildSanitizer(realAddress: string): (s: string) => string {
  const localPart = realAddress.slice(0, realAddress.indexOf('@'));
  return (s: string): string => {
    let out = s.split(realAddress).join('bridge-user@example.com');
    if (localPart.length >= 3) {
      out = out.split(localPart).join('bridge-user');
    }
    return out;
  };
}

let sanitize: (s: string) => string = (s) => s;

function log(message: string): void {
  console.log(sanitize(`[${new Date().toISOString()}] ${message}`));
}

/**
 * Keep only low-entropy tag params of DKIM-ish headers; drop signature and
 * body-hash blobs entirely (b=, bh=). Applied to DKIM-Signature and
 * ARC-* headers before they may be printed.
 */
function stripSignatureBlobs(value: string): string {
  return value
    .split(';')
    .map((part) => part.trim())
    .filter((part) => {
      const tag = part.slice(0, part.indexOf('=')).trim().toLowerCase();
      return tag !== 'b' && tag !== 'bh';
    })
    .join('; ');
}

/** Header names whose full (sanitized) values are the P0-3 payload. */
const AUTH_HEADER_NAMES = [
  'authentication-results',
  'arc-authentication-results',
  'received-spf',
  'dkim-signature',
  'arc-message-signature',
  'arc-seal',
  'return-path',
] as const;

const BLOB_STRIPPED = new Set(['dkim-signature', 'arc-message-signature', 'arc-seal']);

/**
 * Minimal RFC 5322 header-block parser (unfolds continuation lines). Same
 * hand-scan stance as the production header parsing: no regex.
 */
function parseHeaderBlock(raw: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const lines = raw.split(/\r?\n/);
  let currentName: string | null = null;
  let currentValue = '';
  const flush = (): void => {
    if (currentName === null) return;
    const key = currentName.toLowerCase();
    const list = out.get(key) ?? [];
    list.push(currentValue.trim());
    out.set(key, list);
    currentName = null;
    currentValue = '';
  };
  for (const line of lines) {
    if (line === '') break;
    if (line.startsWith(' ') || line.startsWith('\t')) {
      currentValue += ` ${line.trim()}`;
      continue;
    }
    flush();
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    currentName = line.slice(0, colon);
    currentValue = line.slice(colon + 1).trim();
  }
  flush();
  return out;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function argNumber(name: string, fallback: number): number {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  const raw = process.argv[idx + 1];
  const value = raw === undefined ? Number.NaN : Number(raw);
  if (Number.isNaN(value)) throw new Error(`--${name} expects a number`);
  return value;
}

async function main(): Promise<void> {
  if (process.env['AMB_SEND_PROBE'] !== '1') {
    console.log(
      'send-observe: refusing to run — this spike SENDS mail (red line 3, approved class: ' +
        'authenticated self-send to the dedicated test mailbox). Set AMB_SEND_PROBE=1 to run.',
    );
    process.exitCode = 2;
    return;
  }
  const count = argNumber('count', 3);
  if (count < 1 || count > HARD_CAP) {
    throw new Error(`--count must be 1..${HARD_CAP} (approved batch size)`);
  }

  const creds = readCreds();
  sanitize = buildSanitizer(creds.user);
  const runId = Date.now().toString(36);
  log(`P0-1 send-visibility spike — runId=${runId} count=${count} (self-send only)`);
  log('credentials loaded from ~/.secrets/amb-test.env (values not shown)');

  // --- IMAP side first: baseline + event listeners, then we send. ---
  const imap = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: creds,
    logger: false,
  });
  await imap.connect();
  const mailbox = await imap.mailboxOpen('INBOX');
  const baselineUidNext = mailbox.uidNext;
  log(`INBOX opened — exists=${mailbox.exists} uidNext=${baselineUidNext}`);

  const existsEvents: number[] = [];
  imap.on('exists', (data: { count: number; prevCount: number }) => {
    existsEvents.push(Date.now());
    log(`EXISTS event — count ${data.prevCount} -> ${data.count}`);
  });

  const smtp = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: creds,
  });

  const plans: ProbePlan[] = [];
  for (let n = 1; n <= count; n += 1) {
    const isReply = n === count && count >= 2;
    const first = plans[0];
    plans.push({
      n,
      subject:
        isReply && first !== undefined
          ? `Re: ${first.subject}`
          : `AMB P0-1 send probe ${n}/${runId}`,
      messageId: `<amb-p01-${runId}-${n}@amb-probe.invalid>`,
      inReplyTo: isReply && first !== undefined ? first.messageId : null,
    });
  }

  const results: ProbeResult[] = [];
  for (const plan of plans) {
    const before = existsEvents.length;
    const sentAtMs = Date.now();
    await smtp.sendMail({
      from: creds.user,
      to: creds.user,
      subject: plan.subject,
      text: 'AMB P0-1 send-visibility probe. No sensitive content.',
      messageId: plan.messageId,
      headers: {
        'X-AMB-Probe': `${runId}-${plan.n}`,
        ...(plan.inReplyTo === null
          ? {}
          : { 'In-Reply-To': plan.inReplyTo, References: plan.inReplyTo }),
      },
    });
    log(`probe ${plan.n}: SMTP accepted (${plan.inReplyTo === null ? 'fresh' : 'reply to probe 1'})`);

    let visibleAtMs: number | null = null;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (existsEvents.length > before) {
        visibleAtMs = existsEvents[existsEvents.length - 1] ?? null;
        break;
      }
      await sleep(500);
    }
    log(
      visibleAtMs === null
        ? `probe ${plan.n}: NOT visible within 90s (EXISTS never fired)`
        : `probe ${plan.n}: visible after ${visibleAtMs - sentAtMs}ms`,
    );
    results.push({
      n: plan.n,
      sentAtMs,
      visibleAtMs,
      visibilityLatencyMs: visibleAtMs === null ? null : visibleAtMs - sentAtMs,
      uid: null,
      fetchedMessageId: null,
      messageIdPreserved: null,
      threadId: null,
      internalDate: null,
      authHeaders: {},
    });
  }

  // --- Attribution + header harvest: match probes by X-AMB-Probe. ---
  await sleep(2_000);
  const found = await imap.search({ uid: `${baselineUidNext}:*` }, { uid: true });
  const uids = Array.isArray(found) ? found : [];
  log(`UID SEARCH ${baselineUidNext}:* -> ${uids.length} uid(s)`);

  for (const uid of uids) {
    const msg = await imap.fetchOne(
      String(uid),
      { headers: true, internalDate: true, threadId: true, envelope: true },
      { uid: true },
    );
    if (!msg || !Buffer.isBuffer(msg.headers)) continue;
    const headerMap = parseHeaderBlock(msg.headers.toString('utf8'));
    const probeTag = headerMap.get('x-amb-probe')?.[0];
    if (probeTag === undefined || !probeTag.startsWith(`${runId}-`)) {
      log(`uid ${uid}: not one of this run's probes — skipped`);
      continue;
    }
    const n = Number(probeTag.slice(runId.length + 1));
    const result = results.find((r) => r.n === n);
    const plan = plans.find((p) => p.n === n);
    if (result === undefined || plan === undefined) continue;

    result.uid = uid;
    result.internalDate =
      msg.internalDate instanceof Date ? msg.internalDate.toISOString() : null;
    result.threadId = typeof msg.threadId === 'string' ? msg.threadId : null;
    result.fetchedMessageId = headerMap.get('message-id')?.[0] ?? null;
    result.messageIdPreserved = result.fetchedMessageId === plan.messageId;
    for (const name of AUTH_HEADER_NAMES) {
      const values = headerMap.get(name);
      if (values === undefined) continue;
      result.authHeaders[name] = values.map((v) =>
        BLOB_STRIPPED.has(name) ? stripSignatureBlobs(v) : v,
      );
    }
  }

  await imap.logout();
  smtp.close();

  const firstResult = results[0];
  const lastResult = results[results.length - 1];
  const threadedWithParent =
    count >= 2 && firstResult?.threadId != null && lastResult?.threadId != null
      ? firstResult.threadId === lastResult.threadId
      : null;

  log('=== SUMMARY (machine-readable, sanitized) ===');
  console.log(
    sanitize(
      JSON.stringify(
        {
          runId,
          count,
          replyProbeThreadedWithParent: threadedWithParent,
          probes: results,
        },
        null,
        2,
      ),
    ),
  );
}

main().catch((err: unknown) => {
  log(`FATAL: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
  process.exitCode = 1;
});
