/**
 * Grocery list data model + pure helpers.
 *
 * UI-agnostic and pure. The shape is deliberately CRDT-ready for the shared-
 * sync module (build step 4): every item carries `updatedAt` and a
 * soft-delete `deletedAt` tombstone instead of being hard-removed, so two
 * devices can merge per-item by `updatedAt` with tombstones (canon
 * § Backup & restore #5 — never file-level last-write-wins). Single-device
 * code still works: the UI just filters tombstoned items out.
 */

import { makeId } from '../lib/id';
import { now as clockNow } from '../sync/clock';
import {
  type Category,
  DEFAULT_CATEGORY_ORDER,
  inferCategory,
} from './categories';

export const MAX_QTY = 99;
export const DEFAULT_LIST_NAME = 'Groceries';

/**
 * The persistent shared-list identity. Absent until a list is shared; written
 * once at pairing and stored durably on every paired device (this is what
 * makes "pair once, synced forever" hold). Populated by the shared-sync
 * module at build step 4 — declared here so the model and storage shape are
 * stable now and step 4 needs no migration.
 */
export interface ShareIdentity {
  /** Stable per-list secret; the drop-box channel id derives from it. */
  secret: string;
  createdAt: number;
}

export interface GroceryItem {
  id: string;
  name: string;
  /** Integer, 1..MAX_QTY. */
  quantity: number;
  note?: string;
  category: Category;
  checked: boolean;
  checkedAt?: number;
  /** When `checked` last changed — the check state's OWN merge clock, separate
   *  from `updatedAt` (the content clock). Without it the whole item is one
   *  last-writer-wins unit, so a partner renaming or re-quantitying an item
   *  after you crossed it off silently reverts the check when the copies merge
   *  (the "my checked-off items came back" defect). Absent on legacy records →
   *  merge falls back to `updatedAt`. */
  checkedUpdatedAt?: number;
  addedAt: number;
  updatedAt: number;
  /** Soft-delete tombstone (ms). Set instead of removing the item so a delete
   *  survives a cross-device merge. UI treats `deletedAt != null` as gone. */
  deletedAt?: number;
}

