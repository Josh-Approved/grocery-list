/**
 * Translation-ready i18n — canonical, app-agnostic. Synced by
 * `sync.mjs app-shell`; do NOT fork per app.
 *
 * Canon § Translations: every v1 ships translation-READY — all user-facing
 * strings live in one externalized module (no copy hardcoded in components),
 * and dates / numbers / currency format through the platform locale APIs.
 * Full per-locale translation is the post-launch step (P7); the *structure*
 * here is the v1 ship gate, and retrofitting it later is the expensive path.
 *
 * How it works:
 *   - `SHELL_STRINGS` (shellStrings.ts) is the canonical, app-agnostic copy
 *     (Settings / About / common actions). Edit it in the factory, not per app.
 *   - `APP_STRINGS` (appStrings.ts, app-owned, ifAbsent) is each app's domain
 *     copy. The two are deep-merged at module load.
 *   - `t('settings.title')` reads a dotted path out of the merged dictionary;
 *     a missing key returns the key itself (visible failure, never a crash).
 *   - `t('list.itemCount', { count: 3 })` interpolates `{count}`.
 *
 * v1 is single-language (English is the build language). The dictionary is
 * intentionally shaped so a locale map drops in later without touching call
 * sites: when translations land (P7), `setLocaleStrings(locale, dict)` swaps
 * the active table. Formatters are already locale-aware today.
 */

import { SHELL_STRINGS } from './shellStrings';
import { APP_STRINGS } from './appStrings';
import { LOCALES } from './locales';

type Dict = { [key: string]: string | Dict };

/**
 * Canon § Translations: every live app ships in-app strings in this set within
 * its first listing-iteration cycle. Order = match priority (most-specific
 * first). Extend per app when per-country installs justify it; RTL only after
 * the layout is verified. Keep in lockstep with the store-listing locale set
 * (`scripts/translate.mjs`, `runbooks/translations.md`).
 */
export const CANONICAL_LOCALES = ['es', 'de', 'fr', 'it', 'pt-BR', 'ja'] as const;

function deepMerge(base: Dict, extra: Dict): Dict {
  const out: Dict = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    const cur = out[k];
    if (v && typeof v === 'object' && cur && typeof cur === 'object') {
      out[k] = deepMerge(cur as Dict, v as Dict);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** The English base — SHELL + APP, no locale overlay. A fresh object every call
 *  so a reset can never alias a previously-overlaid dictionary. */
function baseStrings(): Dict {
  return deepMerge(SHELL_STRINGS as Dict, APP_STRINGS as Dict);
}

let active: Dict = baseStrings();

/** Drop every locale overlay and return the active dictionary to English.
 *  This is what makes "English" (and System on an English phone) a real
 *  destination, not just "stop translating": without an explicit reset,
 *  switching away from a locale leaves the previous overlay in place and the
 *  old language sticks on screen. */
export function resetToBaseStrings(): void {
  active = baseStrings();
}

/** Replace the active dictionary (locale switch). Keeps SHELL+APP as the
 *  English base and overlays the locale's translations on top. */
export function setLocaleStrings(localeDict: Dict): void {
  active = deepMerge(baseStrings(), localeDict);
}

/**
 * Pick the best available locale for a device locale tag. Tries the full tag
 * (e.g. "pt-BR"), then the primary subtag (e.g. "pt" → "pt-BR" if that's the
 * only Portuguese we have), else null (English stays). Pure — exported for test.
 */
export function pickLocale(
  deviceLocale: string,
  available: string[] = Object.keys(LOCALES)
): string | null {
  if (!deviceLocale || !available.length) return null;
  const tag = deviceLocale.replace('_', '-');
  if (available.includes(tag)) return tag;
  const primary = tag.split('-')[0].toLowerCase();
  // Exact primary match (e.g. "es-MX" → "es").
  const exact = available.find((a) => a.toLowerCase() === primary);
  if (exact) return exact;
  // Else a regional variant sharing the primary subtag (e.g. "pt" → "pt-BR").
  const variant = available.find((a) => a.toLowerCase().split('-')[0] === primary);
  return variant ?? null;
}

/** Apply the device's locale from the LOCALES map (no-op when English or when
 *  no matching translation exists). Called once at module load below. */
export function applyDeviceLocale(): void {
  // Reset first so a device locale with no translation (e.g. English) returns
  // to English instead of leaving a previous overlay in place.
  resetToBaseStrings();
  try {
    const match = pickLocale(getLocale(), Object.keys(LOCALES));
    if (match && LOCALES[match]) {
      active = deepMerge(baseStrings(), LOCALES[match] as Dict);
    }
  } catch {
    /* keep English base */
  }
}

/** Look up a dotted key. Returns the key itself if absent (visible, never throws). */
export function t(key: string, vars?: Record<string, string | number>): string {
  let node: string | Dict | undefined = active;
  for (const part of key.split('.')) {
    if (node && typeof node === 'object') {
      node = (node as Dict)[part];
    } else {
      node = undefined;
      break;
    }
  }
  if (typeof node !== 'string') return key;
  if (!vars) return node;
  return node.replace(/\{(\w+)\}/g, (m, name) =>
    name in vars ? String(vars[name]) : m
  );
}

// ---------- Locale-aware formatting (canon § Translations) ----------
// Hermes ships Intl, so these need no extra dependency. Reading the resolved
// locale from Intl avoids a hard dep on expo-localization; an app that already
// depends on it can pass an explicit locale to override.

/** The device's resolved BCP-47 locale (e.g. "en-US"), with a safe fallback. */
export function getLocale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || 'en-US';
  } catch {
    return 'en-US';
  }
}

export function formatDate(
  value: Date | number,
  opts: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' },
  locale = getLocale()
): string {
  try {
    return new Intl.DateTimeFormat(locale, opts).format(value);
  } catch {
    return new Date(value).toDateString();
  }
}

export function formatNumber(
  value: number,
  opts: Intl.NumberFormatOptions = {},
  locale = getLocale()
): string {
  try {
    return new Intl.NumberFormat(locale, opts).format(value);
  } catch {
    return String(value);
  }
}

/** Format a minor-unit integer (cents/pence) or a major-unit number as
 *  currency. Pass `minor: true` to divide by the currency's minor scale. */
export function formatCurrency(
  amount: number,
  currency: string,
  locale = getLocale()
): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount);
  } catch {
    return `${currency} ${amount}`;
  }
}

// Localize on import — picks the device locale from LOCALES, or stays English.
// A no-op until translations land (LOCALES starts empty), so it's safe to ship
// in every app from day one (canon § Translations: translation-ready by default).
applyDeviceLocale();
