/**
 * Component test — MoreFromJA (Uplevel-3 T3 action coverage).
 *
 * The quiet cross-promo row lists the studio's OTHER live apps for the current
 * platform; each row opens that app's store listing via Linking.openURL. We
 * inject the catalogue by mocking `./jaCatalog` so a row is guaranteed to
 * render (independent of which apps happen to be live today), then prove
 * pressing a row opens its URL. Queries by role/label only; no testID/snapshots.
 */

import React from 'react';
import { render, screen, userEvent } from '@testing-library/react-native';
import { Linking } from 'react-native';

jest.mock('expo-font', () => ({
  useFonts: () => [true, null],
  isLoaded: () => true,
  loadAsync: () => Promise.resolve(),
}));
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

// Deterministic catalogue: one live sibling app with a known URL.
jest.mock('../jaCatalog', () => ({
  moreFromJA: () => [
    {
      slug: 'workout-timer',
      name: 'Workout Timer',
      blurb: 'Interval timer for Tabata and HIIT.',
      url: 'https://apps.apple.com/app/workout-timer/id123',
    },
  ],
}));

import { MoreFromJA } from '../MoreFromJA';

describe('MoreFromJA', () => {
  it('opens the app store listing when a promo row is pressed', async () => {
    const openURL = jest
      .spyOn(Linking, 'openURL')
      .mockResolvedValue(undefined as never);
    const user = userEvent.setup();

    await render(<MoreFromJA />);

    // The row is reachable by its accessible label ("<name> — <blurb>").
    const row = screen.getByRole('button', {
      name: 'Workout Timer — Interval timer for Tabata and HIIT.',
    });
    await user.press(row);

    expect(openURL).toHaveBeenCalledWith(
      'https://apps.apple.com/app/workout-timer/id123'
    );

    openURL.mockRestore();
  });
});
