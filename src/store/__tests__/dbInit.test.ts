/**
 * Database open concurrency (trust core).
 *
 * Regression cover for the fleet-wide "second connection" defect (ticket
 * fleet-domain-db-second-connection, packing-list fixed the identical shape
 * 2026-08-01): store/db.ts used to call SQLite.openDatabaseAsync itself
 * instead of routing through the shell's storage/kv.ts getDb(), so the app
 * held two connections to one file. On the first launch after an install the
 * SQLite directory does not exist yet, so both connections raced expo-
 * sqlite's ensureDatabasePathExists and the loser rejected with "Couldn't
 * create directory … Path already points to a non-normal file" — hydration
 * caught that and failed open to an empty list. Reproduced at ~2 in 15 cold
 * launches on packing-list; the same two-call-site shape existed here.
 *
 * The fake database below reproduces SQLite's real behavior closely enough to
 * prove the app opens exactly one connection, and that the domain module's
 * legacy-table migration (ALTER TABLE lists ADD COLUMN nameUpdatedAt) still
 * runs correctly through the shared connection.
 */

const LEGACY_COLUMNS = [
  'id',
  'name',
  'items',
  'categoryOrder',
  'shareIdentity',
  'createdAt',
  'updatedAt',
];

let columns: string[] = [];
let openCount = 0;

/** Yields to the microtask/timer queue so concurrent callers interleave. */
const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * Every step of the fake database is a real `setTimeout(0)` (that interleaving
 * IS the race under test), so these tests are timer-scheduling bound rather
 * than work bound — see grocery-list/packing-list's dbInit.test.ts learning
 * L23: a starved timer queue on a loaded machine can blow through Jest's 5s
 * default and read as a broken trust-core test rather than a slow one.
 */
const TIMER_BOUND_TIMEOUT_MS = 30_000;

const mockDb = {
  async execAsync(sql: string) {
    await tick();
    const add = /ALTER TABLE lists ADD COLUMN (\w+)/.exec(sql);
    if (add) {
      const col = add[1];
      // Exactly what SQLite does — this is the failure the app hit.
      if (columns.includes(col)) {
        throw new Error(`SQLiteErrorException: duplicate column name: ${col}`);
      }
      columns.push(col);
    }
    return undefined;
  },
  async getAllAsync(sql: string) {
    await tick();
    if (/PRAGMA table_info\(lists\)/.test(sql)) {
      return columns.map((name) => ({ name }));
    }
    return [];
  },
  async getFirstAsync() {
    await tick();
    return null;
  },
  async runAsync() {
    await tick();
    return undefined;
  },
};

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => {
    openCount += 1;
    await tick();
    return mockDb;
  }),
}));

beforeEach(() => {
  columns = [...LEGACY_COLUMNS];
  openCount = 0;
});

describe('db init', () => {
  it('opens once and migrates once when several callers race at startup', async () => {
    await jest.isolateModulesAsync(async () => {
      const db = require('../db');

      // The real startup shape: hydration + a settings read land in the same
      // tick.
      const [lists, setting] = await Promise.all([
        db.loadAllLists(),
        db.getAppSetting('theme'),
        db.loadAllLists(),
      ]);

      expect(lists).toEqual([]);
      expect(setting).toBeNull();
      expect(openCount).toBe(1);
      // The legacy-table migration ran exactly once, by exactly one caller.
      expect(columns.filter((c) => c === 'nameUpdatedAt')).toHaveLength(1);
    });
  }, TIMER_BOUND_TIMEOUT_MS);

  /**
   * The whole APP opens the database exactly once — the domain module and the
   * shell's storage/kv.ts must share one connection, not one each.
   *
   * Two openDatabaseAsync call sites on the same file are harmless once the
   * SQLite directory exists, which is why this hid for so long: it only bites
   * on the FIRST launch after an install, when both race expo-sqlite's
   * ensureDatabasePathExists and the loser rejects. hydrate() catches that and
   * fails open, so the user's first launch renders an empty list.
   *
   * A test that only ever exercises store/db.ts would count 1 open while the
   * app really made 2. This one drives BOTH modules in the same tick.
   */
  it('opens once across the whole app — domain and shell share one connection', async () => {
    await jest.isolateModulesAsync(async () => {
      const db = require('../db');
      const kv = require('../../storage/kv');

      // Cold start: hydration (domain) and a shell settings read land together.
      await Promise.all([
        db.loadAllLists(),
        kv.getAppSetting('theme'),
        db.getAppSetting('gender'),
      ]);

      expect(openCount).toBe(1);
    });
  }, TIMER_BOUND_TIMEOUT_MS);

  it('adds the nameUpdatedAt column to a legacy lists table', async () => {
    await jest.isolateModulesAsync(async () => {
      const db = require('../db');
      await db.loadAllLists();
      expect(columns).toContain('nameUpdatedAt');
    });
  }, TIMER_BOUND_TIMEOUT_MS);

  /**
   * Sharing one open promise removes the race INSIDE this process, but not the
   * one against a second connection to the same file — another app instance, or
   * a background task the OS restored — which can add the column between our
   * PRAGMA and our ALTER. SQLite answers that with "duplicate column name", and
   * an upgrading user whose hydration threw there would open to an empty list.
   * The column exists either way, so losing the race is the harmless outcome.
   */
  it('survives another connection adding the column first', async () => {
    await jest.isolateModulesAsync(async () => {
      const db = require('../db');

      // Slip the column in after the PRAGMA has been read but before the ALTER
      // lands — exactly the window a second connection occupies.
      const realGetAll = mockDb.getAllAsync;
      const spy = jest
        .spyOn(mockDb, 'getAllAsync')
        .mockImplementation(async (sql: string) => {
          const rows = await realGetAll.call(mockDb, sql);
          if (/PRAGMA table_info\(lists\)/.test(sql)) {
            columns.push('nameUpdatedAt');
          }
          return rows;
        });

      await expect(db.loadAllLists()).resolves.toEqual([]);
      expect(columns).toContain('nameUpdatedAt');
      spy.mockRestore();
    });
  }, TIMER_BOUND_TIMEOUT_MS);
});
