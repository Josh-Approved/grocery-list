/**
 * SQLite persistence for grocery lists.
 *
 * One row per list with JSON-encoded `items` / `categoryOrder` / optional
 * `shareIdentity`. This blob shape is deliberately the same one the shared-
 * sync module (build step 4) replicates, so local and synced storage stay
 * identical and no relational migration is needed when sync lands.
 *
 * Persisting to the app's SQLite DB in the default Documents location also
 * gives us canon § Backup & restore Layer 1 (rides iCloud / Android auto-
 * backup) for free, with zero UI.
 *
 * All functions are async. Writes are fire-and-forget (UI is the source of
 * truth); the single hydrate() is awaited at app start.
 */

import * as SQLite from 'expo-sqlite';
import type { Category } from '../data/categories';
import type { GroceryItem, GroceryList, ShareIdentity } from '../data/list';
import type { Kit, KitItem } from '../data/kit';

const DB_NAME = 'grocery-list.db';

let _db: SQLite.SQLiteDatabase | null = null;

async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (_db) return _db;
  _db = await SQLite.openDatabaseAsync(DB_NAME);
  await _db.execAsync(`
    CREATE TABLE IF NOT EXISTS lists (
      id            TEXT PRIMARY KEY NOT NULL,
      name          TEXT NOT NULL,
      nameUpdatedAt INTEGER,
      items         TEXT NOT NULL,
      categoryOrder TEXT NOT NULL,
      shareIdentity TEXT,
      createdAt     INTEGER NOT NULL,
      updatedAt     INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tombstones (
      id        TEXT PRIMARY KEY NOT NULL,
      deletedAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_meta (
      k TEXT PRIMARY KEY NOT NULL,
      v TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_settings (
      k TEXT PRIMARY KEY NOT NULL,
      v TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS item_history (
      name     TEXT PRIMARY KEY NOT NULL,
      count    INTEGER NOT NULL,
      lastUsed INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kits (
      id            TEXT PRIMARY KEY NOT NULL,
      name          TEXT NOT NULL,
      nameUpdatedAt INTEGER,
      items         TEXT NOT NULL,
      createdAt     INTEGER NOT NULL,
      updatedAt     INTEGER NOT NULL,
      deletedAt     INTEGER
    );
  `);
  // Migration: `nameUpdatedAt` (the name's own merge clock) was added after
  // first release. Old installs have the column missing; add it. Existing
  // rows stay NULL → rowToList falls back to createdAt.
  const cols = await _db.getAllAsync<{ name: string }>(
    'PRAGMA table_info(lists)'
  );
  if (!cols.some((c) => c.name === 'nameUpdatedAt')) {
    await _db.execAsync('ALTER TABLE lists ADD COLUMN nameUpdatedAt INTEGER');
  }
  return _db;
}

// ---------- Item history (local autocomplete; never synced, never external) --

export interface HistoryRow {
  name: string;
  count: number;
  lastUsed: number;
}

export async function loadHistory(): Promise<HistoryRow[]> {
  const db = await getDb();
  return db.getAllAsync<HistoryRow>(
    'SELECT name, count, lastUsed FROM item_history ORDER BY count DESC, lastUsed DESC'
  );
}

export async function recordHistory(name: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO item_history (name, count, lastUsed) VALUES (?, 1, ?)
     ON CONFLICT(name) DO UPDATE SET count = count + 1, lastUsed = excluded.lastUsed`,
    [name, Date.now()]
  );
}

/** Permanently forget a single autocomplete entry (case-insensitive) — the
 *  swipe-to-delete on a Recent row. Re-typing the word re-adds it from scratch. */
export async function deleteHistory(name: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    'DELETE FROM item_history WHERE name = ? COLLATE NOCASE',
    [name]
  );
}

/** Re-insert a forgotten row verbatim (Undo) — restores its exact count and
 *  lastUsed so its ranking is unchanged, not reset to a fresh single use. */
export async function putHistory(row: HistoryRow): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT OR REPLACE INTO item_history (name, count, lastUsed) VALUES (?, ?, ?)`,
    [row.name, row.count, row.lastUsed]
  );
}

interface ListRow {
  id: string;
  name: string;
  nameUpdatedAt: number | null;
  items: string;
  categoryOrder: string;
  shareIdentity: string | null;
  createdAt: number;
  updatedAt: number;
}

