/**
 * Regression: adding an item from a suggestion row must CLEAR the search box.
 *
 * Josh-reported defect grocery-list-20260705-1: after typing a partial term
 * ("app") and tapping a suggestion ("apple"), the item was added but the typed
 * fragment stayed in the box — so a later checkmark/submit re-added the stray
 * fragment. This test drives the real ItemPicker: type a partial term, tap the
 * matching seed suggestion, and assert the input is empty afterward.
 *
 * Fails on the pre-fix code (add() didn't reset the query; only submitTyped did).
 */

import React from 'react';
import { TextInput } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import TestRenderer, { act } from 'react-test-renderer';
import ItemPicker from '../ItemPicker';

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

// Native side-effects with no bearing on the behavior under test.
jest.mock('expo-haptics', () => ({ selectionAsync: () => Promise.resolve() }));
jest.mock('expo-font', () => ({ useFonts: () => [true, null], isLoaded: () => true }));
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
// Stub the SQLite-backed persistence so the account store runs in node
// (expo-sqlite can't load here). Persist is fire-and-forget; UI state is the SUT.
jest.mock('../../store/db', () => ({
  loadHistory: jest.fn(async () => []),
  recordHistory: jest.fn(async () => {}),
  deleteHistory: jest.fn(async () => {}),
  putHistory: jest.fn(async () => {}),
  getAppSetting: jest.fn(async () => null),
  setAppSetting: jest.fn(async () => {}),
}));

function render(onAdd: (name: string) => void) {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(
      <SafeAreaProvider initialMetrics={METRICS}>
        <ItemPicker
          activeNames={new Set()}
          onAdd={onAdd}
          targetName="Weekly shop"
          onClose={() => {}}
          presentLabel="On list"
          presentA11y={(name) => `${name} on list`}
        />
      </SafeAreaProvider>
    );
  });
  return tree;
}

const input = (tree: TestRenderer.ReactTestRenderer) => tree.root.findByType(TextInput);

// Fake timers so the mount-focus timeout and the Snackbar auto-dismiss can't
// fire after the test finishes (which crashes react-test-renderer's teardown).
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test('tapping a suggestion adds the item and clears the search box', () => {
  const onAdd = jest.fn();
  const tree = render(onAdd);

  // Type a partial term that surfaces a built-in seed suggestion.
  act(() => input(tree).props.onChangeText('app'));
  expect(input(tree).props.value).toBe('app');

  // Find the "apple" suggestion row (its add button carries a11y "Add apple").
  const addApple = tree.root.findAll(
    (el) =>
      el.props.accessibilityRole === 'button' &&
      el.props.accessibilityLabel === 'Add apple'
  );
  expect(addApple.length).toBeGreaterThan(0);

  act(() => addApple[0].props.onPress());

  // The item was added...
  expect(onAdd).toHaveBeenCalledWith('apple', expect.anything());
  // ...and the box is now empty, ready for the next add or a clean exit.
  expect(input(tree).props.value).toBe('');

  act(() => tree.unmount());
});
