/**
 * Kits store — Zustand state with disk-backed persistence.
 *
 * Mirrors the lists store: React state updates synchronously; the SQLite save
 * runs fire-and-forget. Deletes are soft (kit.deletedAt / item.deletedAt) so the
 * kit collection converges across devices instead of resurrecting a delete.
 *
 * Kits sync over the shared-list channels (see sync/index.ts): `mergeRemoteKits`
 * is the entry point the sync engine calls when a peer broadcasts its kits.
 */

import { create } from 'zustand';
import {
  type Kit,
  type KitItem,
  clampKitItem,
  findActiveKitItemByName,
  makeKit,
  makeKitItem,
} from '../data/kit';
import type { Category } from '../data/categories';
import { makeId } from '../lib/id';
import { mergeKits } from '../sync/mergeKits';
import {
  now as clockNow,
  observe as observeClock,
} from '../sync/clock';
import { loadAllKits, saveKit } from './db';
import { QA_MODE } from '../qa/qaMode';
import { qaKits } from '../qa/fixtures';

interface KitsState {
  kits: Kit[];
  hydrated: boolean;

  hydrate: () => Promise<void>;

  createKit: (name?: string) => string;
  getKit: (id: string) => Kit | undefined;
  renameKit: (id: string, name: string) => void;
  duplicateKit: (id: string) => string | null;
  /** Soft-delete (tombstone) a kit so the delete converges across devices. */
  deleteKit: (id: string) => void;

  /** Add an ingredient to a kit. If an active item with the same name exists,
   *  bump its quantity instead of stacking a duplicate row (mirrors lists). */
  addKitItem: (
    kitId: string,
    name: string,
    locale?: string,
    category?: Category,
    quantity?: number
  ) => void;
  setKitItemQuantity: (kitId: string, itemId: string, qty: number) => void;
  setKitItemName: (kitId: string, itemId: string, name: string) => void;
  recategorizeKitItem: (
    kitId: string,
    itemId: string,
    category: Category
  ) => void;
  /** Soft-delete (tombstone) an ingredient. */
  deleteKitItem: (kitId: string, itemId: string) => void;
  /** Undo primitive: write the given item snapshots back verbatim (clears a
   *  tombstone). Used by ingredient-delete undo. */
  restoreKitItems: (kitId: string, items: KitItem[]) => void;

  /** Merge an incoming remote kit collection (a peer's broadcast). Conflict-
   *  free per mergeKits. */
  mergeRemoteKits: (remote: Kit[]) => void;

  /** Durably write all current kits, AWAITED (background-flush, like lists). */
  flushPending: () => Promise<void>;
}

function persist(kit: Kit): void {
  saveKit(kit).catch((err) =>
    console.warn('grocery-list: failed to persist kit', err)
  );
}

export const useKitsStore = create<KitsState>()((set, get) => {
  /** Map one kit by id through `fn`, bump its updatedAt, persist. */
  function mutate(id: string, fn: (k: Kit) => Kit): void {
    let updated: Kit | undefined;
    set((s) => ({
      kits: s.kits.map((k) => {
        if (k.id !== id) return k;
        updated = { ...fn(k), updatedAt: clockNow() };
        return updated;
      }),
    }));
    if (updated) persist(updated);
  }

  /** Map one item within a kit, stamping item + kit updatedAt. */
  function mutateItem(
    kitId: string,
    itemId: string,
    fn: (it: KitItem) => KitItem
  ): void {
    mutate(kitId, (k) => ({
      ...k,
      items: k.items.map((it) =>
        it.id === itemId ? { ...fn(it), updatedAt: clockNow() } : it
      ),
    }));
  }

  return {
    kits: [],
    hydrated: false,

    hydrate: async () => {
      try {
        const loaded = await loadAllKits();
        if (QA_MODE && loaded.length === 0) {
          set({ kits: qaKits(), hydrated: true });
          return;
        }
        set({ kits: loaded, hydrated: true });
      } catch (err) {
        console.warn('grocery-list: failed to load kits from disk', err);
        set({ hydrated: true });
      }
    },

    createKit: (name) => {
      const kit = makeKit(name);
      set((s) => ({ kits: [kit, ...s.kits] }));
      persist(kit);
      return kit.id;
    },

    getKit: (id) => get().kits.find((k) => k.id === id),

    renameKit: (id, name) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      mutate(id, (k) => ({ ...k, name: trimmed, nameUpdatedAt: clockNow() }));
    },

    duplicateKit: (id) => {
      const original = get().kits.find((k) => k.id === id);
      if (!original) return null;
      const now = clockNow();
      const dup: Kit = {
        ...original,
        id: makeId('k'),
        name: `${original.name} (copy)`,
        nameUpdatedAt: now,
        items: original.items
          .filter((it) => it.deletedAt == null)
          .map((it) => ({ ...it, id: makeId('ki'), updatedAt: now })),
        createdAt: now,
        updatedAt: now,
        deletedAt: undefined,
      };
      set((s) => ({ kits: [dup, ...s.kits] }));
      persist(dup);
      return dup.id;
    },

    deleteKit: (id) => {
      mutate(id, (k) => ({ ...k, deletedAt: clockNow() }));
    },

    addKitItem: (kitId, name, locale = 'en', category, quantity) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      const kit = get().kits.find((k) => k.id === kitId);
      if (!kit) return;
      const existing = findActiveKitItemByName(kit, trimmed);
      if (existing) {
        mutateItem(kitId, existing.id, (it) => ({
          ...it,
          quantity: clampKitItem(it.quantity + 1),
        }));
        return;
      }
      mutate(kitId, (k) => ({
        ...k,
        items: [...k.items, makeKitItem(trimmed, locale, category, quantity)],
      }));
    },

    setKitItemQuantity: (kitId, itemId, qty) => {
      mutateItem(kitId, itemId, (it) => ({
        ...it,
        quantity: clampKitItem(qty),
      }));
    },

    setKitItemName: (kitId, itemId, name) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      mutateItem(kitId, itemId, (it) => ({ ...it, name: trimmed }));
    },

    recategorizeKitItem: (kitId, itemId, category) => {
      mutateItem(kitId, itemId, (it) => ({ ...it, category }));
    },

    deleteKitItem: (kitId, itemId) => {
      mutateItem(kitId, itemId, (it) => ({ ...it, deletedAt: clockNow() }));
    },

    restoreKitItems: (kitId, items) => {
      if (items.length === 0) return;
      const byId = new Map(items.map((it) => [it.id, it]));
      const at = clockNow();
      mutate(kitId, (k) => ({
        ...k,
        items: k.items.map((it) =>
          byId.has(it.id)
            ? { ...byId.get(it.id)!, deletedAt: undefined, updatedAt: at }
            : it
        ),
      }));
    },

    mergeRemoteKits: (remote) => {
      if (remote.length === 0) return;
      // Advance our clock past every timestamp in the incoming copy, so our next
      // local edit out-clocks the peer's — last-action-in-causal-order wins.
      let remoteMax = 0;
      for (const k of remote) {
        remoteMax = Math.max(remoteMax, k.updatedAt, k.nameUpdatedAt, k.deletedAt ?? 0);
        for (const it of k.items) {
          remoteMax = Math.max(remoteMax, it.updatedAt, it.deletedAt ?? 0);
        }
      }
      observeClock(remoteMax);
      const merged = mergeKits(get().kits, remote);
      set({ kits: merged });
      for (const k of merged) persist(k);
    },

    flushPending: async () => {
      const kits = get().kits;
      await Promise.all(kits.map((k) => saveKit(k).catch(() => {})));
    },
  };
});
