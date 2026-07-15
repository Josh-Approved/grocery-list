/**
 * Component test — the item editor sheet (Uplevel-3 T3 action coverage).
 *
 * ItemEditor is a prop-less `useItemEditor()` hook driven by the lists + account
 * Zustand stores; `open({ listId, itemId, onRemove })` reveals the Modal. We seed
 * the stores directly, drive the editor through a small harness, press each real
 * control, and assert the observable outcome — the store mutated (qty / aisle /
 * name / note / usual) or the `onRemove` callback fired. Queries go by
 * role/label/text only — no testID, no snapshots. `db.ts` (SQLite) is mocked so
 * the fire-and-forget persistence is a no-op under jest.
 */

import React from 'react';
import { render, screen, userEvent } from '@testing-library/react-native';
import { View, Text, Pressable } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

jest.mock('expo-haptics', () => ({
  selectionAsync: () => Promise.resolve(),
  notificationAsync: () => Promise.resolve(),
  NotificationFeedbackType: { Warning: 'warning' },
}));
jest.mock('expo-font', () => ({
  useFonts: () => [true, null],
  isLoaded: () => true,
  loadAsync: () => Promise.resolve(),
}));
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
// SQLite persistence is fire-and-forget; stub it so nothing touches a real DB.
jest.mock('../../store/db', () => ({
  loadHistory: () => Promise.resolve([]),
  recordHistory: () => Promise.resolve(),
  deleteHistory: () => Promise.resolve(),
  putHistory: () => Promise.resolve(),
  loadAllLists: () => Promise.resolve([]),
  saveList: () => Promise.resolve(),
  deleteListFromDb: () => Promise.resolve(),
  loadAllKits: () => Promise.resolve([]),
  saveKit: () => Promise.resolve(),
  putTombstone: () => Promise.resolve(),
  removeTombstone: () => Promise.resolve(),
  getSyncMeta: () => Promise.resolve(null),
  setSyncMeta: () => Promise.resolve(),
  getAppSetting: () => Promise.resolve(null),
  setAppSetting: () => Promise.resolve(),
}));

import { useItemEditor } from '../ItemEditor';
import { useListsStore } from '../../store/lists';
import { useAccountStore } from '../../store/account';
import { makeItem, makeList, type GroceryItem } from '../../data/list';

const LIST_ID = 'l-test';
const ITEM_ID = 'i-test';

function seed(overrides: Partial<GroceryItem> = {}) {
  const list = makeList('Weekly shop');
  const item: GroceryItem = {
    ...makeItem('Milk', 'en', 'Dairy & eggs'),
    id: ITEM_ID,
    quantity: 2,
    ...overrides,
  };
  useListsStore.setState({ lists: [{ ...list, id: LIST_ID, items: [item] }] });
  useAccountStore.setState({ staples: [], hydrated: true, history: [] });
}

function Harness({ onRemove }: { onRemove?: (i: GroceryItem) => void }) {
  const { open, element } = useItemEditor();
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="trigger"
        onPress={() =>
          open({ listId: LIST_ID, itemId: ITEM_ID, onRemove: onRemove ?? (() => {}) })
        }
      >
        <Text>trigger</Text>
      </Pressable>
      {element}
    </View>
  );
}

function wrap(ui: React.ReactElement) {
  return <SafeAreaProvider initialMetrics={METRICS}>{ui}</SafeAreaProvider>;
}

const curItem = () =>
  useListsStore.getState().lists.find((l) => l.id === LIST_ID)!.items.find((i) => i.id === ITEM_ID)!;
const curList = () => useListsStore.getState().lists.find((l) => l.id === LIST_ID)!;

async function openEditor(user: ReturnType<typeof userEvent.setup>) {
  await user.press(screen.getByRole('button', { name: 'trigger' }));
}

