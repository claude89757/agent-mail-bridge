/**
 * CLI path resolution (decision D-P5S-2): where the config file and the
 * default SQLite store live on disk. Every function here is pure — `env`
 * and `homedir` are always caller-injected (never `process.env` /
 * `os.homedir()` read directly), so tests can pin them to fixed fake values
 * and `main.ts` (Task 3) is the only place real values are read.
 *
 * Follows the three XDG Base Directory variables this CLI needs:
 *   - `XDG_CONFIG_HOME` (config file), falling back to `<homedir>/.config`.
 *   - `XDG_DATA_HOME` (default SQLite store), falling back to
 *     `<homedir>/.local/share`.
 *   - `XDG_STATE_HOME` (log files — logs are state, not data), falling back
 *     to `<homedir>/.local/state`.
 * A variable that is present but empty is treated the same as unset. Beyond
 * that, values are used as-is — e.g. a relative `XDG_CONFIG_HOME` is not
 * itself rejected here; that is out of scope for v1.
 */
import { join } from 'node:path';

/**
 * Minimal shape of `process.env` this module needs — a plain object so
 * tests can inject fixed values instead of mutating the real environment.
 */
export type EnvLike = Readonly<Record<string, string | undefined>>;

const APP_DIR = 'agent-mail-bridge';

function readXdgVar(env: EnvLike, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value.length === 0 ? undefined : value;
}

/**
 * Path to the config file: `$XDG_CONFIG_HOME/agent-mail-bridge/config.json`,
 * or `<homedir>/.config/agent-mail-bridge/config.json` when
 * `XDG_CONFIG_HOME` is unset (or empty).
 */
export function resolveConfigPath(env: EnvLike, homedir: string): string {
  const base = readXdgVar(env, 'XDG_CONFIG_HOME') ?? join(homedir, '.config');
  return join(base, APP_DIR, 'config.json');
}

/**
 * Default SQLite store path: `$XDG_DATA_HOME/agent-mail-bridge/bridge.db`,
 * or `<homedir>/.local/share/agent-mail-bridge/bridge.db` when
 * `XDG_DATA_HOME` is unset (or empty). Only used to fill in `BridgeConfig`'s
 * `dbPath` when a config file omits it — an explicit `dbPath` always wins
 * (see `src/cli/config.ts`).
 */
export function resolveDefaultDbPath(env: EnvLike, homedir: string): string {
  const base = readXdgVar(env, 'XDG_DATA_HOME') ?? join(homedir, '.local', 'share');
  return join(base, APP_DIR, 'bridge.db');
}

/**
 * Default bridge-owned worktrees root (D-P5B12-1):
 * `$XDG_DATA_HOME/agent-mail-bridge/worktrees`, falling back to
 * `<homedir>/.local/share/agent-mail-bridge/worktrees` — the SAME data
 * directory `resolveDefaultDbPath` uses, so the two bridge-owned artifact
 * families (the SQLite store and task worktrees) sit side by side under one
 * predictable parent. Only used to fill in `BridgeConfig.worktreesRoot`
 * when a config file omits it — an explicit value always wins (see
 * `src/cli/config.ts`, mirroring `dbPath`'s treatment).
 */
export function resolveDefaultWorktreesRoot(env: EnvLike, homedir: string): string {
  const base = readXdgVar(env, 'XDG_DATA_HOME') ?? join(homedir, '.local', 'share');
  return join(base, APP_DIR, 'worktrees');
}

/**
 * Default scrubbed-log directory (D-P5B13-4):
 * `$XDG_STATE_HOME/agent-mail-bridge/logs`, falling back to
 * `<homedir>/.local/state/agent-mail-bridge/logs`. Logs follow the XDG
 * STATE directory — they are operational state, not user data — so this
 * deliberately does NOT share `XDG_DATA_HOME` with `resolveDefaultDbPath`/
 * `resolveDefaultWorktreesRoot`. Consumed by `src/cli/start.ts` (the tee's
 * file sink) and `src/cli/service.ts` (launchd's Standard*Path).
 */
export function resolveDefaultLogDir(env: EnvLike, homedir: string): string {
  const base = readXdgVar(env, 'XDG_STATE_HOME') ?? join(homedir, '.local', 'state');
  return join(base, APP_DIR, 'logs');
}

/**
 * Expands a leading `~/` to `homedir`. Does NOT validate or reject
 * anything: a path with no leading `~/` — absolute or relative alike —
 * passes through completely unchanged. Rejecting relative paths is
 * `validateConfig`'s job (`src/cli/config.ts`), which runs BEFORE this is
 * ever called in the real `loadConfig` flow — `loadConfig` only expands
 * tildes on a `credentialsEnvFile`/`dbPath` that schema validation has
 * already confirmed is absolute or `~/`-prefixed.
 */
export function expandTilde(p: string, homedir: string): string {
  return p.startsWith('~/') ? join(homedir, p.slice(2)) : p;
}
