/**
 * Add items — the full-screen sheet that is the hub for building a list fast.
 *
 * Opens from the List-detail "Add an item" bar. One surface that unifies what
 * used to take digging:
 *   - Your usuals (staples) pinned at the top — one tap to add each.
 *   - Recent — your own history, ranked by how often you buy it.
 *   - Common items — the built-in localized seed catalog (dimmed, last), so
 *     autocomplete is useful on day one and for words you've never typed.
 * Type to filter all three; the keyboard's return key adds whatever you typed
 * (match or not). ★ on every row marks/unmarks a usual on the spot — no more
 * pencil → editor → star. Items already on the list show a check and bump
 * quantity when tapped. The sheet stays open so you can add many in a row.
 *
 * Tenet boundary: only the seed tier is non-user data, and it only suggests —
 * see data/seedCatalog.ts. Everything added is still the user's choice.
 *
 * Cross-platform: pure RN `Modal` + design-system tokens — no ActionSheetIOS /
 * Alert.prompt (canon § Cross-platform functional parity).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal,
  View,
  Text,
  Pressable,
  TextInput,
  FlatList,
  StyleSheet,
  Keyboard,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Search, Plus, Check, Star, X } from 'lucide-react-native';
import { useReducedMotion } from './Dialogs';
import { useListsStore } from '../store/lists';
import { useAccountStore } from '../store/account';
import { visibleItems } from '../data/list';
import type { Category } from '../data/categories';
import {
  suggestSeed,
  starterItemsForLocale,
  type SeedItem,
} from '../data/seedCatalog';
import {
  t,
  pickLocale,
  getLocale,
  CANONICAL_LOCALES,
} from '../i18n';
import { useLocalePreference } from '../i18n/localePreference';
import {
  useTheme,
  fontFamily,
  space,
  radius,
  target,
  type as ty,
  hairline,
  type Colors,
} from '../theme';

interface Props {
  visible: boolean;
  listId: string;
  onClose: () => void;
}

type SheetRow =
  | { t: 'header'; key: string; label: string; dim?: boolean; star?: boolean }
  | { t: 'hint'; key: string; text: string }
  | {
      t: 'item';
      key: string;
      name: string;
      category?: Category;
      onList: boolean;
      isUsual: boolean;
    };

const RECENT_BROWSE_CAP = 30;
const RECENT_QUERY_CAP = 12;
const USUALS_CAP = 50;
const SEED_CAP = 20;

/** Prefix-first, then substring; case-insensitive; deduped; capped. */
function rankNames(names: string[], query: string, cap: number): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return names.slice(0, cap);
  const prefix: string[] = [];
  const contains: string[] = [];
  const seen = new Set<string>();
  for (const n of names) {
    const l = n.toLowerCase();
    if (seen.has(l)) continue;
    if (l.startsWith(q)) {
      prefix.push(n);
      seen.add(l);
    } else if (l.includes(q)) {
      contains.push(n);
      seen.add(l);
    }
  }
  return [...prefix, ...contains].slice(0, cap);
}

