/**
 * Intent fuzzer — the adversarial gate for the shared-list stack.
 *
 * WHY A SECOND FUZZER. syncSim.test.ts drives hand-rolled ops against the
 * merge and asserts CONVERGENCE — devices agree. But both of the 2026-07-03
 * Josh-reported defects ("re-add shows quantity 2", "checked-off items come
 * back after a gap") CONVERGED just fine: every device agreed on the wrong
 * state. Convergence is necessary, never sufficient. This fuzzer drives the
 * REAL store actions a person actually performs (addItem, setChecked,
 * clearChecked, undo, kit add — via the production zustand store and logical
 * clock per device, see ../simHarness) through random households (2–3 devices,
 * honest clock skew, offline stretches, lost and stale-replayed messages) and
 * asserts USER INTENT:
 *
 *   I1 CONVERGENCE+  — visible name→(qty,checked) fingerprints identical on
 *                      every device (now includes checked, which syncSim never
 *                      modelled).
 *   I2 LAST CHECK ACTION WINS — the wall-clock-latest check/uncheck of an item
 *      (when clearly separated from any rival action) is what every device
 *      shows after syncing. This is the "my check-offs came back" oracle.
 *   I3 RE-ADD IS A FRESH NEED — re-adding a crossed-off item yields qty 1,
 *      unchecked, asserted at the moment of the action on the acting device.
 *   I4 NO DUPLICATE NAMES — concurrent adds of the same name collapse.
 *   I5 NO RESURRECTION / NO LOSS — a specific ROW (id) whose last action was
 *      its removal stays gone everywhere; a NAME whose last action was adding
 *      it stays visible. Removal binds at id level deliberately: the set is
 *      add-wins — finishing a shop clears what was in the cart (the rows the
 *      finisher could see), never a want another device added unseen.
 *   I6 BOUNDED PAYLOAD — no device's published state outgrows relay limits.
 *
 * Blind concurrent check-state edits inside the separation window are
 * inherently last-writer-wins (the app is honest about this); the oracles
 * only bind when actions are separated by SEPARATION_MS — comfortably above
 * the honest skews modelled here (phones NTP-sync within seconds).
 *
 * Deterministic (seeded mulberry32); a failure prints its seed + op log.
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
  rng,
} from '../simHarness';

// One Date.now mock for the whole file; each scenario swaps its world in.
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

const NAMES = [
  'Milk', 'Eggs', 'Bread', 'Butter', 'Coffee', 'Apples', 'Rice', 'Chicken',
  'Pasta', 'Cheese', 'Tomatoes', 'Onions',
];
/** Honest skews: phones NTP-sync within seconds; a stray ±90s is generous. */
const SKEWS = [0, 2_000, -3_000, 30_000, -90_000];
/** Oracles only bind when rival actions are at least this far apart. */
const SEPARATION_MS = 5 * 60_000;

interface CheckAction {
  wall: number;
  want: boolean; // desired checked state
}
interface ExistAction {
  wall: number;
  exists: boolean;
}

