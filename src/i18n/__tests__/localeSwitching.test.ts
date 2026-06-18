/**
 * Regression test for the in-app language switch (canon § Translations).
 *
 * Canonical, app-agnostic — synced by `sync.mjs app-shell` / `sync.mjs i18n`;
 * do NOT fork per app. It asserts the property a user reported broken
 * (2026-06-14): after switching to another language you can ALWAYS get all the
 * way back to English. The bug was that resetting the active dictionary was a
 * no-op when the device locale had no translation, so the previous overlay
 * stuck on screen.
 *
 * Pure: exercises the i18n dictionary primitives directly (no AsyncStorage / no
 * React), and only reads `common.cancel`, which is in the canonical
 * SHELL_LOCALES for every app — so this passes in any app that has the shell
 * i18n module, translated or not.
 */

import {
  t,
  setLocaleStrings,
  resetToBaseStrings,
  applyDeviceLocale,
} from '../index';
import { LOCALES } from '../locales';

describe('i18n language switching', () => {
  afterEach(() => resetToBaseStrings());

  it('overlays a locale, then returns ALL THE WAY back to English', () => {
    setLocaleStrings(LOCALES.es);
    expect(t('common.cancel')).toBe('Cancelar');

    // The reported bug: switching back to English must clear the overlay, not
    // leave the previous language stuck.
    resetToBaseStrings();
    expect(t('common.cancel')).toBe('Cancel');
  });

  it('survives repeated round-trips without a language sticking', () => {
    for (let i = 0; i < 3; i++) {
      setLocaleStrings(LOCALES.fr);
      expect(t('common.cancel')).toBe('Annuler');
      resetToBaseStrings();
      expect(t('common.cancel')).toBe('Cancel');

      setLocaleStrings(LOCALES.de);
      expect(t('common.cancel')).toBe('Abbrechen');
      resetToBaseStrings();
      expect(t('common.cancel')).toBe('Cancel');
    }
  });

  it('applyDeviceLocale resets to English when the device locale is unmatched', () => {
    setLocaleStrings(LOCALES.de);
    expect(t('common.cancel')).toBe('Abbrechen');

    // The Jest runtime's locale is en-US, which has no overlay in LOCALES, so
    // applyDeviceLocale must reset to the English base — not keep German.
    applyDeviceLocale();
    expect(t('common.cancel')).toBe('Cancel');
  });
});
