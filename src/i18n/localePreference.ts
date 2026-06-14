/**
 * User language preference — System / English / a translated locale — for the
 * whole app. The language sibling of the design system's themePreference.ts
 * (System / Light / Dark): same singleton-store + useSyncExternalStore shape,
 * same persist-and-apply-on-launch contract, so the in-app control behaves
 * identically to the appearance control (canon § Translations, § Theming).
 *
 * Canonical, app-agnostic — synced by `sync.mjs app-shell`; do NOT fork per app.
 *
 * It lives in i18n/ (not the design system, where themePreference sits) because
 * it depends on the i18n machinery — `applyDeviceLocale()` / `setLocaleStrings()`
 * / `LOCALES` — which is the app shell, not the theme. An app without the shell
 * can't translate in-app anyway, so there is nothing to gate from here.
 *
 * How it drives the UI (the one real difference from theme): a theme change
 * rides `useColorScheme()`, which re-renders every themed surface for free. A
 * language change has no OS primitive — `t()` reads a module-level dictionary —
 * so the app root keys its <NavigationContainer> on `useLocaleVersion()`, and an
 * explicit switch bumps that version, re-rendering the whole tree in the new
 * language (and returning to the home route, as an OS-level language change
 * would on relaunch). Cold start applies a saved non-System choice before the
 * user sees anything, with at most one startup remount.
 *
 *   // App root (or AppShell), once:
 *   useApplyLocalePreference();
 *   const localeVersion = useLocaleVersion();   // -> <NavigationContainer key={localeVersion} />
 *
 *   // The control (or any surface that reads/sets the choice):
 *   const { pref, setPref } = useLocalePreference();
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { CANONICAL_LOCALES, applyDeviceLocale, setLocaleStrings } from './index';
import { LOCALES } from './locales';
import { SHELL_LOCALES } from './shellLocales';

/** 'system' follows the phone (the default — today's behavior). Any other value
 *  is an explicit locale tag the user chose ('en' or a CANONICAL_LOCALES tag). */
export type LocalePref = 'system' | string;

/**
 * The display name of each language in its OWN language (autonym) — never
 * translated into the current UI language, so a user who lands in the wrong one
 * can always find their way back (the universal language-picker convention).
 * Keyed by locale tag; 'system' is labelled from the translated shell strings.
 */
export const AUTONYMS: Record<string, string> = {
  en: 'English',
  es: 'Español',
  de: 'Deutsch',
  fr: 'Français',
  it: 'Italiano',
  'pt-BR': 'Português (Brasil)',
  ja: '日本語',
};

const STORAGE_KEY = 'ja.locale.preference';

// Module-level singleton store — one source of truth shared by the control, the
// apply-on-launch hook, and the root remount key, without a React context
// wrapping the tree (mirrors themePreference.ts). Components subscribe via
// useSyncExternalStore.
let pref: LocalePref = 'system';
let version = 0; // remount key — bumps only when the active language changes
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Point the active dictionary at a preference. 'system' re-reads the device
 *  locale; an explicit tag overlays that locale (falling back to English
 *  per-key for anything untranslated); an unknown tag falls back to device. */
function applyPref(p: LocalePref): void {
  if (p === 'system') {
    applyDeviceLocale();
    return;
  }
  const dict = LOCALES[p];
  if (dict) setLocaleStrings(dict);
  else applyDeviceLocale();
}

function coerce(value: string | null): LocalePref {
  if (value === 'system' || value === 'en') return value;
  return value && value in LOCALES ? value : 'system';
}

/** Persist + apply a new preference and re-render the app in that language.
 *  Exported for non-React call sites (e.g. QA seeding); UI should prefer the
 *  `useLocalePreference` hook. */
export function setLocalePreference(p: LocalePref): void {
  pref = p;
  applyPref(p);
  version += 1; // explicit switch -> remount the tree in the new language
  emit();
  AsyncStorage.setItem(STORAGE_KEY, p).catch(() => {});
}

let loadStarted = false;

/** Load the saved preference from disk and apply it. Idempotent — safe to call
 *  from more than one mounted component; the read happens once. A saved
 *  non-System choice bumps the version once so already-mounted screens adopt it;
 *  System needs no bump (the device locale was applied on i18n import). */
export function loadLocalePreference(): void {
  if (loadStarted) return;
  loadStarted = true;
  AsyncStorage.getItem(STORAGE_KEY)
    .then((value) => {
      pref = coerce(value);
      if (pref !== 'system') {
        applyPref(pref);
        version += 1;
      }
    })
    .catch(() => {})
    .finally(emit);
}

/**
 * Call ONCE near the app root (the canonical AppShell): on mount it restores the
 * saved language and applies it before the user touches anything. Without it the
 * app silently follows the OS, ignoring a saved choice.
 */
export function useApplyLocalePreference(): void {
  useEffect(() => {
    loadLocalePreference();
  }, []);
}

/**
 * The remount key. Use it as `key` on the app's <NavigationContainer> so the
 * whole tree re-renders when the language changes — the one piece of wiring a
 * JS-dictionary i18n needs that a theme change gets free from useColorScheme().
 */
export function useLocaleVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => version);
}

/** Reactive accessor for the picker UI and anything that branches on the user's
 *  explicit choice. */
export function useLocalePreference(): {
  pref: LocalePref;
  setPref: (pref: LocalePref) => void;
} {
  const value = useSyncExternalStore(subscribe, () => pref, () => pref);
  const setPref = useCallback((next: LocalePref) => setLocalePreference(next), []);
  return { pref: value, setPref };
}

/** The locales this app is actually translated INTO, in canonical order — i.e.
 *  the app has overlaid its own DOMAIN strings on top of the shell chrome in
 *  `locales.ts` for that locale. Until then the control offers only System +
 *  English, so a user never lands on a half-translated app; each app's
 *  languages light up here, with no code change, as its P7 domain-translation
 *  pass lands. ('system' and 'en' are always offered by the control on top.)
 *
 *  Signal: the default `locales.ts` spreads SHELL_LOCALES, so an untranslated
 *  locale is reference-identical to its shell entry; a real translation merges
 *  a fresh object (`{ ...SHELL_LOCALES.es, ...es }`), which differs. */
export function availableLocales(): string[] {
  const shell = SHELL_LOCALES as Record<string, unknown>;
  return CANONICAL_LOCALES.filter((l) => {
    const dict = LOCALES[l];
    return !!dict && (dict as unknown) !== shell[l];
  });
}
