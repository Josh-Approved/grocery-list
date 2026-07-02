/**
 * Canonical SQLite foundation — app-agnostic. Synced by `sync.mjs app-shell`;
 * do not fork.
 *
 * Owns the shared database connection + the three canonical cross-cutting
 * tables every data app needs:
 *   - app_settings  — account-level key/value prefs (theme, currency, …)
 *   - sync_meta     — cross-device sync bookkeeping (Layer 2)
 *   - tombstones    — per-record deletes so a delete propagates instead of
 *                     being resurrected on the next pull (canon § Backup #5)
 *
 * The database lives in expo-sqlite's default location (the app's Documents
 * directory), which is exactly canon § Backup & restore Layer 1: it rides
 * iCloud Backup / Android Auto Backup automatically, with zero UI.
 *
 * The app's domain module (e.g. store/db.ts) calls `getDb()` to get the same
 * connection and adds its own CREATE TABLE for its records. One connection,
 * one file, one backup unit.
 *
 * Set DB_NAME in dbConfig.ts (app-owned; bootstrap fills the slug).
 */

import * as SQLite from 'expo-sqlite';
import { DB_NAME } from './dbConfig';

let _db: SQLite.SQLiteDatabase | null = null;

export async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (_db) return _db;
  _db = await SQLite.openDatabaseAsync(DB_NAME);
  await _db.execAsync(`
    CREATE TABLE IF NOT EXISTS app_settings (
      k TEXT PRIMARY KEY NOT NULL,
      v TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_meta (
      k TEXT PRIMARY KEY NOT NULL,
      v TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tombstones (
      id        TEXT PRIMARY KEY NOT NULL,
      deletedAt INTEGER NOT NULL
    );
  `);
  return _db;
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

// ---------- sync_meta (Layer 2 bookkeeping) ----------

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
  await db.runAsync('INSERT OR REPLACE INTO sync_meta (k, v) VALUES (?, ?)', [k, v]);
}

// ---------- Tombstones (per-record delete propagation) ----------

export interface TombstoneRow {
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
