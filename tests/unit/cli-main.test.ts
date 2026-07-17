import { describe, expect, it } from 'vitest';

import { buildCliGreeting } from '../../src/cli/main.js';

describe('cli placeholder', () => {
  it('identifies itself and states that commands are not implemented yet', () => {
    const greeting = buildCliGreeting();

    expect(greeting).toContain('agent-mail-bridge');
    expect(greeting).toContain('not implemented yet');
  });
});
