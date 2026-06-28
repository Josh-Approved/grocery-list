/**
 * App-specific merge for grocery lists.
 *
 * The per-item LWW-element-set + tombstone logic lives in the factory module
 * (`./mergeRecordSet.ts`). This file resolves the *list-level* fields and
 * delegates item-set merging to the generic helper. Aisle order and share
 * identity follow the whole-list `updatedAt`; the **name merges on its own
 * clock** (`nameUpdatedAt`) so the name only changes when a person renames
 * the list — never as a side effect of one device adding an item, and never
 * when a freshly-joined device (which has no name of its own) syncs in.
 *
 * Yjs / Automerge were considered (the spec named them) and deliberately not
 * used: a list of records needs an LWW-element-set, not a sequence CRDT —
 * fewer deps, smaller bundle, and far more robust on React Native. Recorded
 * as a deliberate build decision in the project's build notes.
 */

import type { GroceryList } from '../data/list';
import { mergeRecordSet } from './mergeRecordSet';

/** The clock the *name* merges by. Legacy lists persisted before `nameUpdatedAt`
 *  existed fall back to `createdAt` (the name was set at creation). A joined
 *  list's placeholder name carries `nameUpdatedAt: 0`, so any real name beats
 *  it. */
function nameClock(l: GroceryList): number {
  return l.nameUpdatedAt ?? l.createdAt;
}

/** Merge `remote` into `local`, returning a new list. Conflict-free,
 *  commutative, idempotent. */
export function mergeList(
  local: GroceryList,
  remote: GroceryList
): GroceryList {
  const localNewer = local.updatedAt >= remote.updatedAt;
  const head = localNewer ? local : remote;
  // The name resolves on its OWN clock, independent of the list's updatedAt.
  // Tie → keep local's name (>=), matching the stable per-item tie-break.
  const nameHead = nameClock(local) >= nameClock(remote) ? local : remote;
  return {
    id: local.id, // keep the local id — devices have independent local ids
    name: nameHead.name,
    nameUpdatedAt: Math.max(nameClock(local), nameClock(remote)),
    categoryOrder: head.categoryOrder,
    shareIdentity:
      head.shareIdentity ?? local.shareIdentity ?? remote.shareIdentity,
    items: mergeRecordSet(local.items, remote.items),
    createdAt: Math.min(local.createdAt, remote.createdAt),
    updatedAt: Math.max(local.updatedAt, remote.updatedAt),
  };
}
