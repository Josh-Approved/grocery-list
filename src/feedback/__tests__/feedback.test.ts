/**
 * Trust-core tests for the Send-feedback flow (canon § QA & testing, Tier 1).
 * The things a bug here corrupts silently are (1) the privacy scrub — user
 * content must never pool in the diagnostic log — (2) the email composition +
 * mailto fallback, and (3) DELIVERY of the log the user opted into sharing.
 * All pure/logic-level, so they're tested headless here and ride every app's
 * `npm test`. Canonical, app-agnostic — synced by app-shell.
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

// The file layer is the thing that failed silently in production (SDK 54 made
// the write throw, the failure was swallowed, the attachment vanished and
// nothing said so). Mocking it here is what lets us prove the fallback.
jest.mock('../fileStore', () => ({
  cacheDir: jest.fn(() => 'file:///cache/'),
  docDir: jest.fn(() => 'file:///docs/'),
  writeText: jest.fn(async (uri: string) => uri),
  readText: jest.fn(async () => null),
  remove: jest.fn(async () => {}),
}));

import { logEvent, logError, logWarn, serialize, serializeBounded, entryCount, clear } from '../log';
import { sendFeedback } from '../compose';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const MailComposer = require('expo-mail-composer');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fileStore = require('../fileStore');

beforeEach(() => {
  clear();
  jest.clearAllMocks();
  MailComposer.isAvailableAsync.mockResolvedValue(true);
  fileStore.writeText.mockImplementation(async (uri: string) => uri);
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
    for (let i = 0; i < 900; i++) logEvent('loop', `event-${i}`);
    expect(entryCount()).toBeLessThanOrEqual(600);
    const out = serialize();
    expect(out).toContain('event-899'); // newest kept
    expect(out).not.toContain('event-0 '); // oldest dropped (trailing space avoids event-0xx)
  });
});

describe('diagnostic log — is it actually readable', () => {
  it('stamps every line with local time of day, not just seconds since boot', () => {
    logEvent('test', 'a thing happened');
    // "13:09:18 INFO  test: a thing happened"
    expect(serialize()).toMatch(/^\d{2}:\d{2}:\d{2} INFO\s+test: a thing happened$/m);
  });

  it('opens with a counted summary so triage starts at the answer', () => {
    logEvent('test', 'fine');
    logWarn('test', 'hmm');
    logError('test', new Error('boom'));
    const head = serialize().split('\n\n')[0];
    expect(head).toMatch(/^Session:/m);
    expect(head).toContain('1 error(s)');
    expect(head).toContain('1 warning(s)');
  });

  it('collapses a repeated message instead of letting it flood the buffer', () => {
    // The real report that triggered this: one Expo deprecation warning, three
    // times, and nothing else — the noise had pushed everything useful out.
    for (let i = 0; i < 40; i++) logWarn('console', 'Method writeAsStringAsync is deprecated.');
    logEvent('nav', 'Settings');
    expect(entryCount()).toBe(2); // the collapsed run + the nav breadcrumb
    expect(serialize()).toContain('(×40)');
  });

  it('suppresses a chronic non-consecutive repeat rather than burying the trail', () => {
    for (let i = 0; i < 30; i++) {
      logWarn('console', 'the same warning again');
      logEvent('nav', `Screen-${i}`); // breaks the consecutive run every time
    }
    const lines = serialize().split('\n').filter((l) => l.includes('the same warning again'));
    expect(lines.length).toBeLessThanOrEqual(8);
    expect(serialize()).toContain('further repeats suppressed');
    // The breadcrumbs it would otherwise have crowded out are all still there.
    expect(serialize()).toContain('Screen-29');
  });

  it('trims from the FRONT when it has to fit, keeping the header and the newest lines', () => {
    for (let i = 0; i < 400; i++) logEvent('loop', `event-${i}`);
    const kept = serializeBounded(2000);
    expect(kept.length).toBeLessThanOrEqual(2000);
    expect(kept).toContain('Recorded:'); // the counted header survives the trim
    expect(kept).toContain('event-399'); // and the newest events, not the oldest
    expect(kept).not.toContain('event-1 ');
  });

  it('keeps a stack trace at full length — a trace clipped to one frame is useless', () => {
    const err = new Error('boom');
    err.stack = `Error: boom\n${'    at someDeeplyNestedFrame (app.bundle:12345:67)\n'.repeat(30)}`;
    logError('test', err);
    const out = serialize();
    expect(out).toContain('someDeeplyNestedFrame');
    expect(out.length).toBeGreaterThan(1000); // not clipped to the 120-char field cap
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

describe('the opted-in log is always delivered', () => {
  it('attaches the report file when it can be written', async () => {
    logEvent('test', 'BREADCRUMB-MARKER');
    const r = await sendFeedback({ type: 'bug', fields: {}, includeLogs: true });
    expect(r.attachedLog).toBe(true);
    expect(r.inlinedLog).toBe(false);
    const arg = MailComposer.composeAsync.mock.calls[0][0];
    expect(arg.attachments).toHaveLength(1);
    // The file we handed to the composer really carries the trail.
    expect(fileStore.writeText.mock.calls.some(([, text]: [string, string]) =>
      text.includes('BREADCRUMB-MARKER')
    )).toBe(true);
  });

  it('REGRESSION: inlines the log in the body when the attachment cannot be written', async () => {
    // This is the shipped defect. `writeAsStringAsync` throws on SDK 54, the
    // throw was swallowed, and the log the user agreed to share reached nobody
    // while the UI said it had been attached.
    fileStore.writeText.mockResolvedValue(null);
    logEvent('test', 'BREADCRUMB-MARKER');

    const r = await sendFeedback({ type: 'bug', fields: {}, includeLogs: true });

    expect(r.attachedLog).toBe(false);
    expect(r.inlinedLog).toBe(true);
    const arg = MailComposer.composeAsync.mock.calls[0][0];
    expect(arg.attachments).toBeUndefined();
    expect(arg.body).toContain('BREADCRUMB-MARKER'); // it went out anyway
  });

  it('inlines the log on the mailto floor, which can never carry an attachment', async () => {
    MailComposer.isAvailableAsync.mockResolvedValue(false);
    const spy = jest.spyOn(Linking, 'openURL').mockResolvedValue(true as never);
    logEvent('test', 'BREADCRUMB-MARKER');

    const r = await sendFeedback({ type: 'bug', fields: {}, includeLogs: true });

    expect(r.status).toBe('mailto');
    expect(r.inlinedLog).toBe(true);
    expect(decodeURIComponent(spy.mock.calls[0][0])).toContain('BREADCRUMB-MARKER');
    spy.mockRestore();
  });

  it('never sends the log when the user did not opt in', async () => {
    logEvent('test', 'BREADCRUMB-MARKER');
    const r = await sendFeedback({ type: 'general', fields: {}, includeLogs: false });
    expect(r.attachedLog).toBe(false);
    expect(r.inlinedLog).toBe(false);
    const arg = MailComposer.composeAsync.mock.calls[0][0];
    expect(arg.attachments).toBeUndefined();
    expect(arg.body).not.toContain('BREADCRUMB-MARKER');
  });
});
