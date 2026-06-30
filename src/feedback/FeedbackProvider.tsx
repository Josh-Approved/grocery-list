/**
 * Feedback context — exposes `useFeedback().open()` to the whole app and hosts the
 * single FeedbackSheet, mounted once by AppShell. The main-screen footer and the
 * Settings/About row both call `open()` so there is one canonical flow, not two.
 *
 * Also the one place that installs on-device diagnostics capture (console + crash
 * breadcrumbs into the bounded, scrubbed buffer) — once, at app root.
 *
 * Canonical, app-agnostic — synced by `sync.mjs app-shell`; do not fork.
 */

import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { FeedbackSheet } from './FeedbackSheet';
import { installDiagnostics } from './log';
import { sendFeedback, type FeedbackType } from './compose';

type FeedbackApi = {
  /** Open the feedback sheet. Pass a type to skip the picker and land on its form. */
  open: (type?: FeedbackType) => void;
};

// Default (no provider mounted): degrade to a direct general-feedback compose so a
// stray call never crashes. The real value is supplied by FeedbackProvider.
const FeedbackContext = createContext<FeedbackApi>({
  open: (type) => {
    void sendFeedback({ type: type ?? 'general', fields: {}, includeLogs: type === 'bug' });
  },
});

export function useFeedback(): FeedbackApi {
  return useContext(FeedbackContext);
}

export function FeedbackProvider({ children }: { children: React.ReactNode }) {
  const [visible, setVisible] = useState(false);
  const [initialType, setInitialType] = useState<FeedbackType | undefined>(undefined);

  // Start capturing diagnostics as early as the tree mounts (covers everything
  // after app launch; a crash is flushed to disk for the next session).
  useEffect(() => {
    installDiagnostics();
  }, []);

  const api = useMemo<FeedbackApi>(
    () => ({
      open: (type) => {
        setInitialType(type);
        setVisible(true);
      },
    }),
    []
  );

  return (
    <FeedbackContext.Provider value={api}>
      {children}
      <FeedbackSheet
        visible={visible}
        initialType={initialType}
        onClose={() => setVisible(false)}
      />
    </FeedbackContext.Provider>
  );
}
