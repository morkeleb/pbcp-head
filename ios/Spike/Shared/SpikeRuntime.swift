// THROWAWAY. What the intents share: whether the app is in the foreground when an intent runs, and the Live Activity.

import ActivityKit
import Foundation
#if canImport(UIKit) && !WIDGET_EXTENSION
import UIKit
#endif

enum SpikeRuntime {
  @MainActor static func appInForegroundOnMain() -> Bool {
    #if canImport(UIKit) && !WIDGET_EXTENSION
    UIApplication.shared.applicationState == .active
    #else
    false
    #endif
  }

  static func appInForeground() async -> Bool { await appInForegroundOnMain() }

  static var liveActivityActive: Bool { !Activity<BriefingAttributes>.activities.isEmpty }

  /// Starts the Live Activity, or updates it to the briefing's position; ends it when the briefing closed or stopped.
  static func update(_ briefing: SpikeBriefing, line: String) async {
    let position = await briefing.position
    let paused = await briefing.paused
    let current = await briefing.current
    guard let position, let current, !paused else {
      for a in Activity<BriefingAttributes>.activities { await a.end(nil, dismissalPolicy: .immediate) }
      return
    }
    let state = BriefingAttributes.ContentState(label: "\(current.kind == .task ? "Task" : "Decision") \(position.index + 1) of \(position.of)", title: current.title, lastLine: line)
    if let a = Activity<BriefingAttributes>.activities.first {
      await a.update(ActivityContent(state: state, staleDate: nil))
    } else {
      _ = try? Activity.request(attributes: BriefingAttributes(), content: ActivityContent(state: state, staleDate: nil))
    }
  }

  static func endActivity() async {
    for a in Activity<BriefingAttributes>.activities { await a.end(nil, dismissalPolicy: .immediate) }
  }
}
