/**
 * CANONICAL RNTL EXEMPLAR — copy this shape for every component test.
 *
 * This is the reference `*.component.test.tsx` (Uplevel 3 / T3). It tests the
 * shared ScreenHeader the way a user meets it, using @testing-library/react-native
 * v14 + userEvent. Authoring notes — follow them in every component test:
 *
 *   • QUERY BY ROLE / LABEL / TEXT, never by implementation detail. Use
 *     getByRole('button', { name }) / getByLabelText / getByText. A user finds
 *     the back control because it is a button named "Back" — so does the test.
 *   • MISSING ACCESSIBILITY LABELS FAIL THE TEST — that is a feature, not a
 *     nuisance. `getByRole('button', { name: 'Back' })` cannot resolve if the
 *     Pressable drops its accessibilityLabel, so a11y regressions surface here
 *     for free (canon § a11y gains mechanical teeth).
 *   • DRIVE WITH userEvent, not fireEvent — it models real press timing and
 *     runs in milliseconds. `const user = userEvent.setup(); await user.press(el)`.
 *   • NO SNAPSHOTS. A snapshot asserts nothing a user cares about and rots into
 *     a rubber-stamp. Assert observable behavior instead.
 *   • NO testID QUERIES except where the visible surface is genuinely
 *     non-textual (an icon-only control with no accessible name — and the real
 *     fix there is usually to give it an accessibilityLabel, not a testID).
 *   • Keep it a trust-core COMPLEMENT, never a replacement (engineering-standards
 *     § testing): the handler's logic is unit-tested; this proves the wired UI
 *     exposes it to a real user.
 *
 * Rides into every app alongside ScreenHeader via `sync.mjs app-shell`
 * (templates/app-shell/README.md § Component tests ride along). Edit HERE.
 */

import React from 'react';
import { render, screen, userEvent } from '@testing-library/react-native';

// Native side-effect stubs — declare them BEFORE importing the component. The
// theme barrel (`../theme`, imported by every shell component) eagerly pulls in
// the font loader (expo-font → expo-asset) and AsyncStorage (theme preference),
// native modules with no bearing on rendering. Stubbing them is the standard
// component-test preamble: mock native side-effects, never the SUT. Placed above
// the component import so they register first even without jest.mock hoisting.
jest.mock('expo-font', () => ({
  useFonts: () => [true, null],
  isLoaded: () => true,
  loadAsync: () => Promise.resolve(),
}));
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import { ScreenHeader } from '../ScreenHeader';

describe('ScreenHeader', () => {
  it('shows the title and calls onBack when the Back button is pressed', async () => {
    const onBack = jest.fn();
    const user = userEvent.setup();

    // RTL v14's render is ASYNC (it awaits the React act() internally) — always
    // `await` it, then read the tree through the `screen` singleton it binds.
    await render(<ScreenHeader title="Settings" onBack={onBack} />);

    // The title is on screen for a sighted user...
    expect(screen.getByText('Settings')).toBeTruthy();

    // ...and the back control is reachable as a button named "Back" (its
    // accessibilityLabel). If that label is ever dropped, this query throws —
    // the a11y regression fails the test.
    const back = screen.getByRole('button', { name: 'Back' });
    await user.press(back);

    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
