/**
 * Unit tests for the skew-resistant logical clock (clock.ts).
 *
 * These pin the properties the shared-list merge depends on: monotonicity
 * across a backward OS-clock jump, advancing past peer timestamps, and clamping
 * a grossly-wrong peer so it can't poison the local clock.
 */
import { LogicalClock } from '../clock';

/** A controllable physical-time source. */
function fakeTime(start: number) {
  let t = start;
  return {
    fn: () => t,
    set: (v: number) => {
      t = v;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

const T0 = 1_700_000_000_000;

test('now() is strictly monotonic even when physical time stands still', () => {
  const time = fakeTime(T0);
  const c = new LogicalClock({ physicalNow: time.fn });
  const a = c.now();
  const b = c.now();
  const d = c.now();
  expect(a).toBe(T0);
  expect(b).toBe(T0 + 1);
  expect(d).toBe(T0 + 2);
});

test('now() tracks physical time as it advances', () => {
  const time = fakeTime(T0);
  const c = new LogicalClock({ physicalNow: time.fn });
  expect(c.now()).toBe(T0);
  time.advance(5000);
  expect(c.now()).toBe(T0 + 5000);
});

test('now() never goes backwards when the OS clock jumps back', () => {
  const time = fakeTime(T0);
  const c = new LogicalClock({ physicalNow: time.fn });
  const high = c.now(); // T0
  time.set(T0 - 60_000); // user corrects a fast clock: time jumps back 1 min
  const next = c.now();
  expect(next).toBe(high + 1); // monotonic, not T0 - 60_000
});

test('observe() lifts the clock so our next edit out-clocks the peer', () => {
  const time = fakeTime(T0);
  const c = new LogicalClock({ physicalNow: time.fn });
  c.now(); // T0
  c.observe(T0 + 10_000); // peer is 10s ahead (within skew tolerance)
  expect(c.now()).toBe(T0 + 10_001); // beats the peer's stamp
});

test('observe() ignores peer stamps we already out-clock', () => {
  const time = fakeTime(T0 + 50_000);
  const c = new LogicalClock({ physicalNow: time.fn });
  const mine = c.now(); // T0 + 50_000
  c.observe(T0); // stale peer
  expect(c.now()).toBe(mine + 1);
});

test('observe() clamps a grossly-future peer to physical + maxSkew', () => {
  const time = fakeTime(T0);
  const c = new LogicalClock({ physicalNow: time.fn, maxSkewMs: 60_000 });
  c.observe(T0 + 365 * 24 * 3600 * 1000); // peer clock a year ahead
  // Clamped: our clock did not jump a year, only to now + 60s ceiling.
  expect(c.peek()).toBe(T0 + 60_000);
});

test('persistence is throttled to the configured granularity', () => {
  const time = fakeTime(T0);
  const writes: number[] = [];
  const c = new LogicalClock({ physicalNow: time.fn, persistGranularityMs: 2000 });
  c.init(T0, (v) => writes.push(v)); // restored at the current high-water mark
  c.now(); // tiny +1 advance, below granularity
  expect(writes).toHaveLength(0);
  time.advance(2500);
  c.now(); // jumped 2500ms past last persist -> persists
  expect(writes).toHaveLength(1);
  expect(writes[0]).toBe(T0 + 2500);
});

test('init() raises the high-water mark but never lowers it', () => {
  const c = new LogicalClock({ physicalNow: () => T0 });
  c.init(T0 + 99_999, () => {});
  expect(c.peek()).toBe(T0 + 99_999);
  c.init(T0, () => {}); // a lower persisted value must not regress it
  expect(c.peek()).toBe(T0 + 99_999);
});
