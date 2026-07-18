/**
 * CLI path resolution (decision D-P5S-2): where the config file and the
 * default SQLite store live on disk. Every function here is pure — `env`
 * and `homedir` are always caller-injected (never `process.env` /
 * `os.homedir()` read directly), so tests can pin them to fixed fake values
 * and `main.ts` (Task 3) is the only place real values are read.
 *
 * Follows the two XDG Base Directory variables this CLI needs:
 *   - `XDG_CONFIG_HOME` (config file), falling back to `<homedir>/.config`.
 *   - `XDG_DATA_HOME` (default SQLite store), falling back to
 *     `<homedir>/.local/share`.
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
