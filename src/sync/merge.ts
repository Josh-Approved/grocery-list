/**
 * Conflict-free merge of two copies of one list.
 *
 * This is canon § Backup & restore #5 made concrete: per-record merge by
 * `updatedAt` with `deletedAt` tombstones — NEVER file-level last-write-wins
 * (which silently loses offline edits when both devices changed things while
 * disconnected).
 *
 * The item set is a state-based LWW-element-set keyed by item id: for each id
 * the side with the newer `updatedAt` wins, and a tombstone (`deletedAt`)
 * competes on the same clock so a delete isn't resurrected by a stale edit.
 * List-level fields (name, categoryOrder, shareIdentity) are LWW by the
 * list's own `updatedAt`. The function is pure, commutative, idempotent, and
 * associative — the properties that make "drop a message, it re-converges"
 * true, so the transport can be best-effort.
 *
 * Yjs/Automerge were considered (spec named them) and deliberately not used:
 * a list of records needs an LWW-element-set, not a sequence CRDT — fewer
 * deps, smaller bundle, and far more robust on React Native. Recorded as a
 * build decision in the app CLAUDE.md.
 */

import type { GroceryItem, GroceryList } from '../data/list';

/** The effective clock for an item: a live item uses updatedAt; a tombstoned
 *  one uses max(updatedAt, deletedAt) so a delete always out-clocks the edit
 *  that preceded it. */
function clock(it: GroceryItem): number {
  return it.deletedAt != null ? Math.max(it.updatedAt, it.deletedAt) : it.updatedAt;
}

function mergeItems(
  a: GroceryItem[],
  b: GroceryItem[]
): GroceryItem[] {
  const byId = new Map<string, GroceryItem>();
  for (const it of a) byId.set(it.id, it);
  for (const it of b) {
    const cur = byId.get(it.id);
    if (!cur) {
      byId.set(it.id, it);
      continue;
    }
    const ic = clock(it);
    const cc = clock(cur);
    if (ic > cc) byId.set(it.id, it);
    else if (ic === cc) {
      // Tie: a delete wins over a live edit (safe, converges identically on
      // both devices); otherwise keep the existing (deterministic).
      if (it.deletedAt != null && cur.deletedAt == null) byId.set(it.id, it);
    }
  }
  return Array.from(byId.values());
}

/** Merge `remote` into `local`, returning a new list. Order of arguments
 *  doesn't matter to the result (commutative). */
export function mergeList(
  local: GroceryList,
  remote: GroceryList
): GroceryList {
  const localNewer = local.updatedAt >= remote.updatedAt;
  const head = localNewer ? local : remote;
  return {
    id: local.id,
    name: head.name,
    categoryOrder: head.categoryOrder,
    shareIdentity: head.shareIdentity ?? local.shareIdentity ?? remote.shareIdentity,
    items: mergeItems(local.items, remote.items),
    createdAt: Math.min(local.createdAt, remote.createdAt),
    updatedAt: Math.max(local.updatedAt, remote.updatedAt),
  };
}
