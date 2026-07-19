import { vi } from 'vitest';

/**
 * The shared five-sink stdio guard (D-P5B13-3, extracted from the batch-12
 * Important-1 guard in tests/unit/cli-start.test.ts): spies every stdio
 * sink `no-console` cannot police — `src/cli/**` is exempt from the rule
 * entirely, and raw `process.std*.write` is invisible to it EVERYWHERE — so
 * red-line-2 tests can assert a credential value reaches none of them.
 *
 * Sinks covered: console.log / console.error / console.warn plus the raw
 * process.stdout.write / process.stderr.write streams.
 *
 * `captured` is read from the spies BEFORE they are restored (a restored
 * mock's call history is reset — reading it afterwards would make every
 * absence assertion vacuously pass), and the spies are always restored in a
 * `finally`, so a throwing `fn` still leaves real stdio behind for the test
 * runner's own failure output.
 */
export interface StdioSpyOutcome<T> {
  readonly result: T;
  /** Every argument written to any of the five sinks, stringified and
   *  newline-joined — the haystack for `not.toContain` assertions. */
  readonly captured: string;
}

export async function withStdioSpy<T>(fn: () => T | Promise<T>): Promise<StdioSpyOutcome<T>> {
  const consoleSpies = [
    vi.spyOn(console, 'log').mockImplementation(() => undefined),
    vi.spyOn(console, 'error').mockImplementation(() => undefined),
    vi.spyOn(console, 'warn').mockImplementation(() => undefined),
  ];
  const streamSpies = [
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true),
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true),
  ];
  try {
    const result = await fn();
    const captured = [...consoleSpies, ...streamSpies]
      .flatMap((spy) => spy.mock.calls.flat())
      .map(String)
      .join('\n');
    return { result, captured };
  } finally {
    // Restore ONLY the five spies this helper created (never
    // vi.restoreAllMocks(), which would tear down the caller's own mocks).
    for (const spy of [...consoleSpies, ...streamSpies]) {
      spy.mockRestore();
    }
  }
}
