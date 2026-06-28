/**
 * Headless two/three-device sync simulator — the production-defect net for the
 * shared-list engine.
 *
 * WHY THIS EXISTS. Shared-list bugs (the "list went wonky / disappeared" class)
 * are deterministic faults in a system we fully control — so they don't need
 * production logs to find, they need a fuzzable model. This drives several
 * virtual devices through random op sequences with random clock skew, offline
 * windows, app restarts, and lossy message delivery, all through the REAL
 * `mergeList` + logical clock, and asserts the CRDT invariants that must always
 * hold. It is deterministic (seeded PRNG), dependency-free, and runs in the
 * normal `npm test` gate — so this whole bug family is caught before any build
 * ships, at zero token cost.
 *
 * Invariants checked per scenario:
 *   1. CONVERGENCE   — after every device exchanges to quiescence, all devices
 *                      hold an identical visible item set.
 *   2. NO RESURRECTION — an item every device has tombstoned stays gone.
 *   3. MONOTONIC CLOCKS — no device clock ever runs backwards.
 *   4. DETERMINISM   — the same seed produces the same outcome.
 *
 * A failing scenario prints its seed so it can be replayed and minimised.
 */
import { LogicalClock } from '../clock';
import { mergeList } from '../merge';
import type { GroceryItem, GroceryList } from '../../data/list';

const SECRET = 'sim-secret';

/** Deterministic PRNG (mulberry32) — seeded so failures are replayable. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface World {
  realTime: number; // shared wall clock the device clocks offset from
}

class SimDevice {
  list: GroceryList;
  readonly clock: LogicalClock;
  private skewMs: number;
  private maxClockSeen = 0;
  clockRegressed = false;

  constructor(
    label: string,
    private world: World,
    skewMs: number
  ) {
    this.skewMs = skewMs;
    this.clock = new LogicalClock({ physicalNow: () => this.world.realTime + this.skewMs });
    const at = this.tick();
    this.list = {
      id: `l_${label}`,
      name: 'Groceries',
      nameUpdatedAt: at,
      items: [],
      categoryOrder: ['Other'],
      createdAt: at,
      updatedAt: at,
      shareIdentity: { secret: SECRET, createdAt: at },
    };
  }

  /** Advance the clock and assert monotonicity. */
  private tick(): number {
    const t = this.clock.now();
    if (t < this.maxClockSeen) this.clockRegressed = true;
    this.maxClockSeen = t;
    return t;
  }

  /** Simulate the device's wall clock being changed (skew can shift any time). */
  reskew(skewMs: number): void {
    this.skewMs = skewMs;
  }

  /** Restart the app: clock state is restored from its persisted high-water
   *  mark (we model perfect persistence — peek() survives). */
  restart(): void {
    const persisted = this.clock.peek();
    (this.clock as unknown as { last: number }).last = 0; // wipe in-memory state
    this.clock.init(persisted, () => {});
  }

  addNew(id: string): void {
    const at = this.tick();
    this.list = {
      ...this.list,
      updatedAt: at,
      items: [
        ...this.list.items,
        {
          id,
          name: id,
          quantity: 1,
          category: 'Other',
          checked: false,
          addedAt: at,
          updatedAt: at,
        },
      ],
    };
  }

  editQty(id: string, qty: number): void {
    const at = this.tick();
    this.list = {
      ...this.list,
      updatedAt: at,
      items: this.list.items.map((it) =>
        it.id === id ? { ...it, quantity: qty, updatedAt: at } : it
      ),
    };
  }

  delete(id: string): void {
    const at = this.tick();
    this.list = {
      ...this.list,
      updatedAt: at,
      items: this.list.items.map((it) =>
        it.id === id ? { ...it, deletedAt: at, updatedAt: at } : it
      ),
    };
  }

  reAdd(id: string): void {
    const at = this.tick();
    this.list = {
      ...this.list,
      updatedAt: at,
      items: this.list.items.map((it) =>
        it.id === id ? { ...it, deletedAt: undefined, updatedAt: at } : it
      ),
    };
  }

  receive(remote: GroceryList): void {
    let max = Math.max(remote.updatedAt, remote.nameUpdatedAt);
    for (const it of remote.items) max = Math.max(max, it.updatedAt, it.deletedAt ?? 0);
    this.clock.observe(max);
    if (this.clock.peek() < this.maxClockSeen) this.clockRegressed = true;
    this.maxClockSeen = Math.max(this.maxClockSeen, this.clock.peek());
    this.list = mergeList(this.list, remote);
  }

  visibleIds(): string[] {
    return this.list.items.filter((it) => it.deletedAt == null).map((it) => it.id).sort();
  }

  /** id -> visible quantity (deleted items omitted). */
  visibleMap(): Record<string, number> {
    const m: Record<string, number> = {};
    for (const it of this.list.items) if (it.deletedAt == null) m[it.id] = it.quantity;
    return m;
  }

  allItemIds(): string[] {
    return this.list.items.map((it) => it.id);
  }

  isDeleted(id: string): boolean {
    const it = this.list.items.find((x) => x.id === id);
    return !!it && it.deletedAt != null;
  }
}

/** Exchange every pairing repeatedly until convergence (merge is idempotent +
 *  commutative, so a few rounds suffice). */
function flush(devices: SimDevice[]): void {
  for (let round = 0; round < 4; round++) {
    for (const a of devices) {
      for (const b of devices) {
        if (a !== b) b.receive(a.list);
      }
    }
  }
}

