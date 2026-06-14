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

export type Category =
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

/** The Category union values are stable internal keys (persisted + used for
 *  inference); their localizable display names live in i18n under `aisles.*`.
 *  Keys, not resolved strings — `categoryLabel` resolves at render time. */
const CATEGORY_LABEL_KEY: Record<Category, string> = {
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

/** Localized display name for an aisle. Call at render time (never module-level). */
export function categoryLabel(category: Category): string {
  return t(CATEGORY_LABEL_KEY[category]);
}

/** Canonical default aisle order. A list copies this at creation and may then
 *  reorder its own copy (build step 3) without affecting other lists. */
export const DEFAULT_CATEGORY_ORDER: Category[] = [
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

/** Substring keywords → category. First category with any matching keyword
 *  wins (checked in CATEGORY_KEYWORDS insertion order). Lowercased compare. */
const CATEGORY_KEYWORDS: Array<{ category: Category; keywords: string[] }> = [
  {
    category: 'Produce',
    keywords: [
      'apple', 'banana', 'orange', 'lemon', 'lime', 'grape', 'berry', 'berries',
      'strawberr', 'blueberr', 'avocado', 'tomato', 'potato', 'onion', 'garlic',
      'lettuce', 'spinach', 'kale', 'carrot', 'celery', 'pepper', 'cucumber',
      'broccoli', 'cauliflower', 'mushroom', 'zucchini', 'squash', 'corn',
      'salad', 'herb', 'cilantro', 'parsley', 'basil', 'ginger', 'melon',
      'peach', 'pear', 'plum', 'mango', 'pineapple', 'cabbage', 'asparagus',
    ],
  },
  {
    category: 'Bakery',
    keywords: [
      'bread', 'bagel', 'bun', 'roll', 'baguette', 'croissant', 'muffin',
      'tortilla', 'pita', 'naan', 'cake', 'donut', 'doughnut', 'pastry',
    ],
  },
  {
    category: 'Meat & seafood',
    keywords: [
      'chicken', 'beef', 'pork', 'steak', 'bacon', 'sausage', 'ham', 'turkey',
      'lamb', 'mince', 'ground beef', 'fish', 'salmon', 'tuna', 'shrimp',
      'prawn', 'cod', 'tilapia', 'crab', 'lobster', 'meat',
    ],
  },
  {
    category: 'Dairy & eggs',
    keywords: [
      'milk', 'cheese', 'butter', 'yogurt', 'yoghurt', 'cream', 'egg',
      'sour cream', 'cottage', 'mozzarella', 'cheddar', 'parmesan', 'feta',
      'margarine', 'half and half', 'creamer',
    ],
  },
  {
    category: 'Frozen',
    keywords: [
      'frozen', 'ice cream', 'popsicle', 'fries', 'frozen pizza', 'waffle',
    ],
  },
  {
    category: 'Pantry',
    keywords: [
      'rice', 'pasta', 'noodle', 'flour', 'sugar', 'salt', 'oil', 'olive oil',
      'vinegar', 'sauce', 'ketchup', 'mustard', 'mayo', 'mayonnaise', 'beans',
      'lentil', 'canned', 'can of', 'soup', 'cereal', 'oats', 'oatmeal',
      'peanut butter', 'jam', 'jelly', 'honey', 'spice', 'stock', 'broth',
      'tomato sauce', 'salsa', 'baking', 'yeast', 'cornstarch', 'tea bag',
    ],
  },
  {
    category: 'Snacks',
    keywords: [
      'chip', 'crisps', 'cracker', 'cookie', 'biscuit', 'candy', 'chocolate',
      'popcorn', 'pretzel', 'nuts', 'almond', 'cashew', 'granola bar',
      'snack', 'trail mix', 'gum',
    ],
  },
  {
    category: 'Beverages',
    keywords: [
      'water', 'juice', 'soda', 'pop', 'cola', 'coffee', 'tea', 'beer',
      'wine', 'drink', 'sparkling', 'lemonade', 'kombucha', 'energy drink',
    ],
  },
  {
    category: 'Household',
    keywords: [
      'paper towel', 'toilet paper', 'tissue', 'napkin', 'detergent', 'soap',
      'dish', 'sponge', 'trash bag', 'bin bag', 'cleaner', 'bleach', 'wipes',
      'foil', 'plastic wrap', 'ziploc', 'battery', 'bulb', 'light bulb',
      'laundry', 'fabric softener',
    ],
  },
  {
    category: 'Personal care',
    keywords: [
      'shampoo', 'conditioner', 'toothpaste', 'toothbrush', 'deodorant',
      'floss', 'razor', 'shaving', 'lotion', 'sunscreen', 'tampon', 'pad',
      'diaper', 'vitamin', 'medicine', 'bandage', 'body wash', 'hand soap',
      'mouthwash', 'q-tip', 'cotton',
    ],
  },
];

/** Best-guess aisle for a freshly typed item. Defaults to 'Other'. */
export function inferCategory(name: string): Category {
  const n = name.trim().toLowerCase();
  if (!n) return 'Other';
  for (const { category, keywords } of CATEGORY_KEYWORDS) {
    for (const kw of keywords) {
      if (n.includes(kw)) return category;
    }
  }
  return 'Other';
}
