// Canonical Josh Approved tip-jar sheet — the in-app tip jar UI (the IAP
// replacement for the rejected Buy Me a Coffee link-out).
// Source: josh-approved-factory/templates/tip-jar/TipJarSheet.tsx
// Pairs with tipJar.ts. See README.md for canonical rules and wiring.
//
// One canonical sheet, used unmodified across the catalogue — like DonationModal
// it is the one piece of custom UI we allow because it is ONE custom UI, not
// many. Inherits the design system from '../theme'; don't restyle per app.
//
// Copy is locked (canon § Tip jar): reaffirm free + studio-supported-by-tips,
// never "nothing unlocks", no guilt. Prices are ALWAYS the store's localized
// `displayPrice` — we never hardcode or guess a price.

import React, { useEffect, useState } from 'react';
import {
  Modal,
  View,
  Text,
  Pressable,
  ScrollView,
  ActivityIndicator,
  StyleSheet,
  AccessibilityInfo,
} from 'react-native';
import {
  useTheme,
  fontFamily,
  space,
  radius,
  type as ty,
  hairline,
  Colors,
} from '../theme';
import { t } from '../i18n';
import { useTipJar, isStoreKnownUnavailable, type TipStatus } from '../lib/tipJar';
import type { Product } from 'expo-iap';

interface Props {
  visible: boolean;
  onDismiss: () => void;
  /** The app's tip product ids, cheapest → most generous (see src/constants/tipProducts.ts). */
  productIds: readonly string[];
}

/**
 * The tip sheet. We only open a billing connection (mount `useTipJar`) while the
 * sheet is actually visible AND the store isn't already known-unavailable this
 * launch. On a device with no billing store — a de-Googled Android with no Play
 * Store — that means the native billing stack is never touched again after the
 * first miss: no repeat "Google Play Store is missing" log, and an instant calm
 * "unavailable" state instead of a spinner. Everything the app offers stays free
 * and fully functional regardless; only this optional tip surface is affected.
 */
export default function TipJarSheet({ visible, onDismiss, productIds }: Props) {
  if (!visible || isStoreKnownUnavailable()) {
    return (
      <SheetShell
        visible={visible}
        onDismiss={onDismiss}
        status={isStoreKnownUnavailable() ? 'unavailable' : 'connecting'}
        products={[]}
        pendingSku={null}
        onTip={() => {}}
      />
    );
  }
  return <ConnectedSheet visible onDismiss={onDismiss} productIds={productIds} />;
}

/** Mounts the IAP hook and drives the shell — only rendered when we intend to connect. */
function ConnectedSheet({ visible, onDismiss, productIds }: Props) {
  const { status, products, pendingSku, tip } = useTipJar(productIds);
  return (
    <SheetShell
      visible={visible}
      onDismiss={onDismiss}
      status={status}
      products={products}
      pendingSku={pendingSku}
      onTip={tip}
    />
  );
}

interface ShellProps {
  visible: boolean;
  onDismiss: () => void;
  status: TipStatus;
  products: Product[];
  pendingSku: string | null;
  onTip: (sku: string) => void;
}

