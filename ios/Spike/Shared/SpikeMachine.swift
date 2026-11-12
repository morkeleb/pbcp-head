// THROWAWAY. A tiny in-memory briefing, not the real machine (docs/briefing-machine.md; its package is a later PR): it
// only produces the next spoken line for each event and logs every event it received. States: opening, item(i), close.

import Foundation
import PBCPModels

enum SpikeEvent: String, Codable, Sendable, CaseIterable {
  case approve, reject, done, next, later, stop, `repeat`, unknown
}

/// Where the tester says they are speaking from: iOS does not tell an intent which surface invoked it.
enum SpikeSurface: String, Codable, Sendable, CaseIterable {
  case foreground = "foreground"
  case backgroundLiveActivity = "background + Live Activity"
  case siriApp = "Siri app"
}

enum SpikeState: Codable, Sendable, Equatable {
  case opening
  case item(Int)
  case close

  var label: String {
    switch self {
    case .opening: "opening"
    case .item(let i): "item(\(i))"
    case .close: "close"
    }
  }
}

struct SpikeLogEntry: Codable, Sendable, Identifiable, Equatable {
  var id = UUID()
  var at: Date
  var intent: String
  var event: String
  var text: String?
  var named: String?
  var surface: SpikeSurface
  var appInForeground: Bool
  var liveActivity: Bool
  var before: String
  var after: String
  var spoken: String
}

/// The briefing, the surface the tester chose, and the log, kept on disk so a relaunch from Siri finds them.
actor SpikeBriefing {
  private(set) var items: [MeCard]
  private(set) var state: SpikeState = .opening
  private(set) var paused = false
  private(set) var surface: SpikeSurface = .foreground
  private(set) var log: [SpikeLogEntry] = []
  private let file: URL

  init(items: [MeCard], directory: URL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]) {
    self.items = items
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    file = directory.appending(path: "spike-briefing.json")
    if let data = try? Data(contentsOf: file), let saved = try? JSONDecoder().decode(Saved.self, from: data) {
      state = saved.state
      paused = saved.paused
      surface = saved.surface
      log = saved.log
    }
  }

  private struct Saved: Codable {
    var state: SpikeState
    var paused: Bool
    var surface: SpikeSurface
    var log: [SpikeLogEntry]
  }

  private func save() {
    if let data = try? JSONEncoder().encode(Saved(state: state, paused: paused, surface: surface, log: log)) { try? data.write(to: file) }
  }

  func setSurface(_ s: SpikeSurface) {
    surface = s
    save()
  }

  func clearLog() {
    log = []
    save()
  }

  var position: (index: Int, of: Int)? {
    if case .item(let i) = state { return (i, items.count) }
    return nil
  }

  var current: MeCard? { position.map { items[$0.index] } }

  /// "Brief me": starts afresh, or picks up where a stop left it.
  func start(intent: String, appInForeground: Bool, liveActivity: Bool) -> String {
    let before = state.label
    let line: String
    if paused, case .item(let i) = state {
      paused = false
      line = "Picking up at item \(i + 1) of \(items.count). " + prompt(i)
    } else {
      state = .item(0)
      paused = false
      line = "Three things: two decisions and a task. First, " + prompt(0)
    }
    record(intent: intent, event: "start", text: nil, named: nil, appInForeground: appInForeground, liveActivity: liveActivity, before: before, line: line)
    return line
  }

  /// One reply. `position` (1-based) and `named` pick another item ("the second one is done", "approve the reply to Anna").
  func reply(_ event: SpikeEvent, text: String?, position: Int?, named: String?, intent: String, appInForeground: Bool, liveActivity: Bool) -> String {
    let before = state.label
    let line = step(event, position: position, named: named)
    record(intent: intent, event: event.rawValue, text: text, named: named, appInForeground: appInForeground, liveActivity: liveActivity, before: before, line: line)
    return line
  }

  private func step(_ event: SpikeEvent, position: Int?, named: String?) -> String {
    guard case .item(var i) = state, !paused else {
      return state == .close ? "The briefing is over. Say brief me to start again." : "No briefing is running. Say brief me in Brief spike."
    }
    if let named, let j = items.firstIndex(where: { $0.id == named }) { i = j }
    else if let position, (1...items.count).contains(position) { i = position - 1 }
    let card = items[i]
    switch event {
    case .approve, .reject:
      guard card.kind == .decision else { return "That one's a task: done, or later?" }
      return advance(from: i, said: event == .approve ? "Approved." : "Rejected.")
    case .done:
      guard card.kind == .task else { return "That one's a decision: " + SpikeItems.options(card) }
      return advance(from: i, said: "Ticked.")
    case .later: return advance(from: i, said: "Snoozed till tomorrow.")
    case .next: return advance(from: i, said: "Skipped.")
    case .repeat: return prompt(i)
    case .stop:
      paused = true
      return "Stopped at item \(i + 1) of \(items.count). Say brief me to pick up."
    case .unknown: return "I didn't catch that. \(card.title): " + SpikeItems.options(card)
    }
  }

  private func advance(from i: Int, said: String) -> String {
    if i + 1 < items.count {
      state = .item(i + 1)
      return "\(said) Next, " + prompt(i + 1)
    }
    state = .close
    return "\(said) That's everything."
  }

  private func prompt(_ i: Int) -> String {
    let c = items[i]
    return "\(c.kind == .task ? "a task" : "a decision") from \(c.producer): \(c.title). \(SpikeItems.options(c).prefix(1).uppercased() + SpikeItems.options(c).dropFirst())"
  }

  private func record(intent: String, event: String, text: String?, named: String?, appInForeground: Bool, liveActivity: Bool, before: String, line: String) {
    log.append(SpikeLogEntry(at: .now, intent: intent, event: event, text: text, named: named, surface: surface, appInForeground: appInForeground, liveActivity: liveActivity, before: before, after: paused ? "\(state.label) (paused)" : state.label, spoken: line))
    save()
  }

  /// The log as text, for the share sheet and for pasting into FINDING.md.
  func logText() -> String {
    let f = Date.ISO8601FormatStyle().time(includingFractionalSeconds: true)
    return log.map { e in
      "\(e.at.formatted(f))\t\(e.surface.rawValue)\tfg=\(e.appInForeground)\tLA=\(e.liveActivity)\t\(e.intent)\t\(e.event)\(e.text.map { " \"\($0)\"" } ?? "")\(e.named.map { " [\($0)]" } ?? "")\t\(e.before)→\(e.after)\t\(e.spoken)"
    }.joined(separator: "\n")
  }
}
