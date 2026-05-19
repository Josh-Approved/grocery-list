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
  addedAt: number;
  updatedAt: number;
  /** Soft-delete tombstone (ms). Set instead of removing the item so a delete
   *  survives a cross-device merge. UI treats `deletedAt != null` as gone. */
  deletedAt?: number;
}

export interface GroceryList {
  id: string;
  name: string;
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
  const now = Date.now();
  return {
    id: makeId('l'),
    name: (name ?? '').trim() || DEFAULT_LIST_NAME,
    items: [],
    categoryOrder: [...DEFAULT_CATEGORY_ORDER],
    createdAt: now,
    updatedAt: now,
  };
}

export function makeItem(name: string): GroceryItem {
  const now = Date.now();
  return {
    id: makeId('i'),
    name: name.trim(),
    quantity: 1,
    category: inferCategory(name),
    checked: false,
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
