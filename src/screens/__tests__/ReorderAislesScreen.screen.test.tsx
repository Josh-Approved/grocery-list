/**
 * Screen test — ReorderAislesScreen action coverage (Uplevel-3 T3).
 *
 * Renders the real screen against the real lists store and exercises every
 * user-facing action: Done (goBack), Move up, Move down, and Remove (a custom
 * aisle). Queried by role/label only — no testID, no snapshot.
 *
 * Destructive-confirm regression proof: an aisle "Remove" now routes through a
 * confirm dialog. The test asserts removeCategory has NOT run after the row
 * tap, and only runs after the confirm "Remove" button — this fails on the old
 * immediate-remove code (which is the point).
 */

import React from 'react';
import { render, screen, userEvent } from '@testing-library/react-native';
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
jest.mock('../../store/db', () => ({
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

import ReorderAislesScreen from '../ReorderAislesScreen';
import { useListsStore } from '../../store/lists';

const LIST_ID = 'l_reorder';
// A custom aisle ("Deli") makes the Remove control appear (built-ins can't be
// removed). Produce/Bakery are built-ins used to drive up/down.
function seedList() {
  useListsStore.setState({
    hydrated: true,
    lists: [
      {
        id: LIST_ID,
        name: 'Shop',
        nameUpdatedAt: 1,
        items: [],
        categoryOrder: ['Produce', 'Bakery', 'Deli'],
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  });
}

function resetStore() {
  useListsStore.setState({ lists: [], hydrated: true });
}

function nav() {
  return { navigate: jest.fn(), goBack: jest.fn() } as any;
}

async function renderScreen(navigation = nav()) {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <ReorderAislesScreen
        navigation={navigation}
        route={{ params: { listId: LIST_ID } } as any}
      />
    </SafeAreaProvider>
  );
  return { navigation };
}

beforeEach(() => seedList());
afterEach(() => resetStore());

describe('ReorderAislesScreen', () => {
  it('closes the screen when Done is pressed', async () => {
    const user = userEvent.setup();
    const { navigation } = await renderScreen();

    await user.press(screen.getByRole('button', { name: 'Done' }));
    expect(navigation.goBack).toHaveBeenCalledTimes(1);
  });

  it('moves an aisle down, reordering the list', async () => {
    const user = userEvent.setup();
    await renderScreen();

    // Produce is first; moving it down swaps it with Bakery.
    await user.press(screen.getByRole('button', { name: 'Move Produce down' }));

    expect(
      useListsStore.getState().lists[0].categoryOrder
    ).toEqual(['Bakery', 'Produce', 'Deli']);
  });

  it('moves an aisle up, reordering the list', async () => {
    const user = userEvent.setup();
    await renderScreen();

    // Bakery is second; moving it up swaps it with Produce.
    await user.press(screen.getByRole('button', { name: 'Move Bakery up' }));

    expect(
      useListsStore.getState().lists[0].categoryOrder
    ).toEqual(['Bakery', 'Produce', 'Deli']);
  });

  it('REMOVE is guarded by a confirm dialog — no removal until confirmed', async () => {
    const user = userEvent.setup();
    await renderScreen();

    await user.press(screen.getByRole('button', { name: 'Remove Deli' }));

    // Regression guard: the aisle must NOT be removed merely by tapping Remove.
    expect(
      useListsStore.getState().lists[0].categoryOrder
    ).toContain('Deli');

    // The confirm dialog's "Remove" button is what actually removes.
    await user.press(screen.getByRole('button', { name: 'Remove' }));
    expect(
      useListsStore.getState().lists[0].categoryOrder
    ).not.toContain('Deli');
  });
});
