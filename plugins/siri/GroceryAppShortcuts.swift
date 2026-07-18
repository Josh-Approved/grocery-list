import AppIntents

// Registers the App Shortcut so the user can speak the command straight to
// Siri with zero setup. Injected into the app target.
//
// App Shortcut phrase rules (enforced by the App Intents metadata compiler):
//   - every phrase MUST contain \(.applicationName);
//   - a phrase may embed at most ONE parameter, and it must be an AppEnum or
//     AppEntity — NOT a free-text String. So the item (a free String) can NOT
//     appear in the phrase; Siri asks for it as a follow-up
//     (`requestValueDialog` on the intent's `item` parameter). The list IS an
//     AppEntity, so it can be named in the phrase.
//
// Resulting flow:
//   "Add to Grocery List"            → Siri: "What would you like to add?"
//                                      → resolves to the default / only list.
//   "Add to Cabin in Grocery List"   → Siri asks the item → adds to Cabin.
// Naming a specific list relies on Siri having indexed the list entities; a
// brand-new list may take a short while (or an app relaunch) before it can be
// addressed by name — the default-list path is unaffected.

@available(iOS 16.0, *)
struct GroceryAppShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: AddGroceryItemIntent(),
      phrases: [
        "Add an item to \(.applicationName)",
        "Add to \(.applicationName)",
        "Add something to \(.applicationName)",
        "Add to \(\.$list) in \(.applicationName)",
        "Add an item to my \(\.$list) in \(.applicationName)"
      ],
      shortTitle: "Add item",
      systemImageName: "cart.badge.plus"
    )
  }
}
