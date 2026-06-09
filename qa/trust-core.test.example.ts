/**
 * Tier 1 — trust-core unit test (EXAMPLE / template).
 *
 * Copy this next to your trust core and rename it to `<thing>.test.ts` (or put
 * it in a `__tests__/` dir beside the module). Delete this example once your
 * real tests exist — it is intentionally NOT picked up by jest (its name ends
 * in `.example.ts`, and it lives outside any `__tests__/` dir).
 *
 * WHAT TO TEST (and what NOT to)
 * ------------------------------
 * Test the ONE module where a bug is silent and expensive — the "trust core":
 *   • split-expenses → the split / balance / settlement math + currency rounding
 *   • packing-list / grocery-list → list merge + tombstone reconciliation
 *       (canon § Backup & restore #5 — a merge bug silently loses a user's data)
 *   • workout-timer → interval / rest sequencing + survives backgrounding
 *   • tally → counter math + persistence
 *   • EVERY app → its own `src/qa/fixtures.ts` (a broken fixture silently
 *       poisons the Tier 2 / Tier 3 capture runs)
 *
 * Do NOT write component / snapshot tests (brittle, need a render env, low ROI
 * for apps this size) and do NOT chase a coverage %. The bar is qualitative:
 * "the trust core is covered" — pin the worked examples the spec promises, and
 * the edge cases a refactor would quietly break (rounding, empty input,
 * tombstone-wins-over-edit, the off-by-one).
 *
 * RUN: `npm test`  (jest-expo; wired by `sync.mjs qa`).
 */

// Replace with your real trust-core module:
//   import { computeBalances, computeSettlement } from '../math/balances';

describe('trust core — <module name>', () => {
  it('produces the worked example the spec promises', () => {
    // Arrange the canonical worked example from the app's spec / CLAUDE.md…
    // const result = computeBalances(group);
    // expect(result).toEqual(expected);
    expect(true).toBe(true); // ← replace with a real assertion
  });

  it('handles the edge case a refactor would silently break', () => {
    // e.g. rounding to the cent, empty input, a tombstone beating a stale edit…
    expect(true).toBe(true); // ← replace with a real assertion
  });
});
