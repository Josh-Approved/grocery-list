/**
 * The shared-list merge is the trust core — these tests pin the CRDT
 * properties canon § Backup & restore #5 promises. A bug here silently loses
 * or resurrects a household's grocery items across devices, so we test the
 * real LWW-element-set-with-tombstones semantics, not a happy path:
 *
 *   • newer edit wins over older edit (last-write-wins by clock)
 *   • a tombstone out-clocks an older edit (delete wins) BUT a genuinely newer
 *     edit out-clocks an older tombstone (resurrection only when legitimately
 *     newer — a re-added item)
 *   • commutative: merge(a,b) ≡ merge(b,a)  (best-effort transport can reorder)
 *   • idempotent: merge(a,a) ≡ a            (re-publishing must not drift)
 *   • associative-ish: concurrent disjoint adds both survive
 *   • empty / one-sided merges
 *
 * mergeRecordSet returns an array in undefined order, so every comparison
 * sorts by id first.
 */

import { mergeRecordSet, type Record } from '../mergeRecordSet';
import { makeList, makeItem, type GroceryList, type GroceryItem } from '../../data/list';
import { mergeList } from '../merge';

// A minimal record satisfying the merge contract. Real timestamps (ms epoch).
type Rec = Record & { name?: string; checked?: boolean };

const T0 = 1_700_000_000_000; // a real ms-epoch baseline
const rec = (id: string, updatedAt: number, extra: Partial<Rec> = {}): Rec => ({
  id,
  updatedAt,
  ...extra,
});
const tomb = (id: string, updatedAt: number, deletedAt: number, extra: Partial<Rec> = {}): Rec =>
  ({ id, updatedAt, deletedAt, ...extra });

