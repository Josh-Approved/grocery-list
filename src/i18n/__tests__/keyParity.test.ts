/**
 * Key-parity net for translations (canon § Translations).
 *
 * Canonical, app-agnostic — synced by `sync.mjs app-shell` / `sync.mjs i18n`;
 * do NOT fork per app. It guards the drift class found 2026-07-13 on
 * grocery-list: the app gained 6 new APP_STRINGS keys after its locale pass
 * and every locale dict silently fell back to English — nothing flagged it
 * (the translations job only watches the LISTING drafts, and the
 * locale-switching test checks switching, not coverage). This makes that
 * drift a CI red instead of a silent English fallback.
 *
 * Two assertions:
 *   1. SHELL parity — every SHELL_STRINGS key exists in every shell locale.
 *      Unconditional: both files are factory-owned and overwrite-synced, so a
 *      hole here is factory drift and should fail in every consumer at once.
 *   2. DOMAIN parity — every APP_STRINGS key exists in each locale that has
 *      had a domain pass. Conditional on evidence (the locale already carries
 *      at least one APP_STRINGS key): a translation-READY app that has not
 *      yet translated its domain stays green — forcing translations is the
 *      weekly translations job's business, not CI's. But once a locale is
 *      domain-translated, new APP_STRINGS keys must reach it or CI goes red.
 */

import { APP_STRINGS } from '../appStrings';
import { SHELL_STRINGS } from '../shellStrings';
import { SHELL_LOCALES } from '../shellLocales';
import { LOCALES } from '../locales';

type Dict = { [key: string]: string | Dict };

/** Dotted paths of every string leaf in a dictionary. */
function leafPaths(d: Dict, prefix = ''): string[] {
  return Object.entries(d).flatMap(([k, v]) => {
    const path = prefix ? `${prefix}.${k}` : k;
    return v && typeof v === 'object' ? leafPaths(v as Dict, path) : [path];
  });
}

/** True when `path` resolves to a string leaf in `d`. */
function hasLeaf(d: Dict, path: string): boolean {
  let cur: string | Dict | undefined = d;
  for (const part of path.split('.')) {
    if (!cur || typeof cur !== 'object') return false;
    cur = (cur as Dict)[part];
  }
  return typeof cur === 'string';
}

describe('i18n key parity (translation drift net)', () => {
  it('every shell locale carries every SHELL_STRINGS key', () => {
    const shellKeys = leafPaths(SHELL_STRINGS as unknown as Dict);
    const failures: string[] = [];
    for (const [locale, dict] of Object.entries(SHELL_LOCALES)) {
      const missing = shellKeys.filter((k) => !hasLeaf(dict as Dict, k));
      if (missing.length) failures.push(`${locale}: ${missing.join(', ')}`);
    }
    expect(failures).toEqual([]);
  });

  it('every domain-translated locale carries every APP_STRINGS key', () => {
    const appKeys = leafPaths(APP_STRINGS as unknown as Dict);
    if (appKeys.length === 0) return; // fresh app, no domain copy yet
    const failures: string[] = [];
    for (const [locale, dict] of Object.entries(LOCALES)) {
      const present = appKeys.filter((k) => hasLeaf(dict as Dict, k));
      if (present.length === 0) continue; // no domain pass for this locale yet
      const missing = appKeys.filter((k) => !hasLeaf(dict as Dict, k));
      if (missing.length) failures.push(`${locale}: ${missing.join(', ')}`);
    }
    expect(failures).toEqual([]);
  });
});