export default function AddItemsSheet({ visible, listId, onClose }: Props) {
  const { c } = useTheme();
  const s = makeStyles(c);
  const reduced = useReducedMotion();
  const inputRef = useRef<TextInput>(null);
  const [query, setQuery] = useState('');

  const list = useListsStore((st) => st.lists.find((l) => l.id === listId));
  const addItem = useListsStore((st) => st.addItem);

  const recordUse = useAccountStore((st) => st.recordUse);
  const staples = useAccountStore((st) => st.staples);
  const history = useAccountStore((st) => st.history);
  const addStaple = useAccountStore((st) => st.addStaple);
  const removeStaple = useAccountStore((st) => st.removeStaple);

  const { pref } = useLocalePreference();
  const activeLocale =
    pref === 'system'
      ? pickLocale(getLocale(), [...CANONICAL_LOCALES]) ?? 'en'
      : pref;

  // Focus the search the moment the sheet opens; reset the query each open.
  useEffect(() => {
    if (!visible) return;
    setQuery('');
    const id = setTimeout(() => inputRef.current?.focus(), 60);
    return () => clearTimeout(id);
  }, [visible]);

  const activeSet = useMemo(
    () =>
      new Set(
        (list ? visibleItems(list) : []).map((it) => it.name.toLowerCase())
      ),
    [list]
  );
  const usualSet = useMemo(() => new Set(staples), [staples]);

  const rows = useMemo<SheetRow[]>(() => {
    const q = query.trim();
    const historyNames = history.map((h) => h.name);
    const recentSource = historyNames.filter(
      (n) => !usualSet.has(n.toLowerCase())
    );

    const usuals = rankNames(staples, q, q ? USUALS_CAP : USUALS_CAP);
    const recent = rankNames(
      recentSource,
      q,
      q ? RECENT_QUERY_CAP : RECENT_BROWSE_CAP
    );

    // Catalog suggestions never re-offer something the user already has.
    const exclude = new Set<string>([
      ...staples,
      ...historyNames.map((n) => n.toLowerCase()),
    ]);
    let common: SeedItem[] = [];
    if (q) {
      common = suggestSeed(q, activeLocale, exclude, SEED_CAP);
    } else if (usuals.length === 0 && recent.length === 0) {
      // Brand-new user: carry day one with a small starter set.
      common = starterItemsForLocale(activeLocale).filter(
        (it) => !exclude.has(it.name.toLowerCase())
      );
    }

    const out: SheetRow[] = [];
    const mk = (name: string, category?: Category, tier = 'i') => {
      const lower = name.toLowerCase();
      out.push({
        t: 'item',
        key: `${tier}:${lower}`,
        name,
        category,
        onList: activeSet.has(lower),
        isUsual: usualSet.has(lower),
      });
    };

    if (usuals.length) {
      out.push({
        t: 'header',
        key: 'h-usuals',
        label: t('detail.yourUsuals'),
        star: true,
      });
      for (const n of usuals) mk(n, undefined, 'u');
    }
    if (recent.length) {
      out.push({ t: 'header', key: 'h-recent', label: t('detail.recent') });
      for (const n of recent) mk(n, undefined, 'r');
    }
    if (!q && usuals.length === 0 && recent.length === 0) {
      out.push({
        t: 'hint',
        key: 'hint-starter',
        text: t('detail.starterHint'),
      });
    }
    if (common.length) {
      out.push({
        t: 'header',
        key: 'h-common',
        label: t('detail.commonItems'),
        dim: true,
      });
      for (const it of common) mk(it.name, it.category, 'c');
    }
    return out;
  }, [query, staples, history, usualSet, activeSet, activeLocale]);

  const add = useCallback(
    (name: string, category?: Category) => {
      const n = name.trim();
      if (!n) return;
      addItem(listId, n, activeLocale, category);
      recordUse(n);
    },
    [addItem, recordUse, listId, activeLocale]
  );

  const submitTyped = useCallback(() => {
    const n = query.trim();
    // The search keeps the keyboard up after each add (blurOnSubmit={false}) so
    // you can rapid-fire a list. An empty submit then has no on-keyboard way
    // out, so read it as "I'm done typing" and dismiss — never trap the user.
    if (!n) {
      Keyboard.dismiss();
      return;
    }
    add(n);
    setQuery('');
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [query, add]);

  const toggleUsual = useCallback(
    (name: string) => {
      if (usualSet.has(name.trim().toLowerCase())) removeStaple(name);
      else addStaple(name);
    },
    [usualSet, addStaple, removeStaple]
  );

  const renderRow = useCallback(
    ({ item: row }: { item: SheetRow }) => {
      if (row.t === 'header') {
        return (
          <View style={s.headerRow} accessibilityRole="header">
            {row.star ? (
              <Star
                size={13}
                color={c.fgMuted}
                strokeWidth={2}
                fill={c.fgMuted}
              />
            ) : null}
            <Text style={[s.sectionHeader, row.dim && s.sectionHeaderDim]}>
              {row.label}
            </Text>
          </View>
        );
      }
      if (row.t === 'hint') {
        return <Text style={s.hint}>{row.text}</Text>;
      }
      const { name, category, onList, isUsual } = row;
      return (
        <View style={s.itemRow}>
          <Pressable
            style={s.itemTap}
            onPress={() => add(name, category)}
            accessibilityRole="button"
            accessibilityLabel={
              onList
                ? t('detail.onListItemA11y', { name })
                : t('detail.addNamed', { name })
            }
          >
            <Text style={[s.itemName, onList && s.itemNameOnList]} numberOfLines={1}>
              {name}
            </Text>
            {onList ? (
              <View style={s.pill}>
                <Text style={s.pillText}>{t('detail.onList')}</Text>
              </View>
            ) : null}
          </Pressable>

          <Pressable
            onPress={() => toggleUsual(name)}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityState={{ selected: isUsual }}
            accessibilityLabel={
              isUsual ? t('detail.removeFromUsuals') : t('detail.saveAsUsual')
            }
            style={({ pressed }) => [s.starBtn, pressed && s.pressed]}
          >
            <Star
              size={18}
              color={isUsual ? c.accent : c.fgSubtle}
              strokeWidth={1.5}
              fill={isUsual ? c.accent : 'transparent'}
            />
          </Pressable>

          {onList ? (
            <View style={s.checkBox} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
              <Check size={18} color={c.accent} strokeWidth={2} />
            </View>
          ) : (
            <Pressable
              onPress={() => add(name, category)}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel={t('detail.addNamed', { name })}
              style={({ pressed }) => [s.addBox, pressed && s.pressed]}
            >
              <Plus size={20} color={c.fgMuted} strokeWidth={2} />
            </Pressable>
          )}
        </View>
      );
    },
    [s, c, add, toggleUsual]
  );

  return (
    <Modal
      visible={visible}
      animationType={reduced ? 'none' : 'slide'}
      presentationStyle="fullScreen"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <SafeAreaView style={s.safe} edges={['top', 'bottom', 'left', 'right']}>
        <View style={s.topBar}>
          <Text style={s.title} accessibilityRole="header">
            {t('detail.addItemsTitle')}
          </Text>
          <Pressable
            onPress={onClose}
            hitSlop={8}
            testID="addSheetDone"
            accessibilityRole="button"
            accessibilityLabel={t('common.done')}
            style={({ pressed }) => [s.doneBtn, pressed && s.pressed]}
          >
            <Text style={s.doneText}>{t('common.done')}</Text>
          </Pressable>
        </View>

        <View style={s.searchWrap}>
          <Search size={18} color={c.fgSubtle} strokeWidth={1.5} />
          <TextInput
            ref={inputRef}
            style={s.searchInput}
            value={query}
            onChangeText={setQuery}
            placeholder={t('detail.searchOrAdd')}
            placeholderTextColor={c.fgSubtle}
            returnKeyType="done"
            blurOnSubmit={false}
            autoCapitalize="none"
            autoCorrect={false}
            onSubmitEditing={submitTyped}
            accessibilityLabel={t('detail.searchOrAdd')}
          />
          {query.length > 0 ? (
            <Pressable
              onPress={() => {
                setQuery('');
                requestAnimationFrame(() => inputRef.current?.focus());
              }}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('common.close')}
              style={({ pressed }) => [s.clearBtn, pressed && s.pressed]}
            >
              <X size={18} color={c.fgSubtle} strokeWidth={1.5} />
            </Pressable>
          ) : null}
        </View>

        <FlatList
          data={rows}
          keyExtractor={(r) => r.key}
          renderItem={renderRow}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="none"
          contentContainerStyle={s.listContent}
        />
      </SafeAreaView>
    </Modal>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: c.bg },
    pressed: { opacity: 0.6 },

    topBar: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: space.s6,
      paddingTop: space.s3,
      paddingBottom: space.s3,
    },
    title: {
      ...ty.md,
      fontFamily: fontFamily.sansSemibold,
      color: c.fg,
    },
    doneBtn: {
      minHeight: target.min,
      justifyContent: 'center',
      paddingLeft: space.s4,
    },
    doneText: {
      ...ty.base,
      fontFamily: fontFamily.sansSemibold,
      color: c.accent,
    },

    searchWrap: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.s3,
      marginHorizontal: space.s6,
      marginBottom: space.s2,
      paddingHorizontal: space.s4,
      backgroundColor: c.bgSubtle,
      borderWidth: hairline,
      borderColor: c.hairline,
      borderRadius: radius.md,
      minHeight: target.min,
    },
    searchInput: {
      ...ty.base,
      flex: 1,
      fontFamily: fontFamily.sans,
      color: c.fg,
      paddingVertical: space.s3,
    },
    clearBtn: {
      width: 28,
      height: 28,
      alignItems: 'center',
      justifyContent: 'center',
    },

    listContent: {
      paddingHorizontal: space.s6,
      paddingBottom: space.s9,
    },

    headerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.s2,
      marginTop: space.s5,
      marginBottom: space.s2,
    },
    sectionHeader: {
      ...ty.xs,
      fontFamily: fontFamily.sansSemibold,
      color: c.fgMuted,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    sectionHeaderDim: { color: c.fgSubtle },
    hint: {
      ...ty.sm,
      fontFamily: fontFamily.sans,
      color: c.fgSubtle,
      marginTop: space.s4,
      marginBottom: space.s2,
      lineHeight: 20,
    },

    itemRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.s2,
      borderBottomWidth: hairline,
      borderBottomColor: c.hairline,
    },
    itemTap: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.s3,
      minHeight: target.min,
      paddingVertical: space.s2,
    },
    itemName: {
      ...ty.base,
      fontFamily: fontFamily.sans,
      color: c.fg,
      flexShrink: 1,
    },
    itemNameOnList: { color: c.fgMuted },
    pill: {
      paddingHorizontal: space.s2,
      paddingVertical: 2,
      borderRadius: radius.sm,
      backgroundColor: c.accentBg,
    },
    pillText: {
      ...ty.xs,
      fontFamily: fontFamily.sansSemibold,
      color: c.accent,
    },
    starBtn: {
      width: target.min,
      height: target.min,
      alignItems: 'center',
      justifyContent: 'center',
    },
    addBox: {
      width: target.min,
      height: target.min,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: hairline,
      borderColor: c.hairlineStrong,
      borderRadius: radius.md,
    },
    checkBox: {
      width: target.min,
      height: target.min,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.md,
      backgroundColor: c.accentBg,
    },
  });
}
