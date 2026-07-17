/**
 * P0-1 spike — IMAP observation (read-only, no mail is ever sent).
 *
 * Measures against the dedicated test mailbox (never a personal mailbox):
 *   1. connect + login latency over TLS 993;
 *   2. IDLE capability and event delivery (`exists` / `expunge` / `flags`);
 *   3. proactive reconnect cycles (the "≤29 min" strategy, spec §3.2);
 *   4. UIDVALIDITY stability across reconnects + UID high-water mark;
 *   5. `UID SEARCH n:*` catch-up behavior after each reconnect.
 *
 * Credentials are read at runtime from ~/.secrets/amb-test.env and are never
 * printed; logs carry protocol metadata only (no addresses, no subjects).
 *
 * Usage (Node >= 22.6 runs .ts directly via type stripping):
 *   node spikes/p0-1-imap/observe.ts --rounds 1 --idle-minutes 0.5   # smoke
 *   node spikes/p0-1-imap/observe.ts --rounds 3 --idle-minutes 25    # full
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { ImapFlow } from 'imapflow';

interface Creds {
  user: string;
  pass: string;
}

interface RoundSummary {
  round: number;
  connectMs: number;
  idleSupported: boolean;
  uidValidity: string;
  uidNext: number;
  exists: number;
  catchUpSearchCount: number;
  events: string[];
  idlePlannedMs: number;
  idleActualMs: number;
}

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

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

function argNumber(name: string, fallback: number): number {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  const raw = process.argv[idx + 1];
  const value = raw === undefined ? Number.NaN : Number(raw);
  if (Number.isNaN(value)) throw new Error(`--${name} expects a number`);
  return value;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runRound(
  creds: Creds,
  round: number,
  idleMs: number,
  prevUidValidity: string | null,
  prevUidNext: number | null,
): Promise<RoundSummary> {
  const events: string[] = [];
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: creds,
    logger: false,
  });

  client.on('error', (err: Error) => {
    events.push(`error:${err.message}`);
    log(`round ${round}: client error: ${err.message}`);
  });

  const t0 = Date.now();
  await client.connect();
  const connectMs = Date.now() - t0;

  const idleSupported = client.capabilities.has('IDLE');
  log(`round ${round}: connected in ${connectMs}ms; IDLE capability: ${idleSupported}`);

  const mailbox = await client.mailboxOpen('INBOX', { readOnly: true });
  const uidValidity = String(mailbox.uidValidity);
  const uidNext = mailbox.uidNext;
  const exists = mailbox.exists;
  log(
    `round ${round}: INBOX opened readOnly — exists=${exists} uidNext=${uidNext} uidValidity=${uidValidity}`,
  );

  if (prevUidValidity !== null) {
    const stable = prevUidValidity === uidValidity;
    log(
      `round ${round}: UIDVALIDITY ${stable ? 'STABLE across reconnect' : `CHANGED (${prevUidValidity} -> ${uidValidity}) — bounded rescan path required`}`,
    );
  }

  // Catch-up rehearsal: what a reconnect would fetch since the last high-water mark.
  const searchSince = prevUidNext ?? uidNext;
  const found = await client.search({ uid: `${searchSince}:*` }, { uid: true });
  const catchUpSearchCount = Array.isArray(found) ? found.length : 0;
  log(
    `round ${round}: UID SEARCH ${searchSince}:* -> ${catchUpSearchCount} uid(s) (catch-up rehearsal)`,
  );

  client.on('exists', (data) => {
    events.push(`exists:${data.prevCount}->${data.count}`);
    log(`round ${round}: EXISTS event — count ${data.prevCount} -> ${data.count}`);
  });
  client.on('expunge', (data) => {
    events.push(`expunge:seq=${data.seq}`);
    log(`round ${round}: EXPUNGE event — seq ${data.seq}`);
  });
  client.on('flags', (data) => {
    events.push(`flags:seq=${data.seq}`);
    log(`round ${round}: FLAGS event — seq ${data.seq}`);
  });

  log(`round ${round}: entering IDLE for ${Math.round(idleMs / 1000)}s`);
  const idleStart = Date.now();
  const idlePromise = client.idle().catch((err: Error) => {
    events.push(`idle-error:${err.message}`);
    log(`round ${round}: idle() rejected: ${err.message}`);
    return false;
  });

  await sleep(idleMs);
  const idleActualMs = Date.now() - idleStart;
  log(`round ${round}: proactive reconnect — logging out after ${idleActualMs}ms in IDLE`);
  await client.logout();
  await idlePromise;

  return {
    round,
    connectMs,
    idleSupported,
    uidValidity,
    uidNext,
    exists,
    catchUpSearchCount,
    events,
    idlePlannedMs: idleMs,
    idleActualMs,
  };
}

async function main(): Promise<void> {
  const rounds = argNumber('rounds', 1);
  const idleMinutes = argNumber('idle-minutes', 0.5);
  const idleMs = Math.round(idleMinutes * 60_000);

  log(`P0-1 IMAP observation spike — rounds=${rounds} idleMinutes=${idleMinutes} (read-only)`);
  const creds = readCreds();
  log('credentials loaded from ~/.secrets/amb-test.env (values not shown)');

  const summaries: RoundSummary[] = [];
  let prevUidValidity: string | null = null;
  let prevUidNext: number | null = null;

  for (let round = 1; round <= rounds; round += 1) {
    const summary = await runRound(creds, round, idleMs, prevUidValidity, prevUidNext);
    summaries.push(summary);
    prevUidValidity = summary.uidValidity;
    prevUidNext = summary.uidNext;
    if (round < rounds) {
      log(`inter-round pause 5s`);
      await sleep(5_000);
    }
  }

  log('=== SUMMARY (machine-readable) ===');
  console.log(JSON.stringify({ rounds: summaries }, null, 2));
}

main().catch((err: unknown) => {
  log(`FATAL: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
