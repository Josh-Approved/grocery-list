/**
 * Screen test — where the review prompt's "successful shop" actually is.
 *
 * The trigger used to hang off "Clear checked", which is CLEANUP, not the
 * success: a shopper who never tidies their list never triggered it at all.
 * Re-anchored 2026-07-27 to the moment the last unchecked item goes, which is
 * the finished shop. These cases pin all four edges of that decision:
 * the last check fires it, an earlier check does not, clearing does not, and a
 * short errand (< 3 items) does not.
 *
 * Only the canonical reviewPrompt storage is mocked — the framework's own
 * thresholds are tested in its own suite; here we assert the WIRING.
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
// The sync status bar pulls in the Nostr transport -> @noble ESM, which jest
// won't transform. Nothing here is about sync; stub the bar to nothing.
jest.mock('../../components/SyncStatusBar', () => ({ SyncStatusBar: () => null }));
jest.mock('../../storage/reviewPrompt', () => ({
  recordSuccessfulCompletion: jest.fn(() => Promise.resolve(false)),
  markReviewPromptShown: jest.fn(() => Promise.resolve()),
  dismissReviewPrompt: jest.fn(() => Promise.resolve()),
  markReviewOpened: jest.fn(() => Promise.resolve()),
}));

import ListDetailScreen from '../ListDetailScreen';
import { useListsStore } from '../../store/lists';
import { makeList, makeItem } from '../../data/list';
import { recordSuccessfulCompletion } from '../../storage/reviewPrompt';

const mockRecord = recordSuccessfulCompletion as jest.MockedFunction<
  typeof recordSuccessfulCompletion
>;

function seedList(names: string[]) {
  const list = makeList('Weekly shop');
  list.items = names.map((n) => makeItem(n));
  useListsStore.setState({ lists: [list], hydrated: true });
  return list;
}

async function renderScreen(listId: string) {
  const navigation = {
    navigate: jest.fn(),
    goBack: jest.fn(),
    replace: jest.fn(),
    setOptions: jest.fn(),
  } as never;
  const route = { params: { listId } } as never;
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <ListDetailScreen route={route} navigation={navigation} />
    </SafeAreaProvider>
  );
}

/** Cross an item off by its name (the row is a checkbox labelled by name). */
async function check(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.press(await screen.findByRole('checkbox', { name }));
}

describe('ListDetailScreen — the review trigger is the finished shop', () => {
  beforeEach(() => {
    useListsStore.setState({ lists: [], hydrated: true });
    jest.clearAllMocks();
    mockRecord.mockResolvedValue(false);
  });

  it('fires when the LAST unchecked item on a 3+ item list is crossed off', async () => {
    const list = seedList(['Milk', 'Bread', 'Eggs']);
    const user = userEvent.setup();
    await renderScreen(list.id);

    await check(user, 'Milk');
    await check(user, 'Bread');
    expect(mockRecord).not.toHaveBeenCalled(); // not done shopping yet

    await check(user, 'Eggs');
    expect(mockRecord).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire when the checked items are cleared (cleanup is not the success)', async () => {
    const list = seedList(['Milk', 'Bread', 'Eggs']);
    const user = userEvent.setup();
    await renderScreen(list.id);

    await check(user, 'Milk');
    jest.clearAllMocks();

    await user.press(
      await screen.findByRole('button', { name: /^Clear 1 crossed-off/ })
    );
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('does NOT fire for a short errand (fewer than 3 items)', async () => {
    const list = seedList(['Milk', 'Bread']);
    const user = userEvent.setup();
    await renderScreen(list.id);

    await check(user, 'Milk');
    await check(user, 'Bread');
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('never fires on mount — the prompt is a completion, not a launch', async () => {
    const list = seedList(['Milk', 'Bread', 'Eggs']);
    await renderScreen(list.id);
    expect(mockRecord).not.toHaveBeenCalled();
  });
});
