// KNOWN-BAD FIXTURE — do not "fix" this. See ../../../../README.md.
//
// Trips: rn/single-db-connection.
//
// The app shell's `src/storage/kv.ts` owns the ONE connection to the app
// database and memoizes the open promise. This domain module opens its own
// second handle to the same file. On the first launch after an install the
// SQLite directory does not exist yet, so both opens race expo-sqlite's
// `ensureDatabasePathExistsAsync` and the loser rejects — hydration then fails
// open and the user sees an empty app with none of their data. It is silent,
// install-only, and roughly 2 in 15 cold launches, which is why it reached a
// live packing-list and no existing tier saw it (defect packing-list-20260801-3).
//
// The fix is always the same: take the handle from the shell's getDb().

import * as SQLite from 'expo-sqlite';

let db: SQLite.SQLiteDatabase | null = null;

export async function getDomainDb(): Promise<SQLite.SQLiteDatabase> {
  if (!db) db = await SQLite.openDatabaseAsync('fixture-app.db');
  return db;
}

export async function loadTrips(): Promise<unknown[]> {
  const handle = await getDomainDb();
  return handle.getAllAsync('SELECT * FROM trips');
}
