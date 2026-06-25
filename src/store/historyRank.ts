/**
 * Recency-weighted ranking for the "Recent" autocomplete list.
 *
 * Kept separate from account.ts / db.ts so it's a pure, dependency-free module
 * (no expo-sqlite import) — directly unit-testable, and reusable wherever a
 * history needs decay-ranking.
 */

import type { HistoryRow } from './db';

// Ranking half-life. A history entry's weight halves every ~30 days of disuse,
// so a one-off typo from weeks ago sinks below things actually bought lately,
// while a weekly staple (re-touched every shop) keeps resetting its clock and
// stays near the top.
const RANK_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Recency-weighted rank score: `count × 2^(-age / halflife)`.
 *
 * Frequency still matters (the multiplier), but age decays it, so "Recent" is
 * no longer a pure count race that a long-dead typo can win once and sit in
 * forever. A staple bought 50× and used yesterday dominates; a typo typed once
 * two months ago scores a small fraction of its count and falls to the bottom —
 * where the user can swipe it away for good.
 */
export function historyScore(row: HistoryRow, now: number): number {
  const age = Math.max(0, now - row.lastUsed);
  return row.count * Math.pow(2, -age / RANK_HALF_LIFE_MS);
}

/** History names in "Recent" display order: recency-weighted, highest first. */
export function rankedHistoryNames(
  history: HistoryRow[],
  now: number
): string[] {
  return [...history]
    .sort((a, b) => historyScore(b, now) - historyScore(a, now))
    .map((h) => h.name);
}
