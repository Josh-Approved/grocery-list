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
 *               yet created in the console) — the sheet degrades gracefully
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

// How long after connecting we wait for products before declaring the jar
// unavailable, so the UI never hangs on a spinner.
const FETCH_TIMEOUT_MS = 6000;

export function useTipJar(productIds: readonly string[]): UseTipJar {
  const [status, setStatus] = useState<TipStatus>('connecting');
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
      setStatus('unavailable')
    );
    // productIds is a stable module constant; intentionally not a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  // Promote to "ready" as soon as products arrive.
  useEffect(() => {
    if (products.length && (status === 'loading' || status === 'connecting')) {
      setStatus('ready');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products.length]);

  // Fallback: never hang on the spinner — if nothing loaded, show unavailable.
  useEffect(() => {
    if (!connected) return;
    const id = setTimeout(() => {
      setStatus((s) =>
        s === 'loading' || s === 'connecting'
          ? productsRef.current.length
            ? 'ready'
            : 'unavailable'
          : s
      );
    }, FETCH_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [connected]);

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
