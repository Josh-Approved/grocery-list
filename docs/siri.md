# Siri "add an item" (iOS)

Say *"Add to Grocery List"* to Siri and it adds an item to your list — no
tapping, no opening the app. This is an iOS-only feature; see **Platform scope**
below for why, and the plan for Android.

## What the user gets

You invoke the action, and Siri asks what to add:

- *"Add to Grocery List"* → Siri: *"What would you like to add?"* → *"milk"* →
  added.

Why the two beats: an **App Shortcut spoken phrase can't contain a free-text
value** — Apple's App Intents compiler only allows the app name and at most one
*entity* parameter in a phrase, never an arbitrary String. So the item can't be
in the phrase; Siri prompts for it. (A user who wants a true one-breath *"Add
milk…"* can still record their own phrase in the Shortcuts app.)

Which list it lands on:

- **One list:** it just goes there.
- **Several lists:**
  - Name one in the phrase (the list IS an entity, so this is allowed):
    *"Add to Cabin in Grocery List"* → Cabin, then Siri asks the item.
  - Don't name one: it goes to the **default list** you pick in Settings → Siri.
  - No default set: Siri asks *"Which list?"*.

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
  ("Add to Cabin in Grocery List") relies on Siri having indexed the list
  entities; iOS re-indexes periodically and on app foreground. The
  **default-list path works immediately** and doesn't depend on indexing.
- **Open the app once after installing.** App Shortcuts index (and the lists
  sync to the App Group) when the app first *runs*, not merely when it installs.
  Fresh installs are voice-enabled by default.
- **"Grocery list" is Apple Reminders' territory.** Saying *"Add milk to grocery
  list"* (item embedded, Reminders' canonical phrasing) routes to Reminders, not
  this app. The invoking phrase is *"Add to Grocery List"* → Siri asks the item.
  If this collision ever proves too costly, the fix is distinct Siri invocation
  names (`INAlternativeAppNames`) — not yet needed (device-verified 2026-07-15).

## Testing

`drain.ts` is pure and unit-tested (`src/siri/__tests__/drain.test.ts`). The
native path can only be verified on a real device (Siri does not run in the
Simulator): install via TestFlight, then speak the phrases and confirm the item
appears after reopening the app.

**Verified on device 2026-07-15** (TestFlight 1.0.7 build 44): *"Add to Grocery
List"* → Siri prompts for the item → it lands on the list. **Gotcha found:**
upgrading over an older build that lacked App Intents can leave the app's Siri
toggle stale/off (Shortcuts app → the shortcut → Siri), so voice does nothing
until toggled on — but a **clean install is voice-enabled by default** and needs
no settings change. So test Siri with a delete-and-reinstall, never an upgrade,
or you'll chase a phantom "it doesn't work."
