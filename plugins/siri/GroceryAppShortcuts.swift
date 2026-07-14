import AppIntents

// Registers the App Shortcut so the user can speak the command straight to
// Siri with zero setup. Every phrase MUST contain \(.applicationName) or the
// shortcut silently fails to register. Injected into the app target.
//
// The default-list path ("Add milk to Grocery List") works the moment the app
// is installed. Naming a specific list ("Add milk to Cabin") relies on Siri
// having indexed the list entities; a brand-new list may take a short while
// (or an app relaunch) before it can be addressed by name — the default path
// is unaffected.

@available(iOS 16.0, *)
struct GroceryAppShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: AddGroceryItemIntent(),
      phrases: [
        "Add \(\.$item) to \(.applicationName)",
        "Add \(\.$item) to my \(.applicationName)",
        "Add \(\.$item) to \(\.$list) in \(.applicationName)",
        "Add \(\.$item) to my \(\.$list) list in \(.applicationName)",
        "Put \(\.$item) on \(.applicationName)"
      ],
      shortTitle: "Add item",
      systemImageName: "cart.badge.plus"
    )
  }
}
