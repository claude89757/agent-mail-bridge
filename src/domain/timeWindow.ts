/**
 * Time-window policy (decision D-P2-6): decides whether a wall-clock instant
 * falls inside an operator-configured local time window — this is what lets
 * ingest (Task 8) queue inbound mail that arrives outside the hours/days the
 * operator wants the bridge acting on (`QUEUED_WINDOW`, D-P2-2) instead of
 * dispatching it immediately.
 *
 * No IO, no clock reads: `now` is always passed in by the caller.
 * `Intl.DateTimeFormat` is part of the JS language/runtime (not IO) and is
 * the only way to convert a UTC instant into a named-timezone wall clock, so
 * it is used here despite `domain/` otherwise avoiding non-deterministic-
 * looking globals — for a fixed `now` and `timezone` its output is pure.
 */

/**
 * Reasons `isWithinWindow` can report for `within: false`. These exact
 * strings are expected to become `commands.status_reason` values once
 * ingest (Task 8) wires `QUEUED_WINDOW` handling in — do not rename them.
 */
export type TimeWindowReason = 'excluded-date' | 'outside-days' | 'outside-hours';

/**
 * Operator-configured local time window (D-P2-6). Every field's semantics
 * (`days`/`start`/`end`/`excludeDates`) are relative to `timezone` — never to
 * the host process's own TZ, and never to UTC.
 */
export interface TimeWindowConfig {
  /**
   * IANA timezone name, e.g. `'Asia/Shanghai'`. Not validated here beyond
   * what `Intl.DateTimeFormat` itself enforces: an invalid name makes it
   * throw a `RangeError`, which `isWithinWindow` lets propagate uncaught
   * (fail closed — the caller is expected to validate config once at
   * startup, not re-derive validity on every single mail).
   */
  readonly timezone: string;
  /** Allowed weekdays, 0 = Sunday .. 6 = Saturday. */
  readonly days: readonly number[];
  /** Window open time, local to `timezone`, `'HH:MM'` (zero-padded, 24h). */
  readonly start: string;
  /**
   * Window close time, local to `timezone`, `'HH:MM'`; EXCLUSIVE — an
   * instant reading exactly `end` counts as outside the window.
   */
  readonly end: string;
  /**
   * Local calendar dates (`'YYYY-MM-DD'`, in `timezone`) that are always
   * outside the window, regardless of weekday or time.
   */
  readonly excludeDates: readonly string[];
}

export interface TimeWindowVerdict {
  readonly within: boolean;
  readonly reason: TimeWindowReason | null;
}

const HHMM = /^\d{2}:\d{2}$/;

/** Config error (fail closed): `value` must be exactly two digits, a colon,
 *  two digits. This is a SHAPE check only — it does not reject a
 *  syntactically-shaped but out-of-range clock value like `'25:00'`; that
 *  class of misconfiguration is left to the caller's own config validation. */
function assertHHMM(value: string): void {
  if (!HHMM.test(value)) {
    throw new Error('timeWindow: start/end must be HH:MM');
  }
}

/** `now`'s local wall-clock reading in a specific timezone. */
interface LocalReading {
  /** `'YYYY-MM-DD'`, for the `excludeDates` check. */
  readonly date: string;
  /**
   * `'HH:MM'`, for the start/end check. Zero-padded, so plain string
   * comparison against another `'HH:MM'` value agrees with numeric order.
   */
  readonly time: string;
  /** 0 = Sunday .. 6 = Saturday. */
  readonly weekday: number;
}

/**
 * Reads `now`'s local wall clock in `timezone`. `'en-CA'` is used only
 * because it is a convenient locale to ask for date parts with (its
 * formatted-string ordering happens to be YYYY-MM-DD); every part is
 * extracted by `type` below, so the locale's own separators/ordering never
 * actually matter.
 *
 * `hourCycle: 'h23'` (rather than `hour12: false`) pins the hour field to
 * the spec-guaranteed 00-23 range. `hour12: false` resolves the cycle
 * through locale/CLDR data and MAY land on `'h24'`, under which local
 * midnight reads `'24:0X'` — lexically above every `'HH:MM'` bound, so a
 * same-day window starting `'00:00'` would wrongly report outside-hours.
 *
 * Weekday is deliberately NOT read from Intl's `weekday` part — that comes
 * back as a locale-dependent name (e.g. `'Fri'`) which would need fragile
 * re-parsing/mapping back to a number. Instead it is derived from the
 * extracted local Y-M-D via `Date.UTC` + `getUTCDay()`: a plain calendar
 * calculation, deterministic, no name parsing, no locale hazard.
 */
function readLocal(timezone: string, now: Date): LocalReading {
  // An invalid `timezone` throws a RangeError right here (Intl's own
  // validation) and is allowed to propagate — see the `timezone` field's
  // doc comment on `TimeWindowConfig` above.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);

  const part = (type: Intl.DateTimeFormatPart['type']): string => {
    const found = parts.find((p) => p.type === type);
    // formatToParts always yields every field type requested in the options
    // above; this is defensive, not a reachable runtime path.
    if (found === undefined) {
      throw new Error(`timeWindow: Intl did not produce a "${type}" part`);
    }
    return found.value;
  };

  const year = part('year');
  const month = part('month');
  const day = part('day');

  return {
    date: `${year}-${month}-${day}`,
    time: `${part('hour')}:${part('minute')}`,
    weekday: new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))).getUTCDay(),
  };
}

/**
 * Decides whether `now` falls inside `config`'s local time window.
 *
 * `undefined` config means "no window configured" and is always
 * `{ within: true, reason: null }`.
 *
 * Check order is fixed (D-P2-6) and the FIRST failing check decides
 * `reason`: `excluded-date` → `outside-days` → `outside-hours`. So an
 * instant whose local date is both excluded AND on a disallowed weekday is
 * reported as `excluded-date`, not `outside-days`.
 *
 * Hours: `start <= end` (string comparison — valid because both are
 * zero-padded `'HH:MM'`, so lexical order agrees with numeric order) is a
 * same-day window, inclusive start / exclusive end (`start <= t < end`).
 * `start > end` crosses midnight; within iff `t >= start OR t < end`.
 *
 * Weekday for the cross-midnight case uses the CURRENT local calendar
 * date's weekday (kept simple for v0.1 — documented, not accidental): e.g. a
 * window starting 23:30 Friday that runs into Saturday morning counts the
 * Saturday-morning instants against Saturday's weekday, not Friday's.
 */
export function isWithinWindow(
  config: TimeWindowConfig | undefined,
  now: Date,
): TimeWindowVerdict {
  if (config === undefined) {
    return { within: true, reason: null };
  }

  assertHHMM(config.start);
  assertHHMM(config.end);

  const local = readLocal(config.timezone, now);

  if (config.excludeDates.includes(local.date)) {
    return { within: false, reason: 'excluded-date' };
  }

  if (!config.days.includes(local.weekday)) {
    return { within: false, reason: 'outside-days' };
  }

  const { start, end } = config;
  const withinHours =
    start <= end
      ? local.time >= start && local.time < end
      : local.time >= start || local.time < end;

  if (!withinHours) {
    return { within: false, reason: 'outside-hours' };
  }

  return { within: true, reason: null };
}
