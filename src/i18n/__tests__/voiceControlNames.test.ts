/**
 * Voice Control speakability of accessible names (canon § Accessibility).
 *
 * Voice Control works by letting someone say the words they can SEE on a
 * control; iOS matches what they said against the control's
 * `accessibilityLabel`. So a label that puts extra words IN FRONT of the
 * visible text makes that control unspeakable, and the person is stuck.
 *
 * The trap is the LOCALE, not the English. Labels are `t('key')` and the label
 * key differs from the visible key by design, so a pair that reads as a clean
 * prefix in English inverts in German and Japanese, which are verb-final:
 * visible "Stammartikel" against label "Als Stammartikel speichern" puts the
 * visible word at the END. Audited 2026-08-09; nine controls in this app were
 * naming themselves with words that were not on screen. Most were fixed by
 * making the label the visible string and moving the extra context to
 * `accessibilityHint` (Voice Control ignores hints, VoiceOver still reads
 * them). What is left here are the pairs that still legitimately differ — a
 * label that adds detail AFTER the visible words — plus the rows named by a
 * runtime value, which must LEAD with that value.
 *
 * Pure: reads the dictionaries directly, no React. Runs over English and every
 * canonical locale, because English passing proves nothing about ja.
 */

import { APP_STRINGS } from '../appStrings';
import { LOCALES } from '../locales';

type Dict = { [key: string]: string | Dict };

/** Resolve a dotted path to its string leaf, or undefined if absent. */
function leaf(d: Dict, path: string): string | undefined {
  const v = path.split('.').reduce<string | Dict | undefined>(
    (acc, k) => (acc && typeof acc === 'object' ? acc[k] : undefined),
    d
  );
  return typeof v === 'string' ? v : undefined;
}

/**
 * The leading run of literal text, i.e. everything before the first
 * placeholder or bracket. "Checked ({count})" -> "Checked". This is the part a
 * person actually reads off the screen and speaks.
 */
function leadingLiteral(s: string): string {
  return s.split(/[{(（]/)[0].replace(/[\s,、，:：.。]+$/u, '').trim();
}

/** English plus every locale that has had a domain translation pass. */
const DICTS: Array<[string, Dict]> = [
  ['en', APP_STRINGS as Dict],
  ...Object.entries(LOCALES)
    .filter(([, d]) => leaf(d as Dict, 'detail.checked') !== undefined)
    .map(([name, d]) => [name, d as Dict] as [string, Dict]),
];

/**
 * Controls whose accessible name adds detail to the visible text. The label
 * must START with what is written on the control.
 */
const PREFIX_PAIRS: Array<{ visible: string; label: string; what: string }> = [
  {
    visible: 'detail.checked',
    label: 'detail.checkedA11y',
    what: 'the Checked section toggle',
  },
];

/**
 * Rows named by a runtime value (an item name, a kit name). The value has to
 * come FIRST — "Add {name}" is unspeakable in English, "{name} hinzufügen" is
 * unspeakable in German. Leading with {name} is the only form that works in
 * every locale.
 */
const NAME_LED = [
  'detail.onListItemA11y',
  'kits.inKitItemA11y',
  'kits.addKitA11y',
];

describe('Voice Control can speak every accessible name', () => {
  describe.each(DICTS)('%s', (_locale, dict) => {
    it.each(PREFIX_PAIRS)(
      'the label for $what starts with the visible words',
      ({ visible, label }) => {
        const seen = leaf(dict, visible);
        const spoken = leaf(dict, label);
        // Locales are allowed to lack a key; key parity is a separate net.
        if (seen === undefined || spoken === undefined) return;
        expect(spoken.startsWith(leadingLiteral(seen))).toBe(true);
      }
    );

    it.each(NAME_LED)('%s leads with the name, not a verb', (key) => {
      const spoken = leaf(dict, key);
      if (spoken === undefined) return;
      expect(spoken.startsWith('{name}')).toBe(true);
    });
  });
});
