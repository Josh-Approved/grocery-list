/**
 * Component test — ReviewModal (Uplevel-3 T3 action coverage).
 *
 * Two actions on the visible modal: the primary "Leave a review" button (opens
 * the platform write-review deep link via Linking.openURL, then dismisses) and
 * the "Not now" secondary, which silently dismisses and writes nothing (the
 * displayed prompt was already counted on mount by markReviewPromptShown). The
 * prompt's storage side-effects (reviewPrompt) are mocked — we never mock the
 * component under test, only its native/storage side-effects. Queries by
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

// Prefixed `mock` so jest's hoisted factory may reference them.
const mockMarkReviewOpened = jest.fn().mockResolvedValue(undefined);
const mockMarkReviewPromptShown = jest.fn().mockResolvedValue(undefined);
jest.mock('../../storage/reviewPrompt', () => ({
  markReviewOpened: (...a: unknown[]) => mockMarkReviewOpened(...a),
  markReviewPromptShown: (...a: unknown[]) => mockMarkReviewPromptShown(...a),
}));

import ReviewModal from '../ReviewModal';

const baseProps = {
  appName: 'Grocery List',
  iosAppStoreId: '6779417031',
  androidPackageName: 'com.joshapproved.grocerylist',
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('ReviewModal', () => {
  it('opens the write-review deep link and dismisses when Leave a review is pressed', async () => {
    const openURL = jest
      .spyOn(Linking, 'openURL')
      .mockResolvedValue(undefined as never);
    const onDismiss = jest.fn();
    const user = userEvent.setup();

    await render(<ReviewModal visible onDismiss={onDismiss} {...baseProps} />);

    // Queried by the words actually ON the button, not a longer descriptive
    // label. Voice Control activates a control by its accessible NAME, so the
    // name has to be the visible text — "Leave a review on the app store" used
    // to be the name, which meant saying what you could see did nothing. The
    // store detail now lives in accessibilityHint, which VoiceOver still reads.
    await user.press(screen.getByRole('button', { name: 'Leave a review' }));

    // Default jest test platform is iOS → the itms-apps write-review link.
    await waitFor(() =>
      expect(openURL).toHaveBeenCalledWith(
        `itms-apps://apps.apple.com/app/id${baseProps.iosAppStoreId}?action=write-review`
      )
    );
    await waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1));
    expect(mockMarkReviewOpened).toHaveBeenCalled();
    openURL.mockRestore();
  });

  it('closes silently, opening nothing, when Not now is pressed', async () => {
    const openURL = jest
      .spyOn(Linking, 'openURL')
      .mockResolvedValue(undefined as never);
    const onDismiss = jest.fn();
    const user = userEvent.setup();

    await render(<ReviewModal visible onDismiss={onDismiss} {...baseProps} />);

    await user.press(screen.getByRole('button', { name: 'Not now' }));

    await waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1));
    expect(openURL).not.toHaveBeenCalled();
    expect(mockMarkReviewOpened).not.toHaveBeenCalled();
    openURL.mockRestore();
  });
});
