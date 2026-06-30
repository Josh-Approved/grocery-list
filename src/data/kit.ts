/**
 * Kit data model + pure helpers.
 *
 * A "kit" is a reusable bundle of items you buy together for one thing you make
 * — a chicken-salad kit is rotisserie chicken + celery + mayo, NOT the salt and
 * pepper you always have. Deliberately not called a recipe: it carries no
 * method, only the short shopping shortlist. Selecting a kit on a list drops its
 * items onto that list in one tap.
 *
 * UI-agnostic and pure. The shape is CRDT-ready, exactly like data/list.ts:
 * every kit AND every kit item carries `updatedAt` + a soft-delete `deletedAt`
 * tombstone, so the whole kit collection merges across devices as a record set
 * (mergeKits → mergeRecordSet) with tombstones — never file-level last-write-
 * wins. Kits ride the shared-list sync channels (see sync/index.ts), so anyone
 * you share a list with converges on the same kits; a solo user's kits stay
 * local.
 */

import { makeId } from '../lib/id';
import { now as clockNow } from '../sync/clock';
import { type Category, inferCategory } from './categories';
import { clampQty } from './list';

export const DEFAULT_KIT_NAME = 'New kit';

/** Clamp an ingredient quantity to the same 1..MAX_QTY range as list items. */
export const clampKitItem = clampQty;

/** One ingredient in a kit. Mirrors the merge-relevant fields of GroceryItem
 *  (id / quantity / category / updatedAt / deletedAt) so it flows through the
 *  same per-record merge, and carries the remembered quantity + aisle onto the
 *  list when the kit is added. No `checked` — a kit is never shopped. */
export interface KitItem {
  id: string;
  name: string;
  /** Integer, 1..MAX_QTY. Remembered, and carried onto the list. */
  quantity: number;
  category: Category;
  updatedAt: number;
  /** Soft-delete tombstone (ms). Set instead of removing so a delete survives
   *  a cross-device merge. UI treats `deletedAt != null` as gone. */
  deletedAt?: number;
}

export interface Kit {
  id: string;
  name: string;
  /** When the name was last set by a person — merges on its own clock, exactly
   *  like GroceryList.nameUpdatedAt, so an item edit never lets a stale name win. */
  nameUpdatedAt: number;
  items: KitItem[];
  createdAt: number;
  updatedAt: number;
  /** Kit-level soft-delete tombstone. The kit collection is a record set; a
   *  deleted kit stays present with this set so the delete converges instead of
   *  the kit being re-adopted from a paired device. */
  deletedAt?: number;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export function makeKit(name?: string): Kit {
  const now = clockNow();
  return {
    id: makeId('k'),
    name: (name ?? '').trim() || DEFAULT_KIT_NAME,
    nameUpdatedAt: now,
    items: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function makeKitItem(
  name: string,
  locale: string = 'en',
  category?: Category,
  quantity: number = 1
): KitItem {
  const now = clockNow();
  return {
    id: makeId('ki'),
    name: name.trim(),
    quantity: clampQty(quantity),
    // A known category (e.g. from the seed catalog) wins; otherwise guess from
    // the name in the active language so it lands in the right aisle on the list.
    category: category ?? inferCategory(name, locale),
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Selectors (pure)
// ---------------------------------------------------------------------------

/** Kits the user can see — tombstoned ones are gone. Caller sorts for the UI. */
export function visibleKits(kits: Kit[]): Kit[] {
  return kits.filter((k) => k.deletedAt == null);
}

/** Items in a kit the user can see — tombstoned ones are gone. */
export function visibleKitItems(kit: Kit): KitItem[] {
  return kit.items.filter((it) => it.deletedAt == null);
}

/** Count of live items in a kit. */
export function kitItemCount(kit: Kit): number {
  return visibleKitItems(kit).length;
}

/** Case-insensitive lookup of an active (non-deleted) item by name — used to
 *  merge a re-added duplicate into the existing row instead of stacking two
 *  identical ingredients (mirrors data/list.ts findActiveByName). */
export function findActiveKitItemByName(
  kit: Kit,
  name: string
): KitItem | undefined {
  const n = name.trim().toLowerCase();
  return visibleKitItems(kit).find((it) => it.name.toLowerCase() === n);
}
