/**
 * Assemble the localized grocery seed catalog from the per-aisle JSON slices in
 * ./raw into src/data/seedCatalogData.ts (the "Common items" tier).
 *
 * Pure build tool — run with Node:  node scratch/seed/assemble.mjs
 *
 * - Validates every row has all 7 locales + a valid built-in category.
 * - Dedupes by the English name (case-insensitive); first slice wins, slices
 *   are read in SLICE_ORDER so cross-aisle collisions resolve deterministically.
 * - Groups output by DEFAULT_CATEGORY_ORDER, preserving each slice's
 *   most-common-first order within a category.
 * - Prints per-category counts + an "untranslated" heuristic report.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = join(HERE, 'raw');
const OUT = join(HERE, '..', '..', 'src', 'data', 'seedCatalogData.ts');

const LOCALES = ['en', 'es', 'de', 'fr', 'it', 'pt-BR', 'ja'];

// Read order = dedup priority (earlier slice wins an en-name collision).
const SLICE_ORDER = [
  'produce-fruits', 'produce-veg', 'bakery', 'meat-seafood', 'dairy-eggs',
  'frozen', 'pantry-cooking', 'pantry-baking', 'snacks', 'beverages',
  'household', 'personal-care',
];

// Output grouping order (matches DEFAULT_CATEGORY_ORDER; 'Other' carries no seeds).
const CATEGORY_ORDER = [
  'Produce', 'Bakery', 'Meat & seafood', 'Dairy & eggs', 'Frozen',
  'Pantry', 'Snacks', 'Beverages', 'Household', 'Personal care',
];
const VALID = new Set(CATEGORY_ORDER);

const rows = [];
const seenEn = new Set();
let dropped = 0;

for (const slug of SLICE_ORDER) {
  const arr = JSON.parse(readFileSync(join(RAW, `${slug}.json`), 'utf8'));
  for (const r of arr) {
    if (!r || typeof r !== 'object') { dropped++; continue; }
    if (!VALID.has(r.category)) { console.warn(`  drop (bad category "${r.category}") in ${slug}`); dropped++; continue; }
    let ok = true;
    const row = { category: r.category };
    for (const loc of LOCALES) {
      const v = typeof r[loc] === 'string' ? r[loc].trim() : '';
      if (!v) { ok = false; break; }
      row[loc] = v;
    }
    if (!ok) { console.warn(`  drop (missing locale) in ${slug}: ${JSON.stringify(r).slice(0, 80)}`); dropped++; continue; }
    const key = row.en.toLowerCase();
    if (seenEn.has(key)) { dropped++; continue; }
    seenEn.add(key);
    rows.push(row);
  }
}

// Group by category in CATEGORY_ORDER, preserving within-category insertion order.
const byCat = new Map(CATEGORY_ORDER.map((c) => [c, []]));
for (const r of rows) byCat.get(r.category).push(r);
const ordered = [];
for (const c of CATEGORY_ORDER) ordered.push(...byCat.get(c));

// Emit.
const esc = (s) => JSON.stringify(s); // safe quoting + unicode kept literal
const lines = ordered.map((r) => {
  const parts = [`category: ${esc(r.category)}`];
  for (const loc of LOCALES) parts.push(`${loc === 'pt-BR' ? `'pt-BR'` : loc}: ${esc(r[loc])}`);
  return `  { ${parts.join(', ')} },`;
});

const header = `/**
 * GENERATED FILE — do not edit by hand.
 *
 * Localized grocery seed catalog: the built-in "Common items" suggestion tier.
 * Generic item names only (no brands), across ${CATEGORY_ORDER.length} aisles and ${LOCALES.length} locales. It only
 * ever *suggests* — it never auto-adds, never tracks, never reaches the network.
 * Regenerate from the per-aisle slices via:  node scratch/seed/assemble.mjs
 *
 * Pure data: the single \`import type\` is erased at compile time, so this file
 * has no runtime imports (tree-shakes cleanly; a Node verifier can parse it).
 */
import type { SeedRow } from './seedCatalog';

export const SEED_ROWS: SeedRow[] = [
`;
writeFileSync(OUT, header + lines.join('\n') + '\n];\n', 'utf8');

// Report.
console.log(`\nseedCatalogData.ts written: ${ordered.length} items (dropped ${dropped}).`);
for (const c of CATEGORY_ORDER) console.log(`  ${c.padEnd(16)} ${byCat.get(c).length}`);
let untranslated = 0;
const samples = [];
for (const r of ordered) {
  for (const loc of LOCALES) {
    if (loc === 'en') continue;
    if (r[loc].toLowerCase() === r.en.toLowerCase()) {
      untranslated++;
      if (samples.length < 25) samples.push(`${loc}:${r.en}`);
      break;
    }
  }
}
console.log(`\nUntranslated heuristic (a non-en field == en — many are legit loanwords): ${untranslated}`);
console.log('  sample:', samples.join('  '));