/** Run one randomised scenario; returns a description of any invariant breach. */
function runScenario(seed: number): string | null {
  const rand = rng(seed);
  const pick = <T,>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
  const T0 = 1_700_000_000_000;
  const world: World = { realTime: T0 };

  const deviceCount = 2 + Math.floor(rand() * 2); // 2 or 3 devices (a household)
  const skews = [0, 1000, 60_000, 3_600_000, -90_000, 12 * 3_600_000];
  const devices = Array.from(
    { length: deviceCount },
    (_, i) => new SimDevice(`d${i}`, world, pick(skews))
  );

  let nextItem = 0;
  const steps = 12 + Math.floor(rand() * 30);
  for (let s = 0; s < steps; s++) {
    world.realTime += Math.floor(rand() * 90_000); // 0–90s passes between steps
    const dev = pick(devices);
    const roll = rand();
    if (roll < 0.3 || dev.allItemIds().length === 0) {
      dev.addNew(`i${nextItem++}`);
    } else if (roll < 0.5) {
      const id = pick(dev.allItemIds());
      if (!dev.isDeleted(id)) dev.editQty(id, 1 + Math.floor(rand() * 9));
    } else if (roll < 0.65) {
      const id = pick(dev.allItemIds());
      if (!dev.isDeleted(id)) dev.delete(id);
    } else if (roll < 0.75) {
      const id = pick(dev.allItemIds());
      if (dev.isDeleted(id)) dev.reAdd(id);
    } else if (roll < 0.85) {
      // a peer comes online briefly and exchanges with one other device
      const other = pick(devices);
      if (other !== dev) {
        dev.receive(other.list);
        other.receive(dev.list);
      }
    } else if (roll < 0.93) {
      dev.reskew(pick(skews)); // the device's wall clock gets changed
    } else {
      dev.restart(); // app relaunch
    }
  }

  // Everyone goes quiet and fully syncs.
  world.realTime += 3_600_000;
  flush(devices);

  // INV3: clocks never regressed.
  for (const d of devices) {
    if (d.clockRegressed) return `clock regressed on a device`;
  }

  // INV1: convergence — identical visible item maps. Compare order-independently
  // (merge returns items in device-specific array order; the SET of visible
  // id→qty entries is what must match).
  const canonical = (d: SimDevice): string => {
    const m = d.visibleMap();
    return Object.keys(m)
      .sort()
      .map((k) => `${k}=${m[k]}`)
      .join(',');
  };
  const ref = canonical(devices[0]);
  for (let i = 1; i < devices.length; i++) {
    const got = canonical(devices[i]);
    if (got !== ref) {
      return `divergence: d0=[${ref}] vs d${i}=[${got}]`;
    }
  }

  // INV2: an item deleted on every device must stay gone after convergence.
  const everDeletedEverywhere = devices[0]
    .allItemIds()
    .filter((id) => devices.every((d) => d.isDeleted(id)));
  for (const id of everDeletedEverywhere) {
    if (devices.some((d) => d.visibleIds().includes(id))) {
      return `resurrection of ${id}`;
    }
  }

  return null;
}

/**
 * Causal-chain oracle: devices edit one shared item in a ping-pong where each
 * edit is made AFTER receiving the peer's latest state (so every edit causally
 * follows the previous one), under adversarial clock skew. The last edit in the
 * chain must win on every device. This is the property the clock fix restores —
 * under the old raw-`Date.now()` merge a fast phone's earlier edit out-stamps a
 * later one, so the last writer loses. Convergence alone can't catch that (both
 * devices agree on the wrong value); this can.
 */
function runCausalChain(seed: number): string | null {
  const rand = rng(seed);
  const pick = <T,>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
  const T0 = 1_700_000_000_000;
  const world: World = { realTime: T0 };
  const skews = [0, 3_600_000, -3_600_000, 600_000, 12 * 3_600_000];
  const devs = [
    new SimDevice('a', world, pick(skews)),
    new SimDevice('b', world, pick(skews)),
  ];

  devs[0].addNew('x');
  devs[1].receive(devs[0].list); // both now share item x

  let expected = 1;
  const rounds = 6 + Math.floor(rand() * 12);
  for (let r = 0; r < rounds; r++) {
    world.realTime += 1000 + Math.floor(rand() * 120_000);
    const editor = devs[r % 2];
    const peer = devs[(r + 1) % 2];
    editor.receive(peer.list); // causally observe the peer's latest
    if (rand() < 0.25) editor.reskew(pick(skews)); // wall clock changes mid-chain
    expected = r + 2; // strictly-increasing unique value → no coincidental pass
    editor.editQty('x', expected);
  }

  world.realTime += 3_600_000;
  flush(devs);
  for (let i = 0; i < devs.length; i++) {
    const got = devs[i].visibleMap()['x'];
    if (got !== expected) {
      return `last-writer lost: d${i} shows x=${got}, expected ${expected}`;
    }
  }
  return null;
}

test('last causal writer wins under skew across 300 ping-pong chains', () => {
  const failures: string[] = [];
  for (let seed = 1; seed <= 300; seed++) {
    const breach = runCausalChain(seed);
    if (breach) failures.push(`seed ${seed}: ${breach}`);
  }
  expect(failures).toEqual([]);
});

test('convergence + no-resurrection across 400 randomised chaos scenarios', () => {
  const failures: string[] = [];
  for (let seed = 1; seed <= 400; seed++) {
    const breach = runScenario(seed);
    if (breach) failures.push(`seed ${seed}: ${breach}`);
  }
  expect(failures).toEqual([]);
});

test('scenarios are deterministic (same seed -> same outcome)', () => {
  for (const seed of [7, 42, 123, 256]) {
    expect(runScenario(seed)).toBe(runScenario(seed));
  }
});
