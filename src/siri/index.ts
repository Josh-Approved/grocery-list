/**
 * Siri "add an item" integration — orchestration.
 *
 * iOS only, and only on builds that include the `GrocerySiri` native module;
 * every path degrades to a no-op elsewhere (see `native.ts`). Two directions:
 *
 *   - OUT: `syncListsToSiri` mirrors the current lists + the user's default
 *     choice into the shared App Group so the App Intent can resolve which
 *     list "add milk" means. `startSiriListSync` keeps that mirror fresh by
 *     (debounced) re-pushing whenever lists change.
 *   - IN: `drainPendingSiriItems` pulls anything the user dictated to Siri
 *     while we were backgrounded/closed into the real store via `addItem`.
 *
 * Kept deliberately thin: all the branching logic lives in `drain.ts` (pure,
 * unit-tested). This module just wires it to the live store and the bridge.
 */

import { useListsStore } from '../store/lists';
import { getSiriDefaultListId } from './defaultList';
import { planDrain } from './drain';
import {
  clearPendingSiriItems,
  isSiriSupported,
  pushListsToSiri,
  readPendingSiriItems,
  type SiriListRef,
} from './native';

export { getSiriDefaultListId, setSiriDefaultListId } from './defaultList';
export { isSiriSupported } from './native';

function currentListRefs(): SiriListRef[] {
  // `lists` in the store is already the active set (deletes hard-remove the
  // row from the array), so no filtering needed.
  return useListsStore.getState().lists.map((l) => ({ id: l.id, name: l.name }));
}

/** Mirror the current lists + default-list choice into the App Group. */
export async function syncListsToSiri(): Promise<void> {
  if (!isSiriSupported()) return;
  const defaultId = await getSiriDefaultListId();
  pushListsToSiri(currentListRefs(), defaultId);
}

/** Drain anything dictated to Siri into the real store. */
export async function drainPendingSiriItems(): Promise<void> {
  if (!isSiriSupported()) return;
  const pending = readPendingSiriItems();
  if (pending.length === 0) return;

  const defaultId = await getSiriDefaultListId();
  const { adds, drainedRequestIds } = planDrain(
    pending,
    currentListRefs(),
    defaultId
  );

  const { addItem } = useListsStore.getState();
  for (const add of adds) addItem(add.listId, add.name);

  clearPendingSiriItems(drainedRequestIds);
}

/**
 * Start keeping Siri's view of the lists in sync. Pushes once immediately,
 * then re-pushes (debounced) on every list change. Returns an unsubscribe.
 */
export function startSiriListSync(): () => void {
  if (!isSiriSupported()) return () => {};

  void syncListsToSiri();

  let timer: ReturnType<typeof setTimeout> | null = null;
  const unsub = useListsStore.subscribe(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void syncListsToSiri();
    }, 400);
  });

  return () => {
    if (timer) clearTimeout(timer);
    unsub();
  };
}
