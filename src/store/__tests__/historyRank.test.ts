/**
 * Recency-weighted "Recent" ranking. The point of the decay is that a stale
 * one-off typo sinks below things actually bought lately, even if the typo's
 * raw count once tied or beat them — so swipe-to-forget has less to clean up
 * and the wrong rows fall to the bottom on their own.
 */

import { historyScore, rankedHistoryNames } from '../historyRank';
import type { HistoryRow } from '../db';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000; // fixed clock so the test is deterministic

describe('historyScore', () => {
  it('decays an unused entry toward zero (~half per 30 days)', () => {
    const fresh: HistoryRow = { name: 'milk', count: 1, lastUsed: NOW };
    const old: HistoryRow = { name: 'milk', count: 1, lastUsed: NOW - 30 * DAY };
    expect(historyScore(fresh, NOW)).toBeCloseTo(1, 5);
    expect(historyScore(old, NOW)).toBeCloseTo(0.5, 2);
  });

  it('still rewards frequency — a staple outscores a one-off at equal age', () => {
    const staple: HistoryRow = { name: 'eggs', count: 20, lastUsed: NOW };
    const oneOff: HistoryRow = { name: 'eg', count: 1, lastUsed: NOW };
    expect(historyScore(staple, NOW)).toBeGreaterThan(historyScore(oneOff, NOW));
  });
});

describe('rankedHistoryNames', () => {
  it('sinks a stale high-count typo below a recent staple', () => {
    const history: HistoryRow[] = [
      // A typo bought 3× but not in ~3 months.
      { name: 'banananana', count: 3, lastUsed: NOW - 90 * DAY },
      // A staple bought twice, just last week.
      { name: 'bread', count: 2, lastUsed: NOW - 5 * DAY },
    ];
    expect(rankedHistoryNames(history, NOW)).toEqual(['bread', 'banananana']);
  });

  it('does not mutate the input array', () => {
    const history: HistoryRow[] = [
      { name: 'a', count: 1, lastUsed: NOW - 40 * DAY },
      { name: 'b', count: 1, lastUsed: NOW },
    ];
    const before = history.map((h) => h.name);
    rankedHistoryNames(history, NOW);
    expect(history.map((h) => h.name)).toEqual(before);
  });
});
