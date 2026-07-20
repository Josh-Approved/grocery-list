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
 *
 * Also carries the KEY-PARITY drift net (ticket translations-strings-drift-check,
 * 2026-07-20): every APP_STRINGS key must exist in every CANONICAL_LOCALES dict.
 * Found 2026-07-13: grocery-list gained 6 domain strings after its locale pass
 * and all six locale dicts silently fell back to English — nothing flagged it.
 * A failure here means the app's src/i18n/<locale>.ts dicts are missing keys:
 * run `node scripts/translate.mjs --strings <app>` and fill them (machine-draft
 * policy — no human language review). Vacuously green pre-translation
 * (APP_STRINGS = {} in the template default).
 */

import {
  t,
  setLocaleStrings,
  resetToBaseStrings,
  applyDeviceLocale,
  CANONICAL_LOCALES,
} from '../index';
import { LOCALES } from '../locales';
import { APP_STRINGS } from '../appStrings';

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

describe('i18n key parity (in-app translation drift net)', () => {
  type Dict = { [key: string]: unknown };

  const flatten = (obj: Dict, prefix = ''): string[] =>
    Object.entries(obj ?? {}).flatMap(([k, v]) => {
      const key = prefix ? `${prefix}.${k}` : k;
      return v && typeof v === 'object' ? flatten(v as Dict, key) : [key];
    });

  it('every APP_STRINGS key is translated in every canonical locale', () => {
    const appKeys = flatten(APP_STRINGS as unknown as Dict);
    const failures: string[] = [];
    for (const loc of CANONICAL_LOCALES) {
      const dict = (LOCALES as Dict)[loc];
      if (!dict) {
        // A canonical locale with no dict at all: every domain key falls back.
        if (appKeys.length) failures.push(`${loc}: no locale dict in LOCALES`);
        continue;
      }
      const locKeys = new Set(flatten(dict as Dict));
      for (const k of appKeys) {
        if (!locKeys.has(k)) failures.push(`${loc}: missing "${k}"`);
      }
    }
    // A failure lists exactly which locale dicts silently fall back to English.
    // Fix: node scripts/translate.mjs --strings <app>, fill src/i18n/<locale>.ts.
    expect(failures).toEqual([]);
  });
});
