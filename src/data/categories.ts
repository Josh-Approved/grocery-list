/**
 * Grocery aisle categories + keyword inference.
 *
 * Inference is a static keyword map — NOT AI, NOT a network call, NOT a
 * "suggested items" feed. It only ever sorts an item the user already typed
 * into an aisle so the list reads in store order. App tenet: the list
 * contains only what the user typed.
 *
 * `categoryOrder` is stored per-list and is user-reorderable (build step 3)
 * so it can match a specific store's layout. This module only provides the
 * default order + the text→aisle guess for a freshly added item.
 */

import { t } from '../i18n';
import { KEYWORDS_BY_LOCALE } from './categoryKeywords';

/** The fixed, code-defined aisles. Stable internal keys (persisted + used for
 *  keyword inference); their localizable display names live in i18n under
 *  `aisles.*`. */
export type BuiltinCategory =
  | 'Produce'
  | 'Bakery'
  | 'Meat & seafood'
  | 'Dairy & eggs'
  | 'Frozen'
  | 'Pantry'
  | 'Snacks'
  | 'Beverages'
  | 'Household'
  | 'Personal care'
  | 'Other';

/** An aisle key. Either a built-in (above) or a user-created custom aisle —
 *  for a custom aisle the literal name IS the key and its own display label
 *  (it carries no translation and never auto-receives items; you file items
 *  into it by hand). Stored in `list.categoryOrder`, so it syncs and reorders
 *  exactly like a built-in. */
export type Category = string;

/** The Category union values are stable internal keys (persisted + used for
 *  inference); their localizable display names live in i18n under `aisles.*`.
 *  Keys, not resolved strings — `categoryLabel` resolves at render time. */
const CATEGORY_LABEL_KEY: Record<BuiltinCategory, string> = {
  Produce: 'aisles.produce',
  Bakery: 'aisles.bakery',
  'Meat & seafood': 'aisles.meatSeafood',
  'Dairy & eggs': 'aisles.dairyEggs',
  Frozen: 'aisles.frozen',
  Pantry: 'aisles.pantry',
  Snacks: 'aisles.snacks',
  Beverages: 'aisles.beverages',
  Household: 'aisles.household',
  'Personal care': 'aisles.personalCare',
  Other: 'aisles.other',
};

/** Is this key one of the fixed, code-defined aisles? (vs. a user custom one) */
export function isBuiltinCategory(category: string): category is BuiltinCategory {
  return Object.prototype.hasOwnProperty.call(CATEGORY_LABEL_KEY, category);
}

/** Localized display name for an aisle. Call at render time (never module-level).
 *  A custom aisle is its own label — there's nothing to translate. */
export function categoryLabel(category: Category): string {
  return isBuiltinCategory(category) ? t(CATEGORY_LABEL_KEY[category]) : category;
}

/** Canonical default aisle order. A list copies this at creation and may then
 *  reorder its own copy (build step 3) without affecting other lists. */
export const DEFAULT_CATEGORY_ORDER: BuiltinCategory[] = [
  'Produce',
  'Bakery',
  'Meat & seafood',
  'Dairy & eggs',
  'Frozen',
  'Pantry',
  'Snacks',
  'Beverages',
  'Household',
  'Personal care',
  'Other',
];

/** Scan one locale's keyword map for the first category (in
 *  DEFAULT_CATEGORY_ORDER) with a substring hit. 'Other' carries no keywords,
 *  so it is never matched here — it's the fallback. Returns null on no match. */
function matchInMap(
  n: string,
  map: Record<string, string[]> | undefined
): Category | null {
  if (!map) return null;
  for (const category of DEFAULT_CATEGORY_ORDER) {
    const keywords = map[category];
    if (!keywords) continue;
    for (const kw of keywords) {
      if (n.includes(kw)) return category;
    }
  }
  return null;
}

/**
 * Best-guess aisle for a freshly typed item. Locale-aware: an item typed in the
 * active in-app language matches that language's keywords, with English as the
 * per-item fallback so English input still sorts in any locale (and an unknown
 * locale behaves exactly like the old English-only matcher). Defaults to
 * 'Other'. Keywords live in `categoryKeywords.ts` (single source of truth).
 */
export function inferCategory(name: string, locale: string = 'en'): Category {
  const n = name.trim().toLowerCase();
  if (!n) return 'Other';
  const localeMap = KEYWORDS_BY_LOCALE[locale];
  // Try the active locale first (unless it IS English), then English fallback.
  if (localeMap && localeMap !== KEYWORDS_BY_LOCALE.en) {
    const hit = matchInMap(n, localeMap);
    if (hit) return hit;
  }
  return matchInMap(n, KEYWORDS_BY_LOCALE.en) ?? 'Other';
}
