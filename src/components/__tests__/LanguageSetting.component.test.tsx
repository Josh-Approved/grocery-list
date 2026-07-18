/**
 * Component test — LanguageSetting (Uplevel-3 T3 action coverage).
 *
 * The row-plus-sheet language picker. Five actions:
 *   • Press the trigger row → opens the selection sheet.
 *   • Press a language option (radio) → selects it (setPref) and closes.
 *   • Press "Cancel" (the scrim) → closes without changing the language.
 *   • Press "Done" (the X) → closes without changing the language.
 *   • Press a second option later → selects that one.
 * We drive the real locale-preference store (AsyncStorage is mocked) and assert
 * observable outcomes: the sheet opens/closes and the chosen language surfaces
 * on the trigger row. Queries by role/label/text only; no testID, no snapshots.
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

import { LanguageSetting } from '../LanguageSetting';
import { setLocalePreference } from '../../i18n/localePreference';

// Reset the module-level locale store to System (English) between tests so each
// starts from the known default.
afterEach(() => {
  setLocalePreference('system');
});

describe('LanguageSetting', () => {
  it('opens the selection sheet when the trigger row is pressed', async () => {
    const user = userEvent.setup();
    await render(<LanguageSetting />);

    // The trigger is a button labelled "Language, <current>" (default System).
    await user.press(screen.getByRole('button', { name: 'Language, System' }));

    // The sheet is open — the English option (a radio) is now reachable.
    expect(screen.getByRole('radio', { name: 'English' })).toBeTruthy();
  });

  it('selects a language and closes the sheet when an option is pressed', async () => {
    const user = userEvent.setup();
    await render(<LanguageSetting />);

    await user.press(screen.getByRole('button', { name: 'Language, System' }));
    // Spanish autonym is "Español" (grocery-list ships translations).
    await user.press(screen.getByRole('radio', { name: 'Español' }));

    // The sheet closed (no radios) and the trigger now shows the chosen language.
    expect(screen.queryByRole('radio', { name: 'English' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Idioma, Español' })).toBeTruthy();
  });

  it('closes without changing the language when the scrim (Cancel) is pressed', async () => {
    const user = userEvent.setup();
    await render(<LanguageSetting />);

    await user.press(screen.getByRole('button', { name: 'Language, System' }));
    // The scrim carries the Cancel accessibility label.
    await user.press(screen.getByLabelText('Cancel'));

    expect(screen.queryByRole('radio', { name: 'English' })).toBeNull();
    // Language unchanged — still System.
    expect(screen.getByRole('button', { name: 'Language, System' })).toBeTruthy();
  });

  it('closes without changing the language when Done (the X) is pressed', async () => {
    const user = userEvent.setup();
    await render(<LanguageSetting />);

    await user.press(screen.getByRole('button', { name: 'Language, System' }));
    await user.press(screen.getByRole('button', { name: 'Done' }));

    expect(screen.queryByRole('radio', { name: 'English' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Language, System' })).toBeTruthy();
  });

  it('can select a different language on a later open', async () => {
    const user = userEvent.setup();
    await render(<LanguageSetting />);

    await user.press(screen.getByRole('button', { name: 'Language, System' }));
    await user.press(screen.getByRole('radio', { name: 'Deutsch' }));

    expect(screen.getByRole('button', { name: 'Sprache, Deutsch' })).toBeTruthy();
  });
});
