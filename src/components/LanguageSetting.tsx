/**
 * The canonical in-app language control — a Settings row that opens a sheet to
 * pick the app's language. The translation sibling of the design system's
 * <AppearanceToggle/> (System / Light / Dark): a drop-in control, configured by
 * props, never forked, so every app's language picker is identical (canon
 * § Translations). The appearance control is a 3-up segmented toggle; language
 * has too many options for that, so it's a row + selection sheet (the platform
 * convention, and identical on iOS and Android — canon § Cross-platform parity).
 *
 * Self-contained on purpose: it depends only on the design-system theme (every
 * app has it) and the i18n module — NOT on the app shell's AboutRow — so it
 * drops into any app, shell or pre-shell-with-i18n, without pulling chrome.
 *
 * Canonical, app-agnostic — synced by `sync.mjs app-shell`; do not fork.
 *
 * Why an in-app picker rather than the OS per-app language screen: iOS and
 * Android 13+ expose one in system settings, but Android 12 and below do not —
 * shipping only that would leave older Android with no way to change just this
 * app's language, a § Cross-platform functional parity defect. This works on
 * every version of both platforms.
 *
 *   // In the Settings screen, under a "Language" section label:
 *   <LanguageSetting />
 */

import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  Modal,
  ScrollView,
  StyleSheet,
  AccessibilityInfo,
} from 'react-native';
import { Languages, Check, X, ChevronRight } from 'lucide-react-native';
import { t } from '../i18n';
import {
  useLocalePreference,
  availableLocales,
  AUTONYMS,
  type LocalePref,
} from '../i18n/localePreference';
import {
  useTheme,
  fontFamily,
  space,
  radius,
  target,
  hairline,
  type as ty,
  type Colors,
} from '../theme';

/** Live reduced-motion flag (WCAG 2.2 AA — matches the review/donation modals). */
function useReducedMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => mounted && setReduce(v))
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduce);
    return () => {
      mounted = false;
      sub.remove();
    };
  }, []);
  return reduce;
}

export function LanguageSetting({ icon = true }: { icon?: boolean }) {
  const { c } = useTheme();
  const s = makeStyles(c);
  const { pref, setPref } = useLocalePreference();
  const [open, setOpen] = useState(false);
  const reduceMotion = useReducedMotion();

  const options: { key: LocalePref; label: string; sub?: string }[] = [
    { key: 'system', label: t('settings.languageSystem'), sub: t('settings.languageSystemHint') },
    { key: 'en', label: AUTONYMS.en },
    ...availableLocales().map((l) => ({ key: l, label: AUTONYMS[l] ?? l })),
  ];

  const currentLabel =
    pref === 'system' ? t('settings.languageSystem') : AUTONYMS[pref] ?? pref;

  const choose = (key: LocalePref) => {
    setOpen(false);
    if (key !== pref) setPref(key);
  };

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        style={({ pressed }) => [s.trigger, pressed && s.pressed]}
        accessibilityRole="button"
        accessibilityLabel={`${t('settings.language')}, ${currentLabel}`}
      >
        {icon ? <Languages size={20} color={c.fgMuted} strokeWidth={1.5} /> : null}
        <Text style={s.triggerLabel}>{t('settings.language')}</Text>
        <Text style={s.triggerValue}>{currentLabel}</Text>
        <ChevronRight size={18} color={c.fgSubtle} strokeWidth={1.5} />
      </Pressable>

      <Modal
        visible={open}
        transparent
        animationType={reduceMotion ? 'none' : 'slide'}
        onRequestClose={() => setOpen(false)}
      >
        <Pressable style={s.scrim} onPress={() => setOpen(false)} accessibilityLabel={t('common.cancel')}>
          <Pressable style={s.sheet} onPress={() => {}} accessibilityViewIsModal>
            <View style={s.header}>
              <Text style={s.title}>{t('settings.language')}</Text>
              <Pressable
                onPress={() => setOpen(false)}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel={t('common.done')}
                style={s.close}
              >
                <X size={20} color={c.fgMuted} />
              </Pressable>
            </View>
            <ScrollView
              style={s.list}
              accessibilityRole="radiogroup"
              accessibilityLabel={t('settings.language')}
            >
              {options.map((o) => {
                const selected = o.key === pref;
                return (
                  <Pressable
                    key={o.key}
                    onPress={() => choose(o.key)}
                    accessibilityRole="radio"
                    accessibilityState={{ selected }}
                    accessibilityLabel={o.label}
                    style={s.row}
                  >
                    <View style={s.rowText}>
                      <Text style={s.rowLabel}>{o.label}</Text>
                      {o.sub ? <Text style={s.rowSub}>{o.sub}</Text> : null}
                    </View>
                    {selected ? <Check size={20} color={c.accent} /> : null}
                  </Pressable>
                );
              })}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    trigger: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.s4,
      minHeight: target.min + 6,
      paddingHorizontal: space.s6,
      borderBottomWidth: hairline,
      borderBottomColor: c.hairline,
    },
    pressed: { opacity: 0.6 },
    triggerLabel: { ...ty.base, flex: 1, fontFamily: fontFamily.sans, color: c.fg },
    triggerValue: { ...ty.sm, fontFamily: fontFamily.sans, color: c.fgMuted },

    scrim: { flex: 1, backgroundColor: c.bgScrim, justifyContent: 'flex-end' },
    sheet: {
      backgroundColor: c.bgElevated,
      borderTopLeftRadius: radius.lg,
      borderTopRightRadius: radius.lg,
      paddingBottom: space.s7,
      maxHeight: '80%',
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: space.s6,
      paddingTop: space.s6,
      paddingBottom: space.s4,
      borderBottomWidth: hairline,
      borderBottomColor: c.hairline,
    },
    title: { ...ty.md, fontFamily: fontFamily.sansSemibold, color: c.fg },
    close: { minWidth: target.min, minHeight: target.min, alignItems: 'flex-end', justifyContent: 'center' },
    list: { paddingHorizontal: space.s6 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      minHeight: target.min,
      paddingVertical: space.s3,
      borderBottomWidth: hairline,
      borderBottomColor: c.hairline,
    },
    rowText: { flex: 1 },
    rowLabel: { ...ty.base, fontFamily: fontFamily.sans, color: c.fg },
    rowSub: { ...ty.sm, fontFamily: fontFamily.sans, color: c.fgMuted, marginTop: 2 },
  });
}
