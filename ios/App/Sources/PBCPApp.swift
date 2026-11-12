// The app's foundation (ios/README.md): three actors and no singletons (Store, HeadClient, Outbox, with the Sync task
// beside them), made once at launch and handed to views through the SwiftUI environment, so previews and tests inject
// fakes. No screens yet: the Brief, Card and Orders screens build on this (docs/superpowers/specs/2026-11-10-ios-secretary-design.md).

import BackgroundTasks
import Network
import PBCPClient
import PBCPModels
import PBCPStore
import PBCPSync
import SwiftUI

@main
struct PBCPApp: App {
  @Environment(\.scenePhase) private var phase
  private let services = Services.launch()
  private let network = NetworkWatch()

  var body: some Scene {
    WindowGroup {
      RootView()
        .environment(\.services, services)
        .task { await network.onReturn { await services?.sync.sync() } }
    }
    .onChange(of: phase) { _, now in
      // On launch and every return to the foreground: send what waits, then sync (which drains again once it reached
      // the head). Going to the background asks for the next refresh.
      guard let services else { return }
      if now == .active {
        Task {
          await services.outbox.drain()
          await services.sync.sync()
        }
      } else if now == .background {
        BackgroundRefresh.schedule()
      }
    }
    .backgroundTask(.appRefresh(BackgroundRefresh.id)) {
      BackgroundRefresh.schedule()
      await services?.sync.sync()
    }
  }
}

/// Background refresh: the system wakes the app now and then to sync, so the brief is current when it opens.
enum BackgroundRefresh {
  static let id = "app.pbcp.sync"

  static func schedule() {
    let request = BGAppRefreshTaskRequest(identifier: id)
    request.earliestBeginDate = Date(timeIntervalSinceNow: 30 * 60)
    try? BGTaskScheduler.shared.submit(request)
  }
}

/// What a view may reach: actors, which only ever hand back Sendable values.
struct Services: Sendable {
  let store: Store
  let client: HeadClient
  let outbox: Outbox
  let sync: Sync

  /// The device's store and the head it is connected to; nil until a head is chosen (onboarding is a later step).
  static func launch() -> Services? {
    guard let head = UserDefaults.standard.string(forKey: "head_url").flatMap(URL.init(string:)) else { return nil }
    do {
      let dir = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
      let store = try Store(path: dir.appending(path: "pbcp.sqlite").path)
      let client = HeadClient(base: head, tokens: KeychainTokens())
      let outbox = Outbox(store: store, head: client)
      return Services(store: store, client: client, outbox: outbox, sync: Sync(store: store, head: client, outbox: outbox))
    } catch {
      return nil
    }
  }
}

extension EnvironmentValues {
  @Entry var services: Services? = nil
}

/// Tells the app when the network comes back, so what waits in the outbox goes.
final class NetworkWatch: Sendable {
  private let monitor = NWPathMonitor()

  func onReturn(_ action: @escaping @Sendable () async -> Void) async {
    let paths = AsyncStream<NWPath.Status> { continuation in
      monitor.pathUpdateHandler = { continuation.yield($0.status) }
      monitor.start(queue: DispatchQueue(label: "pbcp.network"))
    }
    var last: NWPath.Status?
    for await status in paths {
      if status == .satisfied, last != .satisfied, last != nil { await action() }
      last = status
    }
  }
}
