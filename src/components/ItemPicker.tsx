/**
 * ItemPicker — the reusable usuals / recent / common-items picker.
 *
 * Extracted from AddItemsSheet so two surfaces can share one tuned, accessible,
 * localized picker without duplicating it:
 *   - adding items to a LIST (AddItemsSheet, "Items" tab), and
 *   - adding ingredients to a KIT (AddIngredientsSheet).
 *
 * It owns the search box, the ranked usuals/recent/seed rows, ★ usuals
 * toggling, the Recent edit/forget menu, the add haptic + toast, and keyboard
 * tracking. The TARGET is abstracted behind props: `activeNames` (what's
 * already there), `onAdd` (where a pick goes), `targetName` (toast), and the
 * "already added" pill label. Picks always enrich the user's own history
 * (recordUse) — the tenet holds: suggestions are only the user's own past
 * entries plus the built-in seed catalog.
 *
 * Cross-platform: pure RN, design-system tokens. Lives inside a parent that
 * already provides the SafeAreaProvider (canon § rn/modal-safe-area-provider).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  TextInput,
  FlatList,
  StyleSheet,
  Keyboard,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { Search, Pencil, Check, Star, X } from 'lucide-react-native';
import { useReducedMotion, useActionMenu, usePrompt } from './Dialogs';
import { Snackbar } from './Snackbar';
import { useAccountStore, rankedHistoryNames } from '../store/account';
import type { Category } from '../data/categories';
import {
  suggestSeed,
  starterItemsForLocale,
  type SeedItem,
} from '../data/seedCatalog';
import { t, pickLocale, getLocale, CANONICAL_LOCALES } from '../i18n';
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
  /** Lowercased names already present on the target (list items / kit items). */
  activeNames: Set<string>;
  /** Add a picked or typed item to the target. */
  onAdd: (name: string, category?: Category) => void;
  /** Target name, for the "Added to …" toast. */
  targetName: string;
  /** Close the whole sheet (the empty-submit "I'm done" path). */
  onClose: () => void;
  /** The "already added" pill text (e.g. "On list" / "In kit"). */
  presentLabel: string;
  /** A11y label for an already-present row. */
  presentA11y: (name: string) => string;
}

type SheetRow =
  | {
      t: 'header';
      key: string;
      label: string;
      dim?: boolean;
      star?: boolean;
      toggle?: 'more' | 'less';
    }
  | { t: 'hint'; key: string; text: string }
  | {
      t: 'item';
      key: string;
      name: string;
      category?: Category;
      onList: boolean;
      isUsual: boolean;
      recent: boolean;
    };

const RECENT_BROWSE_CAP = 30;
const RECENT_QUERY_CAP = 12;
const USUALS_CAP = 50;
const USUALS_PEEK = 8;
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

