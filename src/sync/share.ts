/**
 * Share identity + the link/QR a person taps once to pair.
 *
 * The link is the *whole* handshake. After it's used the pairing is durable:
 * both devices keep the secret and the derived channel forever — "pair once,
 * synced forever" (no expiring rooms, no re-share to shop again).
 */

import type { ShareIdentity } from '../data/list';
import { newSecret } from './crypto';

export const SHARE_SCHEME = 'grocerylist';

export function makeShareIdentity(): ShareIdentity {
  return { secret: newSecret(), createdAt: Date.now() };
}

/** Deep link encoding the secret. Tapping it (or scanning the QR of the same
 *  string) is all the other person does. */
export function buildShareLink(secret: string): string {
  return `${SHARE_SCHEME}://join?s=${encodeURIComponent(secret)}`;
}

/** Pull the secret back out of a tapped link / scanned QR. Tolerant of the
 *  scheme being present or not. Returns null if it isn't one of ours. */
export function parseShareLink(url: string): string | null {
  if (!url) return null;
  const m = url.match(/[?&]s=([^&]+)/);
  if (!m) return null;
  try {
    const secret = decodeURIComponent(m[1]);
    // base64 of 32 bytes ≈ 44 chars; sanity-check it's plausible.
    return secret.length >= 16 ? secret : null;
  } catch {
    return null;
  }
}
