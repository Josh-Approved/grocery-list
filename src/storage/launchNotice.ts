// Canonical Josh Approved launch-notice storage + trigger logic.
// Source: josh-approved-factory/templates/launch-notice/launchNotice.ts
// Pairs with LaunchNoticeModal.tsx in this folder.
// See README.md for canonical rules and wiring.

import AsyncStorage from '@react-native-async-storage/async-storage';

const DEFAULT_KEY = '@josh-approved/launch-notice';

export const LAUNCH_NOTICE_CONFIG = {
  /** Sessions the notice appears in before it stops for good. */
  maxShowings: 3,
  /** Days after the app's public launch that the notice stays eligible. */
  windowDays: 60,
};

const DAY_MS = 24 * 60 * 60 * 1000;

interface State {
  showings: number;
}

const DEFAULT_STATE: State = { showings: 0 };

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
    // Storage failure is non-fatal. Worst case the notice shows again next
    // session; the window still closes it. Never crash a cold start for this.
  }
}

/**
 * True while the app is inside its public launch window.
 *
 * `launchedAt` is the app's own public launch date as an ISO date string
 * ('2026-07-27'), declared as a per-app constant. There is no server and no
 * remote config — the date ships in the binary.
 *
 * Fails closed: a missing or malformed date means "not launching", so a
 * typo can never pin the notice on forever.
 */
export function isWithinLaunchWindow(
  launchedAt: string,
  now: number = Date.now()
): boolean {
  const launched = Date.parse(launchedAt);
  if (Number.isNaN(launched)) return false;
  const elapsed = now - launched;
  if (elapsed < 0) return false;
  return elapsed < LAUNCH_NOTICE_CONFIG.windowDays * DAY_MS;
}

/**
 * Call once per app session, at the point the first real screen is ready.
 * Returns true if the canonical LaunchNoticeModal should be shown.
 *
 * Two independent stops, whichever lands first:
 *   - the per-install showing cap (default 3 sessions)
 *   - the launch window closing (default 60 days after launch)
 */
export async function shouldShowLaunchNotice(
  launchedAt: string,
  storageKey?: string,
  now: number = Date.now()
): Promise<boolean> {
  if (!isWithinLaunchWindow(launchedAt, now)) return false;
  const state = await load(storageKey);
  return state.showings < LAUNCH_NOTICE_CONFIG.maxShowings;
}

/**
 * Called by the modal when it becomes visible. Counts the showing so the cap
 * holds even if the user back-dismisses or kills the app without tapping
 * "Got it" — those paths never reach the dismiss handler.
 */
export async function markLaunchNoticeShown(storageKey?: string): Promise<void> {
  const state = await load(storageKey);
  state.showings += 1;
  await save(state, storageKey);
}

/** Test/QA helper. Never call from product code. */
export async function resetLaunchNotice(storageKey?: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(key(storageKey));
  } catch {
    // Best-effort.
  }
}
