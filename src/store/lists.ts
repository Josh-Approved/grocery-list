/**
 * Lists store — Zustand state with disk-backed persistence.
 *
 * React state updates synchronously (UI feels instant); the SQLite save runs
 * fire-and-forget in the background. The store is the single source of truth
 * in memory; db.ts is durable backup + (build step 4) the sync substrate.
 *
 * Deletes are soft (item.deletedAt / a list-level tombstone) so the shared-
 * sync module can converge a delete across devices instead of resurrecting
 * it. `applySync` is the reserved entry point step 4 fills in.
 */

import { create } from 'zustand';
import {
  type GroceryItem,
  type GroceryList,
  clampQty,
  findActiveByName,
  makeItem,
  makeList,
} from '../data/list';
import { isBuiltinCategory, type Category } from '../data/categories';
import { makeId } from '../lib/id';
import { makeShareIdentity } from '../sync/share';
import { mergeList } from '../sync/merge';
import {
  loadAllLists,
  saveList,
  deleteListFromDb,
  putTombstone,
  removeTombstone,
} from './db';
import { QA_MODE } from '../qa/qaMode';
import { qaLists } from '../qa/fixtures';

/** Heal duplicate ids in loaded data (legacy/edge collisions corrupt React
 *  keys and would let two devices share an id once sync lands). */
function repairIds(lists: GroceryList[]): {
  lists: GroceryList[];
  changed: GroceryList[];
} {
  const seenList = new Set<string>();
  const changed: GroceryList[] = [];
  const out = lists.map((l) => {
    let mutated = false;
    let listId = l.id;
    if (seenList.has(listId)) {
      listId = makeId('l');
      mutated = true;
    }
    seenList.add(listId);

    const seenItem = new Set<string>();
    const items = l.items.map((it) => {
      let id = it.id;
      if (seenItem.has(id)) {
        id = makeId('i');
        mutated = true;
      }
      seenItem.add(id);
      return id === it.id ? it : { ...it, id };
    });

    if (mutated) {
      const repaired: GroceryList = { ...l, id: listId, items };
      changed.push(repaired);
      return repaired;
    }
    return l;
  });
  return { lists: out, changed };
}

interface ListsState {
  lists: GroceryList[];
  hydrated: boolean;

  hydrate: () => Promise<void>;

  createList: (name?: string) => string;
  getList: (id: string) => GroceryList | undefined;
  renameList: (id: string, name: string) => void;
  duplicateList: (id: string) => string | null;
  deleteList: (id: string) => void;
  /** Additive import (canon Layer 3). Lists arrive with fresh ids already
   *  (see lib/transfer), so this never clobbers existing data. Returns the
   *  number added. */
  importLists: (incoming: GroceryList[]) => number;

  /** Add an item. If an active item with the same name exists, bump its
   *  quantity instead of stacking a duplicate row. `locale` is the active
   *  in-app language so a non-English item categorizes into the right aisle
   *  (defaults to English for non-UI callers). `category`, when given (e.g. an
   *  item picked from the seed catalog), sets the aisle exactly and skips the
   *  keyword guess. */
  addItem: (
    listId: string,
    name: string,
    locale?: string,
    category?: Category
  ) => void;
  setChecked: (listId: string, itemId: string, checked: boolean) => void;
  setQuantity: (listId: string, itemId: string, qty: number) => void;
  setNote: (listId: string, itemId: string, note: string) => void;
  /** Rename an item. An empty/whitespace name is ignored (the previous name
   *  stands) so clearing the field mid-edit can never wipe the row. */
  setName: (listId: string, itemId: string, name: string) => void;
  recategorize: (listId: string, itemId: string, category: Category) => void;
  /** Replace this list's aisle order (build step 3, user-reorderable). */
  reorderAisles: (listId: string, order: Category[]) => void;
  /** Create a custom aisle on this list (deduped case-insensitively against
   *  existing aisles). Returns the resolved aisle key, or null if the name was
   *  empty or the list is gone. */
  addCategory: (listId: string, name: string) => string | null;
  /** Remove a custom aisle: drop it from the order and reassign its items to
   *  'Other'. Built-in aisles can't be removed. */
  removeCategory: (listId: string, category: string) => void;
  /** Soft-delete (tombstone) an item. */
  deleteItem: (listId: string, itemId: string) => void;

  /** Tombstone every checked item ("bought"); returns their pre-change
   *  snapshots so the caller can offer Undo. */
  finishShop: (listId: string) => GroceryItem[];
  /** Undo primitive: write the given item snapshots back verbatim (clears a
   *  tombstone, restores checked state). Used by delete + finish-shop undo. */
  restoreItems: (listId: string, items: GroceryItem[]) => void;

  /** Mint (or return the existing) share secret for a list. Sharing is
   *  permanent once minted — the secret never rotates. */
  shareList: (listId: string) => string | null;
  /** Create a local list paired to an existing shared secret (tapped link /
   *  scanned QR). Idempotent: re-joining the same secret returns the list
   *  already paired to it. Returns the local list id. */
  joinShared: (secret: string) => string;
  /** Merge an incoming remote copy, matched by shared secret (NOT id —
   *  devices have independent local ids). Conflict-free per merge.ts. */
  mergeRemoteList: (remote: GroceryList) => void;

