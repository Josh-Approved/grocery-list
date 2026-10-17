// Canonical Josh Approved review-prompt storage + trigger logic.
// Source: josh-approved-factory/templates/review-prompt/reviewPrompt.ts
// Pairs with ReviewModal.tsx (the surface: the OS-native rating sheet, with
// the custom modal as the fallback) in this folder.
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
  /**
   * Prompts *presented* — advanced the moment the native sheet is requested or
   * the fallback modal becomes visible, never on dismissal.
   */
  promptsShown: number;
  /**
   * The user opened the store's write-review page from the fallback modal.
   * Retires this install. The native sheet never sets this: the OS does not
   * say whether the user rated, so a native request only counts as shown.
   */
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
 * Called by ReviewModal the moment it presents — before the native sheet is
 * requested, or as the fallback modal becomes visible. Counts the prompt as
 * *shown* so the 3-prompt ceiling holds even if the user back-dismisses or
 * kills the app without tapping "Not now" — those paths never reach a dismiss
 * handler, so the counter must advance on show. It also advances the positional
 * threshold: the next eligible session is `promptAtSessions[promptsShown]`.
 *
 * Counting a native *request* (not a confirmed display) is deliberate: the OS
 * decides whether the sheet actually appears and never tells us, so the request
 * is the only event we can count. It also keeps us under Apple's own quota —
 * 3 requests per install ever is inside SKStoreReviewController's 3 per 365 days.
 */
export async function markReviewPromptShown(storageKey?: string): Promise<void> {
  const state = await load(storageKey);
  state.promptsShown += 1;
  await save(state, storageKey);
}

/**
 * Called by the fallback modal when the user taps "Leave a review." Stops all
 * future prompts. Pair with deep-linking to the store's write-review URL.
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

// ---- Success moments -------------------------------------------------------
//
// The session count decides WHETHER an install is asked this boot; a success
// moment decides WHEN in the boot. Both stores say the same thing — ask right
// after the user has just got something done, not while they are on their way
// to doing it — and a launch-time ask is the opposite of that. An app that has
// a clear "done" state (a finished workout, a saved list, an export that landed)
// opts in with `review={{ …, waitForSuccessMoment: true }}` on <AppShell>, and
// calls `onSuccessMoment()` from that state. When the session is eligible, the
// shell holds the prompt until the first such call; if the app never reaches a
// success moment this boot, the prompt rolls to the next eligible session
// (eligibility is a `>=` check, so nothing is lost). An app that does not opt
// in keeps the post-splash timing.
//
// This is a plain module-level channel rather than React context so a hook deep
// in a screen (e.g. a playback hook) can call it without plumbing. One
// subscriber — the shell — ever listens.

type SuccessMomentListener = () => void;
let successMomentListener: SuccessMomentListener | null = null;

/**
 * App-facing. Call it at a natural success moment. Safe to call freely and
 * often: it does nothing unless the shell is holding an eligible prompt for
 * this session, and only the first call in an eligible session presents.
 */
export function onSuccessMoment(): void {
  successMomentListener?.();
}

/**
 * Shell-facing. Registers the single listener; returns the unsubscribe. Apps
 * never call this — `AppShell` does, when given a `review` prop.
 */
export function subscribeSuccessMoments(listener: SuccessMomentListener): () => void {
  successMomentListener = listener;
  return () => {
    if (successMomentListener === listener) successMomentListener = null;
  };
}
