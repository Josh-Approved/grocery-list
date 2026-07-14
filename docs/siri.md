# Siri "add an item" (iOS)

Say *"Add milk to Grocery List"* to Siri and the item lands on your list — no
tapping, no opening the app. This is an iOS-only feature; see **Platform scope**
below for why, and the plan for Android.

## What the user gets

- **One list:** *"Add milk to Grocery List"* adds to it. Done.
- **Several lists:**
  - Name one: *"Add milk to Cabin"* → goes to Cabin.
  - Don't name one: it goes to the **default list** you pick in Settings → Siri.
  - No default set: Siri asks *"Which list?"* and you say the name.

Everything stays local and private — the item is written to the same on-device
store as a hand-typed one, and rides the normal shared-list sync.

## How it works

Siri App Intents run in a background process **separate from the React Native
app**, so they can't call our JS store directly. The two sides talk through a
shared **App Group** container:

```
 Siri ──► AddGroceryItemIntent (Swift, app target)
            │  resolves the target list, appends the item
            ▼
      App Group  (group.com.joshapproved.grocerylist)
        • siri.lists         ← JS mirrors the current lists here
        • siri.defaultListId ← JS mirrors the Settings choice here
        • siri.pending       → the queue of dictated items
            ▲                          │
            │ push (on change)         │ drain (on launch/foreground)
      React Native app (src/siri/*) ───┘  → useListsStore.addItem(...)
```

- **Native, in the app target** (`plugins/siri/*.swift`, injected at prebuild by
  `plugins/withSiriIntents.js`): `AddGroceryItemIntent` + `GroceryListEntity`
  (so a list can be named out loud) + `GroceryAppShortcuts` (the spoken-phrase
  registration). App Shortcuts **must** live in the app target for Siri to
  recognise them with zero setup, which is why they're injected rather than
  shipped in a Pod. `SiriStore.swift` is the App Group accessor.
- **Native bridge** (`modules/grocery-siri`): a small autolinked Expo module so
  JS can read/write the same App Group container. iOS-only; absent everywhere
  else.
- **JS** (`src/siri/`): `native.ts` (the bridge, no-ops off iOS), `drain.ts`
  (pure, unit-tested list-resolution + de-dup), `defaultList.ts` (the Settings
  pref), `index.ts` (wires it to `useListsStore` and the app lifecycle in
  `App.tsx`). The Settings control is `src/components/SiriSetting.tsx`.

Because the intent runs while the app is closed, a Siri-added item appears in
the UI on the **next launch or foreground** (when the queue is drained), not
instantly. That's inherent to the background-intent design and is fine for a
grocery list.

## Platform scope

**iOS only, by an explicit product decision (2026-07-14).** This is a recorded
exception to the studio's cross-platform functional-parity rule, made knowingly:
there is no shippable Android equivalent in 2026. Google has replaced Assistant
(which powered App Actions) with Gemini, which does not honour App Actions; its
successor, **AppFunctions**, is Android-16-only, in private preview, and has no
React Native path. So a parity Android voice-add cannot be built today.

**Android is deferred, not dropped.** When AppFunctions (or an equivalent) opens
to third-party apps with a usable React Native path, the same "add an item via
voice" belongs on Android too. The JS core here (`drain.ts`, `defaultList.ts`,
the store seam) is platform-neutral and is meant to be reused; only the native
assistant layer would be new.

## Known v1 limitations

- **Spoken phrases are English only.** `GroceryAppShortcuts` registers English
  phrases; a non-English Siri may not match them yet. Localising the phrase set
  (App Shortcut string catalogs) is a follow-up. The Settings copy is translated
  in all six locales regardless.
- **A brand-new list may take a moment to be sayable by name.** Naming a list
  ("Add milk to Cabin") relies on Siri having indexed the list entities; iOS
  re-indexes periodically and on app foreground. The **default-list path works
  immediately** and doesn't depend on indexing.

## Testing

`drain.ts` is pure and unit-tested (`src/siri/__tests__/drain.test.ts`). The
native path can only be verified on a real device (Siri does not run in the
Simulator): install via TestFlight, then speak the phrases and confirm the item
appears after reopening the app.
