// Canonical Josh Approved review-prompt storage + trigger logic.
// Source: josh-approved-factory/templates/review-prompt/reviewPrompt.ts
// Pairs with ReviewModal.tsx in this folder.
// See README.md for canonical rules and wiring.

import AsyncStorage from '@react-native-async-storage/async-storage';

const DEFAULT_KEY = '@josh-approved/review';

/**
 * The studio-wide trigger framework: a **session** is one app cold start (one
 * JS boot). The prompt becomes eligible at the 3rd, 15th and 30th session, and
 * the array length is itself the hard cap — 3 prompts per install, ever.
 *
 * Session-based (2026-07-27) because the previous completion-based trigger
 * required each app to judge what counted as a "satisfying success", and that
 * judgement kept going wrong in ways nobody could see: tend and tally shipped
 * with the module synced and nothing calling it, and grocery-list's trigger sat
 * on a cleanup action most users never took. A session count is app-agnostic,
 * the shell owns it, and there is nothing per-app left to mis-wire.
 *
 * Thresholds are positional — the next one is always
 * `promptAtSessions[promptsShown]`, so nothing needs to be scheduled or stored
 * when a prompt is dismissed.
 */
export const REVIEW_CONFIG = {
  promptAtSessions: [3, 15, 30],
};

interface State {
  /** App cold starts counted so far (QA-mode boots are never counted). */
  sessionCount: number;
  /** Prompts *displayed* — advanced on show, not on dismissal. */
  promptsShown: number;
  /** The user opened the store's write-review page. Retires this install. */
  reviewOpened: boolean;
}

const DEFAULT_STATE: State = {
  sessionCount: 0,
  promptsShown: 0,
  reviewOpened: false,
};

function key(storageKey?: string): string {
  return storageKey ?? DEFAULT_KEY;
}

/**
 * Load + normalize. Normalizing (rather than spreading the raw blob) is the
 * migration path off the old completion-based shape
 * (`{ successfulCompletions, promptsShown, reviewOpened, nextPromptAt }`):
 * `promptsShown` and `reviewOpened` carry over — an install that already used
 * up prompts, or already left a review, must never be re-asked from zero — and
 * the two dead fields are simply dropped on the next save. `sessionCount`
 * starts at 0, so a mid-life install gets its next prompt at the positional
 * threshold for the prompts it has already seen (1 shown → session 15).
 */
async function load(storageKey?: string): Promise<State> {
  try {
    const raw = await AsyncStorage.getItem(key(storageKey));
    if (!raw) return { ...DEFAULT_STATE };
    const stored = JSON.parse(raw) ?? {};
    return {
      sessionCount:
        typeof stored.sessionCount === 'number' ? stored.sessionCount : 0,
      promptsShown:
        typeof stored.promptsShown === 'number' ? stored.promptsShown : 0,
      reviewOpened: stored.reviewOpened === true,
    };
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
 * Call once per app session (one JS boot), from the app shell — never from a
 * screen, never from a success path, never more than once per boot.
 * `AppShell` does this itself when it is given a `review={…}` prop, so no app
 * carries trigger code of its own.
 *
 * Returns true if the canonical ReviewModal should be shown this session.
 */
export async function recordSessionStart(
  storageKey?: string
): Promise<boolean> {
  const state = await load(storageKey);
  state.sessionCount += 1;
  const threshold = REVIEW_CONFIG.promptAtSessions[state.promptsShown];
  const shouldPrompt =
    !state.reviewOpened &&
    state.promptsShown < REVIEW_CONFIG.promptAtSessions.length &&
    state.sessionCount >= threshold;
  await save(state, storageKey);
  return shouldPrompt;
}

/**
 * Called by the modal when it becomes visible. Counts the prompt as *shown* so
 * the 3-prompt ceiling holds even if the user back-dismisses or kills the app
 * without tapping "Not now" — those paths never reach a dismiss handler, so the
 * counter must advance on show. It also advances the positional threshold: the
 * next eligible session is `promptAtSessions[promptsShown]`.
 */
export async function markReviewPromptShown(storageKey?: string): Promise<void> {
  const state = await load(storageKey);
  state.promptsShown += 1;
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

/** Test/QA helper. Never call from product code. */
export async function resetReviewPrompt(storageKey?: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(key(storageKey));
  } catch {
    // Best-effort.
  }
}
