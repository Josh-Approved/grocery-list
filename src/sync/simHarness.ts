/**
 * Multi-device simulation harness for the shared-list stack — used by the
 * intent fuzzer (and future sync tests). NOT a test file.
 *
 * Each simulated device is a fresh module registry (jest.isolateModules), so
 * it runs the REAL zustand lists store and the REAL logical clock as its own
 * singletons — the production code paths, not re-implementations. All devices
 * share one mocked wall clock (`world.now`) with a per-device skew; `on(dev,
 * fn)` routes Date.now to that device while `fn` runs.
 *
 * The wire is modelled as each device's serialized list (what seal/open
 * carries), delivered via mergeRemoteList — the exact receive path of the
 * engine. The Channel keeps a history of published payloads so tests can
 * deliver stale copies out of order (relays re-deliver; the merge must be
 * order-tolerant).
 */

import type { GroceryItem, GroceryList } from '../data/list';

export interface SimWorld {
  now: number;
  active: SimDev | null;
}

export interface SimDev {
  name: string;
  skewMs: number;
  store: typeof import('../store/lists').useListsStore;
  clock: typeof import('./clock');
  world: SimWorld;
}

export function makeWorld(startAt = 1_750_000_000_000): SimWorld {
  return { now: startAt, active: null };
}

/** Install the shared Date.now mock. Call once per test file (beforeAll). */
export function installWorldClock(world: SimWorld): jest.SpyInstance {
  return jest
    .spyOn(Date, 'now')
    .mockImplementation(() => world.now + (world.active?.skewMs ?? 0));
}

export function makeDev(world: SimWorld, name: string, skewMs = 0): SimDev {
  let store!: SimDev['store'];
  let clock!: SimDev['clock'];
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    store = require('../store/lists').useListsStore;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    clock = require('./clock');
  });
  const dev: SimDev = { name, skewMs, store, clock, world };
  on(dev, () => {
    clock.initClock(0, () => {});
    store.setState({ lists: [], hydrated: true });
  });
  return dev;
}

/** Run `fn` as this device (its skewed wall clock feeds Date.now). */
export function on<T>(dev: SimDev, fn: () => T): T {
  const prev = dev.world.active;
  dev.world.active = dev;
  try {
    return fn();
  } finally {
    dev.world.active = prev;
  }
}

export function sharedListOf(dev: SimDev, secret: string): GroceryList {
  const list = dev.store
    .getState()
    .lists.find((l) => l.shareIdentity?.secret === secret);
  if (!list) throw new Error(`no shared list on device ${dev.name}`);
  return list;
}

/** The device's current copy as the wire would carry it. */
export function snapshot(dev: SimDev, secret: string): GroceryList {
  return JSON.parse(JSON.stringify(sharedListOf(dev, secret))) as GroceryList;
}

/** Deliver an arbitrary (possibly stale) payload to a device. */
export function deliverPayload(
  to: SimDev,
  payload: GroceryList
): void {
  on(to, () => to.store.getState().mergeRemoteList(payload));
}

/** Deliver `from`'s CURRENT state to `to`. */
export function deliver(from: SimDev, to: SimDev, secret: string): void {
  deliverPayload(to, snapshot(from, secret));
}

/** Every device exchanges with every other until quiescent. */
export function converge(devs: SimDev[], secret: string, rounds = 4): void {
  for (let r = 0; r < rounds; r++) {
    for (const a of devs) {
      for (const b of devs) {
        if (a !== b) deliver(a, b, secret);
      }
    }
  }
}

export function visible(dev: SimDev, secret: string): GroceryItem[] {
  return sharedListOf(dev, secret).items.filter((it) => it.deletedAt == null);
}

/** Canonical fingerprint of what the user SEES on this device: normalized
 *  name → quantity/checked, order-independent. Two converged devices must
 *  produce identical fingerprints. */
export function fingerprint(dev: SimDev, secret: string): string {
  return visible(dev, secret)
    .map((it) => `${it.name.trim().toLowerCase()}=${it.quantity},${it.checked ? 1 : 0}`)
    .sort()
    .join(';');
}

/** Deterministic PRNG (mulberry32) — seeded so failures are replayable. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
