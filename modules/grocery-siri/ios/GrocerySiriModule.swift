import ExpoModulesCore
import Foundation

// JS <-> App Group bridge for the Siri add-item integration.
//
// This module runs inside the app process. It reads and writes the SAME App
// Group container that the App Intent (injected into the app target by
// `plugins/withSiriIntents.js`) uses. The keys + JSON shapes here MUST stay in
// lockstep with `plugins/siri/SiriStore.swift` — they are the wire contract:
//   - "siri.lists"          : JSON string, [{ id, name }]
//   - "siri.defaultListId"  : String (absent = no default)
//   - "siri.pending"        : JSON string, [{ requestId, listId?, name, addedAt }]
//
// The App Group id must match the entitlement added by the config plugin.
private let kAppGroup = "group.com.joshapproved.grocerylist"
private let kListsKey = "siri.lists"
private let kDefaultKey = "siri.defaultListId"
private let kPendingKey = "siri.pending"

private struct PendingItem: Codable {
  let requestId: String
  let listId: String?
  let name: String
  let addedAt: Double
}

public class GrocerySiriModule: Module {
  private var store: UserDefaults? { UserDefaults(suiteName: kAppGroup) }

  public func definition() -> ModuleDefinition {
    Name("GrocerySiri")

    Function("isSupported") { () -> Bool in
      if #available(iOS 16.0, *) {
        return self.store != nil
      }
      return false
    }

    // Mirror the current lists + default-list choice for the App Intent.
    Function("syncLists") { (listsJson: String, defaultListId: String?) in
      guard let store = self.store else { return }
      store.set(listsJson, forKey: kListsKey)
      if let def = defaultListId, !def.isEmpty {
        store.set(def, forKey: kDefaultKey)
      } else {
        store.removeObject(forKey: kDefaultKey)
      }
    }

    // Raw pending queue, as the App Intent wrote it. "[]" when empty.
    Function("getPendingItems") { () -> String in
      self.store?.string(forKey: kPendingKey) ?? "[]"
    }

    // Drop the drained requests from the queue.
    Function("clearPendingItems") { (requestIds: [String]) in
      guard let store = self.store else { return }
      guard
        let raw = store.string(forKey: kPendingKey),
        let data = raw.data(using: .utf8),
        let items = try? JSONDecoder().decode([PendingItem].self, from: data)
      else { return }
      let drop = Set(requestIds)
      let remaining = items.filter { !drop.contains($0.requestId) }
      if let out = try? JSONEncoder().encode(remaining),
         let str = String(data: out, encoding: .utf8) {
        store.set(str, forKey: kPendingKey)
      }
    }
  }
}
