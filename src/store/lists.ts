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
  healFutureStamps,
  makeItem,
  makeList,
  pruneTombstones,
  visibleItems,
} from '../data/list';
import { isBuiltinCategory, type Category } from '../data/categories';
import { makeId } from '../lib/id';
import { makeShareIdentity } from '../sync/share';
import { mergeList } from '../sync/merge';
import {
  now as clockNow,
  initClock,
  observe as observeClock,
  peek as clockPeek,
  MAX_SKEW_MS,
} from '../sync/clock';
import {
  loadAllLists,
  saveList,
  deleteListFromDb,
  putTombstone,
  removeTombstone,
  getSyncMeta,
  setSyncMeta,
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
  /** Add a kit's items to a list in one shot. Skips any name already WANTED
   *  on the list; a crossed-off match is revived (unchecked, qty 1 — the kit
   *  says you need it again). Items arrive with their remembered quantity +
   *  pre-assigned aisle, so they land sorted instantly. Returns the new items
   *  (`added`) and pre-change snapshots of revived ones (`revived`) so the
   *  caller's Undo can remove the former and restore the latter. */
  addKitItems: (
    listId: string,
    items: { name: string; quantity: number; category: Category }[]
  ) => { added: GroceryItem[]; revived: GroceryItem[] };
  /** Soft-delete a batch of items in a single mutate — the Undo for a kit add. */
  removeItems: (listId: string, itemIds: string[]) => void;
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

  /** Tombstone every checked item (what you've crossed off); returns their
   *  pre-change snapshots so the caller can offer Undo. This is the "tidy away
   *  what you bought" primitive — invoked from ambient Clear affordances, not a
   *  moment-in-time "finish shop" gate (that ceremony was removed 2026-07-15). */
  clearChecked: (listId: string) => GroceryItem[];
  /** Undo primitive: write the given item snapshots back verbatim (clears a
   *  tombstone, restores checked state). Used by delete + clear-checked undo. */
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

  /** Durably write all current state, AWAITED. Per-list saves are otherwise
   *  fire-and-forget, so a check made right before the app is backgrounded can
   *  be lost if iOS suspends/kills the app before the write lands. The App-level
   *  AppState handler awaits this on background. */
  flushPending: () => Promise<void>;
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
        updated = { ...fn(l), updatedAt: clockNow() };
        return updated;
      }),
    }));
    if (updated) persist(updated);
  }

  /** Map one item within a list, stamping item + list updatedAt.
   *  `stampContent:false` leaves the item's content clock alone — a check /
   *  uncheck stamps only its own clock (`checkedUpdatedAt`), because bumping
   *  `updatedAt` would let a check-off clobber a partner's concurrent
   *  rename/quantity edit in the content merge. */
  function mutateItem(
    listId: string,
    itemId: string,
    fn: (it: GroceryItem) => GroceryItem,
    stampContent = true
  ): void {
    mutate(listId, (l) => ({
      ...l,
      items: l.items.map((it) =>
        it.id === itemId
          ? stampContent
            ? { ...fn(it), updatedAt: clockNow() }
            : fn(it)
          : it
      ),
    }));
  }

  return {
    lists: [],
    hydrated: false,

    hydrate: async () => {
      const persistClock = (v: number) => {
        setSyncMeta('clock', String(v)).catch(() => {});
      };
      try {
        const [persistedClock, loaded] = await Promise.all([
          getSyncMeta('clock'),
          loadAllLists(),
        ]);
        // Hygiene before anything reads the data: clamp far-future stamps
        // (poison left by the pre-logical-clock skew era — they'd keep beating
        // fresh edits until real time caught up) and prune old tombstones (an
        // unpruned list grows until public relays reject its published state).
        const phys = Date.now();
        const healed = loaded.map((l) =>
          pruneTombstones(healFutureStamps(l, phys + MAX_SKEW_MS), phys)
        );
        const hygieneChanged = healed.filter((l, i) => l !== loaded[i]);

        // Initialise the skew-resistant clock above both the persisted
        // high-water mark and anything already on disk, so a post-update /
        // post-restore install never stamps an edit below its own stored data
        // (which would let stale local state lose to — or beat — a peer wrongly).
        let maxTs = persistedClock ? Number(persistedClock) || 0 : 0;
        for (const l of healed) {
          maxTs = Math.max(maxTs, l.updatedAt, l.nameUpdatedAt);
          for (const it of l.items) {
            maxTs = Math.max(
              maxTs,
              it.updatedAt,
              it.checkedUpdatedAt ?? 0,
              it.deletedAt ?? 0
            );
          }
        }
        initClock(maxTs, persistClock);

        // QA capture boots cleared (clearState:true); seed deterministic data so
        // every screen is screenshot-ready without typing live. Compile-time
        // false in production (EXPO_PUBLIC_QA_MODE unset) → tree-shaken out.
        if (QA_MODE && healed.length === 0) {
          set({ lists: qaLists(), hydrated: true });
          return;
        }
        const { lists, changed } = repairIds(healed);
        set({ lists, hydrated: true });
        const dirty = new Set([...hygieneChanged, ...changed].map((l) => l.id));
        for (const l of lists) if (dirty.has(l.id)) persist(l);
      } catch (err) {
        console.warn('grocery-list: failed to load lists from disk', err);
        initClock(Date.now(), persistClock);
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
      mutate(id, (l) => ({ ...l, name: trimmed, nameUpdatedAt: clockNow() }));
    },

    duplicateList: (id) => {
      const original = get().lists.find((l) => l.id === id);
      if (!original) return null;
      const now = clockNow();
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
            checkedUpdatedAt: now,
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
      putTombstone(id, clockNow()).catch((err) =>
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
        if (existing.checked) {
          // Re-adding a crossed-off item means you want it again NEXT shop —
          // a fresh single need, not "one more than last time". Quantity
          // resets to 1 (bumping it was the reported "shows two" defect).
          mutateItem(listId, existing.id, (it) => ({
            ...it,
            quantity: 1,
            checked: false,
            checkedAt: undefined,
            checkedUpdatedAt: clockNow(),
          }));
        } else {
          // Already on the list and still wanted: you're asking for another.
          mutateItem(listId, existing.id, (it) => ({
            ...it,
            quantity: clampQty(it.quantity + 1),
          }));
        }
        return;
      }
      mutate(listId, (l) => ({
        ...l,
        items: [...l.items, makeItem(trimmed, locale, category)],
      }));
    },

    addKitItems: (listId, kitItems) => {
      const list = get().lists.find((l) => l.id === listId);
      if (!list) return { added: [], revived: [] };
      // Skip anything already wanted on the list (by name), and de-dupe within
      // the kit itself, so one tap can't double up a row. A CHECKED match is
      // revived instead of skipped — the kit says you need it again. Revived
      // items are not in the returned array (the caller's Undo tombstones
      // those ids, which must never delete a pre-existing item).
      const wanted = new Set<string>();
      const checkedByName = new Map<string, GroceryItem>();
      for (const it of visibleItems(list)) {
        const lower = it.name.toLowerCase();
        if (it.checked) checkedByName.set(lower, it);
        else wanted.add(lower);
      }
      const added: GroceryItem[] = [];
      const reviveIds = new Set<string>();
      for (const ki of kitItems) {
        const name = ki.name.trim();
        if (!name) continue;
        const lower = name.toLowerCase();
        if (wanted.has(lower)) continue;
        wanted.add(lower);
        const crossed = checkedByName.get(lower);
        if (crossed) {
          reviveIds.add(crossed.id);
          continue;
        }
        const item = makeItem(name, 'en', ki.category);
        item.quantity = clampQty(ki.quantity);
        added.push(item);
      }
      if (added.length === 0 && reviveIds.size === 0)
        return { added: [], revived: [] };
      const revived = visibleItems(list)
        .filter((it) => reviveIds.has(it.id))
        .map((it) => ({ ...it })); // pre-change snapshots for the caller's Undo
      const at = clockNow();
      mutate(listId, (l) => ({
        ...l,
        items: [
          ...l.items.map((it) =>
            reviveIds.has(it.id)
              ? {
                  ...it,
                  quantity: 1,
                  checked: false,
                  checkedAt: undefined,
                  checkedUpdatedAt: at,
                  // The quantity reset is a CONTENT change — without this
                  // stamp the revive ties with the partner's stale copy and
                  // can lose the merge (reverting to the old quantity).
                  updatedAt: at,
                }
              : it
          ),
          ...added,
        ],
      }));
      return { added, revived };
    },

    removeItems: (listId, itemIds) => {
      if (itemIds.length === 0) return;
      const idSet = new Set(itemIds);
      const at = clockNow();
      // Prune wherever tombstones are minted — a long-resident app that only
      // ever swipe-deletes must still keep its payload bounded.
      mutate(listId, (l) =>
        pruneTombstones(
          {
            ...l,
            items: l.items.map((it) =>
              idSet.has(it.id) ? { ...it, deletedAt: at, updatedAt: at } : it
            ),
          },
          Date.now()
        )
      );
    },

    setChecked: (listId, itemId, checked) => {
      const at = clockNow();
      mutateItem(
        listId,
        itemId,
        (it) => ({
          ...it,
          checked,
          checkedAt: checked ? at : undefined,
          checkedUpdatedAt: at,
        }),
        false // check state rides its own clock, not the content clock
      );
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
      const at = clockNow();
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
      const at = clockNow();
      // Same prune-at-mint rule as removeItems.
      mutate(listId, (l) =>
        pruneTombstones(
          {
            ...l,
            items: l.items.map((it) =>
              it.id === itemId ? { ...it, deletedAt: at, updatedAt: at } : it
            ),
          },
          Date.now()
        )
      );
    },

    clearChecked: (listId) => {
      const list = get().lists.find((l) => l.id === listId);
      if (!list) return [];
      const bought = list.items.filter(
        (it) => it.deletedAt == null && it.checked
      );
      if (bought.length === 0) return [];
      const snapshots = bought.map((it) => ({ ...it }));
      const boughtIds = new Set(bought.map((it) => it.id));
      const at = clockNow();
      // Prune in the same motion — clearing checked is where tombstones are
      // minted, so it's also where the dead weight is kept bounded between launches.
      mutate(listId, (l) =>
        pruneTombstones(
          {
            ...l,
            items: l.items.map((it) =>
              boughtIds.has(it.id)
                ? { ...it, deletedAt: at, updatedAt: at }
                : it
            ),
          },
          Date.now()
        )
      );
      return snapshots;
    },

    restoreItems: (listId, items) => {
      if (items.length === 0) return;
      const byId = new Map(items.map((it) => [it.id, it]));
      const at = clockNow();
      // An undo deliberately reinstates the snapshot's checked state too, so
      // both clocks stamp — the restore must win the merge on every device.
      mutate(listId, (l) => ({
        ...l,
        items: l.items.map((it) =>
          byId.has(it.id)
            ? {
                ...byId.get(it.id)!,
                deletedAt: undefined,
                updatedAt: at,
                checkedUpdatedAt: at,
              }
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
        shareIdentity: { secret, createdAt: clockNow() },
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
      // Heal the INCOMING copy too (hydrate only heals what's on disk): a
      // peer still running the pre-clock build republishes far-future
      // poisoned stamps on every sync, which would otherwise out-clock every
      // fresh local edit and undo the hydrate heal seconds after each launch.
      // The receive boundary is side-effect territory, so the merge itself
      // stays a pure function.
      const healed = healFutureStamps(remote, Date.now() + MAX_SKEW_MS);
      // Advance our clock past every timestamp in the incoming copy, so our
      // NEXT local edit out-clocks whatever the peer last did — this is what
      // turns "fastest wall clock wins" into "last action in causal order wins".
      // The check clock is scanned explicitly: it does NOT ride updatedAt, and
      // relying on the list-level stamp to transitively cover it would be an
      // unwritten invariant.
      let remoteMax = Math.max(healed.updatedAt, healed.nameUpdatedAt);
      for (const it of healed.items) {
        remoteMax = Math.max(
          remoteMax,
          it.updatedAt,
          it.checkedUpdatedAt ?? 0,
          it.checkedAt ?? 0,
          it.deletedAt ?? 0
        );
      }
      observeClock(remoteMax);
      const merged = mergeList(local, healed);
      // A converged echo (peer answering hello, reconnect force-publish) must
      // not cost a store update + full-list SQLite write + re-render.
      if (JSON.stringify(merged) === JSON.stringify(local)) return;
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
        putTombstone(id, clockNow()).catch(() => {});
      }
    },

    flushPending: async () => {
      const lists = get().lists;
      await Promise.all(lists.map((l) => saveList(l).catch(() => {})));
      try {
        await setSyncMeta('clock', String(clockPeek()));
      } catch {
        /* best-effort */
      }
    },
  };
});
