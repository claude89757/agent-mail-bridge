import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { PACKAGE_NAME } from '../../src/index.js';

interface PackageManifest {
  name: string;
  type: string;
  engines: { node: string };
  bin: Record<string, string>;
}

const manifest = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as PackageManifest;

// Guards decision D10 (npm package + bin names) and the Node/ESM baseline.
// If any of these fail, someone changed a decision that requires a new ADR.
describe('package contract (decision D10)', () => {
  it('is published as agent-mail-bridge', () => {
    expect(manifest.name).toBe('agent-mail-bridge');
  });

  it('exposes both the full bin name and the amb alias to the same entry point', () => {
    expect(manifest.bin['agent-mail-bridge']).toBeDefined();
    expect(manifest.bin['amb']).toBe(manifest.bin['agent-mail-bridge']);
  });

  it('requires Node >= 22 and ships as ESM', () => {
    expect(manifest.engines.node).toBe('>=22');
    expect(manifest.type).toBe('module');
  });

  it('keeps the library entry point in sync with the manifest name', () => {
    expect(PACKAGE_NAME).toBe(manifest.name);
  });
});
