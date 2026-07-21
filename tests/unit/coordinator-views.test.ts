import { describe, expect, it } from 'vitest';

import { toProjectView, toProjectViews } from '../../src/application/coordinatorViews.js';
import type { ProjectEntry } from '../../src/application/projectIndex.js';

// Guards the coordination layer's batch-A path-redaction boundary
// (ADR-0006 / AGENTS.md red line 2: real local paths NEVER reach the
// coordinator agent or reply text). A `ProjectEntry`'s `.path` is the one
// trusted real path in the bridge; the coordinator agent only ever sees a
// `ProjectView`, which by construction has NO path. This projection is the
// forward half of the alias<->path redaction (the reverse, alias->path, is
// `projectIndex.lookup`). The `Object.keys` / stringify assertions are the
// load-bearing guard: they fail loudly if a future edit ever adds `path`
// back onto the view.
//
// Fixture discipline: synthetic placeholder path only, never a real one.

const ENTRY: ProjectEntry = {
  name: 'blog',
  path: '/tmp/fixtures/private/blog',
  aliases: ['b', 'weblog'],
};

describe('toProjectView (ADR-0006, coordination batch A/3 — 路径脱敏)', () => {
  it('projects name and aliases only', () => {
    expect(toProjectView(ENTRY)).toEqual({ name: 'blog', aliases: ['b', 'weblog'] });
  });

  it('drops the real path entirely — no path key, no path substring leaks', () => {
    const view = toProjectView(ENTRY);
    expect(Object.keys(view)).not.toContain('path');
    expect(JSON.stringify(view)).not.toContain('/tmp/fixtures/private/blog');
  });

  it('maps a list, preserving order and empty alias arrays', () => {
    const api: ProjectEntry = { name: 'api', path: '/tmp/fixtures/private/api', aliases: [] };
    expect(toProjectViews([ENTRY, api])).toEqual([
      { name: 'blog', aliases: ['b', 'weblog'] },
      { name: 'api', aliases: [] },
    ]);
  });

  it('leaks no path substring across a whole projected list', () => {
    const api: ProjectEntry = { name: 'api', path: '/tmp/fixtures/private/api', aliases: [] };
    const serialized = JSON.stringify(toProjectViews([ENTRY, api]));
    expect(serialized).not.toContain('/tmp/fixtures/private');
  });
});
