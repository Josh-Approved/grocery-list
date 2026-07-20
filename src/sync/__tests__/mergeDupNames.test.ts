/**
 * Duplicate-name collapse + the check state's own clock — the merge behaviours
 * that make two devices' "Milk" rows converge to ONE row with the household's
 * real check intent on it (see merge.ts header). These pin the exact semantics
 * the T2 mutation run showed the suite was blind to:
 *
 *   • checkedClock's addedAt fallback: a never-checked item counts as
 *     "unchecked since it was added" — a stale check can't cross it off.
 *   • combineItems tie: on a check-clock tie the record winner's state stands.
 *   • keepership: a tombstoned namesake never steals keepership from the live
 *     row; among live copies the freshest wins (updatedAt, then addedAt, then
 *     smallest id) identically from both merge directions.
 *   • losers are tombstoned at their own clock (drives pruning horizons).
 *   • check-fold ties resolve to UNCHECKED (the safe branch — the item stays
 *     on the list) and the group's newest check clock is carried forward.
 *   • a no-op fold preserves the keeper's object identity (memoized rows).
 *   • payload-stripped tombstones (name cleared) never join a name group.
 *
 * Every scenario asserts BOTH merge directions: convergence is the contract.
 */

import { mergeList } from '../merge';
import { makeList } from '../../data/list';
import type { GroceryItem, GroceryList } from '../../data/list';

const T0 = 1_700_000_000_000;

function item(over: Partial<GroceryItem> & { id: string }): GroceryItem {
  return {
    name: over.id,
    quantity: 1,
    category: 'Pantry',
    checked: false,
    addedAt: T0,
    updatedAt: T0,
    ...over,
  };
}

function listWith(items: GroceryItem[]): GroceryList {
  return { ...makeList('Base'), updatedAt: T0, createdAt: T0, items };
}

/** Merge both directions and return both item sets — every assertion must
 *  hold on each (convergence). */
function bothWays(a: GroceryItem[], b: GroceryItem[]): GroceryItem[][] {
  return [
    mergeList(listWith(a), listWith(b)).items,
    mergeList(listWith(b), listWith(a)).items,
  ];
}

const live = (items: GroceryItem[]) => items.filter((i) => i.deletedAt == null);
const get = (items: GroceryItem[], id: string) => items.find((i) => i.id === id);

// ---------------------------------------------------------------------------
// checkedClock — the addedAt fallback for never-checked items
// ---------------------------------------------------------------------------