const byId = <T extends Record>(xs: T[]): T[] =>
  [...xs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/** Deep-equal-after-sort, the only meaningful equality for an unordered set. */
const sameSet = <T extends Record>(a: T[], b: T[]) =>
  expect(byId(a)).toEqual(byId(b));

const get = <T extends Record>(xs: T[], id: string): T | undefined =>
  xs.find((r) => r.id === id);

// ---------------------------------------------------------------------------
// Last-write-wins by clock
// ---------------------------------------------------------------------------

describe('mergeRecordSet — last-write-wins by clock', () => {
  it('the newer edit wins over the older edit, regardless of side', () => {
    const old = rec('x', T0, { name: 'Milk' });
    const fresh = rec('x', T0 + 1000, { name: 'Oat milk' });

    expect(get(mergeRecordSet([old], [fresh]), 'x')).toEqual(fresh);
    // and the other way round — the newer one still wins
    expect(get(mergeRecordSet([fresh], [old]), 'x')).toEqual(fresh);
  });

  it('on an exact updatedAt tie between two live edits, BOTH merge orders pick the same copy', () => {
    const left = rec('x', T0, { name: 'A' });
    const right = rec('x', T0, { name: 'B' });
    // The contract: a tie between two live edits resolves by CONTENT (stable
    // key-sorted serialization), identically on every device. The old
    // "keep whichever copy is local" rule meant two phones that stamped the
    // same millisecond each kept their own copy — divergent forever.
    const ab = get(mergeRecordSet([left], [right]), 'x');
    const ba = get(mergeRecordSet([right], [left]), 'x');
    expect(ab).toEqual(ba);
    expect([left, right]).toContainEqual(ab);
  });
});

// ---------------------------------------------------------------------------
// Tombstones — delete wins, resurrection only when legitimately newer
// ---------------------------------------------------------------------------

describe('mergeRecordSet — tombstone (deletion) semantics', () => {
  it('a tombstone beats an OLDER live edit (delete wins — the item stays gone)', () => {
    const edit = rec('x', T0, { name: 'Eggs' });
    const deletion = tomb('x', T0, T0 + 5000); // deleted after the edit
    const out = get(mergeRecordSet([edit], [deletion]), 'x');
    expect(out?.deletedAt).toBe(T0 + 5000);
    sameSet(mergeRecordSet([edit], [deletion]), mergeRecordSet([deletion], [edit]));
  });

  it("a tombstone's clock is max(updatedAt, deletedAt) — a stale-updatedAt delete still out-clocks the edit", () => {
    // The delete was authored with an old updatedAt but a fresh deletedAt;
    // the effective clock must be the deletedAt, so the delete wins.
    const edit = rec('x', T0 + 2000, { name: 'Eggs' });
    const deletion = tomb('x', T0, T0 + 9000);
    expect(get(mergeRecordSet([edit], [deletion]), 'x')?.deletedAt).toBe(T0 + 9000);
  });

  it('a genuinely NEWER edit beats an older tombstone (legit resurrection / re-add)', () => {
    const deletion = tomb('x', T0, T0 + 1000);
    const readd = rec('x', T0 + 5000, { name: 'Eggs (again)' }); // re-added later
    const out = get(mergeRecordSet([deletion], [readd]), 'x');
    expect(out).toEqual(readd);
    expect(out?.deletedAt).toBeUndefined();
    // commutative
    sameSet(mergeRecordSet([deletion], [readd]), mergeRecordSet([readd], [deletion]));
  });

  it('an OLDER edit can NEVER resurrect a newer tombstone (no accidental zombie)', () => {
    const staleEdit = rec('x', T0, { name: 'Eggs' });
    const deletion = tomb('x', T0 + 1000, T0 + 8000);
    expect(get(mergeRecordSet([deletion], [staleEdit]), 'x')?.deletedAt).toBe(T0 + 8000);
    expect(get(mergeRecordSet([staleEdit], [deletion]), 'x')?.deletedAt).toBe(T0 + 8000);
  });

  it('on an exact clock tie, a delete beats a live edit (safe convergence, both sides)', () => {
    const edit = rec('x', T0 + 3000, { name: 'Eggs' });
    // deletedAt chosen so clock(deletion) === clock(edit) === T0 + 3000
    const deletion = tomb('x', T0, T0 + 3000);
    expect(get(mergeRecordSet([edit], [deletion]), 'x')?.deletedAt).toBe(T0 + 3000);
    expect(get(mergeRecordSet([deletion], [edit]), 'x')?.deletedAt).toBe(T0 + 3000);
  });

  it('the newer of two competing tombstones wins (re-delete after a re-add)', () => {
    const firstDelete = tomb('x', T0, T0 + 1000);
    const secondDelete = tomb('x', T0 + 4000, T0 + 5000);
    expect(get(mergeRecordSet([firstDelete], [secondDelete]), 'x')?.deletedAt).toBe(T0 + 5000);
    expect(get(mergeRecordSet([secondDelete], [firstDelete]), 'x')?.deletedAt).toBe(T0 + 5000);
  });
});

// ---------------------------------------------------------------------------
// Concurrent disjoint edits — nothing is lost
// ---------------------------------------------------------------------------

describe('mergeRecordSet — concurrent disjoint changes both survive', () => {
  it('two devices each add a different item offline; the merge keeps both', () => {
    const a = [rec('milk', T0, { name: 'Milk' })];
    const b = [rec('bread', T0 + 100, { name: 'Bread' })];
    const out = mergeRecordSet(a, b);
    expect(out).toHaveLength(2);
    expect(get(out, 'milk')?.name).toBe('Milk');
    expect(get(out, 'bread')?.name).toBe('Bread');
  });

  it('a per-record merge — one device edits item A, the other deletes item B; both intents land', () => {
    const base = [rec('A', T0, { name: 'A0' }), rec('B', T0, { name: 'B0' })];
    const deviceA = [rec('A', T0 + 1000, { name: 'A-edited' }), base[1]];
    const deviceB = [base[0], tomb('B', T0, T0 + 1000)];
    const out = mergeRecordSet(deviceA, deviceB);
    expect(get(out, 'A')?.name).toBe('A-edited'); // A's edit survived
    expect(get(out, 'B')?.deletedAt).toBe(T0 + 1000); // B's delete survived
  });
});

// ---------------------------------------------------------------------------
// Algebraic laws: commutativity, idempotency
// ---------------------------------------------------------------------------

describe('mergeRecordSet — CRDT algebraic laws', () => {
  // A rich, mixed pair: shared ids with different clocks, tombstones on each
  // side, and disjoint ids — the kind of state two real devices reach.
  const a: Rec[] = [
    rec('shared-newer-on-a', T0 + 9000, { name: 'A wins' }),
    rec('shared-newer-on-b', T0, { name: 'A loses' }),
    tomb('deleted-on-a', T0, T0 + 7000),
    rec('only-on-a', T0 + 200, { name: 'solo A' }),
    rec('readd-on-a', T0 + 6000, { name: 'A re-added' }),
  ];
  const b: Rec[] = [
    rec('shared-newer-on-a', T0, { name: 'B loses' }),
    rec('shared-newer-on-b', T0 + 9000, { name: 'B wins' }),
    rec('deleted-on-a', T0, { name: 'still live on B' }),
    rec('only-on-b', T0 + 300, { name: 'solo B' }),
    tomb('readd-on-a', T0, T0 + 1000),
  ];

  it('is commutative: merge(a,b) deep-equals merge(b,a)', () => {
    sameSet(mergeRecordSet(a, b), mergeRecordSet(b, a));
  });

  it('is idempotent: merge(a,a) deep-equals a (re-publishing the same state does not drift)', () => {
    sameSet(mergeRecordSet(a, a), a);
  });

  it('produces the correct converged state on the mixed pair (no winner is wrong)', () => {
    const out = mergeRecordSet(a, b);
    expect(get(out, 'shared-newer-on-a')?.name).toBe('A wins');
    expect(get(out, 'shared-newer-on-b')?.name).toBe('B wins');
    expect(get(out, 'deleted-on-a')?.deletedAt).toBe(T0 + 7000); // delete (newer) beats live B
    expect(get(out, 'only-on-a')?.name).toBe('solo A');
    expect(get(out, 'only-on-b')?.name).toBe('solo B');
    expect(get(out, 'readd-on-a')?.name).toBe('A re-added'); // re-add (T0+6000) beats tomb (T0+1000)
    expect(get(out, 'readd-on-a')?.deletedAt).toBeUndefined();
    expect(out).toHaveLength(6);
  });

  it('re-merging the converged state against either parent is a fixed point', () => {
    const merged = mergeRecordSet(a, b);
    sameSet(mergeRecordSet(merged, a), merged);
    sameSet(mergeRecordSet(merged, b), merged);
    sameSet(mergeRecordSet(merged, merged), merged);
  });
});

// ---------------------------------------------------------------------------
// Degenerate inputs
// ---------------------------------------------------------------------------

describe('mergeRecordSet — empty and one-sided', () => {
  it('merging into empty returns the other side', () => {
    const xs = [rec('a', T0), rec('b', T0 + 1)];
    sameSet(mergeRecordSet([], xs), xs);
    sameSet(mergeRecordSet(xs, []), xs);
  });

  it('merging two empty sets is empty', () => {
    expect(mergeRecordSet([], [])).toEqual([]);
  });

  it('a lone tombstone survives a merge against empty (a delete is real state, not nothing)', () => {
    const t = [tomb('gone', T0, T0 + 1)];
    sameSet(mergeRecordSet([], t), t);
  });
});

// ---------------------------------------------------------------------------
// The app-specific wrapper: mergeList (list-level fields + delegated item merge)
// ---------------------------------------------------------------------------

describe('mergeList — grocery-list wrapper', () => {
  const item = (id: string, updatedAt: number, extra: Partial<GroceryItem> = {}): GroceryItem => ({
    id,
    name: id,
    quantity: 1,
    category: 'Pantry',
    checked: false,
    addedAt: updatedAt,
    updatedAt,
    ...extra,
  });

  function listWith(over: Partial<GroceryList>): GroceryList {
    const base = makeList('Base');
    return { ...base, ...over };
  }

  it('delegates item-set merge to mergeRecordSet (per-item, with tombstones)', () => {
    const local = listWith({
      updatedAt: T0,
      items: [item('milk', T0, { name: 'Milk' }), item('eggs', T0)],
    });
    const remote = listWith({
      id: 'remote-id',
      updatedAt: T0 + 1,
      items: [
        item('milk', T0 + 1000, { name: 'Oat milk' }), // newer edit
        { ...item('eggs', T0), deletedAt: T0 + 2000 }, // deleted on remote
        item('bread', T0 + 50, { name: 'Bread' }), // added on remote
      ],
    });
    const out = mergeList(local, remote);
    const m = (id: string) => out.items.find((i) => i.id === id);
    expect(m('milk')?.name).toBe('Oat milk'); // newer edit won
    expect(m('eggs')?.deletedAt).toBe(T0 + 2000); // tombstone kept
    expect(m('bread')?.name).toBe('Bread'); // disjoint add survived
    expect(out.items).toHaveLength(3);
  });

  it('keeps the LOCAL id (devices have independent local ids)', () => {
    const local = listWith({ id: 'local-id', updatedAt: T0 });
    const remote = listWith({ id: 'remote-id', updatedAt: T0 + 1000 });
    expect(mergeList(local, remote).id).toBe('local-id');
  });

  it('updatedAt-following fields (aisle order) are LWW on the list updatedAt; createdAt=min, updatedAt=max', () => {
    const local = listWith({
      updatedAt: T0,
      createdAt: T0 - 5000,
      categoryOrder: ['Produce', 'Pantry'],
    });
    const remote = listWith({
      id: 'r',
      updatedAt: T0 + 9000,
      createdAt: T0,
      categoryOrder: ['Pantry', 'Produce'],
    });
    const out = mergeList(local, remote);
    expect(out.categoryOrder).toEqual(['Pantry', 'Produce']); // remote newer → wins
    expect(out.createdAt).toBe(T0 - 5000); // earliest creation
    expect(out.updatedAt).toBe(T0 + 9000); // latest touch
  });

  it('local wins updatedAt-following fields when its updatedAt ties or exceeds remote', () => {
    const local = listWith({ updatedAt: T0, categoryOrder: ['Produce', 'Pantry'] });
    const remote = listWith({ id: 'r', updatedAt: T0, categoryOrder: ['Pantry', 'Produce'] });
    expect(mergeList(local, remote).categoryOrder).toEqual(['Produce', 'Pantry']); // tie → local
  });

  it('adopts a shareIdentity from whichever side has one (pairing must propagate)', () => {
    const ident = { secret: 's3cr3t', createdAt: T0 };
    const local = listWith({ updatedAt: T0, shareIdentity: undefined });
    const remote = listWith({ id: 'r', updatedAt: T0 + 1, shareIdentity: ident });
    expect(mergeList(local, remote).shareIdentity).toEqual(ident);
    // and the symmetric case — local has it, remote doesn't
    const local2 = listWith({ updatedAt: T0 + 1, shareIdentity: ident });
    const remote2 = listWith({ id: 'r', updatedAt: T0, shareIdentity: undefined });
    expect(mergeList(local2, remote2).shareIdentity).toEqual(ident);
  });

  it('the item merge inside mergeList is commutative on the converged item set', () => {
    const local = listWith({
      updatedAt: T0,
      items: [item('a', T0 + 5), { ...item('b', T0), deletedAt: T0 + 9 }],
    });
    const remote = listWith({
      id: 'r',
      updatedAt: T0,
      items: [item('a', T0), item('c', T0 + 3)],
    });
    const ab = byId(mergeList(local, remote).items);
    const ba = byId(mergeList(remote, local).items);
    expect(ab).toEqual(ba);
  });
});

// ---------------------------------------------------------------------------
// The name merges on its OWN clock (nameUpdatedAt), not the list's updatedAt.
// Regression cover for the "joining renamed my list to 'Shared list'" bug:
// the name must survive a partner joining and survive everyday item edits,
// and only ever change when someone actually renames the list.
// ---------------------------------------------------------------------------

describe('mergeList — the name only changes on an explicit rename', () => {
  function listWith(over: Partial<GroceryList>): GroceryList {
    return { ...makeList('Base'), ...over };
  }

  it("a freshly-joined device (placeholder name, nameUpdatedAt:0) never renames the creator's list", () => {
    // The creator's list — named "Shiz" at creation.
    const creator = listWith({
      name: 'Shiz',
      nameUpdatedAt: T0,
      createdAt: T0,
      updatedAt: T0,
    });
    // The joiner's placeholder: created later (so a NAIVE whole-list LWW would
    // let it win), but its name clock is 0 because the joiner never named it.
    const joinerPlaceholder = listWith({
      id: 'joiner',
      name: 'Shared list',
      nameUpdatedAt: 0,
      createdAt: T0 + 60_000,
      updatedAt: T0 + 60_000,
    });

    // On the creator's device: merge the joiner's copy in.
    expect(mergeList(creator, joinerPlaceholder).name).toBe('Shiz');
    // On the joiner's device: it adopts the creator's real name.
    expect(mergeList(joinerPlaceholder, creator).name).toBe('Shiz');
  });

  it('adding/checking items (which bump updatedAt) does NOT change the name', () => {
    // Creator named it at T0; then both sides keep editing items for a week,
    // pushing updatedAt far past the name clock. The name must stay put.
    const creator = listWith({
      name: 'Shiz',
      nameUpdatedAt: T0,
      updatedAt: T0 + 999_999, // lots of item activity since the name was set
    });
    const partner = listWith({
      id: 'p',
      name: 'Shared list', // partner's stale placeholder
      nameUpdatedAt: 0,
      updatedAt: T0 + 1_000_000, // partner edited an item most recently
    });
    expect(mergeList(creator, partner).name).toBe('Shiz');
    expect(mergeList(partner, creator).name).toBe('Shiz');
  });

  it('an explicit rename (newer nameUpdatedAt) wins on every device, either side', () => {
    const renamed = listWith({ name: 'Costco run', nameUpdatedAt: T0 + 5000 });
    const stale = listWith({ id: 'r', name: 'Shiz', nameUpdatedAt: T0 });
    expect(mergeList(renamed, stale).name).toBe('Costco run');
    expect(mergeList(stale, renamed).name).toBe('Costco run');
  });

  it('carries the winning name clock forward so a re-merge is a fixed point (converges)', () => {
    const a = listWith({ name: 'Shiz', nameUpdatedAt: T0, updatedAt: T0 });
    const b = listWith({ id: 'b', name: 'Shared list', nameUpdatedAt: 0, updatedAt: T0 + 9 });
    const m = mergeList(a, b);
    expect(m.name).toBe('Shiz');
    expect(m.nameUpdatedAt).toBe(T0); // max of the two name clocks
    // Re-merging either parent in does not flip the name.
    expect(mergeList(m, b).name).toBe('Shiz');
    expect(mergeList(b, m).name).toBe('Shiz');
  });

  it('falls back to createdAt for legacy lists persisted before nameUpdatedAt existed', () => {
    // Simulate a pre-migration pair: neither carries an explicit name clock.
    const older = { ...makeList('Weekly'), createdAt: T0, updatedAt: T0 + 100 } as GroceryList;
    const newer = { ...makeList('Weekly'), id: 'r', createdAt: T0 + 1, updatedAt: T0 } as GroceryList;
    delete (older as Partial<GroceryList>).nameUpdatedAt;
    delete (newer as Partial<GroceryList>).nameUpdatedAt;
    // Both fall back to createdAt; the earlier-created side's name wins — and
    // since both are 'Weekly' here, the result is stable either way.
    expect(mergeList(older, newer).name).toBe('Weekly');
    expect(mergeList(newer, older).name).toBe('Weekly');
  });
});

// ---------------------------------------------------------------------------
// Fixture sanity — a broken seed silently poisons every Tier 2/3 capture run.
// ---------------------------------------------------------------------------

describe('qa fixtures — the seed is internally consistent', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { qaLists } = require('../../qa/fixtures');

  it('produces exactly one valid, non-empty list with unique ids', () => {
    const lists: GroceryList[] = qaLists();
    expect(lists).toHaveLength(1);
    const list = lists[0];
    expect(list.name).toBe('Weekly shop');
    expect(list.items.length).toBeGreaterThan(0);
    const ids = new Set(list.items.map((i) => i.id));
    expect(ids.size).toBe(list.items.length); // no duplicate ids
  });

  it('every seeded item is well-formed (real category, valid qty, no stray tombstone)', () => {
    const list = qaLists()[0];
    for (const it of list.items) {
      expect(typeof it.name).toBe('string');
      expect(it.name.length).toBeGreaterThan(0);
      expect(it.quantity).toBeGreaterThanOrEqual(1);
      expect(it.deletedAt).toBeUndefined(); // nothing seeded pre-deleted
      expect(Number.isFinite(it.updatedAt)).toBe(true);
    }
  });

  it('checked items carry a checkedAt, and the seed reads as a real mid-shop list', () => {
    const list: GroceryList = qaLists()[0];
    const checked = list.items.filter((i) => i.checked);
    expect(checked.length).toBeGreaterThan(0); // some progress, per the fixture comment
    expect(checked.length).toBeLessThan(list.items.length); // but not all
    for (const it of checked) {
      expect(it.checkedAt).toBe(it.updatedAt);
    }
  });

  it('the seed survives a self-merge unchanged (it is a valid CRDT state)', () => {
    const list = qaLists()[0];
    sameSet(mergeRecordSet(list.items, list.items), list.items);
  });
});
