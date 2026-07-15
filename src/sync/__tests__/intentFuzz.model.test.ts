/**
 * Intent fuzzer — the fast-check MODEL-BASED port (Uplevel 3 / T1).
 *
 * This is the grocery hand-rolled `intentFuzz.test.ts` re-expressed on the
 * factory `qa/intent-fuzz` kit (fast-check `fc.commands`). It drives the SAME
 * REAL store per simulated device through the SAME `simHarness`, judged by the
 * SAME user-intent oracles — nothing weakened. What the port adds over the
 * hand-rolled loop is exactly the two things fast-check gives:
 *
 *   1. SHRINKING — a failure minimizes itself to the shortest reproducing
 *      command story (half of "clearly articulated" for free).
 *   2. THE ARTIFACT PIPELINE — on a counterexample the harness crystallizes a
 *      checked-in regression fixture (`qa/regressions/list-sync-seed-<n>.json`),
 *      a defect-intake line, and a logged seed, and `replayRegressions` re-runs
 *      that minimal case forever.
 *
 * PARITY, NOT REPLACEMENT. Per spec § grocery, the hand-rolled
 * `intentFuzz.test.ts` + `syncSim.test.ts` keep running alongside this file;
 * the old suite retires only after a week of nightly parity (both must re-catch
 * every seeded known-bad). Same trust core (the shared-list merge), same
 * oracles below (I1–I6, verbatim intent from the hand-rolled file).
 *
 * ORACLES (intent, never convergence-alone — canon 2026-07-03):
 *   I1 CONVERGENCE+           visible name→(qty,checked) fingerprints identical
 *                             on every device after full sync (checked included).
 *   I2 LAST CHECK ACTION WINS the wall-clock-latest check/uncheck (clearly
 *                             separated from any rival) is what all devices show.
 *   I3 RE-ADD IS A FRESH NEED re-adding a crossed-off item → qty 1, unchecked,
 *                             asserted at the acting moment on the acting device.
 *   I4 NO DUPLICATE NAMES     concurrent same-name adds collapse.
 *   I5 NO RESURRECTION / LOSS a row whose last action was removal stays gone
 *                             (id level); a name last-added stays visible.
 *   I6 BOUNDED PAYLOAD        no device's published state outgrows relay limits.
 *
 * Oracles only bind when rival actions are separated by SEPARATION_MS (blind
 * concurrent edits inside that window are honestly last-writer-wins) — the same
 * rule the hand-rolled fuzzer uses.
 */

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

import fc from 'fast-check';
import { runIntentFuzz } from '../../../qa/intent-fuzz/harness';
import { replayRegressions } from '../../../qa/intent-fuzz/replay';

import type { GroceryList } from '../../data/list';
import {
  type SimDev,
  type SimWorld,
  makeWorld,
  makeDev,
  on,
  converge,
  deliver,
  deliverPayload,
  snapshot,
  sharedListOf,
  visible,
  fingerprint,
} from '../simHarness';

const APP = require('../../../app.json').expo.slug as string;
const MODEL = 'list-sync';

const NAMES = [
  'Milk', 'Eggs', 'Bread', 'Butter', 'Coffee', 'Apples', 'Rice', 'Chicken',
  'Pasta', 'Cheese', 'Tomatoes', 'Onions',
];
/** Honest phone NTP skews (ms) — one per device, fixed per household. */
const DEV_SKEWS = [0, -3_000, 30_000];
/** Oracles only bind when rival actions are at least this far apart. */
const SEPARATION_MS = 5 * 60_000;
/** Same relay-size bound the hand-rolled fuzzer asserts. */
const PAYLOAD_LIMIT = 24 * 1024;
const norm = (s: string) => s.trim().toLowerCase();

// One Date.now spy for the whole file; each story swaps its world in via setup
// (mirrors the hand-rolled file — the shared clock + per-device skew).
const worldRef: { current: SimWorld | null } = { current: null };
let dateSpy: jest.SpyInstance<number, []>;
beforeAll(() => {
  dateSpy = jest
    .spyOn(Date, 'now')
    .mockImplementation(() =>
      worldRef.current
        ? worldRef.current.now + (worldRef.current.active?.skewMs ?? 0)
        : 1_750_000_000_000
    );
});
afterAll(() => dateSpy.mockRestore());

interface CheckAction {
  wall: number;
  want: boolean;
}
interface ExistAction {
  wall: number;
  exists: boolean;
}

/** The intent ledger — last-action-wins expectations, newest first (max 2). */
interface Model {
  check: Map<string, CheckAction[]>; // per normalized name
  exist: Map<string, ExistAction[]>; // per normalized name (adds/removals)
  rowFate: Map<string, ExistAction[]>; // per item ID (removals/revives)
}

