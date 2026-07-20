/**
 * The share link IS the pairing handshake — parse failures must degrade to
 * null (the app shows "not a share link"), never throw into the deep-link
 * handler, and never accept an implausible secret (a truncated link would
 * silently pair onto a dead channel).
 */

import { buildShareLink, parseShareLink } from '../share';
import { SHARE_SCHEME } from '../shareConfig';

const SECRET = 'abcdefghijklmnopqrstuvwxyz012345'; // 32 chars, plausibly a real secret

describe('buildShareLink', () => {
  it('builds the app-scheme join URL with the secret URI-encoded', () => {
    const link = buildShareLink('a+b/c=');
    expect(link).toBe(`${SHARE_SCHEME}://join?s=${encodeURIComponent('a+b/c=')}`);
  });

  it('round-trips: what one phone builds, the other parses back verbatim', () => {
    expect(parseShareLink(buildShareLink(SECRET))).toBe(SECRET);
    // Secrets with URL-hostile characters survive the trip too.
    const hostile = 'abcd/efgh+ijkl=mnop&qrst?uvwx';
    expect(parseShareLink(buildShareLink(hostile))).toBe(hostile);
  });
});

describe('parseShareLink', () => {
  it('returns null for a missing url (deep-link APIs deliver null on cold start)', () => {
    expect(parseShareLink(null as unknown as string)).toBeNull();
    expect(parseShareLink(undefined as unknown as string)).toBeNull();
    expect(parseShareLink('')).toBeNull();
  });

  it('returns null for a URL with no secret param — never throws', () => {
    expect(parseShareLink('https://example.com/whatever')).toBeNull();
    expect(parseShareLink(`${SHARE_SCHEME}://join`)).toBeNull();
  });

  it('accepts the secret from any URL carrying s=, first or later param', () => {
    expect(parseShareLink(`https://example.com/join?s=${SECRET}`)).toBe(SECRET);
    expect(parseShareLink(`https://example.com/join?utm=x&s=${SECRET}`)).toBe(SECRET);
  });

  it('rejects an implausibly short secret (a truncated link must not pair)', () => {
    expect(parseShareLink(`${SHARE_SCHEME}://join?s=short`)).toBeNull();
    expect(parseShareLink(`${SHARE_SCHEME}://join?s=fifteen-chars15`)).toBeNull();
  });

  it('accepts a secret of exactly the minimum plausible length (16)', () => {
    const sixteen = 'abcdefghij123456';
    expect(sixteen).toHaveLength(16);
    expect(parseShareLink(`${SHARE_SCHEME}://join?s=${sixteen}`)).toBe(sixteen);
  });

  it('returns null (not a crash) on malformed percent-encoding', () => {
    expect(parseShareLink(`${SHARE_SCHEME}://join?s=%E0%A4%A`)).toBeNull();
  });
});
