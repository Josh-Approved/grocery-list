/**
 * Kit store + the kit→list add seam.
 *
 * Pins the two Josh-decided behaviours:
 *   - selecting a kit onto a list adds every ingredient ONCE, skipping anything
 *     already on the list (no doubling up), carrying the remembered quantity; and
 *   - building a kit de-dupes a re-added ingredient by bumping its quantity.
 *
 * State-only: the SQLite persist is fire-and-forget and its failure in node is
 * swallowed, so these exercise the in-memory store logic directly.
 */
// Stub the SQLite-backed persistence so the stores can be exercised in node
// (expo-sqlite can't load here). Persist is fire-and-forget; state is the SUT.
jest.mock('../db', () => ({
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

import { useListsStore } from '../lists';
import { useKitsStore } from '../kits';

const liveItems = (listId: string) =>
  useListsStore
    .getState()
    .getList(listId)!
    .items.filter((it) => it.deletedAt == null);

beforeEach(() => {
  useListsStore.setState({ lists: [], hydrated: true });
  useKitsStore.setState({ kits: [], hydrated: true });
});

describe('lists.addKitItems — selecting a kit onto a list', () => {
  test('adds every ingredient once, skipping what is already on the list', () => {
    const listId = useListsStore.getState().createList('Weekly');
    useListsStore.getState().addItem(listId, 'Celery');

    const added = useListsStore.getState().addKitItems(listId, [
      { name: 'Celery', quantity: 2, category: 'Produce' },
      { name: 'Mayonnaise', quantity: 1, category: 'Pantry' },
      { name: 'Rotisserie chicken', quantity: 3, category: 'Meat & seafood' },
    ]);

    // Celery was already present → skipped; the other two added.
    expect(added.map((it) => it.name).sort()).toEqual(
      ['Mayonnaise', 'Rotisserie chicken'].sort()
    );

    const names = liveItems(listId).map((it) => it.name);
    expect(names.filter((n) => n === 'Celery')).toHaveLength(1); // not doubled
    expect(names).toEqual(
      expect.arrayContaining(['Celery', 'Mayonnaise', 'Rotisserie chicken'])
    );

    // Remembered quantity carries onto the list.
    const chicken = liveItems(listId).find((it) => it.name === 'Rotisserie chicken')!;
    expect(chicken.quantity).toBe(3);
    expect(chicken.category).toBe('Meat & seafood');
  });

  test('de-dupes within the kit itself and returns [] when all present', () => {
    const listId = useListsStore.getState().createList('Weekly');
    const first = useListsStore.getState().addKitItems(listId, [
      { name: 'Eggs', quantity: 1, category: 'Dairy & eggs' },
      { name: 'eggs', quantity: 1, category: 'Dairy & eggs' }, // same, case-insensitive
    ]);
    expect(first).toHaveLength(1);

    // Adding the same kit again now finds everything present.
    const second = useListsStore.getState().addKitItems(listId, [
      { name: 'Eggs', quantity: 1, category: 'Dairy & eggs' },
    ]);
    expect(second).toHaveLength(0);
  });

  test('removeItems tombstones exactly the kit-added rows (the Undo)', () => {
    const listId = useListsStore.getState().createList('Weekly');
    const added = useListsStore.getState().addKitItems(listId, [
      { name: 'Salsa', quantity: 1, category: 'Pantry' },
      { name: 'Cheddar', quantity: 1, category: 'Dairy & eggs' },
    ]);
    useListsStore.getState().removeItems(listId, added.map((it) => it.id));
    expect(liveItems(listId)).toHaveLength(0);
  });
});

describe('kits.addKitItem — building a kit', () => {
  test('bumps quantity for a re-added ingredient (case-insensitive)', () => {
    const kitId = useKitsStore.getState().createKit('Chicken salad');
    useKitsStore.getState().addKitItem(kitId, 'Celery');
    useKitsStore.getState().addKitItem(kitId, 'celery');

    const live = useKitsStore
      .getState()
      .getKit(kitId)!
      .items.filter((it) => it.deletedAt == null);
    expect(live).toHaveLength(1);
    expect(live[0].quantity).toBe(2);
  });

  test('mergeRemoteKits folds in a peer kit', () => {
    const kitId = useKitsStore.getState().createKit('Taco night');
    useKitsStore.getState().addKitItem(kitId, 'Taco shells');

    useKitsStore.getState().mergeRemoteKits([
      {
        id: 'remote-kit',
        name: 'Pasta night',
        nameUpdatedAt: 5,
        items: [
          {
            id: 'ki-1',
            name: 'Spaghetti',
            quantity: 1,
            category: 'Pantry',
            updatedAt: 5,
          },
        ],
        createdAt: 5,
        updatedAt: 5,
      },
    ]);

    const ids = useKitsStore.getState().kits.map((k) => k.id);
    expect(ids).toEqual(expect.arrayContaining([kitId, 'remote-kit']));
  });
});