interface Real {
  world: SimWorld;
  devs: SimDev[];
  secret: string;
  history: GroceryList[];
  offline: Set<number>; // device indices currently offline
}

function record<T extends { wall: number }>(
  map: Map<string, T[]>,
  key: string,
  action: T
): void {
  const arr = map.get(key) ?? [];
  arr.unshift(action);
  map.set(key, arr.slice(0, 2));
}

function listIdOn(dev: SimDev, secret: string): string {
  return sharedListOf(dev, secret).id;
}
function devOf(r: Real, idx: number): SimDev {
  return r.devs[idx % r.devs.length];
}
/** Every command advances the shared wall clock 30s–~20min, exactly like the
 *  hand-rolled loop (gap is a fast-check draw, so it shrinks + replays). */
function advance(r: Real, gap: number): number {
  r.world.now += 30_000 + gap * 30_000;
  return r.world.now;
}

class AddItem implements fc.Command<Model, Real> {
  constructor(readonly gap: number, readonly devIdx: number, readonly nameIdx: number) {}
  check = () => true;
  run(m: Model, r: Real): void {
    const dev = devOf(r, this.devIdx);
    const name = NAMES[this.nameIdx % NAMES.length];
    const wall = advance(r, this.gap);
    const lid = listIdOn(dev, r.secret);
    const before = visible(dev, r.secret).find((it) => norm(it.name) === norm(name));
    on(dev, () => dev.store.getState().addItem(lid, name));
    record(m.exist, norm(name), { wall, exists: true });
    if (before) record(m.rowFate, before.id, { wall, exists: true }); // revive/bump
    if (before?.checked) {
      // I3: re-add of a crossed-off item = a fresh single need, right now.
      const after = visible(dev, r.secret).find((it) => norm(it.name) === norm(name));
      if (!after || after.checked || after.quantity !== 1) {
        throw new Error(
          `I3 re-add of checked "${name}" on ${dev.name} → ${JSON.stringify(
            after && { qty: after.quantity, checked: after.checked }
          )}, want qty 1 unchecked`
        );
      }
      record(m.check, norm(name), { wall, want: false });
    } else if (!before) {
      record(m.check, norm(name), { wall, want: false }); // fresh add is unchecked
    }
  }
  toString = () => `d${this.devIdx}.add(${NAMES[this.nameIdx % NAMES.length]})`;
}

class ToggleCheck implements fc.Command<Model, Real> {
  constructor(readonly gap: number, readonly devIdx: number, readonly itemIdx: number) {}
  check = () => true;
  run(m: Model, r: Real): void {
    const dev = devOf(r, this.devIdx);
    const items = visible(dev, r.secret);
    if (items.length === 0) return;
    const it = items[this.itemIdx % items.length];
    const want = !it.checked;
    const wall = advance(r, this.gap);
    const lid = listIdOn(dev, r.secret);
    on(dev, () => dev.store.getState().setChecked(lid, it.id, want));
    record(m.check, norm(it.name), { wall, want });
  }
  toString = () => `d${this.devIdx}.toggleCheck(#${this.itemIdx})`;
}

class ContentEdit implements fc.Command<Model, Real> {
  constructor(
    readonly gap: number,
    readonly devIdx: number,
    readonly itemIdx: number,
    readonly asNote: boolean,
    readonly qty: number
  ) {}
  check = () => true;
  run(m: Model, r: Real): void {
    // A content edit must NEVER disturb check state (the R2 defect class) and
    // KEEPS THE ROW (editing a copy a not-yet-seen removal covered revives it).
    const dev = devOf(r, this.devIdx);
    const items = visible(dev, r.secret);
    if (items.length === 0) return;
    const it = items[this.itemIdx % items.length];
    const wall = advance(r, this.gap);
    const lid = listIdOn(dev, r.secret);
    if (this.asNote) {
      on(dev, () => dev.store.getState().setNote(lid, it.id, `note ${wall}`));
    } else {
      const q = 1 + (this.qty % 5);
      on(dev, () => dev.store.getState().setQuantity(lid, it.id, q));
    }
    record(m.rowFate, it.id, { wall, exists: true });
    record(m.exist, norm(it.name), { wall, exists: true });
  }
  toString = () =>
    `d${this.devIdx}.${this.asNote ? 'setNote' : 'setQty'}(#${this.itemIdx})`;
}

class DeleteItem implements fc.Command<Model, Real> {
  constructor(readonly gap: number, readonly devIdx: number, readonly itemIdx: number) {}
  check = () => true;
  run(m: Model, r: Real): void {
    const dev = devOf(r, this.devIdx);
    const items = visible(dev, r.secret);
    if (items.length === 0) return;
    const it = items[this.itemIdx % items.length];
    const wall = advance(r, this.gap);
    const lid = listIdOn(dev, r.secret);
    on(dev, () => dev.store.getState().deleteItem(lid, it.id));
    record(m.exist, norm(it.name), { wall, exists: false });
    record(m.rowFate, it.id, { wall, exists: false });
  }
  toString = () => `d${this.devIdx}.delete(#${this.itemIdx})`;
}

