/**
 * Component test — FundingFooter (Uplevel-3 T3 action coverage).
 *
 * Two ghost buttons: Support (opens the tip jar via `onSupport`; the button
 * doesn't render at all without one — no external link-out) and Send feedback
 * (opens the feedback sheet via the FeedbackProvider context). We prove each
 * press fires its handler:
 *   • Support with onSupport set → onSupport fires (tip-jar path).
 *   • Support without onSupport → the button is not rendered.
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
// The wordmark's pull-to-reveal animation is reanimated-backed. Reanimated 4.5
// dropped its self-contained `/mock` entry point — it now loads the real index,
// which reaches for the worklets native module and throws under jest — so the
// three pieces the footer actually imports are stubbed to plain React.
jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: { View },
    useAnimatedStyle: (fn: () => unknown) => fn(),
    interpolate: (v: number, inRange: number[], outRange: number[]) =>
      outRange[0] + (v - inRange[0]) * (outRange[1] - outRange[0]),
  };
});

// Supply the feedback context via a mock so we can assert `open()` fired.
// (Prefixed `mock` so jest's hoisted factory may reference it.)
const mockOpenFeedback = jest.fn();
jest.mock('../../feedback/FeedbackProvider', () => ({
  useFeedback: () => ({ open: mockOpenFeedback }),
}));

import { FundingFooter } from '../FundingFooter';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('FundingFooter', () => {
  it('opens the tip jar via onSupport when the Support button is pressed', async () => {
    const onSupport = jest.fn();
    const user = userEvent.setup();

    await render(<FundingFooter onSupport={onSupport} />);

    await user.press(screen.getByRole('button', { name: 'Support' }));

    expect(onSupport).toHaveBeenCalledTimes(1);
  });

  it('does not render the Support button when no onSupport is provided', async () => {
    await render(<FundingFooter />);

    expect(
      screen.queryByRole('button', { name: 'Support' })
    ).toBeNull();
  });

  it('opens the feedback sheet when Send feedback is pressed', async () => {
    const user = userEvent.setup();

    await render(<FundingFooter />);

    await user.press(screen.getByRole('button', { name: 'Send feedback' }));

    expect(mockOpenFeedback).toHaveBeenCalledTimes(1);
  });
});
