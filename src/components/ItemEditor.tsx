/**
 * Item editor — the bottom sheet behind each row's pencil.
 *
 * The list row itself is now a single tap target that checks/unchecks (the
 * dominant gesture while shopping). Everything else about an item — its name,
 * its note (shown in FULL here, multi-line, where the row only previews it),
 * its quantity, its aisle, whether it's a usual, and deleting it — lives in
 * this one sheet, reached by the row's trailing pencil. That split is what
 * makes "where do I tap to edit vs. check off" unambiguous and kills the old
 * bug where tapping a truncated note crossed the item off.
 *
 * App-specific (not a synced canonical component), so it reads the stores
 * directly. Delete bubbles up via `onRemove` so the screen owns the Undo
 * snackbar (the "hard to lose" tenet). Name/note commit on close; quantity,
 * aisle, and usual apply immediately, matching the app's instant-with-undo feel.
 *
 * Cross-platform: pure RN `Modal` + the shared dialog tokens — no
 * `ActionSheetIOS` / `Alert.prompt` (canon § Cross-platform functional parity).
 */

import React, { useCallback, useState } from 'react';
import {
  Modal,
  View,
  Text,
  Pressable,
  TextInput,
  ScrollView,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { Plus, Star, Trash2 } from 'lucide-react-native';
import { useReducedMotion } from './Dialogs';
import { Stepper } from './Stepper';
import { useListsStore } from '../store/lists';
import { useAccountStore } from '../store/account';
import { MAX_QTY, type GroceryItem } from '../data/list';
import { DEFAULT_CATEGORY_ORDER, categoryLabel } from '../data/categories';
import { t } from '../i18n';
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

interface EditTarget {
  listId: string;
  itemId: string;
  /** Delete bubbles to the screen so it can offer Undo (the screen owns the
   *  snackbar). */
  onRemove: (item: GroceryItem) => void;
}

export function useItemEditor(): {
  open: (cfg: EditTarget) => void;
  element: React.ReactElement;
} {
  const { c } = useTheme();
  const s = makeStyles(c);
  const reduced = useReducedMotion();

  const [target_, setTarget] = useState<EditTarget | null>(null);
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  // Inline "create a new aisle" affordance within the aisle picker.
  const [addingAisle, setAddingAisle] = useState(false);
  const [aisleDraft, setAisleDraft] = useState('');

  // Live list/item — so quantity/aisle/usual edits reflect instantly in the
  // sheet, and a freshly created aisle appears among the chips at once.
  const list = useListsStore((st) =>
    target_ ? st.lists.find((l) => l.id === target_.listId) : undefined
  );
  const item = list?.items.find((i) => i.id === target_?.itemId);
  const categoryOrder = list?.categoryOrder ?? DEFAULT_CATEGORY_ORDER;

  const setQuantity = useListsStore((st) => st.setQuantity);
  const recategorize = useListsStore((st) => st.recategorize);
  const addCategory = useListsStore((st) => st.addCategory);
  const setItemName = useListsStore((st) => st.setName);
  const setItemNote = useListsStore((st) => st.setNote);

  const isStaple = useAccountStore((st) => st.isStaple);
  const addStaple = useAccountStore((st) => st.addStaple);
  const removeStaple = useAccountStore((st) => st.removeStaple);

  const open = useCallback((cfg: EditTarget) => {
    const found = useListsStore
      .getState()
      .lists.find((l) => l.id === cfg.listId)
      ?.items.find((i) => i.id === cfg.itemId);
    setName(found?.name ?? '');
    setNote(found?.note ?? '');
    setAddingAisle(false);
    setAisleDraft('');
    setTarget(cfg);
  }, []);

  const commitAisle = useCallback(() => {
    const cur = target_;
    const draft = aisleDraft.trim();
    if (cur && draft) {
      const key = addCategory(cur.listId, draft);
      if (key) recategorize(cur.listId, cur.itemId, key);
    }
    setAddingAisle(false);
    setAisleDraft('');
  }, [target_, aisleDraft, addCategory, recategorize]);

  const commitAndClose = useCallback(() => {
    const cur = target_;
    if (cur) {
      const live = useListsStore
        .getState()
        .lists.find((l) => l.id === cur.listId)
        ?.items.find((i) => i.id === cur.itemId);
      if (live) {
        const nextName = name.trim();
        // Only write when actually changed — an unchanged close shouldn't bump
        // updatedAt and ripple a no-op through sync.
        if (nextName && nextName !== live.name) {
          setItemName(cur.listId, cur.itemId, nextName);
        }
        if (note.trim() !== (live.note ?? '')) {
          setItemNote(cur.listId, cur.itemId, note);
        }
      }
    }
    setAddingAisle(false);
    setAisleDraft('');
    setTarget(null);
  }, [target_, name, note, setItemName, setItemNote]);

  const handleDelete = useCallback(() => {
    const cur = target_;
    if (cur && item) {
      const snapshot = item;
      setTarget(null);
      cur.onRemove(snapshot);
      return;
    }
    setTarget(null);
  }, [target_, item]);

  const toggleUsual = useCallback(() => {
    if (!item) return;
    if (isStaple(item.name)) removeStaple(item.name);
    else addStaple(item.name);
  }, [item, isStaple, addStaple, removeStaple]);

  const usual = item ? isStaple(item.name) : false;

  const element = (
    <Modal
      visible={!!target_ && !!item}
      transparent
      animationType={reduced ? 'none' : 'slide'}
      statusBarTranslucent
      onRequestClose={commitAndClose}
    >
      <KeyboardAvoidingView
        style={s.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <Pressable
          style={s.overlay}
          onPress={commitAndClose}
          accessibilityRole="button"
          accessibilityLabel={t('common.close')}
        >
          <Pressable style={s.sheet} onPress={(e) => e.stopPropagation()}>
            {item ? (
              <ScrollView
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
              >
                <View style={s.headerRow}>
                  <Text style={s.title} accessibilityRole="header">
                    {t('detail.editItem')}
                  </Text>
                  <Pressable
                    onPress={commitAndClose}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={t('common.done')}
                    style={({ pressed }) => [s.doneBtn, pressed && s.pressed]}
                  >
                    <Text style={s.doneText}>{t('common.done')}</Text>
                  </Pressable>
                </View>

                <Text style={s.fieldLabel}>{t('detail.itemNameLabel')}</Text>
                <TextInput
                  style={s.input}
                  value={name}
                  onChangeText={setName}
                  placeholder={t('detail.itemNameLabel')}
                  placeholderTextColor={c.fgSubtle}
                  returnKeyType="done"
                  accessibilityLabel={t('detail.itemNameLabel')}
                />

                <Text style={s.fieldLabel}>{t('detail.noteTitle')}</Text>
                <TextInput
                  style={[s.input, s.noteInput]}
                  value={note}
                  onChangeText={setNote}
                  placeholder={t('detail.notePlaceholder')}
                  placeholderTextColor={c.fgSubtle}
                  multiline
                  accessibilityLabel={t('detail.noteTitle')}
                />

                <View style={s.qtyRow}>
                  <Text style={[s.fieldLabel, s.qtyLabel]}>
                    {t('detail.quantityLabel')}
                  </Text>
                  <Stepper
                    value={item.quantity}
                    min={1}
                    max={MAX_QTY}
                    onChange={(q) =>
                      target_ && setQuantity(target_.listId, target_.itemId, q)
                    }
                    label={t('detail.quantityOf', { name: item.name })}
                  />
                </View>

                <Text style={s.fieldLabel}>{t('detail.aisleLabel')}</Text>
                <View style={s.chips}>
                  {categoryOrder.map((cat) => {
                    const on = cat === item.category;
                    return (
                      <Pressable
                        key={cat}
                        onPress={() =>
                          target_ &&
                          recategorize(target_.listId, target_.itemId, cat)
                        }
                        accessibilityRole="button"
                        accessibilityState={{ selected: on }}
                        accessibilityLabel={categoryLabel(cat)}
                        style={({ pressed }) => [
                          s.chip,
                          on && s.chipOn,
                          pressed && s.pressed,
                        ]}
                      >
                        <Text style={[s.chipText, on && s.chipTextOn]}>
                          {categoryLabel(cat)}
                        </Text>
                      </Pressable>
                    );
                  })}
                  {!addingAisle ? (
                    <Pressable
                      onPress={() => setAddingAisle(true)}
                      accessibilityRole="button"
                      accessibilityLabel={t('detail.newAisle')}
                      style={({ pressed }) => [
                        s.chip,
                        s.chipAdd,
                        pressed && s.pressed,
                      ]}
                    >
                      <Plus size={14} color={c.fgMuted} strokeWidth={1.5} />
                      <Text style={[s.chipText, s.chipAddText]}>
                        {t('detail.newAisle')}
                      </Text>
                    </Pressable>
                  ) : null}
                </View>

                {addingAisle ? (
                  <View style={s.aisleInputRow}>
                    <TextInput
                      style={[s.input, s.aisleInput]}
                      value={aisleDraft}
                      onChangeText={setAisleDraft}
                      placeholder={t('detail.newAislePlaceholder')}
                      placeholderTextColor={c.fgSubtle}
                      autoFocus
                      returnKeyType="done"
                      maxLength={40}
                      onSubmitEditing={commitAisle}
                      accessibilityLabel={t('detail.newAislePlaceholder')}
                    />
                    <Pressable
                      onPress={commitAisle}
                      disabled={aisleDraft.trim().length === 0}
                      accessibilityRole="button"
                      accessibilityLabel={t('common.add')}
                      style={({ pressed }) => [
                        s.aisleAddBtn,
                        aisleDraft.trim().length === 0 && s.aisleAddDisabled,
                        pressed && s.pressed,
                      ]}
                    >
                      <Text style={s.aisleAddText}>{t('common.add')}</Text>
                    </Pressable>
                  </View>
                ) : null}

                <View style={s.divider} />

                <Pressable
                  onPress={toggleUsual}
                  accessibilityRole="button"
                  accessibilityState={{ selected: usual }}
                  accessibilityLabel={
                    usual
                      ? t('detail.removeFromUsuals')
                      : t('detail.saveAsUsual')
                  }
                  style={({ pressed }) => [s.actionRow, pressed && s.pressed]}
                >
                  <Star
                    size={18}
                    color={usual ? c.accent : c.fgMuted}
                    strokeWidth={1.5}
                  />
                  <Text style={s.actionText}>
                    {usual
                      ? t('detail.removeFromUsuals')
                      : t('detail.saveAsUsual')}
                  </Text>
                </Pressable>

                <Pressable
                  onPress={handleDelete}
                  accessibilityRole="button"
                  accessibilityLabel={t('detail.remove')}
                  style={({ pressed }) => [s.actionRow, pressed && s.pressed]}
                >
                  <Trash2 size={18} color={c.danger} strokeWidth={1.5} />
                  <Text style={[s.actionText, s.actionDanger]}>
                    {t('detail.remove')}
                  </Text>
                </Pressable>
              </ScrollView>
            ) : null}
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );

  return { open, element };
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    flex: { flex: 1 },
    pressed: { opacity: 0.6 },

    overlay: {
      flex: 1,
      backgroundColor: c.bgScrim,
      justifyContent: 'flex-end',
    },
    sheet: {
      backgroundColor: c.bgElevated,
      borderTopLeftRadius: radius.lg,
      borderTopRightRadius: radius.lg,
      borderWidth: hairline,
      borderColor: c.hairline,
      paddingHorizontal: space.s7,
      paddingTop: space.s4,
      paddingBottom: space.s7,
      maxHeight: '88%',
    },

    headerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: space.s3,
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
      color: c.fg,
    },

    fieldLabel: {
      ...ty.xs,
      fontFamily: fontFamily.sansSemibold,
      color: c.fgMuted,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      marginTop: space.s5,
      marginBottom: space.s2,
    },
    input: {
      ...ty.base,
      fontFamily: fontFamily.sans,
      color: c.fg,
      backgroundColor: c.bg,
      borderWidth: hairline,
      borderColor: c.hairlineStrong,
      borderRadius: radius.md,
      paddingHorizontal: space.s5,
      paddingVertical: space.s4,
      minHeight: target.min,
    },
    noteInput: {
      minHeight: 84,
      textAlignVertical: 'top',
    },

    qtyRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginTop: space.s5,
    },
    qtyLabel: { marginTop: 0, marginBottom: 0 },

    chips: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: space.s2,
    },
    chip: {
      minHeight: 38,
      paddingHorizontal: space.s4,
      justifyContent: 'center',
      borderRadius: radius.pill,
      borderWidth: hairline,
      borderColor: c.hairlineStrong,
      backgroundColor: c.bg,
    },
    chipOn: {
      backgroundColor: c.accent,
      borderColor: c.accent,
    },
    chipText: {
      ...ty.sm,
      fontFamily: fontFamily.sans,
      color: c.fg,
    },
    chipTextOn: { color: c.fgOnAccent },
    chipAdd: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.s1,
    },
    chipAddText: { color: c.fgMuted },

    aisleInputRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.s3,
      marginTop: space.s3,
    },
    aisleInput: { flex: 1 },
    aisleAddBtn: {
      minHeight: target.min,
      paddingHorizontal: space.s5,
      justifyContent: 'center',
      alignItems: 'center',
      backgroundColor: c.inkButton,
      borderRadius: radius.md,
    },
    aisleAddDisabled: { opacity: 0.4 },
    aisleAddText: {
      ...ty.base,
      fontFamily: fontFamily.sansSemibold,
      color: c.inkButtonText,
    },

    divider: {
      borderTopWidth: hairline,
      borderTopColor: c.hairline,
      marginTop: space.s6,
    },
    actionRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.s3,
      minHeight: target.min,
      paddingVertical: space.s2,
    },
    actionText: {
      ...ty.base,
      fontFamily: fontFamily.sans,
      color: c.fg,
    },
    actionDanger: { color: c.danger },
  });
}
