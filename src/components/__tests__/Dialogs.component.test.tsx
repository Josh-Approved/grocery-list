/**
 * Component test — the cross-platform dialog hooks (Uplevel-3 T3 action coverage).
 *
 * Canonical, app-agnostic — rides `sync.mjs app-shell` with the Dialogs.tsx it
 * tests; do not fork.
 *
 * useActionMenu / usePrompt / useConfirm each return `{ open, element }`. A tiny
 * harness component calls the hook, renders `element`, and exposes a test-only
 * "trigger" button that fires `open(config)` so the dialog becomes visible; we
 * then press its real buttons and assert the observable outcome (a config
 * callback fired, or the dialog closed). Queries go by role/label/text only —
 * no testID, no snapshots.
 *
 * Menu-option handlers are deferred ~260ms past the sheet dismissal (so native
 * presentations aren't rejected by iOS mid-animation) — those assertions go
 * through waitFor, never a bare expect right after the press.
 *
 * These tests wait on real animation wall-clock, so jest's 5s default is too
 * tight on a 2-core CI runner — they pass in about a second locally and time
 * out there. The app's jest config carries a `testTimeout` generous enough to
 * absorb that. Do not "fix" a timeout here by shortening the deferral; it
 * exists to keep iOS from rejecting a native presentation mid-animation.
 */

import React from 'react';
import { fireEvent, render, screen, userEvent, waitFor } from '@testing-library/react-native';
import { View, Text, Pressable } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

// Virtual: not every app ships expo-haptics; the mock applies when it does and
// is inert when it doesn't.
jest.mock(
  'expo-haptics',
  () => ({
    selectionAsync: () => Promise.resolve(),
    notificationAsync: () => Promise.resolve(),
    NotificationFeedbackType: { Warning: 'warning' },
  }),
  { virtual: true }
);
jest.mock('expo-font', () => ({
  useFonts: () => [true, null],
  isLoaded: () => true,
  loadAsync: () => Promise.resolve(),
}));
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import { useActionMenu, usePrompt, useConfirm } from '../Dialogs';

function wrap(ui: React.ReactElement) {
  return <SafeAreaProvider initialMetrics={METRICS}>{ui}</SafeAreaProvider>;
}

// --- Action menu -----------------------------------------------------------

function MenuHarness({
  options,
  title,
}: {
  options: { label: string; onPress: () => void; destructive?: boolean }[];
  title?: string;
}) {
  const { open, element } = useActionMenu();
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="trigger"
        onPress={() => open({ title, options })}
      >
        <Text>trigger</Text>
      </Pressable>
      {element}
    </View>
  );
}

describe('useActionMenu', () => {
  it('fires an option handler and closes the menu when a row is pressed', async () => {
    const user = userEvent.setup({ delay: 0 });
    const onRename = jest.fn();
    const onDelete = jest.fn();
    await render(
      wrap(
        <MenuHarness
          title="List options"
          options={[
            { label: 'Rename', onPress: onRename },
            { label: 'Delete', onPress: onDelete, destructive: true },
          ]}
        />
      )
    );

    await user.press(screen.getByRole('button', { name: 'trigger' }));
    expect(screen.getByRole('header', { name: 'List options' })).toBeTruthy();

    await user.press(screen.getByRole('button', { name: 'Rename' }));
    // The handler is deferred past the sheet's slide-out (~260ms).
    await waitFor(() => expect(onRename).toHaveBeenCalledTimes(1));
    expect(onDelete).not.toHaveBeenCalled();
    // Choosing an option closes the sheet — the title header is gone.
    await waitFor(() =>
      expect(screen.queryByRole('header', { name: 'List options' })).toBeNull()
    );
  });

  it('closes without firing an option when Cancel is pressed', async () => {
    const user = userEvent.setup({ delay: 0 });
    const onPress = jest.fn();
    await render(
      wrap(
        <MenuHarness
          title="List options"
          options={[{ label: 'Rename', onPress }]}
        />
      )
    );

    await user.press(screen.getByRole('button', { name: 'trigger' }));
    await user.press(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.queryByRole('header', { name: 'List options' })).toBeNull()
    );
    // Past the defer window — the handler never fires on Cancel.
    await new Promise((r) => setTimeout(r, 300));
    expect(onPress).not.toHaveBeenCalled();
  });

  it('closes without firing when the scrim (Close menu) is pressed', async () => {
    const user = userEvent.setup({ delay: 0 });
    const onPress = jest.fn();
    await render(
      wrap(
        <MenuHarness
          title="List options"
          options={[{ label: 'Rename', onPress }]}
        />
      )
    );

    await user.press(screen.getByRole('button', { name: 'trigger' }));
    await user.press(screen.getByRole('button', { name: 'Close menu' }));
    await waitFor(() =>
      expect(screen.queryByRole('header', { name: 'List options' })).toBeNull()
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(onPress).not.toHaveBeenCalled();
  });

  it('stays open when the sheet itself is pressed, not the scrim', async () => {
    const onPress = jest.fn();
    await render(
      wrap(<MenuHarness title="List options" options={[{ label: 'Rename', onPress }]} />)
    );

    await userEvent.setup({ delay: 0 }).press(screen.getByRole('button', { name: 'trigger' }));
    // The sheet card swallows taps that land on it (it sits inside the scrim),
    // so a miss between two rows must not dismiss the menu. fireEvent bubbles to
    // the nearest ancestor with a press handler — the sheet, not the scrim.
    fireEvent.press(screen.getByRole('header', { name: 'List options' }));

    await new Promise((r) => setTimeout(r, 300));
    expect(screen.getByRole('header', { name: 'List options' })).toBeTruthy();
    expect(onPress).not.toHaveBeenCalled();
  });
});

