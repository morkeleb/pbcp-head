// A placeholder screen on the foundation: what it shows arrives as values from the store's observation, on the main actor.

import PBCPStore
import SwiftUI

@MainActor @Observable
final class RootModel {
  var waiting = 0

  /// Follows the outbox's count; the store hands back an Int, never a handle on the database.
  func follow(_ store: Store) async {
    do {
      for try await n in store.observeWaitingCount() { waiting = n }
    } catch {}
  }
}

struct RootView: View {
  @Environment(\.services) private var services
  @State private var model = RootModel()

  var body: some View {
    VStack(spacing: 8) {
      Text("Brief").font(.largeTitle)
      if services == nil {
        Text("Not connected to a head yet.").foregroundStyle(.secondary)
      } else if model.waiting > 0 {
        Text("\(model.waiting) changes waiting to send").foregroundStyle(.secondary)
      }
    }
    .task {
      if let store = services?.store { await model.follow(store) }
    }
  }
}
