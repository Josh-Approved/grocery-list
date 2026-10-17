/**
 * Component test — ReviewModal's two surfaces.
 *
 * NATIVE (the default since 2026-10-17): when the OS rating sheet is available
 * the component requests it, counts the prompt as shown, renders nothing of its
 * own, never opens a store URL, never retires the install (the OS does not say
 * whether the user rated), and hands control back to the shell.
 *
 * FALLBACK: when the sheet is unavailable — `isAvailableAsync()` false, or the
 * request rejects — the custom modal renders and the pre-existing link-safety
 * contract holds. The defect that contract locks down is silent and permanent:
 * `markReviewOpened` stops every future prompt for the install, so marking it
 * before the store link actually opened meant a failed link (blank store id,
 * unhandled scheme) opted the user out forever while showing them nothing.
 *
 * Assertions are on observable outcomes only: what got requested or opened,
 * what the install's stored state says, and whether the modal dismissed.
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
jest.mock('expo-store-review', () => ({
  isAvailableAsync: jest.fn(),
  requestReview: jest.fn(),
}));

import * as StoreReview from 'expo-store-review';
import ReviewModal from '../ReviewModal';
import AsyncStorage from '@react-native-async-storage/async-storage';

const isAvailableAsync = StoreReview.isAvailableAsync as jest.Mock;
const requestReview = StoreReview.requestReview as jest.Mock;

const STORE_KEY = '@josh-approved/review';
// The accessible name IS the visible button text — Voice Control matches what the
// user can see, so "Leave a review on the app store" moved to the hint. Querying
// by the visible string is what keeps that from drifting back.
const A11Y_LEAVE = 'Leave a review';
const A11Y_LEAVE_HINT = 'Leave a review on the app store';

async function stored(): Promise<{ promptsShown: number; reviewOpened: boolean }> {
  const raw = await AsyncStorage.getItem(STORE_KEY);
  const parsed = raw ? JSON.parse(raw) : {};
  return {
    promptsShown: parsed.promptsShown ?? 0,
    reviewOpened: parsed.reviewOpened === true,
  };
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

describe('ReviewModal — native sheet (the default surface)', () => {
  beforeEach(() => {
    isAvailableAsync.mockResolvedValue(true);
    requestReview.mockResolvedValue(undefined);
  });

  it('requests the OS rating sheet, renders nothing of its own, and hands back to the shell', async () => {
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined as never);
    const onDismiss = jest.fn();

    await render(<ReviewModal visible onDismiss={onDismiss} {...props} />);

    await waitFor(() => expect(requestReview).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onDismiss).toHaveBeenCalled());
    expect(openURL).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: A11Y_LEAVE })).toBeNull();
  });

  it('counts the request as a prompt shown, but never retires the install', async () => {
    await render(<ReviewModal visible onDismiss={jest.fn()} {...props} />);

    await waitFor(() => expect(requestReview).toHaveBeenCalled());
    await waitFor(async () => expect((await stored()).promptsShown).toBe(1));
    // The OS never says whether the user rated, so a native request must not
    // set the flag that stops all future prompts.
    expect((await stored()).reviewOpened).toBe(false);
  });

  it('counts the prompt BEFORE the request, so a sheet the OS swallows still spends it', async () => {
    requestReview.mockImplementation(async () => {
      expect((await stored()).promptsShown).toBe(1);
    });
    await render(<ReviewModal visible onDismiss={jest.fn()} {...props} />);
    await waitFor(() => expect(requestReview).toHaveBeenCalled());
  });

  it('does nothing at all while not visible', async () => {
    await render(<ReviewModal visible={false} onDismiss={jest.fn()} {...props} />);
    expect(isAvailableAsync).not.toHaveBeenCalled();
    expect(requestReview).not.toHaveBeenCalled();
    expect((await stored()).promptsShown).toBe(0);
  });
});

describe('ReviewModal — falls back to the custom modal only when the sheet is unavailable', () => {
  it('shows the modal when the OS reports no rating sheet', async () => {
    isAvailableAsync.mockResolvedValue(false);
    await render(<ReviewModal visible onDismiss={jest.fn()} {...props} />);

    expect(await screen.findByRole('button', { name: A11Y_LEAVE })).toBeTruthy();
    expect(requestReview).not.toHaveBeenCalled();
    expect((await stored()).promptsShown).toBe(1);
  });

  it('shows the modal when the native request itself fails', async () => {
    isAvailableAsync.mockResolvedValue(true);
    requestReview.mockRejectedValue(new Error('Play flow unavailable'));
    const onDismiss = jest.fn();
    await render(<ReviewModal visible onDismiss={onDismiss} {...props} />);

    expect(await screen.findByRole('button', { name: A11Y_LEAVE })).toBeTruthy();
    // A failed request is not a dismissal — the fallback is now on screen.
    expect(onDismiss).not.toHaveBeenCalled();
  });
});

describe('ReviewModal — fallback modal, "Leave a review" link safety', () => {
  beforeEach(() => {
    isAvailableAsync.mockResolvedValue(false);
  });

  it('opens the write-review URL and marks the install done', async () => {
    const openURL = jest
      .spyOn(Linking, 'openURL')
      .mockResolvedValue(undefined as never);
    const onDismiss = jest.fn();
    const user = userEvent.setup();

    await render(<ReviewModal visible onDismiss={onDismiss} {...props} />);
    await user.press(await screen.findByRole('button', { name: A11Y_LEAVE }));

    expect(openURL).toHaveBeenCalledWith(
      'itms-apps://apps.apple.com/app/id6779417031?action=write-review'
    );
    await waitFor(async () => expect((await stored()).reviewOpened).toBe(true));
    expect(onDismiss).toHaveBeenCalled();
  });

  it('does NOT mark the install done when the store link fails to open', async () => {
    jest.spyOn(Linking, 'openURL').mockRejectedValue(new Error('no handler'));
    const onDismiss = jest.fn();
    const user = userEvent.setup();

    await render(<ReviewModal visible onDismiss={onDismiss} {...props} />);
    await user.press(await screen.findByRole('button', { name: A11Y_LEAVE }));

    // Dismisses either way — but the user stays eligible for a later prompt
    // instead of being silently retired on a link that never opened.
    await waitFor(() => expect(onDismiss).toHaveBeenCalled());
    expect((await stored()).reviewOpened).toBe(false);
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
    await user.press(await screen.findByRole('button', { name: A11Y_LEAVE }));

    expect(openURL).not.toHaveBeenCalled();
    await waitFor(() => expect(onDismiss).toHaveBeenCalled());
    expect((await stored()).reviewOpened).toBe(false);
  });

  // Voice Control activates a control by its accessible NAME. If the name is a
  // longer sentence than the visible text, saying what is on screen matches
  // nothing — and in verb-final locales (de/ja) the visible word lands at the end
  // of that sentence, so it is not even a prefix. The name must be the visible
  // string; the longer phrasing belongs in the hint, which VoiceOver still reads.
  it('names the store button with its visible text and keeps the context in the hint', async () => {
    await render(<ReviewModal visible onDismiss={jest.fn()} {...props} />);

    const leave = await screen.findByRole('button', { name: A11Y_LEAVE });
    expect(leave).toHaveTextContent(A11Y_LEAVE);
    expect(leave.props.accessibilityHint).toBe(A11Y_LEAVE_HINT);
  });
});
