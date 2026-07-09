/**
 * Component test — Credits / Acknowledgements screen (Uplevel-3 T3 action coverage).
 *
 * Two user actions: the Back button (fires onBack) and each credit row (opens
 * its project URL via Linking.openURL). We assert onBack fires and that pressing
 * the first credit row opens that entry's real URL (read from the generated
 * credits data). Queries by role/label only; no testID, no snapshots.
 */

import React from 'react';
import { render, screen, userEvent } from '@testing-library/react-native';
import { Linking } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

jest.mock('expo-font', () => ({
  useFonts: () => [true, null],
  isLoaded: () => true,
  loadAsync: () => Promise.resolve(),
}));
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import Credits from '../Credits';
import { CREDITS } from '../../data/credits';

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function wrap(ui: React.ReactElement) {
  return <SafeAreaProvider initialMetrics={METRICS}>{ui}</SafeAreaProvider>;
}

describe('Credits', () => {
  it('calls onBack when the Back button is pressed', async () => {
    const onBack = jest.fn();
    const user = userEvent.setup();

    await render(wrap(<Credits onBack={onBack} />));

    await user.press(screen.getByRole('button', { name: 'Back' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('opens a credit entry URL when its row is pressed', async () => {
    const openURL = jest
      .spyOn(Linking, 'openURL')
      .mockResolvedValue(undefined as never);
    const user = userEvent.setup();

    await render(wrap(<Credits onBack={jest.fn()} />));

    const first = CREDITS[0];
    // Rows are links labelled "<name>, <license>".
    const row = screen.getByRole('link', {
      name: `${first.name}, ${first.license}`,
    });
    await user.press(row);

    expect(openURL).toHaveBeenCalledWith(first.url);
    openURL.mockRestore();
  });
});
