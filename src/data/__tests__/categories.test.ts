/**
 * Locale-aware aisle inference (inferCategory).
 *
 * The behavioral gate for the localized-categorization fix: an item typed in
 * the active in-app language must land in the right aisle instead of falling
 * into "Other" (Josh's bug: app in Spanish → "manzanas"/"jugo de naranja" →
 * Otros). The companion `scratch/verify-categorization.mjs` checks the keyword
 * DATA is complete + translated; this checks the matcher BEHAVES.
 */

import { inferCategory } from '../categories';

describe('inferCategory — English (default locale)', () => {
  it('categorizes English items with no locale argument (unchanged semantics)', () => {
    expect(inferCategory('milk')).toBe('Dairy & eggs');
    expect(inferCategory('chicken breast')).toBe('Meat & seafood');
    expect(inferCategory('sourdough bread')).toBe('Bakery');
    expect(inferCategory('sparkling water')).toBe('Beverages');
  });

  it('defaults to Other for empty / unknown input', () => {
    expect(inferCategory('')).toBe('Other');
    expect(inferCategory('   ')).toBe('Other');
    expect(inferCategory('zxqwvb')).toBe('Other');
  });

  it('keeps the pre-existing first-match-wins behavior (orange juice → Produce)', () => {
    // Produce is scanned before Beverages, so 'orange' wins — documented, and
    // the reason Spanish Produce omits the bare orange word (see es cases).
    expect(inferCategory('orange juice')).toBe('Produce');
  });
});

describe('inferCategory — Spanish (es)', () => {
  it('categorizes Spanish items into the correct non-fallback aisle', () => {
    expect(inferCategory('manzanas', 'es')).toBe('Produce');
    expect(inferCategory('frutas', 'es')).toBe('Produce');
    expect(inferCategory('leche', 'es')).toBe('Dairy & eggs');
    expect(inferCategory('jugo de naranja', 'es')).toBe('Beverages');
    expect(inferCategory('pan integral', 'es')).toBe('Bakery');
    expect(inferCategory('pollo', 'es')).toBe('Meat & seafood');
  });

  it('still categorizes English input via the English fallback', () => {
    expect(inferCategory('apple', 'es')).toBe('Produce');
    expect(inferCategory('milk', 'es')).toBe('Dairy & eggs');
  });
});

describe('inferCategory — German (de)', () => {
  it('categorizes German items into the correct non-fallback aisle', () => {
    expect(inferCategory('apfel', 'de')).toBe('Produce');
    expect(inferCategory('milch', 'de')).toBe('Dairy & eggs');
    expect(inferCategory('brot', 'de')).toBe('Bakery');
    expect(inferCategory('bier', 'de')).toBe('Beverages');
  });

  it('still categorizes English input via the English fallback', () => {
    expect(inferCategory('apple', 'de')).toBe('Produce');
  });
});

describe('inferCategory — French (fr)', () => {
  it('categorizes French items into the correct non-fallback aisle', () => {
    expect(inferCategory('pomme', 'fr')).toBe('Produce');
    expect(inferCategory('lait', 'fr')).toBe('Dairy & eggs');
    expect(inferCategory('pain', 'fr')).toBe('Bakery');
    expect(inferCategory('bière', 'fr')).toBe('Beverages');
  });

  it('still categorizes English input via the English fallback', () => {
    expect(inferCategory('apple', 'fr')).toBe('Produce');
  });
});

describe('inferCategory — Italian (it)', () => {
  it('categorizes Italian items into the correct non-fallback aisle', () => {
    expect(inferCategory('mela', 'it')).toBe('Produce');
    expect(inferCategory('latte', 'it')).toBe('Dairy & eggs');
    expect(inferCategory('pane', 'it')).toBe('Bakery');
    expect(inferCategory('birra', 'it')).toBe('Beverages');
  });

  it('still categorizes English input via the English fallback', () => {
    expect(inferCategory('apple', 'it')).toBe('Produce');
  });
});

describe('inferCategory — Portuguese (pt-BR)', () => {
  it('categorizes Portuguese items into the correct non-fallback aisle', () => {
    expect(inferCategory('maçã', 'pt-BR')).toBe('Produce');
    expect(inferCategory('leite', 'pt-BR')).toBe('Dairy & eggs');
    expect(inferCategory('pão', 'pt-BR')).toBe('Bakery');
    expect(inferCategory('cerveja', 'pt-BR')).toBe('Beverages');
  });

  it('still categorizes English input via the English fallback', () => {
    expect(inferCategory('apple', 'pt-BR')).toBe('Produce');
  });
});

describe('inferCategory — Japanese (ja)', () => {
  it('categorizes Japanese items into the correct non-fallback aisle', () => {
    expect(inferCategory('りんご', 'ja')).toBe('Produce');
    expect(inferCategory('牛乳', 'ja')).toBe('Dairy & eggs');
    expect(inferCategory('パン', 'ja')).toBe('Bakery');
    expect(inferCategory('ビール', 'ja')).toBe('Beverages');
  });

  it('still categorizes English input via the English fallback', () => {
    expect(inferCategory('apple', 'ja')).toBe('Produce');
  });
});

describe('inferCategory — unknown locale', () => {
  it('falls back to English-only matching (old behavior preserved)', () => {
    expect(inferCategory('milk', 'xx')).toBe('Dairy & eggs');
    expect(inferCategory('manzanas', 'xx')).toBe('Other');
  });
});
