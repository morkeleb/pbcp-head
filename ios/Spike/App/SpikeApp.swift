// THROWAWAY (ios/Spike; deleted when FINDING.md is written). The spike's one screen: pick the surface you are about to
// speak from, start a briefing, watch every event Siri delivered, and share the log as text.

import ActivityKit
import AppIntents
import SwiftUI

@main
struct SpikeApp: App {
  private let briefing: SpikeBriefing

  init() {
    let briefing = SpikeBriefing(items: SpikeItems.load())
    self.briefing = briefing
    // App Intents' own dependency container: the intents, the queries and the Live Activity buttons get the briefing
    // from here, in whichever process launch Siri started.
    AppDependencyManager.shared.add(dependency: briefing)
  }

  var body: some Scene {
    WindowGroup {
      SpikeView(briefing: briefing)
        .task { await SpikeIndex.index(await briefing.items) }
    }
  }
}

@MainActor @Observable
final class SpikeModel {
  var surface: SpikeSurface = .foreground
  var state = ""
  var log: [SpikeLogEntry] = []
  var text = ""

  func refresh(_ b: SpikeBriefing) async {
    surface = await b.surface
    let paused = await b.paused
    state = await b.state.label + (paused ? " (paused)" : "")
    log = await b.log.reversed()
    text = await b.logText()
  }
}

struct SpikeView: View {
  let briefing: SpikeBriefing
  @State private var model = SpikeModel()
  @Environment(\.scenePhase) private var phase

  var body: some View {
    NavigationStack {
      List {
        Section("You are about to speak from") {
          Picker("Surface", selection: Binding(get: { model.surface }, set: { s in Task { await briefing.setSurface(s); await model.refresh(briefing) } })) {
            ForEach(SpikeSurface.allCases, id: \.self) { Text($0.rawValue) }
          }
          .pickerStyle(.segmented)
        }
        Section("Briefing: \(model.state)") {
          Button("Start briefing here") {
            Task {
              let line = await briefing.start(intent: "button", appInForeground: true, liveActivity: SpikeRuntime.liveActivityActive)
              await SpikeRuntime.update(briefing, line: line)
              await model.refresh(briefing)
            }
          }
          Button("End the Live Activity", role: .destructive) { Task { await SpikeRuntime.endActivity() } }
        }
        Section("Log, newest first") {
          ForEach(model.log) { e in
            VStack(alignment: .leading, spacing: 2) {
              Text("\(e.at.formatted(date: .omitted, time: .standard)) · \(e.surface.rawValue) · \(e.appInForeground ? "fg" : "bg")\(e.liveActivity ? " · LA" : "")").font(.caption).foregroundStyle(.secondary)
              Text("\(e.intent): \(e.event)\(e.text.map { " “\($0)”" } ?? "")\(e.named.map { " [\($0)]" } ?? "")  \(e.before)→\(e.after)").font(.callout)
              Text(e.spoken).font(.caption)
            }
          }
        }
      }
      .navigationTitle("Brief spike")
      .toolbar {
        ShareLink(item: model.text) { Label("Share log", systemImage: "square.and.arrow.up") }
        Button("Clear") { Task { await briefing.clearLog(); await model.refresh(briefing) } }
      }
      .refreshable { await model.refresh(briefing) }
      .task {
        // What Siri did while the app was away shows up here.
        while !Task.isCancelled {
          await model.refresh(briefing)
          try? await Task.sleep(for: .seconds(1))
        }
      }
    }
  }
}