interface Scenario {
  seed: number;
  log: string[];
  world: SimWorld;
  devs: SimDev[];
  secret: string;
  // Intent ledger: latest + previous rival action (newest first, max 2).
  check: Map<string, CheckAction[]>; // per normalized name
  exist: Map<string, ExistAction[]>; // per normalized name (adds)
  rowFate: Map<string, ExistAction[]>; // per item ID (removals / revives)
  breaches: string[];
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

function runScenario(seed: number): string | null {
  const rand = rng(seed);
  const pick = <T,>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
  const world = makeWorld();
  worldRef.current = world;
  const devCount = 2 + (rand() < 0.35 ? 1 : 0);
  const devs = Array.from({ length: devCount }, (_, i) =>
    makeDev(world, `d${i}`, pick(SKEWS))
  );
  const sc: Scenario = {
    seed,
    log: [],
    world,
    devs,
    secret: '',
    check: new Map(),
    exist: new Map(),
    rowFate: new Map(),
    breaches: [],
  };

  // Pair everyone on one shared list.
  const listId0 = on(devs[0], () => devs[0].store.getState().createList('Groceries'));
  sc.secret = on(devs[0], () => devs[0].store.getState().shareList(listId0))!;
  for (const d of devs.slice(1)) on(d, () => d.store.getState().joinShared(sc.secret));
  converge(devs, sc.secret);

  // Per-channel publish history for stale replays.
  const history: GroceryList[] = [];
  // Devices currently offline don't exchange.
  const offline = new Set<SimDev>();

  const steps = 25 + Math.floor(rand() * 35);
  for (let s = 0; s < steps; s++) {
    world.now += 30_000 + Math.floor(rand() * 20 * 60_000); // 30s–20min
    const dev = pick(devs);
    const roll = rand();
    const wall = world.now;
    const nm = (n: string) => n.toLowerCase();

    if (roll < 0.28) {
      // Add (typed or picker) — the most common act.
      const name = pick(NAMES);
      const lid = listIdOn(dev, sc.secret);
      const before = visible(dev, sc.secret).find(
        (it) => it.name.toLowerCase() === nm(name)
      );
      on(dev, () => dev.store.getState().addItem(lid, name));
      sc.log.push(`t+${wall} ${dev.name} addItem(${name})`);
      record(sc.exist, nm(name), { wall, exists: true });
      if (before) record(sc.rowFate, before.id, { wall, exists: true }); // revive/bump
      if (before?.checked) {
        // I3: re-add of a crossed-off item = fresh single need, right now,
        // on the acting device.
        const after = visible(dev, sc.secret).find(
          (it) => it.name.toLowerCase() === nm(name)
        );
        if (!after || after.checked || after.quantity !== 1) {
          sc.breaches.push(
            `I3 re-add of checked "${name}" on ${dev.name} → ${JSON.stringify(
              after && { qty: after.quantity, checked: after.checked }
            )}, want qty 1 unchecked`
          );
        }
        record(sc.check, nm(name), { wall, want: false });
      } else if (!before) {
        record(sc.check, nm(name), { wall, want: false }); // fresh add is unchecked
      }
    } else if (roll < 0.48) {
      // Check / uncheck something visible on this device.
      const items = visible(dev, sc.secret);
      if (items.length === 0) continue;
      const it = pick(items);
      const want = !it.checked;
      const lid = listIdOn(dev, sc.secret);
      on(dev, () => dev.store.getState().setChecked(lid, it.id, want));
      sc.log.push(`t+${wall} ${dev.name} setChecked(${it.name}, ${want})`);
      record(sc.check, nm(it.name), { wall, want });
    } else if (roll < 0.56) {
      // Content edit — must never disturb check state (the R2 defect class).
      // A content edit also KEEPS THE ROW: editing a copy that a not-yet-seen
      // removal covered revives it (the editor demonstrably wants it — losing
      // their edit silently would be worse). Check-offs deliberately don't
      // revive: both sides agree the item is done.
      const items = visible(dev, sc.secret);
      if (items.length === 0) continue;
      const it = pick(items);
      const lid = listIdOn(dev, sc.secret);
      if (rand() < 0.5) {
        const q = 1 + Math.floor(rand() * 5);
        on(dev, () => dev.store.getState().setQuantity(lid, it.id, q));
        sc.log.push(`t+${wall} ${dev.name} setQuantity(${it.name}, ${q})`);
      } else {
        on(dev, () => dev.store.getState().setNote(lid, it.id, `note ${s}`));
        sc.log.push(`t+${wall} ${dev.name} setNote(${it.name})`);
      }
      record(sc.rowFate, it.id, { wall, exists: true });
      record(sc.exist, nm(it.name), { wall, exists: true });
    } else if (roll < 0.62) {
      // Swipe-delete an item.
      const items = visible(dev, sc.secret);
      if (items.length === 0) continue;
      const it = pick(items);
      const lid = listIdOn(dev, sc.secret);
      on(dev, () => dev.store.getState().deleteItem(lid, it.id));
      sc.log.push(`t+${wall} ${dev.name} deleteItem(${it.name})`);
      record(sc.exist, nm(it.name), { wall, exists: false });
      record(sc.rowFate, it.id, { wall, exists: false });
    } else if (roll < 0.7) {
      // Finish the shop (tombstones every checked item on this device).
      const lid = listIdOn(dev, sc.secret);
      const bought = visible(dev, sc.secret).filter((it) => it.checked);
      on(dev, () => dev.store.getState().clearChecked(lid));
      sc.log.push(
        `t+${wall} ${dev.name} clearChecked(${bought.map((b) => b.name).join('|') || '-'})`
      );
      for (const b of bought) {
        record(sc.exist, nm(b.name), { wall, exists: false });
        record(sc.rowFate, b.id, { wall, exists: false });
      }
    } else if (roll < 0.78) {
      // Two devices happen to be online together and exchange.
      const other = pick(devs);
      if (other !== dev && !offline.has(dev) && !offline.has(other)) {
        deliver(dev, other, sc.secret);
        deliver(other, dev, sc.secret);
        sc.log.push(`t+${wall} exchange ${dev.name}<->${other.name}`);
      }
    } else if (roll < 0.86) {
      // Publish into the ether: another device may hear it now, or a relay
      // may replay it much later (stale copy) — the merge must not care.
      history.push(snapshot(dev, sc.secret));
      const other = pick(devs);
      if (other !== dev && !offline.has(other) && rand() < 0.7) {
        deliver(dev, other, sc.secret);
      }
      sc.log.push(`t+${wall} publish ${dev.name}`);
    } else if (roll < 0.92) {
      if (history.length > 0 && rand() < 0.8) {
        // Stale replay of an old payload to a random device.
        const victim = pick(devs);
        const stale = history[Math.floor(rand() * history.length)];
        deliverPayload(victim, JSON.parse(JSON.stringify(stale)));
        sc.log.push(`t+${wall} stale-replay -> ${victim.name}`);
      }
    } else {
      // Toggle offline (a phone in a dead spot / backgrounded for days).
      if (offline.has(dev)) offline.delete(dev);
      else offline.add(dev);
      sc.log.push(`t+${wall} ${dev.name} ${offline.has(dev) ? 'offline' : 'online'}`);
    }
  }

  // Everyone comes back online after a long quiet gap and fully syncs.
  world.now += 26 * 3600 * 1000;
  converge(devs, sc.secret);

  // I1 convergence on what people SEE (name, qty, checked).
  const prints = devs.map((d) => fingerprint(d, sc.secret));
  if (new Set(prints).size !== 1) {
    sc.breaches.push(
      `I1 divergence: ${devs.map((d, i) => `${d.name}=[${prints[i]}]`).join(' vs ')}`
    );
  }

  // I4 duplicate visible names.
  for (const d of devs) {
    const names = visible(d, sc.secret).map((it) => it.name.trim().toLowerCase());
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    if (dupes.length) sc.breaches.push(`I4 duplicate rows on ${d.name}: ${dupes.join(',')}`);
  }

  // I5-gone, id level: a specific row whose last fate (clearly separated) was
  // removal must not be visible anywhere. Add-wins: another device's unseen
  // add of the same NAME may legitimately survive under a different id.
  for (const [id, fates] of sc.rowFate) {
    const [last, prev] = fates;
    if (!last || last.exists) continue;
    if (prev && last.wall - prev.wall < SEPARATION_MS) continue;
    for (const d of devs) {
      const row = visible(d, sc.secret).find((it) => it.id === id);
      if (row) {
        sc.breaches.push(
          `I5 resurrection of row ${id} ("${row.name}") on ${d.name} (last fate: removal @${last.wall}; row u${row.updatedAt} cu${row.checkedUpdatedAt})`
        );
        break;
      }
    }
  }
  // I5-present, name level: a name whose last action (clearly separated) was
  // adding it must be visible.
  for (const [name, actions] of sc.exist) {
    const [last, prev] = actions;
    if (!last || !last.exists) continue;
    if (prev && last.wall - prev.wall < SEPARATION_MS) continue;
    const rows = visible(devs[0], sc.secret).filter(
      (it) => it.name.trim().toLowerCase() === name
    );
    if (rows.length === 0) {
      sc.breaches.push(`I5 loss of "${name}" (last action was adding it)`);
    }
  }
  for (const [name, actions] of sc.check) {
    const [last, prev] = actions;
    if (!last || (prev && last.wall - prev.wall < SEPARATION_MS)) continue;
    const existLast = sc.exist.get(name)?.[0];
    if (existLast && !existLast.exists) continue; // it should be gone; I5's turf
    if (existLast && existLast.wall > last.wall) continue; // re-added after; add semantics rule
    const row = visible(devs[0], sc.secret).find(
      (it) => it.name.trim().toLowerCase() === name
    );
    if (row && row.checked !== last.want) {
      sc.breaches.push(
        `I2 check-state of "${name}" is ${row.checked}, last action wanted ${last.want}`
      );
    }
  }

  // I6 payload bound (the pruning happens through real clearChecked calls).
  for (const d of devs) {
    const bytes = JSON.stringify(sharedListOf(d, sc.secret)).length;
    if (bytes > 24 * 1024) sc.breaches.push(`I6 payload ${bytes}B on ${d.name}`);
  }

  if (sc.breaches.length === 0) return null;
  const finals = devs
    .map(
      (d) =>
        `${d.name}: ` +
        sharedListOf(d, sc.secret)
          .items.map(
            (it) =>
              `${it.name || '·'}#${it.id.slice(-6)}[q${it.quantity},c${it.checked ? 1 : 0},u${it.updatedAt},cu${it.checkedUpdatedAt ?? '-'}${it.deletedAt ? ',DEAD' + it.deletedAt : ''}]`
          )
          .join(' ')
    )
    .join('\n    ');
  return `seed ${seed}:\n  ${sc.breaches.join('\n  ')}\n  final:\n    ${finals}\n  ops:\n    ${sc.log.join('\n    ')}`;
}

test('user intent survives 250 randomized household scenarios', () => {
  const failures: string[] = [];
  for (let seed = 1; seed <= 250; seed++) {
    const breach = runScenario(seed);
    if (breach) failures.push(breach);
  }
  if (failures.length) {
    // Print the first few in full; the count says how widespread it is.
    throw new Error(
      `${failures.length}/250 scenarios breached intent:\n\n${failures
        .slice(0, 3)
        .join('\n\n')}`
    );
  }
});

test('scenarios are deterministic (same seed → same outcome)', () => {
  for (const seed of [3, 77, 191]) {
    expect(runScenario(seed)).toBe(runScenario(seed));
  }
});
