/**
 * App-specific merge for grocery lists.
 *
 * The per-item LWW-element-set + tombstone logic lives in the factory module
 * (`./mergeRecordSet.ts`). This file resolves the *list-level* fields —
 * name, aisle order, share identity — by LWW on the list's own `updatedAt`,
 * and delegates item-set merging to the generic helper.
 *
 * Yjs / Automerge were considered (the spec named them) and deliberately not
 * used: a list of records needs an LWW-element-set, not a sequence CRDT —
 * fewer deps, smaller bundle, and far more robust on React Native. Recorded
 * as a build decision in the app CLAUDE.md.
 */

import type { GroceryList } from '../data/list';
import { mergeRecordSet } from './mergeRecordSet';

/** Merge `remote` into `local`, returning a new list. Conflict-free,
 *  commutative, idempotent. */
export function mergeList(
  local: GroceryList,
  remote: GroceryList
): GroceryList {
  const localNewer = local.updatedAt >= remote.updatedAt;
  const head = localNewer ? local : remote;
  return {
    id: local.id, // keep the local id — devices have independent local ids
    name: head.name,
    categoryOrder: head.categoryOrder,
    shareIdentity:
      head.shareIdentity ?? local.shareIdentity ?? remote.shareIdentity,
    items: mergeRecordSet(local.items, remote.items),
    createdAt: Math.min(local.createdAt, remote.createdAt),
    updatedAt: Math.max(local.updatedAt, remote.updatedAt),
  };
}
