/**
 * Component test — DonationModal (Uplevel-3 T3 action coverage).
 *
 * Two actions on the visible modal: the primary Support button (opens the BMAC
 * link via Linking.openURL, then dismisses) and the "Maybe later" secondary
 * (dismisses without opening). We assert both observable outcomes. Queries by
 * role/label only; no testID, no snapshots.
 */

import React from 'react';
import { render, screen, userEvent, waitFor } from '@testing-library/react-native';
import { Linking } from 'react-native';

jest.mock('expo-font', () => ({
  useFonts: () => [true, null],
  isLoaded: () => true,
  loadAsync: () => Promise.resolve(),
}));
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import DonationModal from '../DonationModal';

describe('DonationModal', () => {
  it('opens the support link and dismisses when Support is pressed', async () => {
    const openURL = jest
      .spyOn(Linking, 'openURL')
      .mockResolvedValue(undefined as never);
    const onDismiss = jest.fn();
    const user = userEvent.setup();

    await render(
      <DonationModal visible onDismiss={onDismiss} appName="Grocery List" />
    );

    // The primary button's accessible label is the support-a11y string.
    await user.press(
      screen.getByRole('button', {
        name: 'Support this app, opens in your browser',
      })
    );

    expect(openURL).toHaveBeenCalledWith(
      'https://buymeacoffee.com/jtysonwilliams'
    );
    // handleDonate awaits openURL, then dismisses.
    await waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1));
    openURL.mockRestore();
  });

  it('dismisses without opening a link when Maybe later is pressed', async () => {
    const openURL = jest
      .spyOn(Linking, 'openURL')
      .mockResolvedValue(undefined as never);
    const onDismiss = jest.fn();
    const user = userEvent.setup();

    await render(
      <DonationModal visible onDismiss={onDismiss} appName="Grocery List" />
    );

    await user.press(screen.getByRole('button', { name: 'Maybe later' }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(openURL).not.toHaveBeenCalled();
    openURL.mockRestore();
  });
});
