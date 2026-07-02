/**
 * End-to-end encryption for shared-list messages.
 *
 * Everything that leaves the device is sealed with NaCl secretbox under a key
 * derived only from the per-list shared secret. The drop boxes (public
 * relays) only ever see ciphertext + a random-looking channel id — never the
 * list, never anything about the user. We keep this even though a grocery
 * list is low-PII: it makes the store privacy claim absolute and costs
 * almost nothing (canon § Privacy & data).
 *
 * `react-native-get-random-values` is imported at the app entry so
 * `crypto.getRandomValues` exists for nacl's PRNG on React Native.
 *
 * NOT DEVICE-VERIFIED: the crypto is standard tweetnacl, but the live
 * round-trip through real relays has not been exercised on a device. Shipping
 * code-only is the documented, committed Layer-2 deferral (canon
 * § Backup & restore "when each layer is required"); device-verify is gated
 * before public release.
 */

import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';

const { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 } = naclUtil;

/** New random 32-byte list secret, base64. The whole sharing identity. */
export function newSecret(): string {
  return encodeBase64(nacl.randomBytes(32));
}

/** Symmetric key (32 bytes) derived from the secret. */
function keyFromSecret(secret: string): Uint8Array {
  return nacl.hash(decodeBase64(secret)).slice(0, nacl.secretbox.keyLength);
}

/** Public channel id derived from the secret — what devices rendezvous on.
 *  A different slice of the hash than the key, so the id reveals nothing
 *  about the key. */
export function channelId(secret: string): string {
  return encodeBase64(nacl.hash(decodeBase64(secret)).slice(32, 48));
}

export function seal(secret: string, plaintext: string): string {
  const key = keyFromSecret(secret);
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const box = nacl.secretbox(decodeUTF8(plaintext), nonce, key);
  const out = new Uint8Array(nonce.length + box.length);
  out.set(nonce);
  out.set(box, nonce.length);
  return encodeBase64(out);
}

export function open(secret: string, sealed: string): string | null {
  try {
    const key = keyFromSecret(secret);
    const raw = decodeBase64(sealed);
    const nonce = raw.slice(0, nacl.secretbox.nonceLength);
    const box = raw.slice(nacl.secretbox.nonceLength);
    const plain = nacl.secretbox.open(box, nonce, key);
    return plain ? encodeUTF8(plain) : null;
  } catch {
    return null;
  }
}
