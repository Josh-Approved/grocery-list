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
