// Canonical Josh Approved review-prompt storage + trigger logic.
// Source: josh-approved-factory/templates/review-prompt/reviewPrompt.ts
// Pairs with ReviewModal.tsx in this folder.
// See README.md for canonical rules and wiring.

import AsyncStorage from '@react-native-async-storage/async-storage';

const DEFAULT_KEY = '@josh-approved/review';

export const REVIEW_CONFIG = {
  firstPromptAfterCompletions: 2,
  remindAfterCompletions: 5,
  maxPrompts: 3,
};

interface State {
  successfulCompletions: number;
  promptsShown: number;
  reviewOpened: boolean;
  nextPromptAt: number;
}

const DEFAULT_STATE: State = {
  successfulCompletions: 0,
  promptsShown: 0,
  reviewOpened: false,
  nextPromptAt: REVIEW_CONFIG.firstPromptAfterCompletions,
};

function key(storageKey?: string): string {
  return storageKey ?? DEFAULT_KEY;
}

async function load(storageKey?: string): Promise<State> {
  try {
    const raw = await AsyncStorage.getItem(key(storageKey));
    if (!raw) return { ...DEFAULT_STATE };
    return { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

async function save(state: State, storageKey?: string): Promise<void> {
  try {
    await AsyncStorage.setItem(key(storageKey), JSON.stringify(state));
  } catch {
    // Storage failure is non-fatal — the prompt is best-effort.
  }
}

/**
 * Call from a real success path (a finished workout, a converted file, a
 * summarized page). Never on launch. Never from an error or empty state.
 *
 * Returns true if the canonical ReviewModal should be shown this completion.
 */
export async function recordSuccessfulCompletion(
  storageKey?: string
): Promise<boolean> {
  const state = await load(storageKey);
  state.successfulCompletions += 1;
  const shouldPrompt =
    !state.reviewOpened &&
    state.promptsShown < REVIEW_CONFIG.maxPrompts &&
    state.successfulCompletions >= state.nextPromptAt;
  await save(state, storageKey);
  return shouldPrompt;
}

/**
 * Called by the modal when it becomes visible. Counts the prompt as *shown* so
 * the maxPrompts ceiling holds even if the user back-dismisses or kills the app
 * without tapping "Not now" — those paths never call dismissReviewPrompt, so
 * the counter must advance on show, not only on explicit dismissal.
 */
export async function markReviewPromptShown(storageKey?: string): Promise<void> {
  const state = await load(storageKey);
  state.promptsShown += 1;
  await save(state, storageKey);
}

/**
 * Called by the modal when the user taps "Not now." The shown-count is already
 * advanced by markReviewPromptShown (on display); this only schedules the next
 * eligible completion so we don't double-count a single prompt.
 */
export async function dismissReviewPrompt(storageKey?: string): Promise<void> {
  const state = await load(storageKey);
  state.nextPromptAt =
    state.successfulCompletions + REVIEW_CONFIG.remindAfterCompletions;
  await save(state, storageKey);
}

/**
 * Called by the modal when the user taps "Leave a review." Stops all future
 * prompts. Pair with deep-linking to the store's write-review URL.
 */
export async function markReviewOpened(storageKey?: string): Promise<void> {
  const state = await load(storageKey);
  state.reviewOpened = true;
  await save(state, storageKey);
}