describe('check clock — a never-checked item is "unchecked since it was added"', () => {
  it('a stale check (older than the add) cannot cross off the fresher copy', () => {
    // Same id on both sides. The winner (newer content) was added at T0+100
    // and never checked; the loser carries a check from BEFORE that add.
    // The item was re-added after the old check — it must stay unchecked.
    const winner = item({ id: 'x', name: 'Milk', addedAt: T0 + 100, updatedAt: T0 + 200 });
    const loser = item({
      id: 'x',
      name: 'Milk',
      addedAt: T0 + 100,
      updatedAt: T0,
      checked: true,
      checkedAt: T0 + 50,
      checkedUpdatedAt: T0 + 50,
    });
    for (const out of bothWays([winner], [loser])) {
      expect(get(out, 'x')?.checked).toBe(false);
      expect(get(out, 'x')?.checkedAt).toBeUndefined();
    }
  });

  it('a check NEWER than the add does land on the never-checked copy', () => {
    const winner = item({ id: 'x', name: 'Milk', addedAt: T0 + 100, updatedAt: T0 + 200 });
    const loser = item({
      id: 'x',
      name: 'Milk',
      addedAt: T0 + 100,
      updatedAt: T0,
      checked: true,
      checkedAt: T0 + 150,
      checkedUpdatedAt: T0 + 150,
    });
    for (const out of bothWays([winner], [loser])) {
      expect(get(out, 'x')?.checked).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// combineItems — on a check-clock tie the record winner's state stands
// ---------------------------------------------------------------------------

describe('check clock — exact tie keeps the record winner state', () => {
  it('a tied check-clock never folds the loser state over the winner', () => {
    // Both copies stamped the same check-clock millisecond; the content winner
    // is unchecked. Folding the loser's check in on a mere tie would make the
    // outcome depend on which copy lost — the winner's state must stand.
    const winner = item({
      id: 'x',
      name: 'Milk',
      updatedAt: T0 + 100,
      checked: false,
      checkedUpdatedAt: T0 + 50,
    });
    const loser = item({
      id: 'x',
      name: 'Milk',
      updatedAt: T0,
      checked: true,
      checkedAt: T0 + 50,
      checkedUpdatedAt: T0 + 50,
    });
    for (const out of bothWays([winner], [loser])) {
      expect(get(out, 'x')?.checked).toBe(false);
      expect(get(out, 'x')?.checkedAt).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Keepership — who survives a duplicate-name collapse
// ---------------------------------------------------------------------------

describe('duplicate-name collapse — keepership', () => {
  it('a tombstoned namesake never steals keepership from the live row', () => {
    // The dead copy has the NEWER content clock. If it could win keepership,
    // the live "Milk" would get tombstoned and the item would vanish from the
    // list entirely — only LIVE copies compete.
    const liveMilk = item({ id: 'live1', name: 'Milk', updatedAt: T0 + 100 });
    const deadMilk = item({
      id: 'dead1',
      name: 'Milk',
      updatedAt: T0 + 500,
      deletedAt: T0 + 600,
    });
    for (const out of bothWays([liveMilk], [deadMilk])) {
      expect(get(out, 'live1')?.deletedAt).toBeUndefined(); // still on the list
      expect(get(out, 'dead1')?.deletedAt).toBe(T0 + 600); // still gone
      expect(live(out).map((i) => i.name)).toEqual(['Milk']);
    }
  });

  it('on an updatedAt tie the more recently ADDED copy survives, from both sides', () => {
    const older = item({ id: 'a1', name: 'Milk', quantity: 2, addedAt: T0 + 50, updatedAt: T0 + 100 });
    const newer = item({ id: 'b1', name: 'Milk', quantity: 5, addedAt: T0 + 80, updatedAt: T0 + 100 });
    for (const out of bothWays([older], [newer])) {
      expect(get(out, 'b1')?.deletedAt).toBeUndefined();
      expect(get(out, 'b1')?.quantity).toBe(5); // the keeper keeps its own content
      // The loser is tombstoned at its OWN clock (drives the pruning horizon).
      expect(get(out, 'a1')?.deletedAt).toBe(older.updatedAt);
    }
  });

  it('on a full clock tie the smallest id survives — identical on every device', () => {
    const aa = item({ id: 'aa', name: 'Milk', updatedAt: T0 + 100 });
    const bb = item({ id: 'bb', name: 'Milk', updatedAt: T0 + 100 });
    for (const out of bothWays([aa], [bb])) {
      expect(get(out, 'aa')?.deletedAt).toBeUndefined();
      expect(get(out, 'bb')?.deletedAt).toBe(T0 + 100);
    }
  });
});

// ---------------------------------------------------------------------------
// The check fold across a name group
// ---------------------------------------------------------------------------

describe('duplicate-name collapse — check state folds by its clock, ties stay unchecked', () => {
  it('keeper unchecked + loser checked at the SAME clock → stays unchecked', () => {
    // Tie → unchecked is the safe branch: the item stays visible on the list
    // rather than silently crossing off.
    const keeper = item({
      id: 'k1',
      name: 'Milk',
      updatedAt: T0 + 100,
      checked: false,
      checkedUpdatedAt: T0 + 50,
    });
    const loser = item({
      id: 'l1',
      name: 'Milk',
      updatedAt: T0,
      checked: true,
      checkedAt: T0 + 50,
      checkedUpdatedAt: T0 + 50,
    });
    for (const out of bothWays([keeper], [loser])) {
      expect(get(out, 'k1')?.checked).toBe(false);
    }
  });

  it('keeper checked + loser unchecked at the SAME clock → resolves to unchecked', () => {
    const keeper = item({
      id: 'k1',
      name: 'Milk',
      updatedAt: T0 + 100,
      checked: true,
      checkedAt: T0 + 50,
      checkedUpdatedAt: T0 + 50,
    });
    const loser = item({
      id: 'l1',
      name: 'Milk',
      updatedAt: T0,
      checked: false,
      checkedUpdatedAt: T0 + 50,
    });
    for (const out of bothWays([keeper], [loser])) {
      expect(get(out, 'k1')?.checked).toBe(false);
      expect(get(out, 'k1')?.checkedAt).toBeUndefined();
    }
  });

  it('legacy copies with NO check stamps tie on addedAt and resolve to unchecked', () => {
    // Old-version records carry neither checkedAt nor checkedUpdatedAt — both
    // clocks fall back to addedAt. The tie must still resolve to unchecked.
    const keeper = item({ id: 'k1', name: 'Milk', addedAt: T0, updatedAt: T0 + 100, checked: true });
    const loser = item({ id: 'l1', name: 'Milk', addedAt: T0, updatedAt: T0, checked: false });
    for (const out of bothWays([keeper], [loser])) {
      expect(get(out, 'k1')?.checked).toBe(false);
    }
  });

  it("carries the group's newest check clock onto the keeper (re-merge is a fixed point)", () => {
    // Both copies checked at the same moment, but the loser's check clock has
    // advanced further (a fold on another device). The keeper must adopt the
    // newest clock or later merges could flip the state back and forth.
    const keeper = item({
      id: 'k1',
      name: 'Milk',
      updatedAt: T0 + 100,
      checked: true,
      checkedAt: T0 + 50,
      checkedUpdatedAt: T0 + 50,
    });
    const loser = item({
      id: 'l1',
      name: 'Milk',
      updatedAt: T0,
      checked: true,
      checkedAt: T0 + 50,
      checkedUpdatedAt: T0 + 80,
    });
    for (const out of bothWays([keeper], [loser])) {
      expect(get(out, 'k1')?.checked).toBe(true);
      expect(get(out, 'k1')?.checkedUpdatedAt).toBe(T0 + 80);
    }
  });

  it('a no-op fold keeps the keeper object identity (memoized rows do not re-render)', () => {
    const keeper = item({
      id: 'k1',
      name: 'Milk',
      updatedAt: T0 + 100,
      checked: false,
      checkedUpdatedAt: T0 + 50,
    });
    const loser = item({
      id: 'l1',
      name: 'Milk',
      updatedAt: T0,
      checked: false,
      checkedUpdatedAt: T0 + 50,
    });
    const out = mergeList(listWith([keeper]), listWith([loser])).items;
    // The fold changes nothing about the keeper's check state, so the exact
    // same object must come back — not a value-equal copy.
    expect(get(out, 'k1')).toBe(keeper);
  });

  it('a payload-stripped tombstone (name cleared) never donates state to a name group', () => {
    // Stripping empties the name; normalization maps whitespace names to the
    // same '' key. The stripped tombstone must not group with (and check off)
    // an unrelated row.
    const oddLive = item({ id: 'w1', name: ' ', addedAt: T0, updatedAt: T0 + 100 });
    const stripped = item({
      id: 'g1',
      name: '',
      updatedAt: T0,
      deletedAt: T0 + 50,
      checked: true,
      checkedAt: T0 + 90,
      checkedUpdatedAt: T0 + 90,
    });
    for (const out of bothWays([oddLive], [stripped])) {
      expect(get(out, 'w1')?.checked).toBe(false);
      expect(get(out, 'w1')?.deletedAt).toBeUndefined();
    }
  });
});
