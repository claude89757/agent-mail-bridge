import { describe, expect, it } from 'vitest';

import {
  COORDINATOR_DECISION_SCHEMA,
  parseCoordinatorDecision,
  type CoordinatorDecision,
} from '../../src/domain/coordinatorDecision.js';

// Guards the coordination layer's batch-A decision contract (ADR-0006:
// 门后 codex 只读协调 agent). The coordinator agent's ONLY structured
// output is one of three decisions — `dispatch` / `clarify` / `answer` —
// and `parseCoordinatorDecision` is the fail-closed boundary that turns
// codex's (schema-constrained but still untrusted) JSON into a typed
// decision. Independent of `--output-schema`: even a schema-obeying model
// output is re-validated here (defense in depth), and anything malformed
// clarifies-nothing — it returns `{ ok: false }`, never a half-built
// decision. Same purity discipline as `routing.ts`: no IO, pure function
// over an already-parsed value.
//
// Fixture discipline: synthetic placeholder values only (project alias
// `blog`, never a real path or identifier).

function ok(raw: unknown): CoordinatorDecision {
  const result = parseCoordinatorDecision(raw);
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error}`);
  }
  return result.decision;
}

function errorOf(raw: unknown): string {
  const result = parseCoordinatorDecision(raw);
  if (result.ok) {
    throw new Error(`expected fail-closed, but parsed: ${JSON.stringify(result.decision)}`);
  }
  return result.error;
}

describe('parseCoordinatorDecision (ADR-0006, coordination batch A)', () => {
  describe('dispatch', () => {
    it('accepts a well-formed new-task dispatch', () => {
      expect(
        ok({ kind: 'dispatch', projectAlias: 'blog', prompt: 'fix the footer link', mode: 'new' }),
      ).toEqual({
        kind: 'dispatch',
        projectAlias: 'blog',
        prompt: 'fix the footer link',
        mode: 'new',
      });
    });

    it('accepts mode continue', () => {
      expect(ok({ kind: 'dispatch', projectAlias: 'blog', prompt: 'add a test too', mode: 'continue' }).kind).toBe(
        'dispatch',
      );
    });

    it('rejects an unknown mode value (fail closed)', () => {
      expect(errorOf({ kind: 'dispatch', projectAlias: 'blog', prompt: 'x', mode: 'resume' })).toMatch(/mode/);
    });

    it('rejects a missing projectAlias', () => {
      expect(errorOf({ kind: 'dispatch', prompt: 'x', mode: 'new' })).toMatch(/projectAlias/);
    });

    it('rejects an empty projectAlias (fail closed, no blank routing term)', () => {
      expect(errorOf({ kind: 'dispatch', projectAlias: '   ', prompt: 'x', mode: 'new' })).toMatch(/projectAlias/);
    });

    it('rejects a missing prompt', () => {
      expect(errorOf({ kind: 'dispatch', projectAlias: 'blog', mode: 'new' })).toMatch(/prompt/);
    });

    it('rejects an empty prompt', () => {
      expect(errorOf({ kind: 'dispatch', projectAlias: 'blog', prompt: '', mode: 'new' })).toMatch(/prompt/);
    });
  });

  describe('clarify', () => {
    it('accepts a clarify with only a question', () => {
      expect(ok({ kind: 'clarify', question: 'which project — blog or blog-legacy?' })).toEqual({
        kind: 'clarify',
        question: 'which project — blog or blog-legacy?',
      });
    });

    it('accepts a clarify with options', () => {
      const decision = ok({ kind: 'clarify', question: 'pick one', options: ['blog', 'blog-legacy'] });
      expect(decision).toEqual({ kind: 'clarify', question: 'pick one', options: ['blog', 'blog-legacy'] });
    });

    it('rejects a clarify with a non-string in options (fail closed)', () => {
      expect(errorOf({ kind: 'clarify', question: 'pick', options: ['blog', 7] })).toMatch(/options/);
    });

    it('rejects a missing question', () => {
      expect(errorOf({ kind: 'clarify', options: ['a'] })).toMatch(/question/);
    });
  });

  describe('answer', () => {
    it('accepts a well-formed answer', () => {
      expect(ok({ kind: 'answer', text: 'you have 2 projects: blog, api' })).toEqual({
        kind: 'answer',
        text: 'you have 2 projects: blog, api',
      });
    });

    it('rejects an empty answer text', () => {
      expect(errorOf({ kind: 'answer', text: '' })).toMatch(/text/);
    });
  });

  describe('fail-closed on shape', () => {
    it('rejects null', () => {
      expect(errorOf(null)).toBeTruthy();
    });

    it('rejects a non-object', () => {
      expect(errorOf('dispatch')).toBeTruthy();
    });

    it('rejects a missing kind', () => {
      expect(errorOf({ projectAlias: 'blog', prompt: 'x', mode: 'new' })).toMatch(/kind/);
    });

    it('rejects an unknown kind', () => {
      expect(errorOf({ kind: 'exec', projectAlias: 'blog' })).toMatch(/kind/);
    });
  });
});

describe('COORDINATOR_DECISION_SCHEMA (ADR-0006, coordination batch A)', () => {
  it('is a JSON-Schema object whose three branches match the three decision kinds', () => {
    const branches = COORDINATOR_DECISION_SCHEMA.oneOf;
    expect(Array.isArray(branches)).toBe(true);
    expect(branches).toHaveLength(3);
    const kinds = branches.map((branch) => branch.properties.kind.const).sort();
    expect(kinds).toEqual(['answer', 'clarify', 'dispatch']);
  });

  it('locks every branch to additionalProperties:false (no smuggled fields)', () => {
    for (const branch of COORDINATOR_DECISION_SCHEMA.oneOf) {
      expect(branch.additionalProperties).toBe(false);
    }
  });
});
