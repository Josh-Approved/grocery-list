/**
 * Screen test — KitDetailScreen (Uplevel-3 T3 action coverage).
 *
 * Renders the real screen against a seeded kits store and exercises every
 * user-facing action: back, rename-via-title, the kit options menu (rename /
 * duplicate / delete), add-ingredient, tap-an-item to rename, and the per-item
 * edit menu. Queries by role/label/text only — no testIDs, no snapshots.
 */

import React from 'react';
import { render, screen, userEvent, waitFor } from '@testing-library/react-native';
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
// The stores import ./db (real SQLite). Replace every persistence call with an
// async no-op so state lives purely in memory.
jest.mock('../../store/db', () => ({
  loadHistory: jest.fn(() => Promise.resolve([])),
  recordHistory: jest.fn(() => Promise.resolve()),
  deleteHistory: jest.fn(() => Promise.resolve()),
  putHistory: jest.fn(() => Promise.resolve()),
  loadAllLists: jest.fn(() => Promise.resolve([])),
  saveList: jest.fn(() => Promise.resolve()),
  deleteListFromDb: jest.fn(() => Promise.resolve()),
  loadAllKits: jest.fn(() => Promise.resolve([])),
  saveKit: jest.fn(() => Promise.resolve()),
  putTombstone: jest.fn(() => Promise.resolve()),
  removeTombstone: jest.fn(() => Promise.resolve()),
  getSyncMeta: jest.fn(() => Promise.resolve(null)),
  setSyncMeta: jest.fn(() => Promise.resolve()),
  getAppSetting: jest.fn(() => Promise.resolve(null)),
  setAppSetting: jest.fn(() => Promise.resolve()),
}));

import KitDetailScreen from '../KitDetailScreen';
import { useKitsStore } from '../../store/kits';
import { makeKit, makeKitItem } from '../../data/kit';

function seedKit() {
  const kit = makeKit('Weeknight pasta');
  kit.items = [makeKitItem('Spaghetti'), makeKitItem('Passata')];
  useKitsStore.setState({ kits: [kit], hydrated: true });
  return kit;
}

async function renderScreen(
  kitId: string,
  navOverrides: Record<string, jest.Mock> = {}
) {
  const navigation = {
    navigate: jest.fn(),
    goBack: jest.fn(),
    replace: jest.fn(),
    setOptions: jest.fn(),
    ...navOverrides,
  } as any;
  const route = { params: { kitId } } as any;
  const utils = await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <KitDetailScreen route={route} navigation={navigation} />
    </SafeAreaProvider>
  );
  return { navigation, ...utils };
}

