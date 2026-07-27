/**
 * Trust-core tests for the review-prompt trigger.
 *
 * Everything that can go wrong here is silent in production: a prompt that
 * never fires (the defect this rewrite exists to kill — tend and tally shipped
 * dead prompts), a prompt that fires past its cap (nagging, and a store-policy
 * risk), and a migration that re-asks someone who already left a review. All
 * three are asserted below, plus the back-dismiss path that used to be able to
 * slip past the cap.
 *
 * Sessions are simulated by calling recordSessionStart() — one call is one app
 * cold start.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import {
  REVIEW_CONFIG,
  markReviewOpened,
  markReviewPromptShown,
  recordSessionStart,
  resetReviewPrompt,
} from '../reviewPrompt';

const STORE_KEY = '@josh-approved/review';

/**
 * Run `n` sessions, showing the modal whenever the trigger says to (i.e. the
 * real ReviewModal contract: markReviewPromptShown fires on display). Returns
 * the 1-based session numbers the prompt appeared on.
 */
async function runSessions(n: number): Promise<number[]> {
  const shownAt: number[] = [];
  for (let session = 1; session <= n; session++) {
    if (await recordSessionStart()) {
      shownAt.push(session);
      await markReviewPromptShown();
    }
  }
  return shownAt;
}

beforeEach(async () => {
  await AsyncStorage.clear();
  await resetReviewPrompt();
});

describe('REVIEW_CONFIG', () => {
  it('is the canonical 3/15/30 schedule, and its length is the cap', () => {
    expect(REVIEW_CONFIG.promptAtSessions).toEqual([3, 15, 30]);
  });
});

describe('recordSessionStart — the schedule', () => {
  it('fires on exactly the 3rd, 15th and 30th session, never before', async () => {
    expect(await runSessions(40)).toEqual([3, 15, 30]);
  });

  it('does not fire on the first two sessions', async () => {
    expect(await recordSessionStart()).toBe(false);
    expect(await recordSessionStart()).toBe(false);
    expect(await recordSessionStart()).toBe(true);
  });

  it('holds the 3-prompt cap forever after the last threshold', async () => {
    await runSessions(200);
    // The cap is the array length; nothing re-opens it.
    expect(await recordSessionStart()).toBe(false);
  });
});

describe('recordSessionStart — reviewOpened retires the install', () => {
  it('never prompts again once the user opened the store', async () => {
    await runSessions(3); // first prompt shown
    await markReviewOpened();
    expect(await runSessions(60)).toEqual([]);
  });

  it('never prompts at all if the review was left before any prompt', async () => {
    await markReviewOpened();
    expect(await runSessions(60)).toEqual([]);
  });
});

describe('back-dismiss cannot exceed the cap', () => {
  it('counts a prompt as spent on DISPLAY, not on dismissal', async () => {
    // The user back-dismisses / kills the app each time — no dismiss handler
    // ever runs. markReviewPromptShown (called on display) is the only thing
    // advancing the counter, and it must still stop at three.
    const shownAt = await runSessions(500);
    expect(shownAt).toHaveLength(REVIEW_CONFIG.promptAtSessions.length);
  });
});

describe('migration off the old completion-based shape', () => {
  /** The pre-2026-07-27 stored blob. */
  const legacy = (over: Record<string, unknown>) =>
    AsyncStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        successfulCompletions: 7,
        promptsShown: 1,
        reviewOpened: false,
        nextPromptAt: 12,
        ...over,
      })
    );

  it('carries promptsShown over: one prompt already seen → next at session 15', async () => {
    await legacy({});
    expect(await runSessions(20)).toEqual([15]);
  });

  it('carries reviewOpened over: a retired install is never re-asked', async () => {
    await legacy({ reviewOpened: true });
    expect(await runSessions(60)).toEqual([]);
  });

  it('drops the dead fields on the next save', async () => {
    await legacy({});
    await recordSessionStart();
    const raw = await AsyncStorage.getItem(STORE_KEY);
    expect(Object.keys(JSON.parse(raw as string)).sort()).toEqual([
      'promptsShown',
      'reviewOpened',
      'sessionCount',
    ]);
  });

  it('starts a migrated install at session 0, not at its old completion count', async () => {
    await legacy({ promptsShown: 0 });
    // successfulCompletions was 7, but sessions start from scratch — so the
    // first prompt is 3 sessions away, not immediate.
    expect(await runSessions(4)).toEqual([3]);
  });
});

describe('corrupt storage', () => {
  it('falls back to a clean state rather than crashing a cold start', async () => {
    await AsyncStorage.setItem(STORE_KEY, '{not json');
    expect(await runSessions(3)).toEqual([3]);
  });
});