  /** Reserved generic sync entry (kept for symmetry with other apps). */
  applySync: (changes: { upserts: GroceryList[]; deletes: string[] }) => void;
}

function persist(list: GroceryList): void {
  saveList(list).catch((err) =>
    console.warn('grocery-list: failed to persist list', err)
  );
}

export const useListsStore = create<ListsState>()((set, get) => {
  /** Map one list by id through `fn`, bump its updatedAt, persist. */
  function mutate(id: string, fn: (l: GroceryList) => GroceryList): void {
    let updated: GroceryList | undefined;
    set((s) => ({
      lists: s.lists.map((l) => {
        if (l.id !== id) return l;
        updated = { ...fn(l), updatedAt: Date.now() };
        return updated;
      }),
    }));
    if (updated) persist(updated);
  }

  /** Map one item within a list, stamping item + list updatedAt. */
  function mutateItem(
    listId: string,
    itemId: string,
    fn: (it: GroceryItem) => GroceryItem
  ): void {
    mutate(listId, (l) => ({
      ...l,
      items: l.items.map((it) =>
        it.id === itemId ? { ...fn(it), updatedAt: Date.now() } : it
      ),
    }));
  }

  return {
    lists: [],
    hydrated: false,

    hydrate: async () => {
      try {
        const loaded = await loadAllLists();
        // QA capture boots cleared (clearState:true); seed deterministic data so
        // every screen is screenshot-ready without typing live. Compile-time
        // false in production (EXPO_PUBLIC_QA_MODE unset) → tree-shaken out.
        if (QA_MODE && loaded.length === 0) {
          set({ lists: qaLists(), hydrated: true });
          return;
        }
        const { lists, changed } = repairIds(loaded);
        set({ lists, hydrated: true });
        for (const l of changed) persist(l);
      } catch (err) {
        console.warn('grocery-list: failed to load lists from disk', err);
        set({ hydrated: true });
      }
    },

    createList: (name) => {
      const list = makeList(name);
      set((s) => ({ lists: [list, ...s.lists] }));
      persist(list);
      return list.id;
    },

    getList: (id) => get().lists.find((l) => l.id === id),

    renameList: (id, name) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      // Stamp the name's own clock so this explicit rename wins the merge on
      // every paired device, no matter what they last called the list.
      mutate(id, (l) => ({ ...l, name: trimmed, nameUpdatedAt: Date.now() }));
    },

    duplicateList: (id) => {
      const original = get().lists.find((l) => l.id === id);
      if (!original) return null;
      const now = Date.now();
      const dup: GroceryList = {
        ...original,
        id: makeId('l'),
        name: `${original.name} (copy)`,
        nameUpdatedAt: now,
        // Fresh ids; reset checked; drop tombstoned items and the share
        // identity (a copy is a new, unshared list).
        items: original.items
          .filter((it) => it.deletedAt == null)
          .map((it) => ({
            ...it,
            id: makeId('i'),
            checked: false,
            checkedAt: undefined,
            addedAt: now,
            updatedAt: now,
          })),
        shareIdentity: undefined,
        createdAt: now,
        updatedAt: now,
      };
      set((s) => ({ lists: [dup, ...s.lists] }));
      persist(dup);
      return dup.id;
    },

    deleteList: (id) => {
      set((s) => ({ lists: s.lists.filter((l) => l.id !== id) }));
      deleteListFromDb(id).catch((err) =>
        console.warn('grocery-list: failed to delete list', err)
      );
      putTombstone(id, Date.now()).catch((err) =>
        console.warn('grocery-list: failed to write tombstone', err)
      );
    },

    importLists: (incoming) => {
      if (incoming.length === 0) return 0;
      set((s) => ({ lists: [...incoming, ...s.lists] }));
      for (const l of incoming) persist(l);
      return incoming.length;
    },

    addItem: (listId, name, locale = 'en', category) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      const list = get().lists.find((l) => l.id === listId);
      if (!list) return;
      const existing = findActiveByName(list, trimmed);
      if (existing) {
        mutateItem(listId, existing.id, (it) => ({
          ...it,
          quantity: clampQty(it.quantity + 1),
          // Re-adding a checked item means you want it again this shop.
          checked: false,
          checkedAt: undefined,
        }));
        return;
      }
      mutate(listId, (l) => ({
        ...l,
        items: [...l.items, makeItem(trimmed, locale, category)],
      }));
    },

    setChecked: (listId, itemId, checked) => {
      mutateItem(listId, itemId, (it) => ({
        ...it,
        checked,
        checkedAt: checked ? Date.now() : undefined,
      }));
    },

    setQuantity: (listId, itemId, qty) => {
      mutateItem(listId, itemId, (it) => ({ ...it, quantity: clampQty(qty) }));
    },

    setNote: (listId, itemId, note) => {
      const n = note.trim();
      mutateItem(listId, itemId, (it) => ({
        ...it,
        note: n.length ? n : undefined,
      }));
    },

    setName: (listId, itemId, name) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      mutateItem(listId, itemId, (it) => ({ ...it, name: trimmed }));
    },

    recategorize: (listId, itemId, category) => {
      mutateItem(listId, itemId, (it) => ({ ...it, category }));
    },

    reorderAisles: (listId, order) => {
      mutate(listId, (l) => ({ ...l, categoryOrder: order }));
    },

    addCategory: (listId, name) => {
      const trimmed = name.trim().slice(0, 40);
      if (!trimmed) return null;
      const list = get().lists.find((l) => l.id === listId);
      if (!list) return null;
      // Dedup case-insensitively against existing aisles (built-in or custom).
      const existing = list.categoryOrder.find(
        (cat) => cat.toLowerCase() === trimmed.toLowerCase()
      );
      if (existing) return existing;
      const order = [...list.categoryOrder];
      // Slot a new custom aisle just above 'Other' (the catch-all), else append.
      const otherIdx = order.indexOf('Other');
      if (otherIdx >= 0) order.splice(otherIdx, 0, trimmed);
      else order.push(trimmed);
      mutate(listId, (l) => ({ ...l, categoryOrder: order }));
      return trimmed;
    },

    removeCategory: (listId, category) => {
      // Built-ins are permanent — only user-created aisles can be removed.
      if (isBuiltinCategory(category)) return;
      const at = Date.now();
      mutate(listId, (l) => ({
        ...l,
        categoryOrder: l.categoryOrder.filter((cat) => cat !== category),
        items: l.items.map((it) =>
          it.category === category
            ? { ...it, category: 'Other', updatedAt: at }
            : it
        ),
      }));
    },

    deleteItem: (listId, itemId) => {
      mutateItem(listId, itemId, (it) => ({ ...it, deletedAt: Date.now() }));
    },

    finishShop: (listId) => {
      const list = get().lists.find((l) => l.id === listId);
      if (!list) return [];
      const bought = list.items.filter(
        (it) => it.deletedAt == null && it.checked
      );
      if (bought.length === 0) return [];
      const snapshots = bought.map((it) => ({ ...it }));
      const boughtIds = new Set(bought.map((it) => it.id));
      const at = Date.now();
      mutate(listId, (l) => ({
        ...l,
        items: l.items.map((it) =>
          boughtIds.has(it.id)
            ? { ...it, deletedAt: at, updatedAt: at }
            : it
        ),
      }));
      return snapshots;
    },

    restoreItems: (listId, items) => {
      if (items.length === 0) return;
      const byId = new Map(items.map((it) => [it.id, it]));
      const at = Date.now();
      mutate(listId, (l) => ({
        ...l,
        items: l.items.map((it) =>
          byId.has(it.id)
            ? { ...byId.get(it.id)!, deletedAt: undefined, updatedAt: at }
            : it
        ),
      }));
    },

    shareList: (listId) => {
      const list = get().lists.find((l) => l.id === listId);
      if (!list) return null;
      if (list.shareIdentity) return list.shareIdentity.secret;
      const identity = makeShareIdentity();
      mutate(listId, (l) => ({ ...l, shareIdentity: identity }));
      return identity.secret;
    },

    joinShared: (secret) => {
      const existing = get().lists.find(
        (l) => l.shareIdentity?.secret === secret
      );
      if (existing) return existing.id;
      const base = makeList('Shared list');
      const list: GroceryList = {
        ...base,
        // "Shared list" is only a placeholder shown until the first sync
        // arrives. nameUpdatedAt:0 makes it lose the name merge to whatever
        // the list is actually called, so joining never renames the other
        // person's list — they keep the name they chose.
        nameUpdatedAt: 0,
        shareIdentity: { secret, createdAt: Date.now() },
      };
      set((s) => ({ lists: [list, ...s.lists] }));
      persist(list);
      return list.id;
    },

    mergeRemoteList: (remote) => {
      const secret = remote.shareIdentity?.secret;
      if (!secret) return;
      const local = get().lists.find(
        (l) => l.shareIdentity?.secret === secret
      );
      if (!local) return;
      const merged = mergeList(local, remote);
      set((s) => ({
        lists: s.lists.map((l) => (l.id === local.id ? merged : l)),
      }));
      persist(merged);
    },

    applySync: ({ upserts, deletes }) => {
      if (upserts.length === 0 && deletes.length === 0) return;
      const delSet = new Set(deletes);
      const upMap = new Map(upserts.map((l) => [l.id, l]));
      set((s) => {
        const next: GroceryList[] = [];
        for (const l of s.lists) {
          if (delSet.has(l.id)) continue;
          next.push(upMap.get(l.id) ?? l);
        }
        for (const l of upserts) {
          if (!s.lists.some((x) => x.id === l.id)) next.push(l);
        }
        next.sort((a, b) => b.updatedAt - a.updatedAt);
        return { lists: next };
      });
      for (const l of upserts) {
        persist(l);
        removeTombstone(l.id).catch(() => {});
      }
      for (const id of deletes) {
        deleteListFromDb(id).catch(() => {});
        putTombstone(id, Date.now()).catch(() => {});
      }
    },
  };
});