describe('useItemEditor', () => {
  beforeEach(() => seed());

  it('recategorizes the item to another aisle when a chip is pressed', async () => {
    const user = userEvent.setup({ delay: null });
    await render(wrap(<Harness />));
    await openEditor(user);

    expect(curItem().category).toBe('Dairy & eggs');
    await user.press(screen.getByRole('button', { name: 'Produce' }));
    expect(curItem().category).toBe('Produce');
  });

  it('steps quantity up via the Stepper', async () => {
    const user = userEvent.setup({ delay: null });
    await render(wrap(<Harness />));
    await openEditor(user);

    expect(curItem().quantity).toBe(2);
    await user.press(screen.getByRole('button', { name: 'Increase' }));
    expect(curItem().quantity).toBe(3);
  });

  it('creates a new aisle and moves the item into it (New aisle → type → Add)', async () => {
    const user = userEvent.setup({ delay: null });
    await render(wrap(<Harness />));
    await openEditor(user);

    await user.press(screen.getByRole('button', { name: 'New aisle' }));
    const input = screen.getByLabelText('Name this aisle', { includeHiddenElements: true });
    await user.type(input, 'Deli');
    await user.press(screen.getByRole('button', { name: 'Add' }));

    expect(curList().categoryOrder).toContain('Deli');
    expect(curItem().category).toBe('Deli');
  });

  it('marks the item as a usual and unmarks it (reversible toggle)', async () => {
    const user = userEvent.setup({ delay: null });
    await render(wrap(<Harness />));
    await openEditor(user);

    expect(useAccountStore.getState().isStaple('Milk')).toBe(false);
    // Off → labelled "Save as a usual". `toggleUsual` reads the live staple
    // state on each press and flips it, so pressing the same control twice
    // toggles on then back off (the label itself is driven by a stable-ref
    // selector that doesn't re-render on a bare staple change).
    const usualBtn = screen.getByRole('button', { name: 'Save as a usual' });
    await user.press(usualBtn);
    expect(useAccountStore.getState().isStaple('Milk')).toBe(true);
    await user.press(usualBtn);
    expect(useAccountStore.getState().isStaple('Milk')).toBe(false);
  });

  it('commits an edited name on Done and closes', async () => {
    const user = userEvent.setup({ delay: null });
    await render(wrap(<Harness />));
    await openEditor(user);

    const nameInput = screen.getByLabelText('Item', { includeHiddenElements: true });
    await user.clear(nameInput);
    await user.type(nameInput, 'Oat milk');
    await user.press(screen.getByRole('button', { name: 'Done' }));

    expect(curItem().name).toBe('Oat milk');
    // Sheet closed — the editor header is gone.
    expect(screen.queryByRole('header', { name: 'Edit item' })).toBeNull();
  });

  it('commits an edited note on close', async () => {
    const user = userEvent.setup({ delay: null });
    await render(wrap(<Harness />));
    await openEditor(user);

    const noteInput = screen.getByLabelText('Note', { includeHiddenElements: true });
    await user.type(noteInput, 'the big one');
    await user.press(screen.getByRole('button', { name: 'Done' }));

    expect(curItem().note).toBe('the big one');
  });

  it('closes via the scrim (Close) committing pending edits', async () => {
    const user = userEvent.setup({ delay: null });
    await render(wrap(<Harness />));
    await openEditor(user);

    const nameInput = screen.getByLabelText('Item', { includeHiddenElements: true });
    await user.clear(nameInput);
    await user.type(nameInput, 'Whole milk');
    await user.press(screen.getByRole('button', { name: 'Close' }));

    expect(curItem().name).toBe('Whole milk');
    expect(screen.queryByRole('header', { name: 'Edit item' })).toBeNull();
  });

  it('bubbles the item to onRemove and closes when Remove is pressed', async () => {
    const user = userEvent.setup({ delay: null });
    const onRemove = jest.fn();
    await render(wrap(<Harness onRemove={onRemove} />));
    await openEditor(user);

    await user.press(screen.getByRole('button', { name: 'Remove' }));
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRemove.mock.calls[0][0].id).toBe(ITEM_ID);
    expect(screen.queryByRole('header', { name: 'Edit item' })).toBeNull();
  });
});