describe('KitDetailScreen', () => {
  beforeEach(() => {
    useKitsStore.setState({ kits: [], hydrated: true });
  });

  it('goes back when the back button is pressed', async () => {
    const kit = seedKit();
    const user = userEvent.setup();
    const { navigation } = await renderScreen(kit.id);

    await user.press(screen.getByRole('button', { name: 'Back' }));
    expect(navigation.goBack).toHaveBeenCalledTimes(1);
  });

  it('renames the kit from the header title prompt', async () => {
    const kit = seedKit();
    const user = userEvent.setup();
    await renderScreen(kit.id);

    await user.press(
      screen.getByRole('button', { name: 'Weeknight pasta, rename' })
    );
    // The rename prompt opens with a text field labelled by its title.
    const field = await screen.findByLabelText('Rename kit');
    await user.clear(field);
    await user.type(field, 'Sunday sauce');
    await user.press(screen.getByRole('button', { name: 'Save' }));

    expect(useKitsStore.getState().kits.find((k) => k.id === kit.id)?.name).toBe(
      'Sunday sauce'
    );
  });

  it('opens the kit options menu and duplicates the kit', async () => {
    const kit = seedKit();
    const user = userEvent.setup();
    const { navigation } = await renderScreen(kit.id);

    await user.press(screen.getByRole('button', { name: 'Kit options' }));
    await user.press(await screen.findByRole('button', { name: 'Duplicate' }));

    // A new kit exists and we navigated to it. Menu actions are deferred past
    // the sheet dismissal (~260ms).
    await waitFor(() => expect(useKitsStore.getState().kits.length).toBe(2));
    expect(navigation.replace).toHaveBeenCalledWith(
      'KitDetail',
      expect.objectContaining({ kitId: expect.any(String) })
    );
  });

  it('opens the kit options menu and deletes the kit', async () => {
    const kit = seedKit();
    const user = userEvent.setup();
    const { navigation } = await renderScreen(kit.id);

    await user.press(screen.getByRole('button', { name: 'Kit options' }));
    await user.press(await screen.findByRole('button', { name: 'Delete kit' }));

    // Kits soft-delete (a tombstone converges across devices); the observable
    // outcome is the kit tombstoned and the screen leaving. Menu actions are
    // deferred past the sheet dismissal (~260ms).
    await waitFor(() =>
      expect(
        useKitsStore.getState().kits.find((k) => k.id === kit.id)?.deletedAt
      ).toBeGreaterThan(0)
    );
    expect(navigation.goBack).toHaveBeenCalled();
  });

  it('renames the kit from the options menu', async () => {
    const kit = seedKit();
    const user = userEvent.setup();
    await renderScreen(kit.id);

    await user.press(screen.getByRole('button', { name: 'Kit options' }));
    await user.press(await screen.findByRole('button', { name: 'Rename kit' }));
    const field = await screen.findByLabelText('Rename kit');
    await user.clear(field);
    await user.type(field, 'Pasta night');
    await user.press(screen.getByRole('button', { name: 'Save' }));

    expect(useKitsStore.getState().kits.find((k) => k.id === kit.id)?.name).toBe(
      'Pasta night'
    );
  });

  it('opens the add-ingredient sheet', async () => {
    const kit = seedKit();
    const user = userEvent.setup();
    await renderScreen(kit.id);

    await user.press(screen.getByRole('button', { name: 'Add an ingredient' }));
    // The AddIngredientsSheet becomes visible — its title appears.
    expect(await screen.findByText('Add ingredients')).toBeTruthy();
  });

  it('opens the rename prompt when an item name is tapped', async () => {
    const kit = seedKit();
    const user = userEvent.setup();
    await renderScreen(kit.id);

    // The item-name Pressable and the pencil icon both carry "Edit {name}".
    // The first is the name row, which opens the rename prompt directly.
    const spaghetti = screen.getAllByRole('button', { name: 'Edit Spaghetti' });
    await user.press(spaghetti[0]);
    const field = await screen.findByLabelText('Edit item');
    await user.clear(field);
    await user.type(field, 'Bucatini');
    await user.press(screen.getByRole('button', { name: 'Save' }));

    const names = useKitsStore
      .getState()
      .kits.find((k) => k.id === kit.id)!
      .items.map((i) => i.name);
    expect(names).toContain('Bucatini');
  });

  it('opens the per-item edit menu (pencil) and can delete the item', async () => {
    const kit = seedKit();
    const user = userEvent.setup();
    await renderScreen(kit.id);

    // Two controls share "Edit {name}": the name row and the pencil icon.
    // The pencil (the last one) opens the per-item action menu.
    const editButtons = screen.getAllByRole('button', { name: 'Edit Passata' });
    await user.press(editButtons[editButtons.length - 1]);

    // The action menu offers Delete (a button); choosing it removes the item.
    await user.press(await screen.findByRole('button', { name: 'Delete' }));

    // Menu actions are deferred past the sheet dismissal (~260ms).
    await waitFor(() => {
      const visibleNames = useKitsStore
        .getState()
        .kits.find((k) => k.id === kit.id)!
        .items.filter((i) => i.deletedAt == null)
        .map((i) => i.name);
      expect(visibleNames).not.toContain('Passata');
      expect(visibleNames).toContain('Spaghetti');
    });
  });
});
