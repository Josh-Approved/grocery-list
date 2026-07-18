import Foundation

// Shared App Group store for the Siri add-item integration.
//
// Injected into the app target by `plugins/withSiriIntents.js`. The App Intent
// reads the lists + default choice from here (mirrored in by JS) and appends
// dictated items to the pending queue; the JS side drains that queue into the
// real SQLite store on next launch/foreground.
//
// The keys + JSON shapes MUST stay in lockstep with
// `modules/grocery-siri/ios/GrocerySiriModule.swift` (the JS bridge).
enum SiriStore {
  // Must match the App Group entitlement added by the config plugin AND the
  // group id in GrocerySiriModule.swift.
  static let appGroup = "group.com.joshapproved.grocerylist"

  private static let listsKey = "siri.lists"
  private static let defaultKey = "siri.defaultListId"
  private static let pendingKey = "siri.pending"

  struct ListRef: Codable, Identifiable {
    let id: String
    let name: String
  }

  struct PendingItem: Codable {
    let requestId: String
    let listId: String?
    let name: String
    let addedAt: Double
  }

  private static var defaults: UserDefaults? {
    UserDefaults(suiteName: appGroup)
  }

  static func lists() -> [ListRef] {
    guard
      let raw = defaults?.string(forKey: listsKey),
      let data = raw.data(using: .utf8)
    else { return [] }
    return (try? JSONDecoder().decode([ListRef].self, from: data)) ?? []
  }

  static func defaultListId() -> String? {
    let v = defaults?.string(forKey: defaultKey)
    return (v?.isEmpty == false) ? v : nil
  }

  static func appendPending(name: String, listId: String?) {
    guard let defaults else { return }
    var items = pending()
    items.append(
      PendingItem(
        requestId: UUID().uuidString,
        listId: listId,
        name: name,
        addedAt: Date().timeIntervalSince1970 * 1000
      )
    )
    if let out = try? JSONEncoder().encode(items),
       let str = String(data: out, encoding: .utf8) {
      defaults.set(str, forKey: pendingKey)
    }
  }

  private static func pending() -> [PendingItem] {
    guard
      let raw = defaults?.string(forKey: pendingKey),
      let data = raw.data(using: .utf8)
    else { return [] }
    return (try? JSONDecoder().decode([PendingItem].self, from: data)) ?? []
  }
}
