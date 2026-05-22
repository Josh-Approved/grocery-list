// Canonical Josh Approved donation-prompt storage + trigger logic.
// Source: josh-approved-factory/templates/donation-prompt/donationPrompt.ts
// Pairs with DonationModal.tsx in this folder.
// See README.md for canonical rules and wiring.

import AsyncStorage from '@react-native-async-storage/async-storage';

const DEFAULT_KEY = '@josh-approved/donation';

export const DONATION_CONFIG = {
  firstPromptAfterCompletions: 5,
  remindAfterCompletions: 5,
  maxPrompts: 2,
};

interface State {
  successfulCompletions: number;
  promptsShown: number;
  nextPromptAt: number;
}

const DEFAULT_STATE: State = {
  successfulCompletions: 0,
  promptsShown: 0,
  nextPromptAt: DONATION_CONFIG.firstPromptAfterCompletions,
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
 * Returns true if the canonical DonationModal should be shown this completion.
 *
 * The cap is enforced atomically: when this returns true, `promptsShown` is
 * advanced inside this call. Back-dismissing the modal or killing the app
 * before the user taps a button cannot bypass the ceiling.
 */
export async function recordSuccessfulCompletion(
  storageKey?: string
): Promise<boolean> {
  const state = await load(storageKey);
  state.successfulCompletions += 1;
  const shouldPrompt =
    state.promptsShown < DONATION_CONFIG.maxPrompts &&
    state.successfulCompletions >= state.nextPromptAt;
  if (shouldPrompt) {
    state.promptsShown += 1;
    state.nextPromptAt =
      state.successfulCompletions + DONATION_CONFIG.remindAfterCompletions;
  }
  await save(state, storageKey);
  return shouldPrompt;
}
