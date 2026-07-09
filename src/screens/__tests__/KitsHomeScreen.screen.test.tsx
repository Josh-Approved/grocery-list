/**
 * Screen test — KitsHomeScreen action coverage (Uplevel-3 T3).
 *
 * Renders the real screen against the real Zustand kits store and exercises
 * every user-facing action: New kit (header + empty-state), open a kit row,
 * the per-row overflow menu (rename / duplicate / delete), and the Settings
 * gear. Queried by role/label only — no testID, no snapshot.
 *
 * Destructive-confirm regression proof: "Delete kit" now routes through a
 * confirm dialog. The test asserts deleteKit has NOT run after the menu tap,
 * and only runs after the confirm button. This fails on the old immediate-
 * delete code (which is the point).
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
// Stub the SQLite persistence layer so the Zustand store runs in node.
jest.mock('../../store/db', () => ({
  loadAllKits: jest.fn(async () => []),
  saveKit: jest.fn(async () => {}),
  loadAllLists: jest.fn(async () => []),
  saveList: jest.fn(async () => {}),
  deleteListFromDb: jest.fn(async () => {}),
  putTombstone: jest.fn(async () => {}),
  removeTombstone: jest.fn(async () => {}),
  getSyncMeta: jest.fn(async () => null),
  setSyncMeta: jest.fn(async () => {}),
  getAppSetting: jest.fn(async () => null),
  setAppSetting: jest.fn(async () => {}),
}));

import KitsHomeScreen from '../KitsHomeScreen';
import { useKitsStore } from '../../store/kits';

function resetStore() {
  useKitsStore.setState({ kits: [], hydrated: true });
}

function nav() {
  return { navigate: jest.fn(), goBack: jest.fn() } as any;
}

async function renderScreen(navigation = nav()) {
  // RNTL v14's render is async — await it, then read via the `screen` singleton.
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <KitsHomeScreen navigation={navigation} route={{ params: {} } as any} />
    </SafeAreaProvider>
  );
  return { navigation };
}

beforeEach(() => resetStore());
afterEach(() => resetStore());

describe('KitsHomeScreen', () => {
  it('creates a kit and navigates to it from the header New kit button', async () => {
    const user = userEvent.setup();
    const { navigation } = await renderScreen();

    await user.press(screen.getByRole('button', { name: 'New kit' }));
    // Prompt is open — type a name (the input carries the kit placeholder) and confirm.
    await user.type(screen.getByPlaceholderText('Chicken salad'), 'Chicken salad');
    await user.press(screen.getByRole('button', { name: 'Create' }));

    expect(useKitsStore.getState().kits).toHaveLength(1);
    expect(useKitsStore.getState().kits[0].name).toBe('Chicken salad');
    expect(navigation.navigate).toHaveBeenCalledWith(
      'KitDetail',
      expect.objectContaining({ kitId: expect.any(String) })
    );
  });

  it('creates the first kit from the empty-state button', async () => {
    const user = userEvent.setup();
    await renderScreen();

    await user.press(
      screen.getByRole('button', { name: 'Create your first kit' })
    );
    await user.type(screen.getByPlaceholderText('Chicken salad'), 'Tacos');
    await user.press(screen.getByRole('button', { name: 'Create' }));

    expect(useKitsStore.getState().kits.map((k) => k.name)).toContain('Tacos');
  });

  it('opens a kit when its row is pressed', async () => {
    const id = useKitsStore.getState().createKit('Pancakes');
    const user = userEvent.setup();
    const { navigation } = await renderScreen();

    await user.press(screen.getByRole('button', { name: /Pancakes, 0 items/ }));
    expect(navigation.navigate).toHaveBeenCalledWith('KitDetail', { kitId: id });
  });

  it('renames a kit through the overflow menu', async () => {
    useKitsStore.getState().createKit('Old name');
    const user = userEvent.setup();
    await renderScreen();

    await user.press(
      screen.getByRole('button', { name: 'Options for Old name' })
    );
    await user.press(screen.getByRole('button', { name: 'Rename' }));
    const input = screen.getByLabelText('Rename kit');
    await user.clear(input);
    await user.type(input, 'New name');
    await user.press(screen.getByRole('button', { name: 'Save' }));

    expect(useKitsStore.getState().kits[0].name).toBe('New name');
  });

  it('duplicates a kit through the overflow menu', async () => {
    useKitsStore.getState().createKit('Base');
    const user = userEvent.setup();
    await renderScreen();

    await user.press(screen.getByRole('button', { name: 'Options for Base' }));
    await user.press(screen.getByRole('button', { name: 'Duplicate' }));

    const names = useKitsStore.getState().kits.map((k) => k.name).sort();
    expect(names).toEqual(['Base', 'Base (copy)']);
  });

  it('DELETE is guarded by a confirm dialog — no delete until confirmed', async () => {
    const id = useKitsStore.getState().createKit('Doomed');
    const user = userEvent.setup();
    await renderScreen();

    await user.press(
      screen.getByRole('button', { name: 'Options for Doomed' })
    );
    await user.press(screen.getByRole('button', { name: 'Delete' }));

    // Regression guard: the kit must NOT be deleted merely by tapping Delete.
    expect(
      useKitsStore.getState().kits.find((k) => k.id === id)?.deletedAt
    ).toBeUndefined();

    // The confirm dialog's Delete button is what actually deletes.
    await user.press(screen.getByRole('button', { name: 'Delete' }));
    expect(
      useKitsStore.getState().kits.find((k) => k.id === id)?.deletedAt
    ).toEqual(expect.any(Number));
  });

  it('navigates to Settings from the gear', async () => {
    const user = userEvent.setup();
    const { navigation } = await renderScreen();

    await user.press(screen.getByRole('button', { name: 'Settings' }));
    expect(navigation.navigate).toHaveBeenCalledWith('Settings');
  });
});
