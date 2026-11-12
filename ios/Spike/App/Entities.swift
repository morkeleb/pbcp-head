// THROWAWAY. The briefing's items as App Intents entities, so a named reply ("approve the reply to Anna") can be tried.
// IndexedEntity: indexed into Spotlight at launch, which is how the preview's Siri finds custom content
// (Apple, "Bringing custom actions and content to Siri": "make your app entities available to Spotlight").

import AppIntents
import CoreSpotlight
import Foundation
import PBCPModels

#if canImport(SiriEvaluations)
// The iOS 27.3 beta SDK: properties carry descriptions, as the preview asks.
struct DecisionEntity: IndexedEntity {
  static let typeDisplayRepresentation: TypeDisplayRepresentation = "Decision"
  static let defaultQuery = DecisionQuery()
  var id: String
  @Property(title: "Title", description: "What the decision is about, as its producer wrote it", indexingKey: \.title) var title: String
  @Property(title: "From", description: "The agent that asks for the decision") var producer: String
  @Property(title: "Options", description: "The answers the decision takes, default first") var options: String
  var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(title)", subtitle: "\(producer)") }
}

struct TaskEntity: IndexedEntity {
  static let typeDisplayRepresentation: TypeDisplayRepresentation = "Task"
  static let defaultQuery = TaskQuery()
  var id: String
  @Property(title: "Title", description: "What has to be done", indexingKey: \.title) var title: String
  @Property(title: "From", description: "The agent that keeps the task") var producer: String
  var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(title)", subtitle: "\(producer)") }
}
#else
struct DecisionEntity: IndexedEntity {
  static let typeDisplayRepresentation: TypeDisplayRepresentation = "Decision"
  static let defaultQuery = DecisionQuery()
  var id: String
  @Property(title: "Title", indexingKey: \.title) var title: String
  @Property(title: "From") var producer: String
  @Property(title: "Options") var options: String
  var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(title)", subtitle: "\(producer)") }
}

struct TaskEntity: IndexedEntity {
  static let typeDisplayRepresentation: TypeDisplayRepresentation = "Task"
  static let defaultQuery = TaskQuery()
  var id: String
  @Property(title: "Title", indexingKey: \.title) var title: String
  @Property(title: "From") var producer: String
  var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(title)", subtitle: "\(producer)") }
}
#endif

extension DecisionEntity {
  init(_ c: MeCard) {
    id = c.id
    title = c.title
    producer = c.producer
    options = SpikeItems.options(c)
  }
}

extension TaskEntity {
  init(_ c: MeCard) {
    id = c.id
    title = c.title
    producer = c.producer
  }
}

struct DecisionQuery: EntityStringQuery {
  @Dependency var briefing: SpikeBriefing
  func all() async -> [DecisionEntity] { await briefing.items.filter { $0.kind == .decision }.map(DecisionEntity.init) }
  func entities(for ids: [String]) async throws -> [DecisionEntity] { await all().filter { ids.contains($0.id) } }
  func entities(matching s: String) async throws -> [DecisionEntity] { await all().filter { $0.title.localizedCaseInsensitiveContains(s) || s.localizedCaseInsensitiveContains($0.title) } }
  func suggestedEntities() async throws -> [DecisionEntity] { await all() }
}

struct TaskQuery: EntityStringQuery {
  @Dependency var briefing: SpikeBriefing
  func all() async -> [TaskEntity] { await briefing.items.filter { $0.kind == .task }.map(TaskEntity.init) }
  func entities(for ids: [String]) async throws -> [TaskEntity] { await all().filter { ids.contains($0.id) } }
  func entities(matching s: String) async throws -> [TaskEntity] { await all().filter { $0.title.localizedCaseInsensitiveContains(s) || s.localizedCaseInsensitiveContains($0.title) } }
  func suggestedEntities() async throws -> [TaskEntity] { await all() }
}

enum SpikeIndex {
  /// The three items into Spotlight, so Siri can find them by name.
  static func index(_ items: [MeCard]) async {
    try? await CSSearchableIndex.default().indexAppEntities(items.filter { $0.kind == .decision }.map(DecisionEntity.init))
    try? await CSSearchableIndex.default().indexAppEntities(items.filter { $0.kind == .task }.map(TaskEntity.init))
  }
}
