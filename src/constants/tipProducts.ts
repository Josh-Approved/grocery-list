/**
 * Tip-jar store product ids for Grocery List — app-owned (NOT synced from the
 * factory; each app declares its own). Consumable one-time tips, cheapest →
 * most generous. Ids are reverse-DNS under the bundle id and must match the
 * products created in App Store Connect + Play Console EXACTLY.
 *
 * The tier *key* is decoupled from the price on purpose: the real, localized
 * price lives in the store (rendered via product.displayPrice), so a price
 * change is a console edit, never a code change. Suggested price points:
 * tier1 $2.99 · tier2 $4.99 · tier3 $9.99 · tier4 $19.99 · tier5 $49.99.
 *
 * See josh-approved-factory/templates/tip-jar/README.md § Console setup.
 */
export const TIP_PRODUCT_IDS = [
  'com.joshapproved.grocerylist.tip.tier1',
  'com.joshapproved.grocerylist.tip.tier2',
  'com.joshapproved.grocerylist.tip.tier3',
  'com.joshapproved.grocerylist.tip.tier4',
  'com.joshapproved.grocerylist.tip.tier5',
] as const;
