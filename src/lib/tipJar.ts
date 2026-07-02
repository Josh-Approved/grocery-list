// Canonical Josh Approved tip-jar hook — the expo-iap wrapper that powers the
// in-app tip jar (the IAP replacement for the rejected Buy Me a Coffee link).
// Source: josh-approved-factory/templates/tip-jar/tipJar.ts
// Pairs with TipJarSheet.tsx. See README.md for canonical rules and wiring.
//
// Tips are CONSUMABLE one-time products: nothing unlocks, no benefit is owed,
// so there is no App Store 3.1.2 ongoing-value obligation. The hook fetches the
// app's tip products from the store, runs a single purchase, and immediately
// finishes the transaction as a consumable so it can be given again.
//
// No server, no third-party purchase backend (no RevenueCat): Apple / Google
// are the merchant of record and we never see or hold purchase data — the
// no-server tenet holds.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useIAP } from 'expo-iap';
import type { Product, Purchase } from 'expo-iap';

/**
 * connecting  — opening the store connection
 * loading     — connected, fetching the tip products
 * ready       — products loaded, tiers shown
 * unavailable — store/products couldn't load (offline, sandbox, products not
 *               yet created in the console, or no billing store on the device
 *               at all — e.g. a de-Googled Android with no Play Store) — the
 *               sheet degrades gracefully
 * purchasing  — a purchase is in flight (a tier is being tapped through)
 * thanks      — a purchase completed; show the thank-you state
 */
export type TipStatus =
  | 'connecting'
  | 'loading'
  | 'ready'
  | 'unavailable'
  | 'purchasing'
  | 'thanks';

export interface UseTipJar {
  status: TipStatus;
  /** Tip products, ordered to match the `productIds` argument (store order is arbitrary). */
  products: Product[];
  /** The product id currently being purchased, or null. */
  pendingSku: string | null;
  /** Start a purchase for the given store product id. */
  tip: (sku: string) => void;
}

// How long we wait for the store to connect AND return products before
// declaring the jar unavailable, so the UI degrades fast instead of hanging on
// a spinner. Kept short: on a device with no billing store (a de-Googled
// Android with no Play Store / Play Services, or any offline store) the tiers
// will never arrive, and a long spinner on the prominent "Support" button reads
// as a broken app. A store that is merely slow still recovers — late-arriving
// products promote straight back to 'ready' (see the products effect below).
const FETCH_TIMEOUT_MS = 2500;

// Session-scoped memory of whether a billing store is reachable at all.
//   null  — not yet determined this launch
//   false — we tried and no billing service answered (no Play Store / no
//           StoreKit) — so re-opening the sheet must NOT re-open a connection,
//           which on a no-GMS device otherwise re-emits a native
//           "Google Play Store is missing" log line every single time
//   true  — the store answered with products at least once this launch
let storeReachable: boolean | null = null;

/**
 * True once this launch we've learned no billing store is reachable. The sheet
 * uses this to render an instant, calm "unavailable" state WITHOUT mounting the
 * IAP hook again — no repeat billing connection, no repeat native log.
 */
export function isStoreKnownUnavailable(): boolean {
  return storeReachable === false;
}

export function useTipJar(productIds: readonly string[]): UseTipJar {
  const [status, setStatus] = useState<TipStatus>(() =>
    storeReachable === false ? 'unavailable' : 'connecting'
  );
  const [pendingSku, setPendingSku] = useState<string | null>(null);
  const productsRef = useRef<Product[]>([]);

  const { connected, products, fetchProducts, requestPurchase, finishTransaction } =
    useIAP({
      onPurchaseSuccess: async (purchase: Purchase) => {
        // Finish as consumable so the tip can be given again. We don't gate any
        // feature on this, so there's nothing to verify server-side.
        try {
          await finishTransaction({ purchase, isConsumable: true });
        } catch {
          // Even if finishing fails, the charge succeeded — thank the user.
        }
        setPendingSku(null);
        setStatus('thanks');
      },
      onPurchaseError: () => {
        // Cancellation or failure both just return to the tier list — a tip jar
        // should never throw a scary error at someone for changing their mind.
        setPendingSku(null);
        setStatus(productsRef.current.length ? 'ready' : 'unavailable');
      },
    });

  productsRef.current = products;

  // Fetch products once the store connection is up.
  useEffect(() => {
    if (!connected) return;
    setStatus((s) => (s === 'ready' || s === 'thanks' ? s : 'loading'));
    fetchProducts({ skus: [...productIds], type: 'in-app' }).catch(() =>
      setStatus((s) => (productsRef.current.length ? 'ready' : 'unavailable'))
    );
    // productIds is a stable module constant; intentionally not a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  // Promote to "ready" as soon as products arrive, and remember the store
  // works. Recovers even from 'unavailable' — a merely-slow store that beat the
  // timeout still shows its tiers rather than staying stuck on the fallback.
  useEffect(() => {
    if (!products.length) return;
    storeReachable = true;
    setStatus((s) =>
      s === 'loading' || s === 'connecting' || s === 'unavailable' ? 'ready' : s
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products.length]);

  // Fallback: never hang on the spinner. Armed on mount (NOT gated on
  // `connected`) so a device where the store never connects — a de-Googled
  // Android with no Play Store, where `initConnection` never resolves — still
  // resolves to 'unavailable' instead of spinning forever. If we time out with
  // no products, no billing store is reachable this launch: remember that so
  // the sheet stops re-opening a connection (and re-logging) on every visit.
  useEffect(() => {
    if (storeReachable === false) return;
    const id = setTimeout(() => {
      setStatus((s) => {
        if (s !== 'connecting' && s !== 'loading') return s;
        if (productsRef.current.length) return 'ready';
        storeReachable = false;
        return 'unavailable';
      });
    }, FETCH_TIMEOUT_MS);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tip = useCallback(
    (sku: string) => {
      setPendingSku(sku);
      setStatus('purchasing');
      requestPurchase({
        request: { apple: { sku }, google: { skus: [sku] } },
        type: 'in-app',
      }).catch(() => {
        setPendingSku(null);
        setStatus(productsRef.current.length ? 'ready' : 'unavailable');
      });
    },
    [requestPurchase]
  );

  // Order products to match the requested tier order (store returns them in an
  // arbitrary order); drop any the store didn't return.
  const ordered = productIds
    .map((id) => products.find((p) => p.id === id))
    .filter((p): p is Product => !!p);

  return { status, products: ordered, pendingSku, tip };
}
