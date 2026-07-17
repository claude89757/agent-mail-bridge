import { describe, expect, it } from 'vitest';

import { isWithinWindow, type TimeWindowConfig } from '../../src/domain/timeWindow.js';

// Guards decision D-P2-6: the time-window policy that decides whether an
// inbound mail's arrival instant should be queued (QUEUED_WINDOW) instead of
// dispatched immediately. Every instant below is a fixed UTC `Date`, with the
// Asia/Shanghai / America/New_York wall-clock reading it produces spelled
// out in a comment next to it, so "why this literal" never needs re-deriving.
//
// Default fixture: Asia/Shanghai, 09:00-18:00, all weekdays allowed, no
// excluded dates — individual tests override only the field(s) under test so
// each case isolates one concern (mirrors tests/unit/domain-identity.test.ts).
function config(overrides: Partial<TimeWindowConfig> = {}): TimeWindowConfig {
  return {
    timezone: 'Asia/Shanghai',
    days: [0, 1, 2, 3, 4, 5, 6],
    start: '09:00',
    end: '18:00',
    excludeDates: [],
    ...overrides,
  };
}

describe('isWithinWindow (D-P2-6)', () => {
  it('is always within when config is undefined', () => {
    const result = isWithinWindow(undefined, new Date('2026-07-17T04:00:00Z'));

    expect(result).toEqual({ within: true, reason: null });
  });

  describe('same-day window (Asia/Shanghai, 09:00-18:00)', () => {
    it('is within in the middle of the window', () => {
      // 2026-07-17T04:00:00Z = Shanghai 2026-07-17 12:00 (Fri)
      const result = isWithinWindow(config(), new Date('2026-07-17T04:00:00Z'));

      expect(result).toEqual({ within: true, reason: null });
    });

    it('is outside-hours before the window opens', () => {
      // 2026-07-17T00:00:00Z = Shanghai 2026-07-17 08:00 (Fri)
      const result = isWithinWindow(config(), new Date('2026-07-17T00:00:00Z'));

      expect(result).toEqual({ within: false, reason: 'outside-hours' });
    });

    it('is outside-hours after the window closes', () => {
      // 2026-07-17T10:30:00Z = Shanghai 2026-07-17 18:30 (Fri)
      const result = isWithinWindow(config(), new Date('2026-07-17T10:30:00Z'));

      expect(result).toEqual({ within: false, reason: 'outside-hours' });
    });

    it('treats end as exclusive: exactly 18:00 is outside', () => {
      // 2026-07-17T10:00:00Z = Shanghai 2026-07-17 18:00 (Fri) exactly
      const result = isWithinWindow(config(), new Date('2026-07-17T10:00:00Z'));

      expect(result).toEqual({ within: false, reason: 'outside-hours' });
    });
  });

  describe('weekday gate', () => {
    it('rejects a disallowed weekday with outside-days, even when the time is inside hours', () => {
      // 2026-07-18T04:00:00Z = Shanghai 2026-07-18 12:00 (Sat) — inside
      // 09:00-18:00, but Saturday is not in the Mon-Fri allow-list below.
      const result = isWithinWindow(
        config({ days: [1, 2, 3, 4, 5] }),
        new Date('2026-07-18T04:00:00Z'),
      );

      expect(result).toEqual({ within: false, reason: 'outside-days' });
    });
  });

  describe('excludeDates gate', () => {
    it('rejects an excluded local date with excluded-date, even when weekday and time both pass', () => {
      // 2026-07-17T04:00:00Z = Shanghai 2026-07-17 12:00 (Fri): inside hours
      // and Friday is allowed — but the local date itself is excluded.
      const result = isWithinWindow(
        config({ excludeDates: ['2026-07-17'] }),
        new Date('2026-07-17T04:00:00Z'),
      );

      expect(result).toEqual({ within: false, reason: 'excluded-date' });
    });
  });

  // D-P2-6 fixes the check order so the FIRST failing check decides the
  // reason: excluded-date > outside-days > outside-hours. Each case below is
  // built so two failures both apply, pinning down which one wins.
  describe('reason priority order (excluded-date > outside-days > outside-hours)', () => {
    it('prioritizes excluded-date over outside-days', () => {
      // Friday 2026-07-17: excluded AND not in the Monday-only allow-list.
      const result = isWithinWindow(
        config({ days: [1], excludeDates: ['2026-07-17'] }),
        new Date('2026-07-17T04:00:00Z'),
      );

      expect(result).toEqual({ within: false, reason: 'excluded-date' });
    });

    it('prioritizes outside-days over outside-hours', () => {
      // Shanghai 2026-07-17 08:00 (Fri): before the window opens AND Friday
      // is not in the Monday-only allow-list.
      const result = isWithinWindow(config({ days: [1] }), new Date('2026-07-17T00:00:00Z'));

      expect(result).toEqual({ within: false, reason: 'outside-days' });
    });
  });

  describe('cross-midnight window (America/New_York, 22:00-06:00)', () => {
    const crossMidnight = config({
      timezone: 'America/New_York',
      start: '22:00',
      end: '06:00',
    });

    it('is within just after the window opens (23:00)', () => {
      // 2026-07-17T03:00:00Z = New York 2026-07-16 23:00 (Thu)
      const result = isWithinWindow(crossMidnight, new Date('2026-07-17T03:00:00Z'));

      expect(result).toEqual({ within: true, reason: null });
    });

    it('is within just before the window closes (05:00)', () => {
      // 2026-07-17T09:00:00Z = New York 2026-07-17 05:00 (Fri)
      const result = isWithinWindow(crossMidnight, new Date('2026-07-17T09:00:00Z'));

      expect(result).toEqual({ within: true, reason: null });
    });

    it('is outside-hours in the middle of the day (12:00)', () => {
      // 2026-07-17T16:00:00Z = New York 2026-07-17 12:00 (Fri)
      const result = isWithinWindow(crossMidnight, new Date('2026-07-17T16:00:00Z'));

      expect(result).toEqual({ within: false, reason: 'outside-hours' });
    });
  });

  describe('DST fall-back (America/New_York, 2026-11-01: 02:00 EDT falls back to 01:00 EST)', () => {
    it('gives the SAME verdict for both UTC instants that read as the repeated 01:30 local', () => {
      // The repeated hour: 2026-11-01T05:30:00Z is 01:30 EDT (before the
      // fall-back) and 2026-11-01T06:30:00Z is 01:30 EST (after it) — the
      // SAME wall-clock reading, one hour of real time apart. D-P2-6 is a
      // wall-clock-only policy, so both instants MUST agree; pinned with a
      // window where 01:30 is decisive (01:00-02:00 ⇒ both within).
      const fallBack = config({
        timezone: 'America/New_York',
        start: '01:00',
        end: '02:00',
      });

      const beforeFallBack = isWithinWindow(fallBack, new Date('2026-11-01T05:30:00Z'));
      const afterFallBack = isWithinWindow(fallBack, new Date('2026-11-01T06:30:00Z'));

      expect(beforeFallBack).toEqual({ within: true, reason: null });
      expect(afterFallBack).toEqual({ within: true, reason: null });
      expect(afterFallBack).toEqual(beforeFallBack);
    });
  });

  describe('timezone correctness', () => {
    it('gives opposite verdicts for the same instant when the two zones disagree on the calendar date', () => {
      // The SAME UTC instant reads as two different local calendar days:
      //   Asia/Shanghai:    2026-07-17 10:00 (Fri) -> inside 09:00-18:00
      //   America/New_York: 2026-07-16 22:00 (Thu) -> outside 09:00-18:00
      const instant = new Date('2026-07-17T02:00:00Z');

      const shanghai = isWithinWindow(config({ timezone: 'Asia/Shanghai' }), instant);
      const newYork = isWithinWindow(config({ timezone: 'America/New_York' }), instant);

      expect(shanghai).toEqual({ within: true, reason: null });
      expect(newYork).toEqual({ within: false, reason: 'outside-hours' });
    });
  });

  describe('malformed config (fail closed)', () => {
    it('throws when start is not HH:MM', () => {
      expect(() =>
        isWithinWindow(config({ start: '9:00' }), new Date('2026-07-17T04:00:00Z')),
      ).toThrow('timeWindow: start/end must be HH:MM');
    });

    it('throws when end is not HH:MM', () => {
      expect(() =>
        isWithinWindow(config({ end: '18:0' }), new Date('2026-07-17T04:00:00Z')),
      ).toThrow('timeWindow: start/end must be HH:MM');
    });

    it('lets an invalid IANA timezone propagate as an Intl RangeError', () => {
      // Bad timezone is a config error the caller is expected to validate
      // once at startup (fail closed) — this module does not catch or wrap
      // it, it just lets Intl's own validation surface loudly.
      expect(() =>
        isWithinWindow(config({ timezone: 'Not/AZone' }), new Date('2026-07-17T04:00:00Z')),
      ).toThrow(RangeError);
    });
  });
});
