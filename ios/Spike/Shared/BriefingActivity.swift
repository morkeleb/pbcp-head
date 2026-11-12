// THROWAWAY. The Live Activity a running briefing shows ("Decision 1 of 3"), and the buttons on it, which reach the
// same briefing as Siri does (LiveActivityIntent runs in the app's process).

import ActivityKit
import AppIntents
import Foundation

struct BriefingAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable {
    var label: String // "Decision 1 of 3"
    var title: String
    var lastLine: String
  }
}

/// A Live Activity button: one event for the current item.
struct LiveActivityReplyIntent: LiveActivityIntent {
  static let title: LocalizedStringResource = "Reply from the Live Activity"
  static let isDiscoverable = false

  @Parameter(title: "Event") var event: String

  init() {}
  init(_ event: SpikeEvent) { self.event = event.rawValue }

  @Dependency var briefing: SpikeBriefing

  func perform() async throws -> some IntentResult {
    let fg = await SpikeRuntime.appInForeground()
    let line = await briefing.reply(SpikeEvent(rawValue: event) ?? .unknown, text: nil, position: nil, named: nil, intent: "LiveActivityButton", appInForeground: fg, liveActivity: true)
    await SpikeRuntime.update(briefing, line: line)
    return .result()
  }
}
