/**
 * Kit-collection merge regressions.
 *
 * Kits ride the shared-list sync channels and converge as a record set by id,
 * with a per-kit item merge + name clock — the same conflict-free shape lists
 * use. These asserts pin: new-kit adoption, concurrent item edits merging,
 * tombstones at both the kit and item level (no resurrection), name-by-own-clock,
 * and commutativity/idempotence.
 */
import { mergeKit, mergeKits } from '../mergeKits';
import type { Kit, KitItem } from '../../data/kit';

function item(over: Partial<KitItem> & { id: string }): KitItem {
  return {
    name: over.id,
    quantity: 1,
    category: 'Other',
    updatedAt: 1,
    ...over,
  };
}

function kit(over: Partial<Kit> & { id: string }): Kit {
  return {
    name: over.id,
    nameUpdatedAt: 1,
    items: [],
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

const byId = (ks: Kit[]) => new Map(ks.map((k) => [k.id, k]));

describe('mergeKits — collection', () => {
  test('adopts a kit the local side has never seen', () => {
    const local = [kit({ id: 'a' })];
    const remote = [kit({ id: 'b' })];
    const merged = byId(mergeKits(local, remote));
    expect(merged.has('a')).toBe(true);
    expect(merged.has('b')).toBe(true);
  });

  test('commutative + idempotent for a set of kits', () => {
    const a = [
      kit({ id: 'a', updatedAt: 5, items: [item({ id: 'x', updatedAt: 5 })] }),
      kit({ id: 'b', updatedAt: 2 }),
    ];
    const b = [
      kit({ id: 'a', updatedAt: 3, items: [item({ id: 'y', updatedAt: 3 })] }),
      kit({ id: 'c', updatedAt: 9 }),
    ];
    const ab = mergeKits(a, b);
    const ba = mergeKits(b, a);
    // Same id set both ways.
    expect(new Set(ab.map((k) => k.id))).toEqual(new Set(ba.map((k) => k.id)));
    // Kit 'a' has both items regardless of order.
    const aMerged = byId(ab).get('a')!;
    expect(new Set(aMerged.items.map((i) => i.id))).toEqual(new Set(['x', 'y']));
    // Idempotent: merging the result again changes nothing.
    const twice = mergeKits(ab, b);
    expect(new Set(twice.map((k) => k.id))).toEqual(new Set(ab.map((k) => k.id)));
  });
});

describe('mergeKit — one kit, two copies', () => {
  test('concurrent ingredient adds both survive', () => {
    const local = kit({ id: 'k', items: [item({ id: 'celery', updatedAt: 2 })] });
    const remote = kit({ id: 'k', items: [item({ id: 'mayo', updatedAt: 2 })] });
    const merged = mergeKit(local, remote);
    expect(new Set(merged.items.map((i) => i.id))).toEqual(
      new Set(['celery', 'mayo'])
    );
  });

  test('item tombstone wins — a deleted ingredient stays deleted', () => {
    const local = kit({
      id: 'k',
      items: [item({ id: 'celery', updatedAt: 2 })],
    });
    const remote = kit({
      id: 'k',
      items: [item({ id: 'celery', updatedAt: 2, deletedAt: 5 })],
    });
    const merged = mergeKit(local, remote);
    expect(merged.items.find((i) => i.id === 'celery')!.deletedAt).toBe(5);
  });

  test('quantity LWW — the later quantity edit wins', () => {
    const local = kit({
      id: 'k',
      items: [item({ id: 'celery', quantity: 2, updatedAt: 3 })],
    });
    const remote = kit({
      id: 'k',
      items: [item({ id: 'celery', quantity: 5, updatedAt: 9 })],
    });
    expect(mergeKit(local, remote).items[0].quantity).toBe(5);
  });

  test('kit-level delete wins over an older edit, but a newer edit resurrects', () => {
    const deletedLate = mergeKit(
      kit({ id: 'k', updatedAt: 3 }),
      kit({ id: 'k', updatedAt: 3, deletedAt: 10 })
    );
    expect(deletedLate.deletedAt).toBe(10);

    const editedAfterDelete = mergeKit(
      kit({ id: 'k', updatedAt: 20 }), // a real edit after the peer's delete
      kit({ id: 'k', updatedAt: 3, deletedAt: 10 })
    );
    expect(editedAfterDelete.deletedAt).toBeUndefined();
  });

  test('name merges on its own clock, not the list updatedAt', () => {
    // Local has a busier updatedAt (item edits) but an OLD name; remote renamed.
    const local = kit({ id: 'k', name: 'Old', nameUpdatedAt: 1, updatedAt: 50 });
    const remote = kit({ id: 'k', name: 'New', nameUpdatedAt: 9, updatedAt: 2 });
    expect(mergeKit(local, remote).name).toBe('New');
  });
});

// ---------------------------------------------------------------------------
// Kit clock + name clock details the T2 mutation run showed were unpinned.
// A kit's effective clock is max(updatedAt, deletedAt) — same as the generic
// record clock — and ties resolve delete-first, then name lexicographically,
// identically from both merge directions.
// ---------------------------------------------------------------------------

describe('mergeKit — effective clock (max of edit and delete stamps)', () => {
  test('a delete out-clocks an edit that happened between authoring and deleting', () => {
    // The tombstone was AUTHORED at 3 but the delete happened at 10; an edit
    // at 5 on the other device must lose to the delete.
    const edited = kit({ id: 'k', updatedAt: 5 });
    const deleted = kit({ id: 'k', updatedAt: 3, deletedAt: 10 });
    expect(mergeKit(edited, deleted).deletedAt).toBe(10);
    expect(mergeKit(deleted, edited).deletedAt).toBe(10);
  });

  test("a tombstone with a NEWER updatedAt than its deletedAt still counts as dead at its newest stamp", () => {
    // clock(tombstone) = max(updatedAt, deletedAt): a dead copy touched at 12
    // beats a live edit at 5 even though the delete stamp itself is old.
    const liveEdit = kit({ id: 'k', updatedAt: 5 });
    const deadNewer = kit({ id: 'k', updatedAt: 12, deletedAt: 3 });
    expect(mergeKit(liveEdit, deadNewer).deletedAt).toBe(3);
    expect(mergeKit(deadNewer, liveEdit).deletedAt).toBe(3);
  });

  test('on an EXACT clock tie the delete wins — whichever side it lives on', () => {
    const liveCopy = kit({ id: 'k', updatedAt: 3 });
    const deadCopy = kit({ id: 'k', updatedAt: 3, deletedAt: 3 });
    // Dead copy arriving from the remote side…
    expect(mergeKit(liveCopy, deadCopy).deletedAt).toBe(3);
    // …and from the local side: same outcome (convergence).
    expect(mergeKit(deadCopy, liveCopy).deletedAt).toBe(3);
  });

  test('a genuinely newer remote edit resurrects an older LOCAL tombstone', () => {
    const localDead = kit({ id: 'k', updatedAt: 1, deletedAt: 5 });
    const remoteEdit = kit({ id: 'k', updatedAt: 9 });
    expect(mergeKit(localDead, remoteEdit).deletedAt).toBeUndefined();
  });
});

describe('mergeKit — name clock details', () => {
  test('a LOCAL rename with the newer name clock wins and the clock carries forward', () => {
    const renamed = kit({ id: 'k', name: 'New', nameUpdatedAt: 9, updatedAt: 2 });
    const stale = kit({ id: 'k', name: 'Old', nameUpdatedAt: 1, updatedAt: 50 });
    const out = mergeKit(renamed, stale);
    expect(out.name).toBe('New');
    expect(out.nameUpdatedAt).toBe(9); // max of the two name clocks — NaN/min would break re-merges
  });

  test('a name-clock tie converges to the lexicographically greater name on both devices', () => {
    const apples = kit({ id: 'k', name: 'Apples', nameUpdatedAt: 4 });
    const zest = kit({ id: 'k', name: 'Zest', nameUpdatedAt: 4 });
    expect(mergeKit(apples, zest).name).toBe('Zest');
    expect(mergeKit(zest, apples).name).toBe('Zest');
  });

  test('createdAt converges to the earliest and updatedAt to the latest stamp', () => {
    const a = kit({ id: 'k', createdAt: 3, updatedAt: 20 });
    const b = kit({ id: 'k', createdAt: 7, updatedAt: 11 });
    for (const out of [mergeKit(a, b), mergeKit(b, a)]) {
      expect(out.createdAt).toBe(3);
      expect(out.updatedAt).toBe(20);
    }
  });
});
