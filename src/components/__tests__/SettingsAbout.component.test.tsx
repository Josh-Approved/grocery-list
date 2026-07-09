/**
 * Component test — SettingsAbout (Uplevel-3 T3 action coverage).
 *
 * SettingsAbout assembles the canonical About block: support, feedback, review,
 * privacy, source, acknowledgements rows, the version (static, no press), the
 * cross-promo list, and the "Learn more" stamp link. We render it with the props
 * a real SettingsScreen passes and press each actionable row, asserting the
 * observable outcome:
 *   • Support (with onSupport) → onSupport fires (tip-jar path).
 *   • Send feedback → the feedback `open()` fires.
 *   • Leave a review → openReview() fires.
 *   • Privacy / Source code → openUrl(<that url>).
 *   • Acknowledgements → onAcknowledgements fires.
 *   • Learn more → openUrl(STUDIO_URL).
 * Native/link side-effects are mocked; the component under test is not. Queries
 * by role/label only; no testID, no snapshots.
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

// Mock the links module: keep the real URL constants stable and observe the
// link-opening functions without touching the native bridge.
jest.mock('../../lib/links', () => ({
  BMAC_URL: 'https://buymeacoffee.com/jtysonwilliams',
  PRIVACY_URL: 'https://example.test/privacy',
  REPO_URL: 'https://github.com/josh-approved/grocery-list',
  STUDIO_URL: 'https://joshapproved.com',
  openReview: jest.fn(),
  openUrl: jest.fn(),
  versionLabel: () => '1.0.0 (1)',
}));

// Supply the feedback context. (Prefixed `mock` for jest's hoisted factory.)
const mockOpenFeedback = jest.fn();
jest.mock('../../feedback/FeedbackProvider', () => ({
  useFeedback: () => ({ open: mockOpenFeedback }),
}));

// Keep the cross-promo row out of the way — it's covered by its own test.
jest.mock('../MoreFromJA', () => ({ MoreFromJA: () => null }));

import { SettingsAbout } from '../SettingsAbout';
import {
  openReview,
  openUrl,
  PRIVACY_URL,
  REPO_URL,
  STUDIO_URL,
} from '../../lib/links';

beforeEach(() => {
  jest.clearAllMocks();
});

async function renderBlock(overrides: Partial<React.ComponentProps<typeof SettingsAbout>> = {}) {
  const props = {
    onAcknowledgements: jest.fn(),
    onSupport: jest.fn(),
    ...overrides,
  };
  await render(<SettingsAbout {...props} />);
  return props;
}

describe('SettingsAbout', () => {
  it('opens the tip jar via onSupport when Support is pressed', async () => {
    const user = userEvent.setup();
    const props = await renderBlock();
    await user.press(screen.getByRole('button', { name: 'Support this app' }));
    expect(props.onSupport).toHaveBeenCalledTimes(1);
  });

  it('opens the feedback sheet when Send feedback is pressed', async () => {
    const user = userEvent.setup();
    await renderBlock();
    await user.press(screen.getByRole('button', { name: 'Send feedback' }));
    expect(mockOpenFeedback).toHaveBeenCalledTimes(1);
  });

  it('opens the review flow when Leave a review is pressed', async () => {
    const user = userEvent.setup();
    await renderBlock();
    await user.press(screen.getByRole('button', { name: 'Leave a review' }));
    expect(openReview).toHaveBeenCalledTimes(1);
  });

  it('opens the privacy and source URLs from their rows', async () => {
    const user = userEvent.setup();
    await renderBlock();

    await user.press(screen.getByRole('button', { name: 'Privacy' }));
    expect(openUrl).toHaveBeenCalledWith(PRIVACY_URL);

    await user.press(screen.getByRole('button', { name: 'Source code' }));
    expect(openUrl).toHaveBeenCalledWith(REPO_URL);
  });

  it('navigates to Acknowledgements when that row is pressed', async () => {
    const user = userEvent.setup();
    const props = await renderBlock();
    await user.press(screen.getByRole('button', { name: 'Acknowledgements' }));
    expect(props.onAcknowledgements).toHaveBeenCalledTimes(1);
  });

  it('opens the studio site when Learn more is pressed', async () => {
    const user = userEvent.setup();
    await renderBlock();
    await user.press(
      screen.getByRole('button', { name: 'Learn more at joshapproved.com' })
    );
    expect(openUrl).toHaveBeenCalledWith(STUDIO_URL);
  });
});