// --- Prompt ----------------------------------------------------------------

function PromptHarness({
  onSubmit,
  initialValue,
  confirmLabel,
}: {
  onSubmit: (t: string) => void;
  initialValue?: string;
  confirmLabel?: string;
}) {
  const { open, element } = usePrompt();
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="trigger"
        onPress={() =>
          open({
            title: 'Rename list',
            placeholder: 'List name',
            initialValue,
            confirmLabel,
            onSubmit,
          })
        }
      >
        <Text>trigger</Text>
      </Pressable>
      {element}
    </View>
  );
}

describe('usePrompt', () => {
  it('submits the typed text and closes when Save is pressed', async () => {
    const user = userEvent.setup({ delay: 0 });
    const onSubmit = jest.fn();
    await render(wrap(<PromptHarness onSubmit={onSubmit} />));

    await user.press(screen.getByRole('button', { name: 'trigger' }));
    const input = screen.getByLabelText('Rename list', { includeHiddenElements: true });
    await user.type(input, 'Weekly shop');
    await user.press(screen.getByRole('button', { name: 'Save' }));

    expect(onSubmit).toHaveBeenCalledWith('Weekly shop');
    expect(
      screen.queryByLabelText('Rename list', { includeHiddenElements: true })
    ).toBeNull();
  });

  it('submits via the keyboard return (onSubmitEditing)', async () => {
    const user = userEvent.setup({ delay: 0 });
    const onSubmit = jest.fn();
    await render(
      wrap(<PromptHarness onSubmit={onSubmit} initialValue="Pantry" />)
    );

    await user.press(screen.getByRole('button', { name: 'trigger' }));
    const input = screen.getByLabelText('Rename list', { includeHiddenElements: true });
    await user.type(input, ' run', { submitEditing: true });

    expect(onSubmit).toHaveBeenCalledWith('Pantry run');
  });

  it('closes without submitting when Cancel is pressed', async () => {
    const user = userEvent.setup({ delay: 0 });
    const onSubmit = jest.fn();
    await render(
      wrap(<PromptHarness onSubmit={onSubmit} initialValue="Keep me" />)
    );

    await user.press(screen.getByRole('button', { name: 'trigger' }));
    // Two buttons carry the Cancel label (scrim + ghost) — pressing either closes.
    await user.press(screen.getAllByRole('button', { name: 'Cancel' })[0]);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(
      screen.queryByLabelText('Rename list', { includeHiddenElements: true })
    ).toBeNull();
  });

  it('closes without submitting when the in-card Cancel is pressed', async () => {
    const user = userEvent.setup({ delay: 0 });
    const onSubmit = jest.fn();
    await render(wrap(<PromptHarness onSubmit={onSubmit} initialValue="Keep me" />));

    await user.press(screen.getByRole('button', { name: 'trigger' }));
    // Index 0 is the scrim (covered above); index 1 is the ghost button in the
    // card — the one a user actually aims at. Both must abandon the edit.
    await user.press(screen.getAllByRole('button', { name: 'Cancel' })[1]);

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Rename list', { includeHiddenElements: true })).toBeNull();
  });

  it('stays open when the card itself is pressed, not the scrim', async () => {
    const user = userEvent.setup({ delay: 0 });
    const onSubmit = jest.fn();
    await render(wrap(<PromptHarness onSubmit={onSubmit} initialValue="Keep me" />));

    await user.press(screen.getByRole('button', { name: 'trigger' }));
    // Tapping inside the card (here, its title) must not throw away the edit.
    fireEvent.press(screen.getByRole('header', { name: 'Rename list' }));

    await new Promise((r) => setTimeout(r, 300));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(
      screen.getByLabelText('Rename list', { includeHiddenElements: true })
    ).toBeTruthy();
  });

  it('uses a custom confirm label when provided', async () => {
    const user = userEvent.setup({ delay: 0 });
    const onSubmit = jest.fn();
    await render(
      wrap(
        <PromptHarness
          onSubmit={onSubmit}
          initialValue="x"
          confirmLabel="Create"
        />
      )
    );

    await user.press(screen.getByRole('button', { name: 'trigger' }));
    await user.press(screen.getByRole('button', { name: 'Create' }));
    expect(onSubmit).toHaveBeenCalledWith('x');
  });
});