function SheetShell({
  visible,
  onDismiss,
  status,
  products,
  pendingSku,
  onTip,
}: ShellProps) {
  const { c } = useTheme();
  const s = makeStyles(c);
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion);
    const sub = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      setReduceMotion
    );
    return () => sub.remove();
  }, []);

  const loading = status === 'connecting' || status === 'loading';
  const purchasing = status === 'purchasing';

  return (
    <Modal
      visible={visible}
      transparent
      animationType={reduceMotion ? 'none' : 'fade'}
      statusBarTranslucent
      onRequestClose={onDismiss}
    >
      <View style={s.overlay}>
        <View style={s.card}>
          {status === 'thanks' ? (
            <>
              <Text style={s.title}>{t('tip.thanksTitle')}</Text>
              <Text style={s.body}>{t('tip.thanks')}</Text>
              <Pressable
                style={({ pressed }) => [s.primaryBtn, pressed && s.pressed]}
                onPress={onDismiss}
                accessibilityRole="button"
                accessibilityLabel={t('common.done')}
              >
                <Text style={s.primaryBtnText}>{t('common.done')}</Text>
              </Pressable>
            </>
          ) : (
            <>
              <Text style={s.title}>{t('tip.title')}</Text>
              <Text style={s.body}>{t('tip.body')}</Text>

              {loading && (
                <View style={s.statusBlock}>
                  <ActivityIndicator color={c.fgMuted} />
                </View>
              )}

              {status === 'unavailable' && (
                <View style={s.statusBlock}>
                  <Text style={s.unavailable}>{t('tip.unavailable')}</Text>
                </View>
              )}

              {(status === 'ready' || purchasing) && (
                <ScrollView
                  style={s.tierList}
                  contentContainerStyle={s.tierListContent}
                >
                  {products.map((p) => {
                    const isPending = purchasing && pendingSku === p.id;
                    return (
                      <Pressable
                        key={p.id}
                        style={({ pressed }) => [
                          s.tierBtn,
                          pressed && s.pressed,
                          purchasing && !isPending && s.tierBtnDimmed,
                        ]}
                        onPress={() => onTip(p.id)}
                        disabled={purchasing}
                        accessibilityRole="button"
                        accessibilityLabel={t('tip.tierA11y', {
                          price: p.displayPrice,
                        })}
                      >
                        {isPending ? (
                          <ActivityIndicator color={c.inkButtonText} />
                        ) : (
                          <Text style={s.tierBtnText}>{p.displayPrice}</Text>
                        )}
                      </Pressable>
                    );
                  })}
                </ScrollView>
              )}
            </>
          )}

          {status !== 'thanks' && (
            <Pressable
              style={({ pressed }) => [s.secondaryBtn, pressed && s.pressed]}
              onPress={onDismiss}
              disabled={purchasing}
              accessibilityRole="button"
              accessibilityLabel={t('common.maybeLater')}
              hitSlop={8}
            >
              <Text style={s.secondaryBtnText}>{t('common.maybeLater')}</Text>
            </Pressable>
          )}
        </View>
      </View>
    </Modal>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    overlay: {
      flex: 1,
      backgroundColor: c.bgScrim,
      justifyContent: 'center',
      alignItems: 'center',
      padding: space.s7,
    },
    card: {
      width: '100%',
      maxWidth: 420,
      backgroundColor: c.bgElevated,
      borderRadius: radius.lg,
      borderWidth: hairline,
      borderColor: c.hairline,
      padding: space.s7,
      alignItems: 'center',
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 8 },
      shadowOpacity: 0.18,
      shadowRadius: 16,
      elevation: 10,
    },
    title: {
      ...ty.md,
      fontFamily: fontFamily.sansSemibold,
      color: c.fg,
      textAlign: 'center',
      marginBottom: space.s3,
    },
    body: {
      ...ty.sm,
      fontFamily: fontFamily.sans,
      color: c.fg,
      textAlign: 'center',
      marginBottom: space.s6,
    },
    statusBlock: {
      paddingVertical: space.s6,
      alignItems: 'center',
      width: '100%',
    },
    unavailable: {
      ...ty.sm,
      fontFamily: fontFamily.sans,
      color: c.fgMuted,
      textAlign: 'center',
    },
    tierList: { width: '100%', maxHeight: 320 },
    tierListContent: { gap: space.s3 },
    tierBtn: {
      backgroundColor: c.inkButton,
      borderRadius: radius.md,
      paddingVertical: space.s4,
      paddingHorizontal: space.s7,
      width: '100%',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: 48,
    },
    tierBtnDimmed: { opacity: 0.4 },
    tierBtnText: {
      ...ty.base,
      fontFamily: fontFamily.sansSemibold,
      color: c.inkButtonText,
    },
    primaryBtn: {
      backgroundColor: c.inkButton,
      borderRadius: radius.md,
      paddingVertical: space.s4,
      paddingHorizontal: space.s7,
      width: '100%',
      alignItems: 'center',
      marginTop: space.s4,
    },
    primaryBtnText: {
      ...ty.base,
      fontFamily: fontFamily.sansSemibold,
      color: c.inkButtonText,
    },
    secondaryBtn: { paddingVertical: space.s2, marginTop: space.s4 },
    secondaryBtnText: {
      ...ty.sm,
      fontFamily: fontFamily.sans,
      color: c.fgMuted,
    },
    pressed: { opacity: 0.7 },
  });
}
