import { describe, expect, it } from 'vitest';

import { expandTilde, resolveConfigPath, resolveDefaultDbPath } from '../../src/cli/paths.js';

// Guards decision D-P5S-2 (config file / default db path resolution). `env`
// and `homedir` are always fixed fake values here — never the real
// process.env / os.homedir() — because these functions are pure and take
// both as injected arguments (main.ts, Task 3, is the only place that reads
// the real ones).
const HOME = '/fake-home';

describe('resolveConfigPath (D-P5S-2)', () => {
  it('uses $XDG_CONFIG_HOME/agent-mail-bridge/config.json when XDG_CONFIG_HOME is set', () => {
    const result = resolveConfigPath({ XDG_CONFIG_HOME: '/fake-xdg-config' }, HOME);

    expect(result).toBe('/fake-xdg-config/agent-mail-bridge/config.json');
  });

  it('falls back to <homedir>/.config/agent-mail-bridge/config.json when XDG_CONFIG_HOME is unset', () => {
    const result = resolveConfigPath({}, HOME);

    expect(result).toBe('/fake-home/.config/agent-mail-bridge/config.json');
  });

  it('treats an empty-string XDG_CONFIG_HOME the same as unset', () => {
    const result = resolveConfigPath({ XDG_CONFIG_HOME: '' }, HOME);

    expect(result).toBe('/fake-home/.config/agent-mail-bridge/config.json');
  });
});

describe('resolveDefaultDbPath (D-P5S-2)', () => {
  it('uses $XDG_DATA_HOME/agent-mail-bridge/bridge.db when XDG_DATA_HOME is set', () => {
    const result = resolveDefaultDbPath({ XDG_DATA_HOME: '/fake-xdg-data' }, HOME);

    expect(result).toBe('/fake-xdg-data/agent-mail-bridge/bridge.db');
  });

  it('falls back to <homedir>/.local/share/agent-mail-bridge/bridge.db when XDG_DATA_HOME is unset', () => {
    const result = resolveDefaultDbPath({}, HOME);

    expect(result).toBe('/fake-home/.local/share/agent-mail-bridge/bridge.db');
  });

  it('treats an empty-string XDG_DATA_HOME the same as unset', () => {
    const result = resolveDefaultDbPath({ XDG_DATA_HOME: '' }, HOME);

    expect(result).toBe('/fake-home/.local/share/agent-mail-bridge/bridge.db');
  });
});

describe('expandTilde (D-P5S-2)', () => {
  it('expands a leading ~/ using the injected homedir', () => {
    expect(expandTilde('~/secrets/amb-test.env', HOME)).toBe('/fake-home/secrets/amb-test.env');
  });

  it('passes an absolute path through unchanged', () => {
    expect(expandTilde('/already/absolute/path', HOME)).toBe('/already/absolute/path');
  });

  it('passes a relative (non-tilde) path through unchanged — expandTilde never rejects; validateConfig does', () => {
    expect(expandTilde('relative/path', HOME)).toBe('relative/path');
  });

  it('does not touch a bare "~" with no trailing slash (only the "~/" prefix is recognized)', () => {
    expect(expandTilde('~', HOME)).toBe('~');
  });
});