class ClearChecked implements fc.Command<Model, Real> {
  constructor(readonly gap: number, readonly devIdx: number) {}
  check = () => true;
  run(m: Model, r: Real): void {
    const dev = devOf(r, this.devIdx);
    const wall = advance(r, this.gap);
    const lid = listIdOn(dev, r.secret);
    const bought = visible(dev, r.secret).filter((it) => it.checked);
    on(dev, () => dev.store.getState().clearChecked(lid));
    for (const b of bought) {
      record(m.exist, norm(b.name), { wall, exists: false });
      record(m.rowFate, b.id, { wall, exists: false });
    }
  }
  toString = () => `d${this.devIdx}.clearChecked`;
}

class Exchange implements fc.Command<Model, Real> {
  constructor(readonly gap: number, readonly aIdx: number, readonly bIdx: number) {}
  check = () => true;
  run(_m: Model, r: Real): void {
    advance(r, this.gap);
    const a = devOf(r, this.aIdx);
    const b = devOf(r, this.bIdx);
    if (a === b) return;
    if (r.offline.has(this.aIdx % r.devs.length) || r.offline.has(this.bIdx % r.devs.length)) return;
    deliver(a, b, r.secret);
    deliver(b, a, r.secret);
  }
  toString = () => `exchange(d${this.aIdx}<->d${this.bIdx})`;
}

class Publish implements fc.Command<Model, Real> {
  constructor(readonly gap: number, readonly devIdx: number, readonly otherIdx: number) {}
  check = () => true;
  run(_m: Model, r: Real): void {
    advance(r, this.gap);
    const dev = devOf(r, this.devIdx);
    r.history.push(snapshot(dev, r.secret));
    const other = devOf(r, this.otherIdx);
    if (other !== dev && !r.offline.has(this.otherIdx % r.devs.length)) {
      deliver(dev, other, r.secret);
    }
  }
  toString = () => `publish(d${this.devIdx})`;
}

class StaleReplay implements fc.Command<Model, Real> {
  constructor(readonly gap: number, readonly victimIdx: number, readonly histIdx: number) {}
  check = () => true;
  run(_m: Model, r: Real): void {
    advance(r, this.gap);
    if (r.history.length === 0) return;
    const victim = devOf(r, this.victimIdx);
    const stale = r.history[this.histIdx % r.history.length];
    deliverPayload(victim, JSON.parse(JSON.stringify(stale)) as GroceryList);
  }
  toString = () => `staleReplay(->d${this.victimIdx})`;
}

class ToggleOffline implements fc.Command<Model, Real> {
  constructor(readonly gap: number, readonly devIdx: number) {}
  check = () => true;
  run(_m: Model, r: Real): void {
    advance(r, this.gap);
    const i = this.devIdx % r.devs.length;
    if (r.offline.has(i)) r.offline.delete(i);
    else r.offline.add(i);
  }
  toString = () => `d${this.devIdx}.toggleOffline`;
}

const gap = fc.integer({ min: 0, max: 40 });
const dIdx = fc.integer({ min: 0, max: 2 });
const idx = fc.nat({ max: 40 });

const commands: fc.Arbitrary<fc.Command<Model, Real>>[] = [
  fc.tuple(gap, dIdx, fc.nat({ max: NAMES.length - 1 })).map(([g, d, n]) => new AddItem(g, d, n)),
  fc.tuple(gap, dIdx, idx).map(([g, d, i]) => new ToggleCheck(g, d, i)),
  fc.tuple(gap, dIdx, idx, fc.boolean(), fc.nat({ max: 4 })).map(([g, d, i, note, q]) => new ContentEdit(g, d, i, note, q)),
  fc.tuple(gap, dIdx, idx).map(([g, d, i]) => new DeleteItem(g, d, i)),
  fc.tuple(gap, dIdx).map(([g, d]) => new ClearChecked(g, d)),
  fc.tuple(gap, dIdx, dIdx).map(([g, a, b]) => new Exchange(g, a, b)),
  fc.tuple(gap, dIdx, dIdx).map(([g, d, o]) => new Publish(g, d, o)),
  fc.tuple(gap, dIdx, idx).map(([g, v, h]) => new StaleReplay(g, v, h)),
  fc.tuple(gap, dIdx).map(([g, d]) => new ToggleOffline(g, d)),
];