// --- Confirm ---------------------------------------------------------------

function ConfirmHarness({
  onConfirm,
  confirmLabel,
  destructive,
}: {
  onConfirm: () => void;
  confirmLabel?: string;
  destructive?: boolean;
}) {
  const { open, element } = useConfirm();
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="trigger"
        onPress={() =>
          open({
            title: 'Delete this list?',
            message: 'This cannot be undone.',
            confirmLabel,
            destructive,
            onConfirm,
          })
        }
      >
        <Text>trigger</Text>
      </Pressable>
      {element}
    </View>
  );
}

describe('useConfirm', () => {
  it('fires onConfirm and closes when the confirm button is pressed', async () => {
    const user = userEvent.setup({ delay: 0 });
    const onConfirm = jest.fn();
    await render(wrap(<ConfirmHarness onConfirm={onConfirm} />));

    await user.press(screen.getByRole('button', { name: 'trigger' }));
    expect(
      screen.getByRole('header', { name: 'Delete this list?' })
    ).toBeTruthy();

    // Default confirm label is "Confirm".
    await user.press(screen.getByRole('button', { name: 'Confirm' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('header', { name: 'Delete this list?' })).toBeNull();
  });

  it('closes without confirming when Cancel is pressed', async () => {
    const user = userEvent.setup({ delay: 0 });
    const onConfirm = jest.fn();
    await render(wrap(<ConfirmHarness onConfirm={onConfirm} />));

    await user.press(screen.getByRole('button', { name: 'trigger' }));
    // Two buttons carry the Cancel label (scrim + ghost) — pressing either closes.
    await user.press(screen.getAllByRole('button', { name: 'Cancel' })[0]);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByRole('header', { name: 'Delete this list?' })).toBeNull();
  });

  it('closes without confirming when the in-card Cancel is pressed', async () => {
    const user = userEvent.setup({ delay: 0 });
    const onConfirm = jest.fn();
    await render(wrap(<ConfirmHarness onConfirm={onConfirm} />));

    await user.press(screen.getByRole('button', { name: 'trigger' }));
    // Index 0 is the scrim (covered above); index 1 is the ghost button in the
    // card — the deliberate "no" a user aims at on a destructive confirm.
    await user.press(screen.getAllByRole('button', { name: 'Cancel' })[1]);

    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByRole('header', { name: 'Delete this list?' })).toBeNull();
  });

  it('stays open when the card itself is pressed, not the scrim', async () => {
    const user = userEvent.setup({ delay: 0 });
    const onConfirm = jest.fn();
    await render(wrap(<ConfirmHarness onConfirm={onConfirm} />));

    await user.press(screen.getByRole('button', { name: 'trigger' }));
    // A tap that lands on the card must neither confirm nor dismiss — the
    // decision stays with the user.
    fireEvent.press(screen.getByRole('header', { name: 'Delete this list?' }));

    await new Promise((r) => setTimeout(r, 300));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole('header', { name: 'Delete this list?' })).toBeTruthy();
  });

  it('uses a custom confirm label on a destructive confirm', async () => {
    const user = userEvent.setup({ delay: 0 });
    const onConfirm = jest.fn();
    await render(
      wrap(
        <ConfirmHarness onConfirm={onConfirm} confirmLabel="Remove aisle" destructive />
      )
    );

    await user.press(screen.getByRole('button', { name: 'trigger' }));
    await user.press(screen.getByRole('button', { name: 'Remove aisle' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
