/**
 * Account-level store: item history (powers local autocomplete) + "usuals"
 * (staple items you re-buy every shop).
 *
 * Both are on-device only. History is never synced and never sourced from
 * anywhere external — it is only the words this user has typed before, ranked
 * by how often. App tenet: the list contains only what the user typed; the
 * suggestions are their own past entries, not a feed.
 */

import { create } from 'zustand';
import {
  loadHistory,
  recordHistory,
  deleteHistory,
  putHistory,
  getAppSetting,
  setAppSetting,
  type HistoryRow,
} from './db';

const STAPLES_KEY = 'staples';

// Re-exported so existing call sites can keep importing from the store; the
// implementation lives in a dependency-free module for unit-testing.
export { historyScore, rankedHistoryNames } from './historyRank';

interface AccountState {
  hydrated: boolean;
  history: HistoryRow[];
  /** Lowercased names the user marked as a recurring "usual". */
  staples: string[];

  hydrate: () => Promise<void>;

  /** Record that the user added `name` (bumps autocomplete ranking). */
  recordUse: (name: string) => void;

  /** Permanently forget a Recent suggestion. Returns the removed row so the
   *  caller can offer Undo; undefined if there was nothing to forget. */
  forgetUse: (name: string) => HistoryRow | undefined;
  /** Re-insert a forgotten row verbatim (Undo). */
  restoreUse: (row: HistoryRow) => void;

  isStaple: (name: string) => boolean;
  addStaple: (name: string) => void;
  removeStaple: (name: string) => void;
}

function persistStaples(staples: string[]): void {
  setAppSetting(STAPLES_KEY, JSON.stringify(staples)).catch((err) =>
    console.warn('grocery-list: failed to persist staples', err)
  );
}

export const useAccountStore = create<AccountState>()((set, get) => ({
  hydrated: false,
  history: [],
  staples: [],

  hydrate: async () => {
    try {
      const [history, staplesRaw] = await Promise.all([
        loadHistory(),
        getAppSetting(STAPLES_KEY),
      ]);
      let staples: string[] = [];
      if (staplesRaw) {
        try {
          const parsed = JSON.parse(staplesRaw);
          if (Array.isArray(parsed)) staples = parsed.filter((x) => typeof x === 'string');
        } catch {
          /* corrupt setting → empty */
        }
      }
      set({ history, staples, hydrated: true });
    } catch (err) {
      console.warn('grocery-list: failed to load account data', err);
      set({ hydrated: true });
    }
  },

  recordUse: (name) => {
    const n = name.trim();
    if (!n) return;
    set((s) => {
      const lower = n.toLowerCase();
      const existing = s.history.find((h) => h.name.toLowerCase() === lower);
      const next: HistoryRow[] = existing
        ? s.history.map((h) =>
            h === existing
              ? { ...h, count: h.count + 1, lastUsed: Date.now() }
              : h
          )
        : [...s.history, { name: n, count: 1, lastUsed: Date.now() }];
      next.sort((a, b) => b.count - a.count || b.lastUsed - a.lastUsed);
      return { history: next };
    });
    recordHistory(n).catch((err) =>
      console.warn('grocery-list: failed to record history', err)
    );
  },

  forgetUse: (name) => {
    const lower = name.trim().toLowerCase();
    const removed = get().history.find(
      (h) => h.name.toLowerCase() === lower
    );
    if (!removed) return undefined;
    set((s) => ({
      history: s.history.filter((h) => h.name.toLowerCase() !== lower),
    }));
    deleteHistory(removed.name).catch((err) =>
      console.warn('grocery-list: failed to forget history', err)
    );
    return removed;
  },

  restoreUse: (row) => {
    set((s) => {
      const lower = row.name.toLowerCase();
      if (s.history.some((h) => h.name.toLowerCase() === lower)) return s;
      const next = [...s.history, row];
      next.sort((a, b) => b.count - a.count || b.lastUsed - a.lastUsed);
      return { history: next };
    });
    putHistory(row).catch((err) =>
      console.warn('grocery-list: failed to restore history', err)
    );
  },

  isStaple: (name) =>
    get().staples.includes(name.trim().toLowerCase()),

  addStaple: (name) => {
    const lower = name.trim().toLowerCase();
    if (!lower || get().staples.includes(lower)) return;
    const staples = [...get().staples, lower];
    set({ staples });
    persistStaples(staples);
  },

  removeStaple: (name) => {
    const lower = name.trim().toLowerCase();
    const staples = get().staples.filter((s) => s !== lower);
    set({ staples });
    persistStaples(staples);
  },
}));