export default function ItemPicker({
  activeNames,
  onAdd,
  targetName,
  onClose,
  presentLabel,
  presentA11y,
}: Props) {
  const { c } = useTheme();
  const s = makeStyles(c);
  const menu = useActionMenu();
  const prompt = usePrompt();
  const inputRef = useRef<TextInput>(null);
  const [query, setQuery] = useState('');
  const [showAllUsuals, setShowAllUsuals] = useState(false);

  const recordUse = useAccountStore((st) => st.recordUse);
  const forgetUse = useAccountStore((st) => st.forgetUse);
  const restoreUse = useAccountStore((st) => st.restoreUse);
  const renameUse = useAccountStore((st) => st.renameUse);
  const staples = useAccountStore((st) => st.staples);
  const history = useAccountStore((st) => st.history);
  const addStaple = useAccountStore((st) => st.addStaple);
  const removeStaple = useAccountStore((st) => st.removeStaple);

  const [snack, setSnack] = useState<{
    message: string;
    durationMs: number;
    undo?: () => void;
  } | null>(null);
  const [kbHeight, setKbHeight] = useState(0);

  const { pref } = useLocalePreference();
  const activeLocale =
    pref === 'system'
      ? pickLocale(getLocale(), [...CANONICAL_LOCALES]) ?? 'en'
      : pref;

  // Focus the search when this picker mounts (sheet open / tab switch).
  useEffect(() => {
    const id = setTimeout(() => inputRef.current?.focus(), 60);
    return () => clearTimeout(id);
  }, []);

  useEffect(() => {
    if (query.trim()) setShowAllUsuals(false);
  }, [query]);

  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', (e) =>
      setKbHeight(e.endCoordinates?.height ?? 0)
    );
    const hide = Keyboard.addListener('keyboardDidHide', () => setKbHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  const usualSet = useMemo(() => new Set(staples), [staples]);

  const rows = useMemo<SheetRow[]>(() => {
    const q = query.trim();
    const browsing = !q;
    const historyNames = rankedHistoryNames(history, Date.now());
    const recentSource = historyNames.filter(
      (n) => !usualSet.has(n.toLowerCase())
    );

    const dropOnList = (names: string[]) =>
      browsing ? names.filter((n) => !activeNames.has(n.toLowerCase())) : names;

    const usualsRanked = rankNames(dropOnList(staples), q, USUALS_CAP);
    const recent = rankNames(
      dropOnList(recentSource),
      q,
      q ? RECENT_QUERY_CAP : RECENT_BROWSE_CAP
    );

    const usualsHasMore = browsing && usualsRanked.length > USUALS_PEEK;
    const usuals =
      browsing && !showAllUsuals
        ? usualsRanked.slice(0, USUALS_PEEK)
        : usualsRanked;

    const exclude = new Set<string>([
      ...staples,
      ...historyNames.map((n) => n.toLowerCase()),
    ]);
    const brandNew = staples.length === 0 && history.length === 0;
    let common: SeedItem[] = [];
    if (q) {
      common = suggestSeed(q, activeLocale, exclude, SEED_CAP);
    } else if (brandNew) {
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
        onList: activeNames.has(lower),
        isUsual: usualSet.has(lower),
        recent: tier === 'r',
      });
    };

    if (usuals.length) {
      out.push({
        t: 'header',
        key: 'h-usuals',
        label: t('detail.yourUsuals'),
        star: true,
        toggle: usualsHasMore ? (showAllUsuals ? 'less' : 'more') : undefined,
      });
      for (const n of usuals) mk(n, undefined, 'u');
    }
    if (recent.length) {
      out.push({ t: 'header', key: 'h-recent', label: t('detail.recent') });
      for (const n of recent) mk(n, undefined, 'r');
    }
    if (browsing && brandNew) {
      out.push({ t: 'hint', key: 'hint-starter', text: t('detail.starterHint') });
    } else if (browsing && usuals.length === 0 && recent.length === 0) {
      out.push({ t: 'hint', key: 'hint-all-on-list', text: t('detail.allOnList') });
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
  }, [query, staples, history, usualSet, activeNames, activeLocale, showAllUsuals]);

  const add = useCallback(
    (name: string, category?: Category) => {
      const n = name.trim();
      if (!n) return;
      onAdd(n, category);
      recordUse(n);
      // Clear the search box on every add (typed OR tapped) so the next add
      // starts clean and a stray partial term ("sal") can't be re-added by a
      // later checkmark/submit. See submitTyped, which relies on this.
      setQuery('');
      Haptics.selectionAsync().catch(() => {});
      setSnack({
        message: t('detail.addedToList', { name: targetName }),
        durationMs: 1500,
      });
    },
    [onAdd, recordUse, targetName]
  );

  const forget = useCallback(
    (name: string) => {
      const removed = forgetUse(name);
      if (!removed) return;
      Haptics.selectionAsync().catch(() => {});
      setSnack({
        message: t('detail.forgotSuggestion', { name: removed.name }),
        durationMs: 5000,
        undo: () => restoreUse(removed),
      });
    },
    [forgetUse, restoreUse]
  );

  const editRecent = useCallback(
    (name: string) => {
      Keyboard.dismiss();
      menu.open({
        title: name,
        options: [
          {
            label: t('common.edit'),
            onPress: () =>
              prompt.open({
                title: t('detail.editItem'),
                initialValue: name,
                selectAll: true,
                confirmLabel: t('common.save'),
                onSubmit: (next) => renameUse(name, next),
              }),
          },
          {
            label: t('common.delete'),
            destructive: true,
            onPress: () => forget(name),
          },
        ],
      });
    },
    [menu, prompt, renameUse, forget]
  );

  const submitTyped = useCallback(() => {
    const n = query.trim();
    if (!n) {
      Keyboard.dismiss();
      onClose();
      return;
    }
    add(n); // clears the query itself
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [query, add, onClose]);

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
              <Star size={13} color={c.fgMuted} strokeWidth={2} fill={c.fgMuted} />
            ) : null}
            <Text style={[s.sectionHeader, row.dim && s.sectionHeaderDim]}>
              {row.label}
            </Text>
            {row.toggle ? (
              <Pressable
                onPress={() => setShowAllUsuals(row.toggle === 'more')}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={
                  row.toggle === 'more' ? t('detail.showAll') : t('detail.showLess')
                }
                style={({ pressed }) => [s.headerToggle, pressed && s.pressed]}
              >
                <Text style={s.headerToggleText}>
                  {row.toggle === 'more' ? t('detail.showAll') : t('detail.showLess')}
                </Text>
              </Pressable>
            ) : null}
          </View>
        );
      }
      if (row.t === 'hint') {
        return <Text style={s.hint}>{row.text}</Text>;
      }
      const { name, category, onList, isUsual, recent } = row;
      return (
        <View style={s.itemRow}>
          <Pressable
            style={s.itemTap}
            onPress={() => add(name, category)}
            accessibilityRole="button"
            accessibilityLabel={
              onList ? presentA11y(name) : t('detail.addNamed', { name })
            }
          >
            <Text style={[s.itemName, onList && s.itemNameOnList]} numberOfLines={1}>
              {name}
            </Text>
            {onList ? (
              <View style={s.pill}>
                <Text style={s.pillText}>{presentLabel}</Text>
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

          {recent ? (
            <Pressable
              onPress={() => editRecent(name)}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel={t('detail.editItemA11y', { name })}
              style={({ pressed }) => [s.editBox, pressed && s.pressed]}
            >
              <Pencil size={18} color={c.fgMuted} strokeWidth={1.5} />
            </Pressable>
          ) : onList ? (
            <View
              style={s.checkBox}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              <Check size={18} color={c.accent} strokeWidth={2} />
            </View>
          ) : null}
        </View>
      );
    },
    [s, c, add, toggleUsual, editRecent, presentLabel, presentA11y]
  );

  return (
    <View style={s.flex}>
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

      <Snackbar
        visible={!!snack}
        message={snack?.message ?? ''}
        durationMs={snack?.durationMs}
        actionLabel={snack?.undo ? t('common.undo') : undefined}
        onAction={snack?.undo}
        onDismiss={() => setSnack(null)}
        bottomOffset={kbHeight}
      />

      {menu.element}
      {prompt.element}
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    flex: { flex: 1 },
    pressed: { opacity: 0.6 },

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
    sectionHeaderDim: { color: c.fgMuted },
    headerToggle: {
      marginLeft: 'auto',
      paddingVertical: space.s1,
      paddingLeft: space.s3,
    },
    headerToggleText: {
      ...ty.xs,
      fontFamily: fontFamily.sansSemibold,
      color: c.accent,
      letterSpacing: 0.3,
    },
    hint: {
      ...ty.sm,
      fontFamily: fontFamily.sans,
      color: c.fgMuted,
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
    editBox: {
      width: target.min,
      height: target.min,
      alignItems: 'center',
      justifyContent: 'center',
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
