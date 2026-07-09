/**
 * Component test — FundingFooter (Uplevel-3 T3 action coverage).
 *
 * Two ghost buttons: Support (opens the tip jar via `onSupport`, or the BMAC
 * link-out as a fallback) and Send feedback (opens the feedback sheet via the
 * FeedbackProvider context). We prove each press fires its handler:
 *   • Support with onSupport set → onSupport fires (tip-jar path).
 *   • Support without onSupport → Linking.openURL(BMAC_URL) (link-out path).
 *   • Send feedback → the injected feedback `open()` fires.
 * Queries by role/label only; no testID, no snapshots.
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
jest.mock('react-native-reanimated', () =>
  require('react-native-reanimated/mock')
);

// Mock the links module so the BMAC fallback is observable without hitting the
// native Linking bridge, and keep BMAC_URL stable for the assertion.
jest.mock('../../lib/links', () => ({
  BMAC_URL: 'https://buymeacoffee.com/jtysonwilliams',
  openUrl: jest.fn(),
}));

// Supply the feedback context via a mock so we can assert `open()` fired.
// (Prefixed `mock` so jest's hoisted factory may reference it.)
const mockOpenFeedback = jest.fn();
jest.mock('../../feedback/FeedbackProvider', () => ({
  useFeedback: () => ({ open: mockOpenFeedback }),
}));

import { FundingFooter } from '../FundingFooter';
import { openUrl, BMAC_URL } from '../../lib/links';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('FundingFooter', () => {
  it('opens the tip jar via onSupport when the Support button is pressed', async () => {
    const onSupport = jest.fn();
    const user = userEvent.setup();

    await render(<FundingFooter onSupport={onSupport} />);

    await user.press(screen.getByRole('button', { name: 'Support this app' }));

    expect(onSupport).toHaveBeenCalledTimes(1);
    expect(openUrl).not.toHaveBeenCalled();
  });

  it('falls back to the BMAC link when no onSupport is provided', async () => {
    const user = userEvent.setup();

    await render(<FundingFooter />);

    await user.press(screen.getByRole('button', { name: 'Support this app' }));

    expect(openUrl).toHaveBeenCalledWith(BMAC_URL);
  });

  it('opens the feedback sheet when Send feedback is pressed', async () => {
    const user = userEvent.setup();

    await render(<FundingFooter />);

    await user.press(screen.getByRole('button', { name: 'Send feedback' }));

    expect(mockOpenFeedback).toHaveBeenCalledTimes(1);
  });
});
