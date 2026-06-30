/**
 * Trust-core tests for the Send-feedback flow (canon § QA & testing, Tier 1).
 * The two things a bug here corrupts silently are (1) the privacy scrub — user
 * content must never pool in the diagnostic log — and (2) the email composition +
 * mailto fallback. Both are pure/logic-level, so they're tested headless here and
 * ride every app's `npm test`. Canonical, app-agnostic — synced by app-shell.
 */

import { Linking } from 'react-native';

// expo-mail-composer is an optional native dep (virtual so this runs in an app
// that hasn't installed it yet); compose.ts require()s it at call time.
jest.mock(
  'expo-mail-composer',
  () => ({
    isAvailableAsync: jest.fn(async () => true),
    composeAsync: jest.fn(async () => ({ status: 'sent' })),
  }),
  { virtual: true }
);

import { logEvent, serialize, entryCount, clear } from '../log';
import { sendFeedback } from '../compose';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const MailComposer = require('expo-mail-composer');

beforeEach(() => {
  clear();
  jest.clearAllMocks();
  MailComposer.isAvailableAsync.mockResolvedValue(true);
});

describe('diagnostic log — privacy scrub', () => {
  it('never lets full field content into the serialized log', () => {
    const secret = 'SENSITIVE-CONTENT-'.repeat(40); // ~720 chars of "user content"
    logEvent('test', 'did a thing', { note: secret, payload: { a: 1, b: 2 } });
    const out = serialize();

    // The structured message is kept…
    expect(out).toContain('did a thing');
    // …but the long field value is clipped (never present in full)…
    expect(out).not.toContain(secret);
    expect(out).toMatch(/…\(\+\d+\)/); // the truncation marker
    // …and a nested object collapses to a type tag, not its contents.
    expect(out).toContain('payload=[object]');
    expect(out).not.toContain('"a":1');
  });

  it('caps the ring buffer so it cannot grow unbounded', () => {
    for (let i = 0; i < 600; i++) logEvent('loop', `event-${i}`);
    expect(entryCount()).toBeLessThanOrEqual(400);
    const out = serialize();
    expect(out).toContain('event-599'); // newest kept
    expect(out).not.toContain('event-0 '); // oldest dropped (trailing space avoids event-0xx)
  });
});

describe('email composition', () => {
  it('builds a tagged bug email with the user fields + recipient', async () => {
    const r = await sendFeedback({
      type: 'bug',
      fields: { whatHappened: 'crash on save', expected: 'it should save' },
      includeLogs: false,
    });
    expect(r.status).toBe('composed');
    expect(MailComposer.composeAsync).toHaveBeenCalledTimes(1);
    const arg = MailComposer.composeAsync.mock.calls[0][0];
    expect(arg.recipients).toEqual(['feedback@joshapproved.com']);
    expect(arg.subject).toMatch(/^\[Bug\] /);
    expect(arg.body).toContain('crash on save');
    expect(arg.body).toContain('it should save');
  });

  it('uses an English subject tag regardless of the body language', async () => {
    await sendFeedback({ type: 'feature', fields: { want: 'dark mode' }, includeLogs: false });
    const arg = MailComposer.composeAsync.mock.calls[0][0];
    expect(arg.subject).toMatch(/^\[Feature\] /);
  });

  it('falls back to a pre-filled mailto: when no mail composer is available', async () => {
    MailComposer.isAvailableAsync.mockResolvedValue(false);
    const spy = jest.spyOn(Linking, 'openURL').mockResolvedValue(true as never);
    const r = await sendFeedback({
      type: 'general',
      fields: { message: 'just saying thanks' },
      includeLogs: false,
    });
    expect(r.status).toBe('mailto');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatch(/^mailto:feedback@joshapproved\.com\?/);
    expect(decodeURIComponent(spy.mock.calls[0][0])).toContain('just saying thanks');
    spy.mockRestore();
  });
});
