/**
 * The Siri default-list control — a Settings row (mirrors <LanguageSetting/>):
 * a trigger that opens a sheet to pick which list Siri adds to when you don't
 * name one out loud ("add milk" with no list said). Naming a list in the
 * command always overrides this.
 *
 * iOS only. Renders nothing where the Siri integration is absent (Android,
 * Expo Go, tests) or where there's fewer than two lists (with 0–1 lists there
 * is nothing to disambiguate — the intent just uses the only list, or asks you
 * to make one).
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  Modal,
  ScrollView,
  StyleSheet,
  AccessibilityInfo,
} from 'react-native';
import { Mic, Check, X, ChevronRight } from 'lucide-react-native';
import { t } from '../i18n';
import { useListsStore } from '../store/lists';
import {
  isSiriSupported,
  getSiriDefaultListId,
  setSiriDefaultListId,
  syncListsToSiri,
} from '../siri';
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

const ASK = '__ask__';

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

export function SiriSetting() {
  const { c } = useTheme();
  const s = makeStyles(c);
  const supported = useMemo(() => isSiriSupported(), []);
  const lists = useListsStore((st) => st.lists);
  const [open, setOpen] = useState(false);
  const [defaultId, setDefaultId] = useState<string | null>(null);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    let mounted = true;
    getSiriDefaultListId()
      .then((id) => mounted && setDefaultId(id))
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);

  if (!supported || lists.length < 2) return null;

  const selectedKey =
    defaultId && lists.some((l) => l.id === defaultId) ? defaultId : ASK;
  const currentLabel =
    selectedKey === ASK
      ? t('settings.siriAskEachTime')
      : lists.find((l) => l.id === selectedKey)?.name ?? t('settings.siriAskEachTime');

  const choose = (key: string) => {
    setOpen(false);
    const next = key === ASK ? null : key;
    setDefaultId(next);
    setSiriDefaultListId(next)
      .then(() => syncListsToSiri())
      .catch(() => {});
  };

  const options = [{ key: ASK, label: t('settings.siriAskEachTime') }].concat(
    lists.map((l) => ({ key: l.id, label: l.name }))
  );

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        style={({ pressed }) => [s.trigger, pressed && s.pressed]}
        accessibilityRole="button"
        accessibilityLabel={`${t('settings.siriDefaultList')}, ${currentLabel}`}
      >
        <Mic size={20} color={c.fgMuted} strokeWidth={1.5} />
        <Text style={s.triggerLabel}>{t('settings.siriDefaultList')}</Text>
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
              <Text style={s.title}>{t('settings.siriDefaultList')}</Text>
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
              accessibilityLabel={t('settings.siriDefaultList')}
            >
              {options.map((o) => {
                const selected = o.key === selectedKey;
                return (
                  <Pressable
                    key={o.key}
                    onPress={() => choose(o.key)}
                    accessibilityRole="radio"
                    accessibilityState={{ selected }}
                    accessibilityLabel={o.label}
                    style={s.row}
                  >
                    <Text style={s.rowLabel}>{o.label}</Text>
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
    rowLabel: { ...ty.base, flex: 1, fontFamily: fontFamily.sans, color: c.fg },
  });
}
