/**
 * Regression: the clock-skew failure modes Josh reported are fixed.
 *
 * Models two paired devices, each with its OWN logical clock (one phone an hour
 * fast), stamping edits and exchanging whole-list copies through the real
 * `mergeList` — exactly the engine's data path. Before this fix these scenarios
 * lost edits and made items disappear; the asserts pin the corrected behaviour.
 *
 * The companion `_scratch_skew` demonstration (run during diagnosis, not kept)
 * showed the OLD raw-`Date.now()` merge losing a fresh edit and vanishing an
 * item. Here the same scenarios converge correctly.
 */
import { LogicalClock } from '../clock';
import { mergeList } from '../merge';
import type { GroceryItem, GroceryList } from '../../data/list';

const SECRET = 'shared-secret-xyz';
const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;

/** Shared "real" wall time the two fake device clocks are offset from. */
let real = T0;

class Device {
  list: GroceryList;
  readonly clock: LogicalClock;
  constructor(label: string, skewMs: number) {
    this.clock = new LogicalClock({ physicalNow: () => real + skewMs });
    const at = this.clock.now();
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

  /** Upsert an item (create or edit), stamping with this device's clock. */
  setItem(id: string, patch: Partial<GroceryItem>): void {
    const at = this.clock.now();
    const existing = this.list.items.find((it) => it.id === id);
    const base: GroceryItem = existing ?? {
      id,
      name: id,
      quantity: 1,
      category: 'Other',
      checked: false,
      addedAt: at,
      updatedAt: at,
    };
    const next = { ...base, ...patch, updatedAt: at };
    const items = existing
      ? this.list.items.map((it) => (it.id === id ? next : it))
      : [...this.list.items, next];
    this.list = { ...this.list, items, updatedAt: at };
  }

  delete(id: string): void {
    this.setItem(id, { deletedAt: this.clock.now() });
  }

  /** Receive a peer copy: fold its clock in, then merge (engine's data path). */
  receive(remote: GroceryList): void {
    let max = Math.max(remote.updatedAt, remote.nameUpdatedAt);
    for (const it of remote.items) max = Math.max(max, it.updatedAt, it.deletedAt ?? 0);
    this.clock.observe(max);
    this.list = mergeList(this.list, remote);
  }

  qty(id: string): number | 'GONE' {
    const it = this.list.items.find((x) => x.id === id && x.deletedAt == null);
    return it ? it.quantity : 'GONE';
  }
}

beforeEach(() => {
  real = T0;
});

test('a fresh edit beats a stale edit from the fast phone (no more lost edits)', () => {
  const fast = new Device('fast', HOUR); // wife's-fast-phone analogue
  const ok = new Device('ok', 0);

  // Both already share "milk ×1" (it propagated once, so same id).
  fast.setItem('milk', { quantity: 1 });
  ok.receive(fast.list); // ok now has milk, clock lifted past fast's stamp
  expect(ok.qty('milk')).toBe(1);

  // A minute later, the correct-clock phone corrects it to ×2.
  real += 60_000;
  ok.setItem('milk', { quantity: 2 });

  // Exchange. The correction wins on BOTH — it was the last action in causal
  // order, even though the other phone's wall clock is an hour ahead.
  fast.receive(ok.list);
  expect(ok.qty('milk')).toBe(2);
  expect(fast.qty('milk')).toBe(2);
});

test('a re-added item stays put — no disappear/reappear flapping', () => {
  const fast = new Device('fast', HOUR);
  const ok = new Device('ok', 0);

  fast.setItem('milk', { quantity: 1 });
  ok.receive(fast.list);

  // Fast phone deletes milk; the other phone receives the delete → it vanishes.
  fast.delete('milk');
  ok.receive(fast.list);
  expect(ok.qty('milk')).toBe('GONE');

  // The user puts milk back. With the logical clock the re-add out-clocks the
  // stale fast-phone delete, so it sticks immediately instead of re-vanishing.
  real += 120_000;
  ok.setItem('milk', { quantity: 1, deletedAt: undefined });
  fast.receive(ok.list);
  expect(ok.qty('milk')).toBe(1);
  expect(fast.qty('milk')).toBe(1);
});

test('independent items from both devices both survive a merge', () => {
  const a = new Device('a', HOUR);
  const b = new Device('b', 0);
  a.setItem('eggs', { quantity: 1 });
  b.setItem('bread', { quantity: 2 });
  // Full round trip.
  b.receive(a.list);
  a.receive(b.list);
  for (const d of [a, b]) {
    expect(d.qty('eggs')).toBe(1);
    expect(d.qty('bread')).toBe(2);
  }
});
