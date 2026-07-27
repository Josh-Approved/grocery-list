// KNOWN-BAD FIXTURE — do not "fix" this. See ../README.md.
//
// Trips: review-prompt/wired.
//
// The whole per-app wiring of the review prompt is ONE prop, and this file
// omits it: <AppShell> gets no `review={{ appName, iosAppStoreId,
// androidPackageName }}`, so the shell never counts a session and the synced
// src/storage/reviewPrompt.ts is dead weight in the binary. The `review` prop is
// optional by design (an app may genuinely not ship the module), so nothing but
// this rule can catch the omission.
import React from 'react';
import { AppShell } from './src/shell/AppShell';
import { Screen } from './src/Bad';

export default function App() {
  return (
    <AppShell ready={true}>
      <Screen />
    </AppShell>
  );
}
