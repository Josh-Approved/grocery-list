/**
 * Share identity + the link/QR a person taps once to pair.
 *
 * The link is the *whole* handshake. After it's used the pairing is durable:
 * both devices keep the secret and the derived channel forever — "pair once,
 * synced forever" (no expiring rooms, no re-share later).
 *
 * Per-app: `SHARE_SCHEME` lives in the sibling `shareConfig.ts`, which the
 * factory syncs *only if absent* so each consuming app keeps its own scheme
 * (`grocerylist`, `packinglist`, etc.) without re-syncs clobbering it. The
 * app must also declare the same string as `expo.scheme` in app.json so
 * tapping the link launches the right app.
 */

import { newSecret } from './crypto';
import { SHARE_SCHEME } from './shareConfig';

/** The persistent shared-list identity. Stored on every paired device once
 *  minted. The channel id and the symmetric key both derive from `secret`. */
export interface ShareIdentity {
  secret: string;
  createdAt: number;
}

export function makeShareIdentity(): ShareIdentity {
  return { secret: newSecret(), createdAt: Date.now() };
}

/** Deep link encoding the secret. Tapping it (or scanning the QR of the same
 *  string) is all the other person does. */
export function buildShareLink(secret: string): string {
  return `${SHARE_SCHEME}://join?s=${encodeURIComponent(secret)}`;
}

/** Pull the secret back out of a tapped link / scanned QR. Tolerant of the
 *  scheme being present or not — accepts any URL with an `s=` query param,
 *  so a partner can share a link through any channel. */
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
