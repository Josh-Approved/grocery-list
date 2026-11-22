/**
 * Share-link intake: turns a tapped or scanned share link into "joined and
 * open", safely across a cold start.
 *
 * Why this is its own module (grocery-list customer report 2026-10-24, "the
 * QR code opens the app but doesn't give the shared list"): a link that
 * LAUNCHES the app arrives through `Linking.getInitialURL()` a tick after
 * mount, long before the store has read the disk, and before the
 * NavigationContainer exists (the app shell mounts it only once fonts and
 * stores are ready). Joining at that moment wrote the new shared record into
 * an empty, not-yet-hydrated store, and `hydrate()` replaced the store's
 * contents a moment later, so the record vanished from the screen. The one
 * 500 ms navigate retry then gave up behind the splash. A warm app (already
 * running) was fine, which is why it only ever showed up "sometimes".
 *
 * So intake is two-phase:
 *   1. CATCH the link immediately (cold-start initial URL or a warm `url`
 *      event), so it can never be lost;
 *   2. ACT on it only once the app says it is `ready` (every store the join
 *      touches has hydrated), then OPEN the record as soon as navigation can
 *      take it, retrying briefly instead of once.
 *
 * App glue is two callbacks: `join(secret) → id` (the store's idempotent
 * joinShared) and `open(id) → boolean` (navigate; false while navigation is
 * not ready yet). Overwrite-synced from the factory `shared-sync` module.
 */

import { useEffect, useRef, useState } from 'react';
import { Linking } from 'react-native';
import { parseShareLink } from './share';

export interface ShareIntakeOptions {
  /** True once every store the join touches has hydrated from disk. */
  ready: boolean;
  /** Join the shared record (idempotent) and return its local id. */
  join: (secret: string) => string;
  /** Open that record. Return false while navigation isn't ready yet. */
  open: (id: string) => boolean;
}

/** How often to retry opening while navigation is still mounting. */
export const OPEN_RETRY_MS = 100;
/** Stop retrying after this long. The record is joined either way; this only
 *  bounds how long we wait to navigate to it. */
export const OPEN_GIVE_UP_MS = 15_000;
/** The same link can arrive twice on one launch (initial URL and a `url`
 *  event on some Android versions). Treat a repeat inside this window as one. */
export const DUPLICATE_WINDOW_MS = 3_000;

export function useShareLinkIntake({ ready, join, open }: ShareIntakeOptions): void {
  const pending = useRef<string[]>([]);
  const [arrivals, setArrivals] = useState(0);
  const joinRef = useRef(join);
  const openRef = useRef(open);
  joinRef.current = join;
  openRef.current = open;
  const lastHandled = useRef<{ secret: string; at: number } | null>(null);
  const timers = useRef(new Set<ReturnType<typeof setInterval>>());

  // Phase 1: catch every link from mount on, before anything is ready.
  useEffect(() => {
    let alive = true;
    const receive = (url: string | null) => {
      const secret = url ? parseShareLink(url) : null;
      if (!secret || !alive) return;
      pending.current.push(secret);
      setArrivals((n) => n + 1);
    };
    Linking.getInitialURL()
      .then(receive)
      .catch(() => {});
    const sub = Linking.addEventListener('url', (e) => receive(e.url));
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);

  // Phase 2: once ready, join each caught link and open it.
  useEffect(() => {
    if (!ready || pending.current.length === 0) return;
    const queue = pending.current.splice(0);
    for (const secret of queue) {
      const now = Date.now();
      const last = lastHandled.current;
      if (last && last.secret === secret && now - last.at < DUPLICATE_WINDOW_MS) {
        continue;
      }
      lastHandled.current = { secret, at: now };
      const id = joinRef.current(secret);
      if (openRef.current(id)) continue;
      const started = Date.now();
      const timer = setInterval(() => {
        if (openRef.current(id) || Date.now() - started >= OPEN_GIVE_UP_MS) {
          clearInterval(timer);
          timers.current.delete(timer);
        }
      }, OPEN_RETRY_MS);
      timers.current.add(timer);
    }
  }, [ready, arrivals]);

  // Never leave a retry running past unmount.
  useEffect(() => {
    const live = timers.current;
    return () => {
      for (const t of live) clearInterval(t);
      live.clear();
    };
  }, []);
}
