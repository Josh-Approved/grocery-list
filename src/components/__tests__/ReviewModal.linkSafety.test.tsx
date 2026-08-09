/**
 * Component test — ReviewModal's "Leave a review" path.
 *
 * The defect this locks down is silent and permanent: `markReviewOpened` stops
 * every future prompt for the install, so marking it before the store link
 * actually opened meant a failed link (blank store id, unhandled scheme) opted
 * the user out forever while showing them nothing. Errors were swallowed, so
 * neither the user nor we could see it.
 *
 * Assertions are on observable outcomes only: what got opened, whether the
 * install was marked done, and whether the modal dismissed.
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

import ReviewModal from '../ReviewModal';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORE_KEY = '@josh-approved/review';
// The accessible name IS the visible button text — Voice Control matches what the
// user can see, so "Leave a review on the app store" moved to the hint. Querying
// by the visible string is what keeps that from drifting back.
const A11Y_LEAVE = 'Leave a review';
const A11Y_LEAVE_HINT = 'Leave a review on the app store';

async function reviewOpenedFlag(): Promise<boolean> {
  const raw = await AsyncStorage.getItem(STORE_KEY);
  return raw ? JSON.parse(raw).reviewOpened === true : false;
}

const props = {
  appName: 'Grocery List',
  iosAppStoreId: '6779417031',
  androidPackageName: 'com.joshapproved.grocerylist',
};

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

describe('ReviewModal — Leave a review', () => {
  it('opens the write-review URL and marks the install done', async () => {
    const openURL = jest
      .spyOn(Linking, 'openURL')
      .mockResolvedValue(undefined as never);
    const onDismiss = jest.fn();
    const user = userEvent.setup();

    await render(<ReviewModal visible onDismiss={onDismiss} {...props} />);
    await user.press(screen.getByRole('button', { name: A11Y_LEAVE }));

    expect(openURL).toHaveBeenCalledWith(
      'itms-apps://apps.apple.com/app/id6779417031?action=write-review'
    );
    await waitFor(async () => expect(await reviewOpenedFlag()).toBe(true));
    expect(onDismiss).toHaveBeenCalled();
  });

  it('does NOT mark the install done when the store link fails to open', async () => {
    jest.spyOn(Linking, 'openURL').mockRejectedValue(new Error('no handler'));
    const onDismiss = jest.fn();
    const user = userEvent.setup();

    await render(<ReviewModal visible onDismiss={onDismiss} {...props} />);
    await user.press(screen.getByRole('button', { name: A11Y_LEAVE }));

    // Dismisses either way — but the user stays eligible for a later prompt
    // instead of being silently retired on a link that never opened.
    await waitFor(() => expect(onDismiss).toHaveBeenCalled());
    expect(await reviewOpenedFlag()).toBe(false);
  });

  it('never opens a URL, and never marks done, when the store id is blank', async () => {
    const openURL = jest
      .spyOn(Linking, 'openURL')
      .mockResolvedValue(undefined as never);
    const onDismiss = jest.fn();
    const user = userEvent.setup();

    await render(
      <ReviewModal visible onDismiss={onDismiss} {...props} iosAppStoreId="" />
    );
    await user.press(screen.getByRole('button', { name: A11Y_LEAVE }));

    expect(openURL).not.toHaveBeenCalled();
    await waitFor(() => expect(onDismiss).toHaveBeenCalled());
    expect(await reviewOpenedFlag()).toBe(false);
  });

  // Voice Control activates a control by its accessible NAME. If the name is a
  // longer sentence than the visible text, saying what is on screen matches
  // nothing — and in verb-final locales (de/ja) the visible word lands at the end
  // of that sentence, so it is not even a prefix. The name must be the visible
  // string; the longer phrasing belongs in the hint, which VoiceOver still reads.
  it('names the store button with its visible text and keeps the context in the hint', async () => {
    await render(<ReviewModal visible onDismiss={jest.fn()} {...props} />);

    const leave = screen.getByRole('button', { name: A11Y_LEAVE });
    expect(leave).toHaveTextContent(A11Y_LEAVE);
    expect(leave.props.accessibilityHint).toBe(A11Y_LEAVE_HINT);
  });
});