export interface GroceryList {
  id: string;
  name: string;
  /** When the *name* was last set by a person (rename, or creation). The name
   *  merges by its own clock, NOT the whole-list `updatedAt` — so adding or
   *  checking an item never lets a stale name win, and a freshly-joined
   *  device (which has no name of its own) can't rename the other side's
   *  list. A list keeps its name until someone explicitly renames it. */
  nameUpdatedAt: number;
  items: GroceryItem[];
  /** This list's own aisle order (user-reorderable, build step 3). Seeded
   *  from DEFAULT_CATEGORY_ORDER at creation. */
  categoryOrder: Category[];
  createdAt: number;
  updatedAt: number;
  shareIdentity?: ShareIdentity;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export function makeList(name?: string): GroceryList {
  const now = clockNow();
  return {
    id: makeId('l'),
    name: (name ?? '').trim() || DEFAULT_LIST_NAME,
    nameUpdatedAt: now,
    items: [],
    categoryOrder: [...DEFAULT_CATEGORY_ORDER],
    createdAt: now,
    updatedAt: now,
  };
}

export function makeItem(
  name: string,
  locale: string = 'en',
  category?: Category
): GroceryItem {
  const now = clockNow();
  return {
    id: makeId('i'),
    name: name.trim(),
    quantity: 1,
    // A known category (e.g. from the seed catalog) wins; otherwise guess from
    // the name in the active language.
    category: category ?? inferCategory(name, locale),
    checked: false,
    checkedUpdatedAt: now,
    addedAt: now,
    updatedAt: now,
  };
}

export function clampQty(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.min(MAX_QTY, Math.max(1, Math.round(n)));
}

// ---------------------------------------------------------------------------
// Selectors (pure)
// ---------------------------------------------------------------------------

/** Items the user can see — tombstoned ones are gone. */
export function visibleItems(list: GroceryList): GroceryItem[] {
  return list.items.filter((it) => it.deletedAt == null);
}

export interface ListStats {
  total: number;
  checked: number;
}

export function listStats(list: GroceryList): ListStats {
  const vis = visibleItems(list);
  return {
    total: vis.length,
    checked: vis.reduce((n, it) => (it.checked ? n + 1 : n), 0),
  };
}

export interface CategorySection {
  category: Category;
  items: GroceryItem[];
}

/**
 * Unchecked items grouped by aisle in this list's `categoryOrder`. Empty
 * aisles are omitted; any item whose category isn't in the order (shouldn't
 * happen, but be safe) is appended under its own heading at the end.
 */
export function groupUnchecked(list: GroceryList): CategorySection[] {
  const buckets = new Map<Category, GroceryItem[]>();
  for (const it of visibleItems(list)) {
    if (it.checked) continue;
    const arr = buckets.get(it.category) ?? [];
    arr.push(it);
    buckets.set(it.category, arr);
  }
  const seen = new Set<Category>();
  const sections: CategorySection[] = [];
  for (const cat of list.categoryOrder) {
    seen.add(cat);
    const items = buckets.get(cat);
    if (items && items.length) sections.push({ category: cat, items });
  }
  for (const [cat, items] of buckets) {
    if (!seen.has(cat) && items.length) sections.push({ category: cat, items });
  }
  return sections;
}

/** Checked items (across all aisles), most-recently-checked first. */
export function checkedItems(list: GroceryList): GroceryItem[] {
  return visibleItems(list)
    .filter((it) => it.checked)
    .sort((a, b) => (b.checkedAt ?? 0) - (a.checkedAt ?? 0));
}

/** Case-insensitive lookup of an active (non-deleted) item by name. Used to
 *  merge a re-added duplicate into the existing row instead of stacking two
 *  identical lines — the "easy to correct" tenet, no AI involved. */
export function findActiveByName(
  list: GroceryList,
  name: string
): GroceryItem | undefined {
  const n = name.trim().toLowerCase();
  return visibleItems(list).find((it) => it.name.toLowerCase() === n);
}

// ---------------------------------------------------------------------------
// Hygiene (pure; run at hydrate / finish-shop, NEVER inside the merge — they
// depend on local wall time, and the merge must stay a pure convergent
// function of its two inputs)
// ---------------------------------------------------------------------------

/** How long a tombstone keeps carrying its dead item in the payload, and how
 *  many we keep at most. Tombstones exist so a delete beats a paired device's
 *  stale live copy; a device offline longer than the horizon may resurrect
 *  what it never saw deleted (accepted tradeoff — without pruning, the
 *  published payload grows without bound until public relays reject it and
 *  sync silently dies, which is far worse). */
export const TOMBSTONE_HORIZON_MS = 21 * 24 * 3600 * 1000;
export const MAX_TOMBSTONES = 80;
/** Tombstones keep their payload (notably the NAME) this long: the merge
 *  folds a late check-off made on a collapsed duplicate into the surviving
 *  same-name row, and that fold needs the dead row's name. After a week the
 *  household has long converged; only id + clocks are worth carrying. */
export const STRIP_AFTER_MS = 7 * 24 * 3600 * 1000;

/**
 * Bound the list's dead weight: drop tombstones older than the horizon or
 * beyond the count cap (oldest first), and strip payload fields off the
 * remaining ones once they're old enough that no same-name fold can still
 * need them. Returns the same list object when nothing changed, so callers
 * can cheaply detect a no-op.
 */
export function pruneTombstones(list: GroceryList, now: number): GroceryList {
  const dead = list.items.filter((it) => it.deletedAt != null);
  if (dead.length === 0) return list;

  const keepIds = new Set(
    dead
      .filter((it) => now - (it.deletedAt ?? 0) < TOMBSTONE_HORIZON_MS)
      .sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0))
      .slice(0, MAX_TOMBSTONES)
      .map((it) => it.id)
  );

  let changed = false;
  const items: GroceryItem[] = [];
  for (const it of list.items) {
    if (it.deletedAt == null) {
      items.push(it);
      continue;
    }
    if (!keepIds.has(it.id)) {
      changed = true;
      continue;
    }
    const oldEnoughToStrip = now - (it.deletedAt ?? 0) >= STRIP_AFTER_MS;
    if (!oldEnoughToStrip || (it.name === '' && it.note == null)) {
      items.push(it);
      continue;
    }
    changed = true;
    items.push({
      id: it.id,
      name: '',
      quantity: 1,
      category: it.category,
      checked: false,
      addedAt: it.addedAt,
      updatedAt: it.updatedAt,
      checkedUpdatedAt: it.checkedUpdatedAt,
      deletedAt: it.deletedAt,
    });
  }
  return changed ? { ...list, items } : list;
}

/**
 * Clamp every merge-participating stamp to `cap` (wall time + the clock's max
 * skew). Heals data poisoned by the pre-logical-clock era, where a device with
 * a fast wall clock minted far-future stamps: those stamps otherwise beat
 * every fresh edit until real time catches up — stale copies keep winning
 * merges, checked-off items keep coming back. Returns the same object when
 * nothing changed.
 */
export function healFutureStamps(list: GroceryList, cap: number): GroceryList {
  const clampTs = (t: number): number => (t > cap ? cap : t);
  let changed =
    list.updatedAt > cap || list.nameUpdatedAt > cap || list.createdAt > cap;
  const items = list.items.map((it) => {
    if (
      it.updatedAt <= cap &&
      it.addedAt <= cap &&
      (it.checkedUpdatedAt ?? 0) <= cap &&
      (it.checkedAt ?? 0) <= cap &&
      (it.deletedAt ?? 0) <= cap
    ) {
      return it;
    }
    changed = true;
    return {
      ...it,
      updatedAt: clampTs(it.updatedAt),
      addedAt: clampTs(it.addedAt),
      checkedUpdatedAt:
        it.checkedUpdatedAt != null ? clampTs(it.checkedUpdatedAt) : undefined,
      checkedAt: it.checkedAt != null ? clampTs(it.checkedAt) : undefined,
      deletedAt: it.deletedAt != null ? clampTs(it.deletedAt) : undefined,
    };
  });
  if (!changed) return list;
  return {
    ...list,
    updatedAt: clampTs(list.updatedAt),
    nameUpdatedAt: clampTs(list.nameUpdatedAt),
    createdAt: clampTs(list.createdAt),
    items,
  };
}
