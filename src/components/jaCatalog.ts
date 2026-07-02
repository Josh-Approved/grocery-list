/**
 * The canonical "More from Josh Approved" catalog — the single source of the
 * studio's live mobile apps, used by the quiet in-app cross-promo row
 * (MoreFromJA.tsx). Synced from the factory by `sync.mjs more-from-ja` (and
 * carried by the app shell); edit HERE, never per app, so every app's
 * cross-promo updates from one place on its next release.
 *
 * Canon (`canonical-voice.md` § Truth standard): the cross-promo row is the ONE
 * allowed exception to "No ads, ever" — and only because it is plain text, not
 * an ad unit. No tracking of taps, no network calls, no images. A row only ever
 * appears when the target app has a REAL store URL for the user's platform
 * (`MoreFromJA` filters by Platform.OS), so a row can never point at a listing
 * that isn't live. Add a URL here the moment an app goes live on that store.
 *
 * `slug` MUST match the app's public repo slug (the last path segment of
 * REPO_URL) — that's how an app excludes itself from its own row.
 */

export type JaCatalogEntry = {
  slug: string;
  name: string;
  /** One plain line — what it does. Sentence case, voice canon. No claims. */
  blurb: string;
  /** Live App Store URL, or null until it's listed. */
  iosUrl: string | null;
  /** Live Google Play URL, or null until it's listed. */
  androidUrl: string | null;
};

export const JA_CATALOG: JaCatalogEntry[] = [
  {
    slug: 'workout-timer',
    name: 'Workout Timer',
    blurb: 'Interval timer for Tabata and HIIT.',
    iosUrl: 'https://apps.apple.com/us/app/workout-timer-josh-approved/id6767314178',
    androidUrl: null,
  },
  {
    slug: 'grocery-list',
    name: 'Grocery List',
    blurb: 'A shared shopping list that stays in sync.',
    iosUrl: null,
    androidUrl: null,
  },
  {
    slug: 'split-expenses',
    name: 'Split Expenses',
    blurb: 'Split shared costs and see who owes whom.',
    iosUrl: null,
    androidUrl: null,
  },
  {
    slug: 'packing-list',
    name: 'Packing List',
    blurb: 'A checklist that builds itself from your trip.',
    iosUrl: null,
    androidUrl: null,
  },
  {
    slug: 'tally',
    name: 'Tally',
    blurb: 'A simple counter for anything you count.',
    iosUrl: null,
    androidUrl: null,
  },
  {
    slug: 'budget',
    name: 'Budget',
    blurb: 'See where the money goes, privately.',
    iosUrl: null,
    androidUrl: null,
  },
];

/** The live entries for the current platform, excluding the host app. Pure —
 *  no React, no RN imports — so it's testable and reusable. */
export function moreFromJA(
  os: 'ios' | 'android' | string,
  excludeSlug?: string
): Array<JaCatalogEntry & { url: string }> {
  return JA_CATALOG.filter((a) => a.slug !== excludeSlug)
    .map((a) => ({ ...a, url: os === 'android' ? a.androidUrl : a.iosUrl }))
    .filter((a): a is JaCatalogEntry & { url: string } => typeof a.url === 'string' && a.url.length > 0);
}