/** The placeholder name `joinShared` minted before the name carried its own
 *  clock. A legacy row matching it is an un-renamed joined list, so its name
 *  must lose the merge (clock 0) — otherwise its later createdAt would let the
 *  placeholder overwrite the creator's real name, the very bug this fixes. */
const LEGACY_JOIN_PLACEHOLDER = 'Shared list';

function rowToList(row: ListRow): GroceryList {
  // Pre-migration rows have no name clock. A real list's name was set at
  // creation (→ createdAt); an un-renamed joined placeholder never had a
  // user-chosen name (→ 0, so any real name beats it).
  const nameUpdatedAt =
    row.nameUpdatedAt ??
    (row.shareIdentity != null && row.name === LEGACY_JOIN_PLACEHOLDER
      ? 0
      : row.createdAt);
  return {
    id: row.id,
    name: row.name,
    nameUpdatedAt,
    items: JSON.parse(row.items) as GroceryItem[],
    categoryOrder: JSON.parse(row.categoryOrder) as Category[],
    shareIdentity: row.shareIdentity
      ? (JSON.parse(row.shareIdentity) as ShareIdentity)
      : undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function loadAllLists(): Promise<GroceryList[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<ListRow>(
    'SELECT * FROM lists ORDER BY updatedAt DESC'
  );
  return rows.map(rowToList);
}

export async function saveList(list: GroceryList): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT OR REPLACE INTO lists
       (id, name, nameUpdatedAt, items, categoryOrder, shareIdentity, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      list.id,
      list.name,
      list.nameUpdatedAt,
      JSON.stringify(list.items),
      JSON.stringify(list.categoryOrder),
      list.shareIdentity ? JSON.stringify(list.shareIdentity) : null,
      list.createdAt,
      list.updatedAt,
    ]
  );
}

export async function deleteListFromDb(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM lists WHERE id = ?', [id]);
}

// ---------- Kits (reusable item bundles) ----------
// Same blob-per-row shape as lists. Soft-deleted kits stay in the table with
// `deletedAt` set so a delete converges across devices (the kit collection is a
// record set, like list items); loadAllKits returns them and the store filters
// for the UI but keeps them for merge.

interface KitRow {
  id: string;
  name: string;
  nameUpdatedAt: number | null;
  items: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

function rowToKit(row: KitRow): Kit {
  return {
    id: row.id,
    name: row.name,
    nameUpdatedAt: row.nameUpdatedAt ?? row.createdAt,
    items: JSON.parse(row.items) as KitItem[],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt ?? undefined,
  };
}

export async function loadAllKits(): Promise<Kit[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<KitRow>(
    'SELECT * FROM kits ORDER BY updatedAt DESC'
  );
  return rows.map(rowToKit);
}

export async function saveKit(kit: Kit): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT OR REPLACE INTO kits
       (id, name, nameUpdatedAt, items, createdAt, updatedAt, deletedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      kit.id,
      kit.name,
      kit.nameUpdatedAt,
      JSON.stringify(kit.items),
      kit.createdAt,
      kit.updatedAt,
      kit.deletedAt ?? null,
    ]
  );
}

// ---------- Cross-device sync support (consumed at build step 4) ----------
// Tombstones let a list delete propagate: without "list X deleted at T" a
// pull would re-adopt X from a paired device.

interface TombstoneRow {
  id: string;
  deletedAt: number;
}

export async function loadTombstones(): Promise<TombstoneRow[]> {
  const db = await getDb();
  return db.getAllAsync<TombstoneRow>('SELECT id, deletedAt FROM tombstones');
}

export async function putTombstone(id: string, deletedAt: number): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    'INSERT OR REPLACE INTO tombstones (id, deletedAt) VALUES (?, ?)',
    [id, deletedAt]
  );
}

export async function removeTombstone(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM tombstones WHERE id = ?', [id]);
}

export async function getSyncMeta(k: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ v: string }>(
    'SELECT v FROM sync_meta WHERE k = ?',
    [k]
  );
  return row?.v ?? null;
}

export async function setSyncMeta(k: string, v: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    'INSERT OR REPLACE INTO sync_meta (k, v) VALUES (?, ?)',
    [k, v]
  );
}

// ---------- App settings (account-level prefs) ----------

export async function getAppSetting(k: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ v: string }>(
    'SELECT v FROM app_settings WHERE k = ?',
    [k]
  );
  return row?.v ?? null;
}

export async function setAppSetting(k: string, v: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    'INSERT OR REPLACE INTO app_settings (k, v) VALUES (?, ?)',
    [k, v]
  );
}
