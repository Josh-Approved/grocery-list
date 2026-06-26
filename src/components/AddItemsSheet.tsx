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
import {
  SafeAreaProvider,
  SafeAreaView,
  initialWindowMetrics,
} from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { Search, Pencil, Check, Star, X } from 'lucide-react-native';
import { useReducedMotion, useActionMenu, usePrompt } from './Dialogs';
import { Snackbar } from './Snackbar';
import { useListsStore } from '../store/lists';
import { useAccountStore, rankedHistoryNames } from '../store/account';
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
      /** A Recent (own-history) row — eligible for swipe-to-forget. */
      recent: boolean;
    };

const RECENT_BROWSE_CAP = 30;
const RECENT_QUERY_CAP = 12;
const USUALS_CAP = 50;
// While browsing (no query), only peek the top usuals so a long usuals list
// can't bury Recent. "Show all" expands to the full set (still capped above).
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

export default function AddItemsSheet({ visible, listId, onClose }: Props) {
  const { c } = useTheme();
  const s = makeStyles(c);
  const reduced = useReducedMotion();
  const menu = useActionMenu();
  const prompt = usePrompt();
  const inputRef = useRef<TextInput>(null);
  const [query, setQuery] = useState('');
  // Browse-only "Show all usuals" expander (see USUALS_PEEK).
  const [showAllUsuals, setShowAllUsuals] = useState(false);

  const list = useListsStore((st) => st.lists.find((l) => l.id === listId));
  const addItem = useListsStore((st) => st.addItem);

  const recordUse = useAccountStore((st) => st.recordUse);
  const forgetUse = useAccountStore((st) => st.forgetUse);
  const restoreUse = useAccountStore((st) => st.restoreUse);
  const renameUse = useAccountStore((st) => st.renameUse);
  const staples = useAccountStore((st) => st.staples);
  const history = useAccountStore((st) => st.history);
  const addStaple = useAccountStore((st) => st.addStaple);
  const removeStaple = useAccountStore((st) => st.removeStaple);

  // One snackbar serves two roles: a brief "Added to …" confirmation toast (no
  // action) and the "Forgot …" Undo after a swipe-to-forget.
  const [snack, setSnack] = useState<{
    message: string;
    durationMs: number;
    undo?: () => void;
  } | null>(null);
  // Lift the toast above the keyboard while it's up, so an add made mid-typing
  // still shows its confirmation instead of hiding behind the keys.
  const [kbHeight, setKbHeight] = useState(0);

  const { pref } = useLocalePreference();
  const activeLocale =
    pref === 'system'
      ? pickLocale(getLocale(), [...CANONICAL_LOCALES]) ?? 'en'
      : pref;

  // Focus the search the moment the sheet opens; reset the query each open.
  useEffect(() => {
    if (!visible) return;
    setQuery('');
    setShowAllUsuals(false);
    const id = setTimeout(() => inputRef.current?.focus(), 60);
    return () => clearTimeout(id);
  }, [visible]);

  // The peek only exists while browsing; searching always shows every match.
  // Collapse on search so returning to the browse view starts compact again.
  useEffect(() => {
    if (query.trim()) setShowAllUsuals(false);
  }, [query]);

  // Clear any lingering toast when the sheet closes.
  useEffect(() => {
    if (!visible) setSnack(null);
  }, [visible]);

  // Track keyboard height so the "Added" toast clears it.
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
    const browsing = !q;
    // Recency-weighted order: a frequently-bought item outranks a stale one-off
    // typo even if the typo's raw count was once higher (see historyScore).
    const historyNames = rankedHistoryNames(history, Date.now());
    const recentSource = historyNames.filter(
      (n) => !usualSet.has(n.toLowerCase())
    );

    // While browsing, drop anything already on the list — it's done, and you
    // manage it on the list itself; re-listing it here is just noise. While
    // searching, keep on-list rows (they show a check) so you still get the
    // "already added" feedback and can bump quantity.
    const dropOnList = (names: string[]) =>
      browsing ? names.filter((n) => !activeSet.has(n.toLowerCase())) : names;

    const usualsRanked = rankNames(dropOnList(staples), q, USUALS_CAP);
    const recent = rankNames(
      dropOnList(recentSource),
      q,
      q ? RECENT_QUERY_CAP : RECENT_BROWSE_CAP
    );

    // Peek the usuals while browsing so they can't bury Recent; the query view
    // is already filtered down, so it shows every match.
    const usualsHasMore = browsing && usualsRanked.length > USUALS_PEEK;
    const usuals =
      browsing && !showAllUsuals
        ? usualsRanked.slice(0, USUALS_PEEK)
        : usualsRanked;

    // Catalog suggestions never re-offer something the user already has.
    const exclude = new Set<string>([
      ...staples,
      ...historyNames.map((n) => n.toLowerCase()),
    ]);
    // "Brand-new" means no data at all — not a returning user whose usuals and
    // recent merely filtered down to nothing because they're already on the
    // list. The starter set and its hint are only for a truly empty account.
    const brandNew = staples.length === 0 && history.length === 0;
    let common: SeedItem[] = [];
    if (q) {
      common = suggestSeed(q, activeLocale, exclude, SEED_CAP);
    } else if (brandNew) {
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
      out.push({
        t: 'hint',
        key: 'hint-starter',
        text: t('detail.starterHint'),
      });
    } else if (browsing && usuals.length === 0 && recent.length === 0) {
      // Returning user who has already added everything they usually buy.
      out.push({
        t: 'hint',
        key: 'hint-all-on-list',
        text: t('detail.allOnList'),
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
  }, [query, staples, history, usualSet, activeSet, activeLocale, showAllUsuals]);

  const add = useCallback(
    (name: string, category?: Category) => {
      const n = name.trim();
      if (!n) return;
      addItem(listId, n, activeLocale, category);
      recordUse(n);
      // Tangible confirmation: a light selection tick + a brief toast. The
      // toast doubles as the screen-reader confirmation (Snackbar is a polite
      // live region) and is reduced-motion-safe (it has no animation).
      Haptics.selectionAsync().catch(() => {});
      setSnack({
        message: t('detail.addedToList', { name: list?.name ?? '' }),
        durationMs: 1500,
      });
    },
    [addItem, recordUse, listId, activeLocale, list?.name]
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

  // Pencil on a Recent row: a cross-platform Edit/Delete menu (no swipe). Edit
  // opens a rename prompt that preserves the suggestion's ranking; Delete is the
  // old forget-with-Undo. Dismiss the search keyboard first so the bottom menu
  // (and then the prompt's own keyboard) isn't fighting the keys.
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
    // The search keeps the keyboard up after each add (blurOnSubmit={false}) so
    // you can rapid-fire a list. An empty submit means "I'm done" — dismiss the
    // keyboard and close the whole sheet, matching the top-bar Done. The
    // keyboard's blue Done/return key is the same affordance as Done; it should
    // leave the screen, not just drop the keyboard and strand you here.
    if (!n) {
      Keyboard.dismiss();
      onClose();
      return;
    }
    add(n);
    setQuery('');
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
            {row.toggle ? (
              <Pressable
                onPress={() => setShowAllUsuals(row.toggle === 'more')}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={
                  row.toggle === 'more'
                    ? t('detail.showAll')
                    : t('detail.showLess')
                }
                style={({ pressed }) => [s.headerToggle, pressed && s.pressed]}
              >
                <Text style={s.headerToggleText}>
                  {row.toggle === 'more'
                    ? t('detail.showAll')
                    : t('detail.showLess')}
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
      const body = (
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

          {/*
           * The whole row adds on tap, so there's no separate + button. Recent
           * rows (the user's own history) instead carry a pencil that opens an
           * Edit/Delete menu — modify a typo or forget the suggestion for good.
           * Usuals and the built-in catalog aren't editable here: a usual is
           * managed with its ★, and the catalog isn't user data. On-list rows
           * (only seen while searching) keep a check as a quiet "already added".
           */}
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
            <View style={s.checkBox} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
              <Check size={18} color={c.accent} strokeWidth={2} />
            </View>
          ) : null}
        </View>
      );
      return body;
    },
    [s, c, add, toggleUsual, editRecent]
  );

  return (
    <Modal
      visible={visible}
      animationType={reduced ? 'none' : 'slide'}
      presentationStyle="fullScreen"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      {/*
       * A RN Modal renders in its own native hierarchy, detached from the app's
       * root SafeAreaProvider, so insets read as 0 here — the title and Done
       * overlapped the status bar. Nest a provider (seeded with the launch
       * metrics to avoid a 0-inset first frame) so the SafeAreaView below gets
       * real top/bottom insets inside the full-screen modal.
       */}
      <SafeAreaProvider initialMetrics={initialWindowMetrics}>
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
        </SafeAreaView>
      </SafeAreaProvider>
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
