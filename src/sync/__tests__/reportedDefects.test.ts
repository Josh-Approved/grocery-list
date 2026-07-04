/**
 * Regression fixtures for the 2026-07-03 Josh-reported shared-list defects.
 *
 * Each test here was written against the code AS SHIPPED and demonstrated the
 * defect (recorded in the session log) BEFORE the fix landed — per the studio
 * rule that a quality gate must provably fail its known-bad. They pin USER
 * INTENT, not implementation: what a person doing a weekly shop expects to see.
 *
 * The two reports:
 *   R1 "cross an item off, add it again → shows quantity 2; expected 1."
 *   R2 "after a long gap between syncs, a bunch of previously checked-off
 *       items come back."
 *
 * R2 decomposes into the four mechanisms tested below: whole-item LWW losing
 * `checked` to any concurrent edit of the same item; the R1 re-add stamping
 * items so the inflated/unchecked copy wins the merge; duplicate rows from
 * concurrent same-name adds; and cross-device timestamp ties resolving
 * "keep local" on both sides (permanent divergence).
 *
 * The two-device harness drives the REAL store module (zustand actions, real
 * logical clock) per device via jest.isolateModules — not a re-implementation
 * of the ops — with the wire modelled as a JSON round-trip (what seal/open
 * carries).
 */

// SQLite can't load in node; persistence is fire-and-forget and not the SUT.
jest.mock('../../store/db', () => ({
  loadAllLists: jest.fn(async () => []),
  saveList: jest.fn(async () => {}),
  deleteListFromDb: jest.fn(async () => {}),
  putTombstone: jest.fn(async () => {}),
  removeTombstone: jest.fn(async () => {}),
  getSyncMeta: jest.fn(async () => null),
  setSyncMeta: jest.fn(async () => {}),
  loadAllKits: jest.fn(async () => []),
  saveKit: jest.fn(async () => {}),
}));

import type { GroceryList, GroceryItem } from '../../data/list';

// ---------------------------------------------------------------------------
// Two-device harness: each device is a fresh module registry (own store
// singleton, own logical clock), sharing one mocked wall clock with per-device
// skew. `on(dev, fn)` routes Date.now to that device while fn runs.
// ---------------------------------------------------------------------------

interface Device {
  name: string;
  skewMs: number;
  store: typeof import('../../store/lists').useListsStore;
  clock: typeof import('../clock');
}

let physNow = 1_750_000_000_000; // shared "real" wall time
let active: Device | null = null;
let dateSpy: jest.SpyInstance<number, []>;

beforeAll(() => {
  dateSpy = jest
    .spyOn(Date, 'now')
    .mockImplementation(() => physNow + (active?.skewMs ?? 0));
});
afterAll(() => dateSpy.mockRestore());

function makeDevice(name: string, skewMs = 0): Device {
  let store!: Device['store'];
  let clock!: Device['clock'];
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    store = require('../../store/lists').useListsStore;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    clock = require('../clock');
  });
  const dev: Device = { name, skewMs, store, clock };
  on(dev, () => {
    clock.initClock(0, () => {});
    store.setState({ lists: [], hydrated: true });
  });
  return dev;
}

function on<T>(dev: Device, fn: () => T): T {
  const prev = active;
  active = dev;
  try {
    return fn();
  } finally {
    active = prev;
  }
}

/** Advance shared wall time. */
function tick(ms: number): void {
  physNow += ms;
}

/** Deliver dev A's copy of the shared list to dev B, as the wire would. */
function deliver(from: Device, to: Device, secret: string): void {
  const list = on(from, () =>
    from.store.getState().lists.find((l) => l.shareIdentity?.secret === secret)
  );
  if (!list) throw new Error(`no shared list on ${from.name}`);
  const payload = JSON.parse(JSON.stringify(list)) as GroceryList;
  on(to, () => to.store.getState().mergeRemoteList(payload));
}

/** Full exchange until quiescent (merge is idempotent; 3 rounds is plenty). */
function converge(a: Device, b: Device, secret: string): void {
  for (let i = 0; i < 3; i++) {
    deliver(a, b, secret);
    deliver(b, a, secret);
  }
}

/** Pair two devices on one shared list; returns the shared secret. */
function pair(a: Device, b: Device): string {
  const listId = on(a, () => a.store.getState().createList('Groceries'));
  const secret = on(a, () => a.store.getState().shareList(listId))!;
  on(b, () => b.store.getState().joinShared(secret));
  converge(a, b, secret);
  return secret;
}

