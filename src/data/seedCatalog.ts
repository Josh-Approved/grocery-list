/**
 * Built-in "Common items" suggestion tier.
 *
 * A curated, localized catalog of generic grocery item names (no brands). It
 * powers autocomplete BEFORE the user has their own history — and supplements
 * it after — so a new shopper can one-tap "milk", "eggs", "bananas" on day one
 * instead of typing every word from scratch.
 *
 * Tenet boundary (grocery spec § App-specific tenets): the list still only ever
 * contains what the *user* chose. This catalog only *suggests* — it never
 * auto-adds a row, never reorders the user's list, never tracks, and never
 * touches the network. It's a dictionary, shown dimmed and last, below the
 * user's own usuals and history, and it's deduped against what they already
 * have. (Reconciled into canon as the one allowed exception to "autocomplete
 * draws only from the user's own history".)
 *
 * Data lives in the generated `seedCatalogData.ts` (regenerate via
 * `scratch/seed/assemble.mjs`). This module is the typed, cached accessor.
 */

import type { Category } from './categories';
import { SEED_ROWS } from './seedCatalogData';

/** One catalog row: a generic item with a display name per supported locale. */
export interface SeedRow {
  category: Category;
  en: string;
  es: string;
  de: string;
  fr: string;
  it: string;
  'pt-BR': string;
  ja: string;
}

/** A catalog item resolved to one locale, ready to add (carries its aisle so a
 *  seeded add categorizes exactly, with no keyword guessing). */
export interface SeedItem {
  name: string;
  category: Category;
}

const SEED_LOCALES = ['en', 'es', 'de', 'fr', 'it', 'pt-BR', 'ja'] as const;
type SeedLocale = (typeof SEED_LOCALES)[number];

function resolveLocale(locale: string): SeedLocale {
  return (SEED_LOCALES as readonly string[]).includes(locale)
    ? (locale as SeedLocale)
    : 'en';
}

const localeCache = new Map<SeedLocale, SeedItem[]>();

/** The whole catalog resolved to one locale (computed once per locale). Falls
 *  back to the English name if a row somehow lacks the locale. */
export function seedItemsForLocale(locale: string): SeedItem[] {
  const loc = resolveLocale(locale);
  let items = localeCache.get(loc);
  if (!items) {
    items = SEED_ROWS.map((r) => ({ name: r[loc] || r.en, category: r.category }));
    localeCache.set(loc, items);
  }
  return items;
}

// Brand-new-user starter set: the first few items of the core aisles (catalog
// order is most-common-first), so the empty state is useful on day one without
// dumping the whole catalog. Derived from the data, so it can never name an item
// that isn't present.
const STARTER_CATEGORIES: Category[] = [
  'Produce',
  'Dairy & eggs',
  'Bakery',
  'Meat & seafood',
  'Pantry',
  'Beverages',
  'Household',
];
const STARTER_PER_CATEGORY = 3;
const starterCache = new Map<SeedLocale, SeedItem[]>();

/** A small, universally useful subset for the empty (no-history) state. */
export function starterItemsForLocale(locale: string): SeedItem[] {
  const loc = resolveLocale(locale);
  let items = starterCache.get(loc);
  if (!items) {
    const out: SeedItem[] = [];
    for (const cat of STARTER_CATEGORIES) {
      let n = 0;
      for (const r of SEED_ROWS) {
        if (r.category !== cat) continue;
        out.push({ name: r[loc] || r.en, category: r.category });
        if (++n >= STARTER_PER_CATEGORY) break;
      }
    }
    items = out;
    starterCache.set(loc, items);
  }
  return items;
}

/**
 * Catalog items matching `query` (prefix-first, then substring), excluding any
 * lowercased name in `exclude` — the user's own usuals + history — so the
 * catalog never re-suggests something they already have. Case-insensitive.
 */
export function suggestSeed(
  query: string,
  locale: string,
  exclude: Set<string>,
  limit = 20
): SeedItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const items = seedItemsForLocale(locale);
  const prefix: SeedItem[] = [];
  const contains: SeedItem[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    const lower = it.name.toLowerCase();
    if (exclude.has(lower) || seen.has(lower)) continue;
    if (lower.startsWith(q)) {
      prefix.push(it);
      seen.add(lower);
    } else if (lower.includes(q)) {
      contains.push(it);
      seen.add(lower);
    }
    if (prefix.length >= limit) break;
  }
  return [...prefix, ...contains].slice(0, limit);
}
