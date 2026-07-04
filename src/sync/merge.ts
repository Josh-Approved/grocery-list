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
 * Two grocery-specific merge behaviours beyond the generic set:
 *
 * CHECKED MERGES ON ITS OWN CLOCK. An item's `checked` carries
 * `checkedUpdatedAt`; content fields (name, quantity, note, category) ride
 * `updatedAt`. Merging whole items by one clock meant a partner's concurrent
 * rename/quantity edit silently reverted your check-off — the "crossed-off
 * items came back" defect. The combiner folds the newer check state into the
 * content winner, so both edits survive. Legacy records (no
 * `checkedUpdatedAt`) fall back to `updatedAt`.
 *
 * DUPLICATE NAMES COLLAPSE DETERMINISTICALLY. Two devices adding "Milk" while
 * apart mint two different ids, and an id-keyed union would show two Milk
 * rows forever. After the record merge, visible items sharing a normalized
 * name collapse to the earliest-added copy (ties by id), folding quantity and
 * check state; the losers are tombstoned at the winner's clock. The collapse
 * is a pure function of the merged set, so every device computes the same
 * result — convergence is preserved.
 *
 * Yjs / Automerge were considered (the spec named them) and deliberately not
 * used: a list of records needs an LWW-element-set, not a sequence CRDT —
 * fewer deps, smaller bundle, and far more robust on React Native. Recorded
 * as a deliberate build decision in the project's build notes.
 */

import type { GroceryItem, GroceryList } from '../data/list';
import { mergeRecordSet } from './mergeRecordSet';

/** The clock the *name* merges by. Legacy lists persisted before `nameUpdatedAt`
 *  existed fall back to `createdAt` (the name was set at creation). A joined
 *  list's placeholder name carries `nameUpdatedAt: 0`, so any real name beats
 *  it. */
function nameClock(l: GroceryList): number {
  return l.nameUpdatedAt ?? l.createdAt;
}

/** The check state's clock. Legacy records (minted before the field existed)
 *  fall back to `checkedAt` — exactly when they were checked — and then to
 *  `addedAt` (unchecked since creation). NEVER to `updatedAt`: the content
 *  clock rises with every rename/quantity edit, so falling back to it would
 *  re-create the very defect this clock exists to fix (a content edit
 *  out-clocking and reverting a check-off). */
function checkedClock(it: GroceryItem): number {
  return it.checkedUpdatedAt ?? it.checkedAt ?? it.addedAt;
}

/** Fold the loser's check state into the record winner when it is newer.
 *  Runs regardless of either side's liveness: a tombstoned winner still
 *  carries the newest check clock forward, so the duplicate-name fold can
 *  lift a late check-off made on a collapsed copy onto the surviving row —
 *  instead of the check evaporating with the dead record. The winner's own
 *  liveness is preserved. */
function combineItems(win: GroceryItem, lose: GroceryItem): GroceryItem {
  if (checkedClock(lose) <= checkedClock(win)) return win;
  return {
    ...win,
    checked: lose.checked,
    checkedAt: lose.checkedAt,
    checkedUpdatedAt: checkedClock(lose),
  };
}

function normName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Reconcile items that share a normalized name, deterministically.
 *
 * LIVE duplicates (concurrent adds on two devices) collapse to one row: the
 * FRESHEST copy survives (newest content clock; ties by addedAt then id) and
 * keeps its own content — the newest add/edit is the current intent. (Keeping
 * the oldest instead can resurrect a row the household already deleted: a
 * stale not-yet-tombstoned copy would win keepership from the fresh re-add,
 * then out-clock its own incoming tombstone.) Losers are tombstoned at their
 * own clock so the tie-break (delete wins) retires them on every device.
 *
 * CHECK STATE folds across the whole name group — including rows already
 * tombstoned by an earlier collapse. A person can check off a copy that the
 * rest of the household has since collapsed away; their check must land on
 * the surviving row, not evaporate with the loser. The newest check clock in
 * the group wins (tie → unchecked, the safe branch: the item stays on the
 * list). This relies on tombstones keeping their name for a few days before
 * pruning strips them (see data/list.ts STRIP_AFTER_MS).
 *
 * Pure function of the merged set → identical on every device → convergent.
 */
function collapseDuplicateNames(items: GroceryItem[]): GroceryItem[] {
  const groups = new Map<string, GroceryItem[]>();
  for (const it of items) {
    if (it.name === '') continue; // stripped tombstone — no name to group by
    const key = normName(it.name);
    const arr = groups.get(key) ?? [];
    arr.push(it);
    groups.set(key, arr);
  }

  const replace = new Map<string, GroceryItem>();
  for (const group of groups.values()) {
    const live = group.filter((it) => it.deletedAt == null);
    if (live.length === 0) continue;
    const sorted = [...live].sort(
      (a, b) =>
        b.updatedAt - a.updatedAt ||
        b.addedAt - a.addedAt ||
        (a.id < b.id ? -1 : 1)
    );
    const keeper = sorted[0];
    // Newest check action anywhere in the name group binds.
    let checkSource = keeper;
    for (const it of group) {
      if (it === keeper) continue;
      const dc = checkedClock(it) - checkedClock(checkSource);
      if (dc > 0 || (dc === 0 && !it.checked)) checkSource = it;
    }
    for (const dup of sorted.slice(1)) {
      replace.set(dup.id, {
        ...dup,
        deletedAt: Math.max(dup.updatedAt, dup.deletedAt ?? 0),
      });
    }
    if (checkSource !== keeper || sorted.length > 1) {
      replace.set(keeper.id, {
        ...keeper,
        checked: checkSource.checked,
        checkedAt: checkSource.checkedAt,
        checkedUpdatedAt: checkedClock(checkSource),
      });
    }
  }
  if (replace.size === 0) return items;
  return items.map((it) => replace.get(it.id) ?? it);
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
  // Tie → the lexicographically greater name, so both devices agree even when
  // two renames land in the same millisecond.
  const nc = nameClock(local) - nameClock(remote);
  const nameHead =
    nc !== 0 ? (nc > 0 ? local : remote) : local.name >= remote.name ? local : remote;
  return {
    id: local.id, // keep the local id — devices have independent local ids
    name: nameHead.name,
    nameUpdatedAt: Math.max(nameClock(local), nameClock(remote)),
    categoryOrder: head.categoryOrder,
    shareIdentity:
      head.shareIdentity ?? local.shareIdentity ?? remote.shareIdentity,
    items: collapseDuplicateNames(
      mergeRecordSet(local.items, remote.items, combineItems)
    ),
    createdAt: Math.min(local.createdAt, remote.createdAt),
    updatedAt: Math.max(local.updatedAt, remote.updatedAt),
  };
}