function visible(dev: Device, secret: string): GroceryItem[] {
  const list = dev.store
    .getState()
    .lists.find((l) => l.shareIdentity?.secret === secret)!;
  return list.items.filter((it) => it.deletedAt == null);
}

function byName(dev: Device, secret: string, name: string): GroceryItem[] {
  return visible(dev, secret).filter(
    (it) => it.name.toLowerCase() === name.toLowerCase()
  );
}

function listOf(dev: Device, secret: string): GroceryList {
  return dev.store
    .getState()
    .lists.find((l) => l.shareIdentity?.secret === secret)!;
}

afterEach(() => {
  physNow += 10_000_000; // scenarios never bleed into each other
  active = null;
});

// ---------------------------------------------------------------------------
// R1 — re-adding a crossed-off item
// ---------------------------------------------------------------------------

describe('R1: re-adding a crossed-off item', () => {
  test('single device: cross off milk, add milk again → ONE milk, qty 1, unchecked', () => {
    const a = makeDevice('a');
    const listId = on(a, () => a.store.getState().createList('Groceries'));
    on(a, () => a.store.getState().addItem(listId, 'Milk'));
    tick(60_000);
    const milk = a.store.getState().getList(listId)!.items[0];
    on(a, () => a.store.getState().setChecked(listId, milk.id, true));
    tick(60_000);
    on(a, () => a.store.getState().addItem(listId, 'Milk'));

    const rows = a.store
      .getState()
      .getList(listId)!
      .items.filter((it) => it.deletedAt == null && it.name === 'Milk');
    expect(rows).toHaveLength(1);
    expect(rows[0].checked).toBe(false);
    expect(rows[0].quantity).toBe(1); // NOT 2 — the reported defect
  });

  test('adding an item that is on the list UNCHECKED still bumps quantity (want two)', () => {
    const a = makeDevice('a');
    const listId = on(a, () => a.store.getState().createList('Groceries'));
    on(a, () => a.store.getState().addItem(listId, 'Eggs'));
    tick(1000);
    on(a, () => a.store.getState().addItem(listId, 'Eggs'));
    const rows = a.store
      .getState()
      .getList(listId)!
      .items.filter((it) => it.deletedAt == null);
    expect(rows).toHaveLength(1);
    expect(rows[0].quantity).toBe(2);
  });

  test('weekly cycle never inflates: check off + re-add across 4 weeks stays qty 1', () => {
    const a = makeDevice('a');
    const listId = on(a, () => a.store.getState().createList('Groceries'));
    on(a, () => a.store.getState().addItem(listId, 'Milk'));
    for (let week = 0; week < 4; week++) {
      tick(7 * 24 * 3600 * 1000);
      const milk = a.store
        .getState()
        .getList(listId)!
        .items.find((it) => it.deletedAt == null && it.name === 'Milk')!;
      on(a, () => a.store.getState().setChecked(listId, milk.id, true));
      tick(3600 * 1000);
      on(a, () => a.store.getState().addItem(listId, 'Milk'));
    }
    const rows = a.store
      .getState()
      .getList(listId)!
      .items.filter((it) => it.deletedAt == null && it.name === 'Milk');
    expect(rows).toHaveLength(1);
    expect(rows[0].quantity).toBe(1);
    expect(rows[0].checked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// R2a — a check-off must survive a concurrent edit to the same item
// ---------------------------------------------------------------------------

describe('R2a: check-offs survive concurrent edits of the same item', () => {
  test('A checks milk at the store while B (not yet synced) edits its quantity → after sync, BOTH survive', () => {
    const a = makeDevice('a');
    const b = makeDevice('b');
    const secret = pair(a, b);

    on(a, () => a.store.getState().addItem(listOf(a, secret).id, 'Milk'));
    converge(a, b, secret);
    const milkA = byName(a, secret, 'Milk')[0];
    const milkB = byName(b, secret, 'Milk')[0];

    // Blind concurrency: A checks it off; B (offline, hasn't seen the check)
    // bumps the quantity. B's edit lands later in wall time.
    tick(60_000);
    on(a, () => a.store.getState().setChecked(listOf(a, secret).id, milkA.id, true));
    tick(60_000);
    on(b, () => b.store.getState().setQuantity(listOf(b, secret).id, milkB.id, 3));

    converge(a, b, secret);

    for (const dev of [a, b]) {
      const milk = byName(dev, secret, 'Milk')[0];
      expect(milk.checked).toBe(true); // the check survives (was: reverted)
      expect(milk.quantity).toBe(3); // the quantity edit survives too
    }
  });

  test('a whole shop of check-offs survives the partner idly touching items during the gap', () => {
    const a = makeDevice('a');
    const b = makeDevice('b');
    const secret = pair(a, b);
    const names = ['Milk', 'Eggs', 'Bread', 'Butter', 'Coffee'];
    for (const n of names)
      on(a, () => a.store.getState().addItem(listOf(a, secret).id, n));
    converge(a, b, secret);

    // A shops and checks everything off.
    tick(3600_000);
    for (const n of names) {
      const it = byName(a, secret, n)[0];
      on(a, () => a.store.getState().setChecked(listOf(a, secret).id, it.id, true));
    }
    // Long gap; B never saw the checks and renames/recategorizes a few items.
    tick(2 * 24 * 3600 * 1000);
    const bList = listOf(b, secret).id;
    on(b, () =>
      b.store.getState().setName(bList, byName(b, secret, 'Milk')[0].id, 'Whole milk')
    );
    on(b, () =>
      b.store.getState().recategorize(bList, byName(b, secret, 'Eggs')[0].id, 'Dairy & eggs')
    );

    converge(a, b, secret);

    // Every check-off survives on BOTH devices; B's edits survive too.
    for (const dev of [a, b]) {
      expect(visible(dev, secret).filter((it) => it.checked)).toHaveLength(5);
      expect(byName(dev, secret, 'Whole milk')[0]?.checked).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// R2b — concurrent same-name adds must not stack duplicate rows
// ---------------------------------------------------------------------------

describe('R2b: concurrent same-name adds converge to one row', () => {
  test('both devices add "Milk" while apart → one visible Milk row after sync', () => {
    const a = makeDevice('a');
    const b = makeDevice('b');
    const secret = pair(a, b);

    tick(1000);
    on(a, () => a.store.getState().addItem(listOf(a, secret).id, 'Milk'));
    tick(1000);
    on(b, () => b.store.getState().addItem(listOf(b, secret).id, 'milk'));

    converge(a, b, secret);

    for (const dev of [a, b]) {
      expect(byName(dev, secret, 'Milk')).toHaveLength(1);
    }
    // And the two devices agree on the surviving row.
    expect(byName(a, secret, 'Milk')[0].id).toBe(byName(b, secret, 'Milk')[0].id);
  });
});

// ---------------------------------------------------------------------------
// R2c — cross-device timestamp ties must not diverge forever
// ---------------------------------------------------------------------------

describe('R2c: same-millisecond edits on two devices still converge', () => {
  test('same-ms rename on both sides converges to one agreed name', () => {
    const a = makeDevice('a');
    const b = makeDevice('b');
    const secret = pair(a, b);
    on(a, () => a.store.getState().addItem(listOf(a, secret).id, 'Jam'));
    converge(a, b, secret);

    // Both devices edit the same item in the SAME wall millisecond.
    tick(60_000);
    const aId = byName(a, secret, 'Jam')[0].id;
    on(a, () => a.store.getState().setName(listOf(a, secret).id, aId, 'Strawberry jam'));
    const bId = byName(b, secret, 'Jam')[0].id;
    on(b, () => b.store.getState().setName(listOf(b, secret).id, bId, 'Raspberry jam'));

    converge(a, b, secret);

    const nameA = visible(a, secret)[0].name;
    const nameB = visible(b, secret)[0].name;
    expect(nameA).toBe(nameB); // devices must agree (was: each kept its own)
  });
});

// ---------------------------------------------------------------------------
// R2d — payload growth: a year of weekly shops must stay under relay limits
// ---------------------------------------------------------------------------

describe('R2d: full-state payload stays under relay event-size limits', () => {
  test('52 weekly shops of 25 items → serialized list stays small enough to publish', () => {
    const a = makeDevice('a');
    const listId = on(a, () => a.store.getState().createList('Groceries'));
    on(a, () => a.store.getState().shareList(listId));

    for (let week = 0; week < 52; week++) {
      tick(7 * 24 * 3600 * 1000);
      for (let i = 0; i < 25; i++) {
        on(a, () => a.store.getState().addItem(listId, `Item ${week}-${i}`));
      }
      const list = a.store.getState().getList(listId)!;
      for (const it of list.items.filter((x) => x.deletedAt == null)) {
        on(a, () => a.store.getState().setChecked(listId, it.id, true));
      }
      on(a, () => a.store.getState().finishShop(listId));
    }

    const json = JSON.stringify(a.store.getState().getList(listId)!);
    // Sealed payload adds ~37% (base64) + event envelope; 20KB of JSON keeps
    // the published event safely under the strictest public-relay limits.
    expect(json.length).toBeLessThan(20 * 1024);
  });
});
