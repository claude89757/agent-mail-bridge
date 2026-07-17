import { describe, expect, it } from 'vitest';

import { filterNewUids } from '../../src/domain/uid.js';

// Guards decision D-P2-7 and the P0-1 evidence it exists to neutralize: the
// P0-1 IMAP smoke spike observed that RFC 3501 `UID SEARCH n:*` returns the
// LAST message in the mailbox even when nothing new has arrived since uid
// `n` (a range-inversion quirk — an empty search is NOT reported as empty).
// A caller that trusts that raw result verbatim would re-ingest the same
// message forever. `filterNewUids` is the single chokepoint every caller of
// a search-like fetch must run its result through before treating anything
// in it as "new mail".
describe('filterNewUids (D-P2-7, P0-1 evidence)', () => {
  it('drops the exact P0-1 quirk case: a result equal to the watermark is not new', () => {
    expect(filterNewUids([16102], 16102)).toEqual([]);
  });

  it('keeps only uids strictly greater than the watermark out of a mixed list', () => {
    expect(filterNewUids([16099, 16100, 16101, 16102, 16103], 16101)).toEqual([16102, 16103]);
  });

  it('returns empty for an empty input list', () => {
    expect(filterNewUids([], 100)).toEqual([]);
  });

  it('returns empty when every uid is at or below the watermark', () => {
    expect(filterNewUids([16098, 16099, 16100], 16100)).toEqual([]);
  });

  it('treats watermark 0 (never fetched) as everything being new', () => {
    expect(filterNewUids([1, 2, 3], 0)).toEqual([1, 2, 3]);
  });

  it('preserves input order rather than sorting', () => {
    expect(filterNewUids([16105, 16102, 16104, 16103], 16101)).toEqual([
      16105, 16102, 16104, 16103,
    ]);
  });

  it('preserves duplicates: deduping is the store layer responsibility, not this filter', () => {
    expect(filterNewUids([16102, 16103, 16103, 16102], 16101)).toEqual([
      16102, 16103, 16103, 16102,
    ]);
  });
});
