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

const DB_NAME = 'grocery-list.db';

let _db: SQLite.SQLiteDatabase | null = null;

async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (_db) return _db;
  _db = await SQLite.openDatabaseAsync(DB_NAME);
  await _db.execAsync(`
    CREATE TABLE IF NOT EXISTS lists (
      id            TEXT PRIMARY KEY NOT NULL,
      name          TEXT NOT NULL,
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
  `);
  return _db;
}

interface ListRow {
  id: string;
  name: string;
  items: string;
  categoryOrder: string;
  shareIdentity: string | null;
  createdAt: number;
  updatedAt: number;
}

function rowToList(row: ListRow): GroceryList {
  return {
    id: row.id,
    name: row.name,
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
       (id, name, items, categoryOrder, shareIdentity, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      list.id,
      list.name,
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
