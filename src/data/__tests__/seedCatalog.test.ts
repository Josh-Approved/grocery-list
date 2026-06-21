/**
 * Seed catalog ("Common items" tier) — data integrity + the pure accessors.
 *
 * The catalog is generated (scratch/seed/assemble.mjs); this is the gate that
 * the generated data stays well-formed and fully localized, and that matching /
 * exclusion behave. Companion to categories.test.ts (aisle inference).
 */

import {
  seedItemsForLocale,
  starterItemsForLocale,
  suggestSeed,
} from '../seedCatalog';
import { SEED_ROWS } from '../seedCatalogData';
import { DEFAULT_CATEGORY_ORDER, isBuiltinCategory } from '../categories';
import { makeItem } from '../list';

const LOCALES = ['en', 'es', 'de', 'fr', 'it', 'pt-BR', 'ja'] as const;

describe('seed catalog data integrity', () => {
  it('ships a substantial catalog (~1000+ items)', () => {
    expect(SEED_ROWS.length).toBeGreaterThanOrEqual(1000);
  });

  it('every row is fully localized into all 7 locales', () => {
    for (const r of SEED_ROWS) {
      for (const loc of LOCALES) {
        expect(typeof r[loc]).toBe('string');
        expect(r[loc].trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('every row has a valid built-in category (never Other)', () => {
    for (const r of SEED_ROWS) {
      expect(isBuiltinCategory(r.category)).toBe(true);
      expect(r.category).not.toBe('Other');
      expect(DEFAULT_CATEGORY_ORDER).toContain(r.category);
    }
  });

  it('English names are unique (case-insensitive) — no dupes survived assembly', () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const r of SEED_ROWS) {
      const k = r.en.toLowerCase();
      if (seen.has(k)) dupes.push(r.en);
      seen.add(k);
    }
    expect(dupes).toEqual([]);
  });

  it('carries breadth across every aisle', () => {
    const counts = new Map<string, number>();
    for (const r of SEED_ROWS) counts.set(r.category, (counts.get(r.category) ?? 0) + 1);
    for (const cat of DEFAULT_CATEGORY_ORDER) {
      if (cat === 'Other') continue;
      expect(counts.get(cat) ?? 0).toBeGreaterThanOrEqual(20);
    }
  });
});

describe('seedItemsForLocale', () => {
  it('resolves one item per row', () => {
    expect(seedItemsForLocale('en')).toHaveLength(SEED_ROWS.length);
    expect(seedItemsForLocale('es')).toHaveLength(SEED_ROWS.length);
  });

  it('returns localized names (Spanish differs from English somewhere)', () => {
    const en = seedItemsForLocale('en');
    const es = seedItemsForLocale('es');
    const differ = en.some((it, i) => it.name !== es[i].name);
    expect(differ).toBe(true);
  });

  it('falls back to English for an unsupported locale', () => {
    const en = seedItemsForLocale('en');
    const xx = seedItemsForLocale('xx');
    expect(xx.map((i) => i.name)).toEqual(en.map((i) => i.name));
  });

  it('carries each item’s aisle (so a seeded add categorizes exactly)', () => {
    for (const it of seedItemsForLocale('en')) {
      expect(isBuiltinCategory(it.category)).toBe(true);
    }
  });
});

describe('starterItemsForLocale (empty-state set)', () => {
  it('returns a small, non-empty, localized set', () => {
    const en = starterItemsForLocale('en');
    expect(en.length).toBeGreaterThan(0);
    expect(en.length).toBeLessThanOrEqual(30);
    for (const it of en) expect(it.name.trim().length).toBeGreaterThan(0);
    const de = starterItemsForLocale('de');
    expect(de.some((it, i) => it.name !== en[i]?.name)).toBe(true);
  });
});

describe('suggestSeed', () => {
  it('returns nothing for an empty query', () => {
    expect(suggestSeed('', 'en', new Set())).toEqual([]);
  });

  it('matches prefix-first, then substring', () => {
    const hits = suggestSeed('app', 'en', new Set(), 20).map((h) => h.name.toLowerCase());
    expect(hits.length).toBeGreaterThan(0);
    // Every hit contains the query…
    for (const h of hits) expect(h.includes('app')).toBe(true);
    // …and any prefix matches sort ahead of pure-substring matches.
    const lastPrefix = hits.map((h) => h.startsWith('app')).lastIndexOf(true);
    const firstContains = hits.map((h) => h.startsWith('app')).indexOf(false);
    if (lastPrefix !== -1 && firstContains !== -1) {
      expect(lastPrefix).toBeLessThan(firstContains);
    }
  });

  it('excludes names the user already has', () => {
    const all = suggestSeed('milk', 'en', new Set(), 20).map((h) => h.name.toLowerCase());
    expect(all).toContain('milk');
    const excluded = suggestSeed('milk', 'en', new Set(['milk']), 20).map((h) =>
      h.name.toLowerCase()
    );
    expect(excluded).not.toContain('milk');
  });

  it('respects the limit', () => {
    expect(suggestSeed('a', 'en', new Set(), 5).length).toBeLessThanOrEqual(5);
  });

  it('is case-insensitive', () => {
    const lower = suggestSeed('milk', 'en', new Set()).map((h) => h.name);
    const upper = suggestSeed('MILK', 'en', new Set()).map((h) => h.name);
    expect(upper).toEqual(lower);
  });
});

describe('makeItem with an explicit category (seeded add)', () => {
  it('uses the given category instead of guessing', () => {
    // "sponge" would never infer to Household by keyword; the seed catalog
    // supplies the aisle, so the explicit category must win.
    expect(makeItem('sponge', 'en', 'Household').category).toBe('Household');
  });

  it('still infers when no category is given (unchanged behavior)', () => {
    expect(makeItem('milk', 'en').category).toBe('Dairy & eggs');
  });
});
