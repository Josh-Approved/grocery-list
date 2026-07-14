import AppIntents

// The Siri "add an item" action. Injected into the app target so the App
// Intents metadata processor indexes it and Siri can invoke it directly.
//
// Resolution mirrors the CX we settled on:
//   1. a list named out loud ("add milk to Cabin") wins;
//   2. else the user's default list (set in Settings);
//   3. else, if there is exactly one list, that one;
//   4. else Siri asks which list (disambiguation).
// Runs in the background (openAppWhenRun = false): it appends to the shared
// pending queue and the app drains it on next launch — no UI flash.

@available(iOS 16.0, *)
struct GroceryListEntity: AppEntity {
  let id: String
  let name: String

  static var typeDisplayRepresentation: TypeDisplayRepresentation = "Grocery List"
  var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }

  static var defaultQuery = GroceryListQuery()
}

@available(iOS 16.0, *)
struct GroceryListQuery: EntityQuery {
  func entities(for identifiers: [String]) async throws -> [GroceryListEntity] {
    SiriStore.lists()
      .filter { identifiers.contains($0.id) }
      .map { GroceryListEntity(id: $0.id, name: $0.name) }
  }

  func suggestedEntities() async throws -> [GroceryListEntity] {
    SiriStore.lists().map { GroceryListEntity(id: $0.id, name: $0.name) }
  }
}

@available(iOS 16.0, *)
struct AddGroceryItemIntent: AppIntent {
  static var title: LocalizedStringResource = "Add to Grocery List"
  static var description = IntentDescription("Add an item to one of your grocery lists.")
  static var openAppWhenRun = false

  @Parameter(title: "Item", requestValueDialog: "What would you like to add?")
  var item: String

  @Parameter(title: "List")
  var list: GroceryListEntity?

  static var parameterSummary: some ParameterSummary {
    Summary("Add \(\.$item) to \(\.$list)")
  }

  func perform() async throws -> some IntentResult & ProvidesDialog {
    let name = item.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !name.isEmpty else {
      throw $item.needsValueError("What would you like to add?")
    }

    let lists = SiriStore.lists()
    guard !lists.isEmpty else {
      return .result(
        dialog: "You don't have any grocery lists yet. Open Grocery List to make one."
      )
    }

    let target: SiriStore.ListRef
    if let named = list, let match = lists.first(where: { $0.id == named.id }) {
      target = match
    } else if let defId = SiriStore.defaultListId(),
              let def = lists.first(where: { $0.id == defId }) {
      target = def
    } else if lists.count == 1 {
      target = lists[0]
    } else {
      let choices = lists.map { GroceryListEntity(id: $0.id, name: $0.name) }
      let chosen = try await $list.requestDisambiguation(
        among: choices,
        dialog: "Which list?"
      )
      SiriStore.appendPending(name: name, listId: chosen.id)
      return .result(dialog: "Added \(name) to \(chosen.name).")
    }

    SiriStore.appendPending(name: name, listId: target.id)
    return .result(dialog: "Added \(name) to \(target.name).")
  }
}
