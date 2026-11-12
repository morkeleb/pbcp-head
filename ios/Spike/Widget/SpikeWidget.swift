// THROWAWAY. The Live Activity a running briefing shows, with buttons that answer the current item.

import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

@main
struct SpikeWidgets: WidgetBundle {
  var body: some Widget { BriefingLiveActivity() }
}

struct BriefingLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: BriefingAttributes.self) { context in
      VStack(alignment: .leading, spacing: 6) {
        Text(context.state.label).font(.caption).foregroundStyle(.secondary)
        Text(context.state.title).font(.headline)
        Text(context.state.lastLine).font(.caption).lineLimit(2)
        HStack {
          Button(intent: LiveActivityReplyIntent(.approve)) { Text("Approve") }
          Button(intent: LiveActivityReplyIntent(.done)) { Text("Done") }
          Button(intent: LiveActivityReplyIntent(.next)) { Text("Next") }
          Button(intent: LiveActivityReplyIntent(.stop)) { Text("Stop") }
        }
        .buttonStyle(.bordered)
        .font(.caption)
      }
      .padding()
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) { Text(context.state.label).font(.caption) }
        DynamicIslandExpandedRegion(.bottom) { Text(context.state.title).font(.caption) }
      } compactLeading: {
        Image(systemName: "text.bubble")
      } compactTrailing: {
        Text(context.state.label.components(separatedBy: " ").suffix(3).joined(separator: " ")).font(.caption2)
      } minimal: {
        Image(systemName: "text.bubble")
      }
    }
  }
}
