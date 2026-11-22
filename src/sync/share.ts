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
 *
 * Web links (optional, per app): a `grocerylist://` link is plain, untappable
 * text in WhatsApp and most chat apps, which only linkify http(s). An app that
 * sets `SHARE_WEB_URL` in its shareConfig sends a normal web address instead,
 * which opens the app directly (iOS universal link / Android app link) or,
 * without the app, a joshapproved.com page with the store buttons. The secret
 * rides in the `#` fragment, which browsers never send to the server, so the
 * studio site never sees it. Written as `#?s=` so the link still parses on
 * builds that predate web links (their parser looks for `?s=` / `&s=`).
 */

import { newSecret } from './crypto';
import * as shareConfig from './shareConfig';

const SHARE_SCHEME: string = shareConfig.SHARE_SCHEME;
/** Read defensively: an app whose shareConfig predates web links has none,
 *  and keeps sending scheme links. */
const SHARE_WEB_URL: string | null =
  (shareConfig as unknown as { SHARE_WEB_URL?: string | null }).SHARE_WEB_URL ?? null;

/** The persistent shared-list identity. Stored on every paired device once
 *  minted. The channel id and the symmetric key both derive from `secret`. */
export interface ShareIdentity {
  secret: string;
  createdAt: number;
}

export function makeShareIdentity(): ShareIdentity {
  return { secret: newSecret(), createdAt: Date.now() };
}

/** Link encoding the secret. Tapping it (or scanning the QR of the same
 *  string) is all the other person does. A web link when the app has one
 *  configured, otherwise the app-scheme deep link. */
export function buildShareLink(secret: string): string {
  const s = encodeURIComponent(secret);
  if (SHARE_WEB_URL) return `${SHARE_WEB_URL}#?s=${s}`;
  return `${SHARE_SCHEME}://join?s=${s}`;
}

/** Pull the secret back out of a tapped link / scanned QR. Tolerant of the
 *  scheme being present or not — accepts any URL with an `s=` param in the
 *  query or the fragment, so a partner can share a link through any channel
 *  and old scheme links keep working forever. */
export function parseShareLink(url: string): string | null {
  if (!url) return null;
  const m = url.match(/[?&#]s=([^&]+)/);
  // Stryker disable next-line ConditionalExpression: equivalent mutant, with no `s=` match the next line reads `m[1]` off null, which throws inside the try — and the catch returns null, the same answer by the same function
  if (!m) return null;
  try {
    const secret = decodeURIComponent(m[1]);
    // base64 of 32 bytes ≈ 44 chars; sanity-check it's plausible.
    return secret.length >= 16 ? secret : null;
  } catch {
    return null;
  }
}
