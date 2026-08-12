/**
 * Shared-list envelope crypto (sync/crypto.ts) — the layer two user-visible
 * promises rest on, neither of which a round-trip test can see.
 *
 *  1. PAIR ONCE, SYNCED FOREVER. The channel id (where two phones rendezvous)
 *     and the symmetric key (what opens the envelope) are both DERIVED from the
 *     per-list secret — nothing about either is stored. So if a derivation ever
 *     shifts, two already-paired phones on different app versions stop hearing
 *     each other, silently: no error, no reconnect, just a list that quietly
 *     stops updating. A seal→open round trip cannot catch that (it re-derives
 *     both sides the same wrong way), so both derivations are pinned here to
 *     checked-in golden vectors. If one of these fails, the change breaks every
 *     device already in the field — that is the signal, not a stale fixture.
 *
 *  2. YOUR DATA STAYS WITH YOU, EVEN AGAINST A HOSTILE RELAY. The drop boxes
 *     are public: anyone can push any bytes onto our channel. `open` must
 *     answer `null` for junk, for a tampered envelope, and for one sealed under
 *     somebody else's secret — never throw (the engine's `receive` treats a
 *     throw as a crash, not a skip), and never return `undefined` (which reads
 *     the same as `null` at a truthiness check and then diverges everywhere
 *     else).
 */

import naclUtil from 'tweetnacl-util';

import { newSecret, channelId, seal, open } from '../crypto';

const { encodeBase64, decodeBase64 } = naclUtil;

// ---------------------------------------------------------------------------
// Golden vectors — generated once from the shipped derivation, then frozen.
// SECRET is the base64 of the bytes 0x00..0x1f, so it is reproducible by hand.
// ---------------------------------------------------------------------------

/** base64 of bytes 0x00…0x1f — a fixed stand-in for a real 32-byte secret. */
const SECRET = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
/** What `channelId(SECRET)` has always returned. */
const GOLDEN_CHANNEL = 'qdcYYqPldGtXG+PRh7AEEA==';
/** An envelope sealed under SECRET by an earlier build, and its contents. */
const GOLDEN_SEALED =
  'ZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXp7lgFCbZJxCv8qdDkQU53UlTOuPwe+64o3pPgrKxH0M8pX8hs=';
const GOLDEN_PLAINTEXT = '{"hello":"grocery"}';

/** A different, equally valid secret — the "someone else's list" case. */
const OTHER_SECRET = encodeBase64(new Uint8Array(32).fill(9));

describe('newSecret', () => {
  it('mints a full 32-byte secret', () => {
    expect(decodeBase64(newSecret())).toHaveLength(32);
  });

  it('mints a different secret every time (two lists never collide)', () => {
    const seen = new Set(Array.from({ length: 20 }, () => newSecret()));
    expect(seen.size).toBe(20);
  });
});

describe('channelId — the rendezvous point, frozen', () => {
  it('matches the golden vector (changing it unpairs every device in the field)', () => {
    expect(channelId(SECRET)).toBe(GOLDEN_CHANNEL);
  });

  it('is deterministic — the same secret always meets on the same channel', () => {
    expect(channelId(SECRET)).toBe(channelId(SECRET));
  });

  it('differs per secret, so two shared lists never land on one channel', () => {
    expect(channelId(OTHER_SECRET)).not.toBe(channelId(SECRET));
  });

  it('is a short public id that reveals neither the secret nor the key', () => {
    const id = channelId(SECRET);
    // 16 bytes: enough to be unguessable, and a different slice of the hash
    // than the 32-byte key, so publishing it gives a relay nothing to work with.
    expect(decodeBase64(id)).toHaveLength(16);
    expect(id).not.toContain(SECRET);
    expect(SECRET).not.toContain(id);
  });
});

describe('seal / open round trip', () => {
  it('returns exactly what went in, including unicode and an empty payload', () => {
    for (const payload of [
      GOLDEN_PLAINTEXT,
      '',
      'oat milk 🥛, jalapeños, 100% cacao',
      JSON.stringify({ items: Array.from({ length: 50 }, (_, i) => `item-${i}`) }),
    ]) {
      expect(open(SECRET, seal(SECRET, payload))).toBe(payload);
    }
  });

  it('seals the same payload differently each time, and both still open', () => {
    const a = seal(SECRET, GOLDEN_PLAINTEXT);
    const b = seal(SECRET, GOLDEN_PLAINTEXT);
    // A repeated nonce under one key is the classic secretbox break; a fresh
    // random nonce per envelope is what stops a relay correlating two publishes.
    expect(a).not.toBe(b);
    expect(open(SECRET, a)).toBe(GOLDEN_PLAINTEXT);
    expect(open(SECRET, b)).toBe(GOLDEN_PLAINTEXT);
  });

  it('never puts the list on the wire in the clear', () => {
    const sealed = seal(SECRET, 'buy nappies and a pregnancy test');
    expect(sealed).not.toContain('nappies');
    expect(sealed).not.toContain('pregnancy');
    // The relay sees ciphertext only — not even the key material it derives from.
    expect(sealed).not.toContain(SECRET);
  });
});

describe('open — the key derivation is frozen too', () => {
  it('still opens an envelope sealed by an earlier build', () => {
    expect(open(SECRET, GOLDEN_SEALED)).toBe(GOLDEN_PLAINTEXT);
  });
});

describe('open — hostile input degrades to null, never a throw', () => {
  it('refuses an envelope sealed under somebody else’s secret', () => {
    const theirs = seal(OTHER_SECRET, 'their private list');
    expect(open(SECRET, theirs)).toBeNull();
  });

  it('refuses junk that is not even base64', () => {
    expect(open(SECRET, '!!! not even base64 !!!')).toBeNull();
    expect(open(SECRET, '<<<>>>')).toBeNull();
  });

  it('refuses an envelope too short to hold a nonce', () => {
    expect(open(SECRET, '')).toBeNull();
    expect(open(SECRET, 'AAAA')).toBeNull();
  });

  it('refuses a tampered envelope (one flipped ciphertext byte)', () => {
    const raw = decodeBase64(seal(SECRET, GOLDEN_PLAINTEXT));
    raw[raw.length - 1] ^= 0xff;
    expect(open(SECRET, encodeBase64(raw))).toBeNull();
  });

  it('refuses an envelope whose nonce was swapped out', () => {
    const raw = decodeBase64(seal(SECRET, GOLDEN_PLAINTEXT));
    raw[0] ^= 0xff;
    expect(open(SECRET, encodeBase64(raw))).toBeNull();
  });
});
