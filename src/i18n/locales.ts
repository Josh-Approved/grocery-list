/**
 * The per-locale string overlays this app ships. APP-OWNED.
 *
 * Each locale = the canonical shell chrome (shellLocales.ts — translated once in
 * the factory) DEEP-MERGED with this app's domain translations (src/i18n/<loc>.ts).
 * Deep merge (not a shallow spread) so a domain locale that re-states a shell
 * namespace — e.g. its own `common` / `settings` keys — AUGMENTS the shell chrome
 * instead of replacing it; any key absent here falls back to English at runtime
 * (i18n/index.ts). A fresh object per locale (never the shell reference), so
 * availableLocales() lights each language up in the picker.
 *
 * Regenerate the domain skeletons with `node scripts/translate.mjs --strings <app>`,
 * fill each src/i18n/<locale>.ts, then this file needs no edits — it merges the six.
 */

import { SHELL_LOCALES } from './shellLocales';
import es from './es';
import de from './de';
import fr from './fr';
import it from './it';
import ptBR from './pt-BR';
import ja from './ja';

type Dict = { [key: string]: string | Dict };

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

const S = SHELL_LOCALES as unknown as Record<string, Dict>;

export const LOCALES: Record<string, Dict> = {
  es: deepMerge(S.es, es as Dict),
  de: deepMerge(S.de, de as Dict),
  fr: deepMerge(S.fr, fr as Dict),
  it: deepMerge(S.it, it as Dict),
  'pt-BR': deepMerge(S['pt-BR'], ptBR as Dict),
  ja: deepMerge(S.ja, ja as Dict),
};
