/**
 * Bridge to the `GrocerySiri` native module (iOS only).
 *
 * The module is a thin Swift shim over a shared App Group container that the
 * Siri App Intent also writes to. It exists ONLY on iOS device/simulator
 * builds that include the native module; on Android, in Expo Go, and under
 * Jest it is absent, so every export here degrades to a safe no-op. Callers
 * never need to branch on platform — they call these and get nothing on
 * unsupported targets.
 *
 * The data contract (shared with `modules/grocery-siri/ios/*.swift`):
 *   - JS pushes the current lists + the user's default-list choice so the
 *     intent can resolve "add milk to <named list>" / fall back to the default.
 *   - The intent appends items the user dictated to a pending queue; JS drains
 *     that queue into the real SQLite store on launch/foreground.
 */

import { requireOptionalNativeModule } from 'expo-modules-core';

/** A list as Siri needs to know it: just an id + spoken name. */
export interface SiriListRef {
  id: string;
  name: string;
}

/** One item the user dictated to Siri, waiting to be drained into the store. */
export interface PendingSiriItem {
  /** Stable id for this dictation, so draining is idempotent. */
  requestId: string;
  /** The list the intent resolved at dictation time (may be stale if the list
   *  was since deleted — the JS drain re-resolves defensively). */
  listId: string | null;
  name: string;
  addedAt: number;
}

interface GrocerySiriNativeModule {
  isSupported(): boolean;
  /** Persist the lists + default choice into the App Group for the intent. */
  syncLists(listsJson: string, defaultListId: string | null): void;
  /** Read (but do not clear) the pending queue, as a JSON array. */
  getPendingItems(): string;
  /** Remove the given requests from the pending queue after draining. */
  clearPendingItems(requestIds: string[]): void;
}

const native =
  requireOptionalNativeModule<GrocerySiriNativeModule>('GrocerySiri');

/** True only when the Siri integration is actually present on this build. */
export function isSiriSupported(): boolean {
  try {
    return native?.isSupported() ?? false;
  } catch {
    return false;
  }
}

/** Push the current lists + default-list choice to the App Group for Siri. */
export function pushListsToSiri(
  lists: SiriListRef[],
  defaultListId: string | null
): void {
  if (!native) return;
  try {
    native.syncLists(JSON.stringify(lists), defaultListId ?? null);
  } catch {
    // Best-effort — a failed push just means Siri sees a slightly stale
    // list set until the next change. Never surface to the UI.
  }
}

/** Read the queue of items dictated to Siri since the last drain. */
export function readPendingSiriItems(): PendingSiriItem[] {
  if (!native) return [];
  try {
    const raw = native.getPendingItems();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PendingSiriItem[]) : [];
  } catch {
    return [];
  }
}

/** Drop the given dictations from the queue once they've been drained. */
export function clearPendingSiriItems(requestIds: string[]): void {
  if (!native || requestIds.length === 0) return;
  try {
    native.clearPendingItems(requestIds);
  } catch {
    // If the clear fails the items re-drain next launch; addItem is
    // idempotent-by-name (a re-add just bumps quantity), and the drain
    // planner de-dupes within a batch, so worst case is a rare qty bump.
  }
}
