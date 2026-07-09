/**
 * Screen test — SettingsScreen action coverage (Uplevel-3 T3).
 *
 * Renders the real Settings/About screen and exercises every user-facing
 * action: Back (goBack), Export lists, Import lists, Support (tip jar),
 * Send feedback, Leave a review, Privacy, Source code, Acknowledgements
 * (navigate), and the "Learn more" studio link. Queried by role/label only —
 * no testID, no snapshot.
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
  getAppSetting: jest.fn(async () => null),
  setAppSetting: jest.fn(async () => {}),
}));

// Export / import go through the file/share stack — stub them; the SUT is that
// the row is wired to the handler, and (import) that its result reaches state.
jest.mock('../../lib/transfer', () => ({
  exportLists: jest.fn(async () => {}),
  pickAndParseLists: jest.fn(async () => []),
}));

// Preserve the real link constants/version; spy on the link-out functions so we
// can assert a press without opening a browser / store.
jest.mock('../../lib/links', () => {
  const actual = jest.requireActual('../../lib/links');
  return {
    ...actual,
    openReview: jest.fn(),
    openUrl: jest.fn(),
  };
});

// The IAP tip-jar sheet pulls in expo-iap; a lightweight stand-in reports its
// visibility so we can prove the Support row opened it, without the native module.
jest.mock('../../components/TipJarSheet', () => {
  const { Text } = require('react-native');
  return {
    __esModule: true,
    default: ({ visible }: { visible: boolean }) =>
      visible ? <Text>TIP_JAR_OPEN</Text> : null,
  };
});

import SettingsScreen from '../SettingsScreen';
import { useListsStore } from '../../store/lists';
import { pickAndParseLists } from '../../lib/transfer';
import { openReview, openUrl } from '../../lib/links';
import { makeList } from '../../data/list';

function resetStore() {
  useListsStore.setState({ lists: [], hydrated: true });
}

function nav() {
  return { navigate: jest.fn(), goBack: jest.fn() } as any;
}

// The Settings screen is rendered inside the feedback context in the real app;
// mock the provider so "Send feedback" resolves to a spy instead of composing mail.
const mockOpenFeedback = jest.fn();
jest.mock('../../feedback/FeedbackProvider', () => ({
  useFeedback: () => ({ open: mockOpenFeedback }),
  FeedbackProvider: ({ children }: { children: React.ReactNode }) => children,
}));

async function renderScreen(navigation = nav()) {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <SettingsScreen navigation={navigation} route={{ params: {} } as any} />
    </SafeAreaProvider>
  );
  return { navigation };
}

beforeEach(() => {
  resetStore();
  jest.clearAllMocks();
});
afterEach(() => resetStore());

describe('SettingsScreen', () => {
  it('goes back when the Back button is pressed', async () => {
    const user = userEvent.setup();
    const { navigation } = await renderScreen();

    await user.press(screen.getByRole('button', { name: 'Back' }));
    expect(navigation.goBack).toHaveBeenCalledTimes(1);
  });

  it('exports lists from the Export row', async () => {
    const { exportLists } = require('../../lib/transfer');
    const user = userEvent.setup();
    await renderScreen();

    await user.press(screen.getByRole('button', { name: 'Export lists' }));
    expect(exportLists).toHaveBeenCalledTimes(1);
  });

  it('imports lists from the Import row and reports the count', async () => {
    // The picker returns one list; importLists must fold it into state and the
    // screen must show the added-count status.
    (pickAndParseLists as jest.Mock).mockResolvedValueOnce([makeList('Imported')]);
    const user = userEvent.setup();
    await renderScreen();

    await user.press(screen.getByRole('button', { name: 'Import lists' }));

    await waitFor(() =>
      expect(useListsStore.getState().lists.map((l) => l.name)).toContain(
        'Imported'
      )
    );
    expect(screen.getByText('Added 1 list.')).toBeTruthy();
  });

  it('opens the tip jar from the Support row', async () => {
    const user = userEvent.setup();
    await renderScreen();

    await user.press(screen.getByRole('button', { name: 'Support this app' }));
    expect(screen.getByText('TIP_JAR_OPEN')).toBeTruthy();
  });

  it('opens the feedback flow from the Send feedback row', async () => {
    const user = userEvent.setup();
    await renderScreen();

    await user.press(screen.getByRole('button', { name: 'Send feedback' }));
    expect(mockOpenFeedback).toHaveBeenCalledTimes(1);
  });

  it('opens the store review from the Leave a review row', async () => {
    const user = userEvent.setup();
    await renderScreen();

    await user.press(screen.getByRole('button', { name: 'Leave a review' }));
    expect(openReview).toHaveBeenCalledTimes(1);
  });

  it('opens the privacy page from the Privacy row', async () => {
    const user = userEvent.setup();
    await renderScreen();

    await user.press(screen.getByRole('button', { name: 'Privacy' }));
    expect(openUrl).toHaveBeenCalledWith(expect.stringContaining('http'));
  });

  it('opens the source page from the Source code row', async () => {
    const user = userEvent.setup();
    await renderScreen();

    await user.press(screen.getByRole('button', { name: 'Source code' }));
    expect(openUrl).toHaveBeenCalledWith(expect.stringContaining('github.com'));
  });

  it('navigates to Acknowledgements from its row', async () => {
    const user = userEvent.setup();
    const { navigation } = await renderScreen();

    await user.press(screen.getByRole('button', { name: 'Acknowledgements' }));
    expect(navigation.navigate).toHaveBeenCalledWith('Acknowledgements');
  });

  it('opens the studio site from the Learn more link', async () => {
    const user = userEvent.setup();
    await renderScreen();

    await user.press(
      screen.getByRole('button', { name: 'Learn more at joshapproved.com' })
    );
    expect(openUrl).toHaveBeenCalledWith('https://joshapproved.com');
  });
});
