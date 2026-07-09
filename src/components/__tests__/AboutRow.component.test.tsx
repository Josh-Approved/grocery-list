/**
 * Component test — AboutRow (Uplevel-3 T3 action coverage).
 *
 * AboutRow is prop-driven: with an `onPress` it renders a button labelled by
 * its `label`; without one it's a plain (non-actionable) info row. We prove the
 * one user action — pressing the row fires onPress — and that the static-value
 * variant exposes no button. Queries by role/label/text only; no testID, no
 * snapshots.
 */

import React from 'react';
import { render, screen, userEvent } from '@testing-library/react-native';

jest.mock('expo-font', () => ({
  useFonts: () => [true, null],
  isLoaded: () => true,
  loadAsync: () => Promise.resolve(),
}));
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import { AboutRow } from '../AboutRow';

describe('AboutRow', () => {
  it('calls onPress when the row is pressed', async () => {
    const onPress = jest.fn();
    const user = userEvent.setup();

    await render(<AboutRow label="Privacy" onPress={onPress} />);

    // A user finds the row because it's a button named by its label.
    const row = screen.getByRole('button', { name: 'Privacy' });
    await user.press(row);

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('renders a static value row with no button when onPress is absent', async () => {
    await render(<AboutRow label="Version" value="1.0.0 (1)" />);

    // The value is visible...
    expect(screen.getByText('1.0.0 (1)')).toBeTruthy();
    // ...and there is nothing to press.
    expect(screen.queryByRole('button')).toBeNull();
  });
});