function setup(): { model: Model; real: Real } {
  const world = makeWorld();
  worldRef.current = world;
  const devs = DEV_SKEWS.map((skew, i) => makeDev(world, `d${i}`, skew));
  const listId0 = on(devs[0], () => devs[0].store.getState().createList('Groceries'));
  const secret = on(devs[0], () => devs[0].store.getState().shareList(listId0))!;
  for (const d of devs.slice(1)) on(d, () => d.store.getState().joinShared(secret));
  converge(devs, secret);
  return {
    model: { check: new Map(), exist: new Map(), rowFate: new Map() },
    real: { world, devs, secret, history: [], offline: new Set() },
  };
}

/** After the story: everyone comes back online after a long quiet gap and fully
 *  syncs, then the intent oracles I1–I6 are asserted (verbatim from the
 *  hand-rolled fuzzer). Throws on the first breached oracle → fast-check shrinks. */
function atQuiescence(s: { model: Model; real: Real }): void {
  const { model: m, real: r } = s;
  const { devs, secret } = r;
  r.offline.clear();
  r.world.now += 26 * 3600 * 1000;
  converge(devs, secret);

  const breaches: string[] = [];

  // I1 convergence on what people SEE (name, qty, checked).
  const prints = devs.map((d) => fingerprint(d, secret));
  if (new Set(prints).size !== 1) {
    breaches.push(
      `I1 divergence: ${devs.map((d, i) => `${d.name}=[${prints[i]}]`).join(' vs ')}`
    );
  }

  // I4 duplicate visible names.
  for (const d of devs) {
    const names = visible(d, secret).map((it) => norm(it.name));
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    if (dupes.length) breaches.push(`I4 duplicate rows on ${d.name}: ${dupes.join(',')}`);
  }

  // I5-gone, id level: a row whose last (separated) fate was removal must be
  // gone everywhere. Add-wins: another device's unseen add of the same NAME may
  // legitimately survive under a different id.
  for (const [id, fates] of m.rowFate) {
    const [last, prev] = fates;
    if (!last || last.exists) continue;
    if (prev && last.wall - prev.wall < SEPARATION_MS) continue;
    for (const d of devs) {
      const row = visible(d, secret).find((it) => it.id === id);
      if (row) {
        breaches.push(
          `I5 resurrection of row ${id} ("${row.name}") on ${d.name} (last fate: removal @${last.wall})`
        );
        break;
      }
    }
  }
  // I5-present, name level: a name last (separated) added must be visible.
  for (const [name, actions] of m.exist) {
    const [last, prev] = actions;
    if (!last || !last.exists) continue;
    if (prev && last.wall - prev.wall < SEPARATION_MS) continue;
    const rows = visible(devs[0], secret).filter((it) => norm(it.name) === name);
    if (rows.length === 0) breaches.push(`I5 loss of "${name}" (last action was adding it)`);
  }
  // I2 last check action wins.
  for (const [name, actions] of m.check) {
    const [last, prev] = actions;
    if (!last || (prev && last.wall - prev.wall < SEPARATION_MS)) continue;
    const existLast = m.exist.get(name)?.[0];
    if (existLast && !existLast.exists) continue; // should be gone; I5's turf
    if (existLast && existLast.wall > last.wall) continue; // re-added after; add semantics rule
    const row = visible(devs[0], secret).find((it) => norm(it.name) === name);
    if (row && row.checked !== last.want) {
      breaches.push(`I2 check-state of "${name}" is ${row.checked}, last action wanted ${last.want}`);
    }
  }

  // I6 payload bound (pruning happens through the real clearChecked calls).
  for (const d of devs) {
    const bytes = JSON.stringify(sharedListOf(d, secret)).length;
    if (bytes > PAYLOAD_LIMIT) breaches.push(`I6 payload ${bytes}B on ${d.name}`);
  }

  if (breaches.length) throw new Error(breaches.join(' | '));
}

/** The SAME property the live fuzzer runs — replayed against a checked-in
 *  fixture's exact seed+path by `replayRegressions`. Must mirror runIntentFuzz's
 *  internal build (same commands, same maxCommands default 60, same setup +
 *  atQuiescence). */
export function buildListSyncProperty(): fc.IPropertyWithHooks<unknown> {
  return fc.property(fc.commands(commands, { maxCommands: 60 }), (cmds) => {
    const s = setup();
    fc.modelRun(() => ({ model: s.model, real: s.real }), cmds);
    atQuiescence(s);
  }) as unknown as fc.IPropertyWithHooks<unknown>;
}

describe('grocery shared-list — intent fuzzer (fast-check model port)', () => {
  it('user intent survives randomized household stories', () => {
    runIntentFuzz<Model, Real>({ app: APP, model: MODEL, commands, setup, atQuiescence });
  });
});

replayRegressions({ models: { [MODEL]: buildListSyncProperty } });
