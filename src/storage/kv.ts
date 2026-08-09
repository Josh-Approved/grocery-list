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
import { logEvent, logError } from '../feedback/log';

// Memoize the open PROMISE, not the resolved handle. If two callers race
// getDb() before the first open settles, caching the handle lets both run
// openDatabaseAsync + the schema exec concurrently — a class of bug that has
// cost real upgrade-path hydration failures in app-owned db.ts (racing PRAGMA
// / ADD COLUMN, racing first opens pointing the path at a half-written file).
// Caching the in-flight promise makes every caller await the one open.
let _dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

export function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (_dbPromise) return _dbPromise;
  const openedAt = Date.now();
  _dbPromise = (async () => {
    const db = await SQLite.openDatabaseAsync(DB_NAME);
    await db.execAsync(`
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
    // A slow or failed open is the single most common cause of "the app opened
    // to an empty list" — the one report that is unanswerable without a trail.
    logEvent('db', 'opened', { ms: Date.now() - openedAt });
    return db;
  })().catch((err) => {
    // Don't cache a rejected open — let the next caller retry a fresh open.
    _dbPromise = null;
    logError('db', err, { during: 'open', ms: Date.now() - openedAt });
    throw err;
  });
  return _dbPromise;
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
