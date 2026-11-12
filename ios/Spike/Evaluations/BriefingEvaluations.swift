// THROWAWAY. The gate's matrix as Siri Evaluations (iOS 27.3 beta SDK; Apple's "Siri Evaluations" and "SiriService"
// pages): one scenario per surface, the same turns in each, every run recorded in Xcode's evaluation report rather than
// remembered. It needs a device with the Siri AI Developer Preview, Developer Mode, and Settings > Developer > Enable UI
// Automation. It is a UI testing target, as SiriService asks, so `subject(from:)` can put the app in the foreground or
// the background before Siri runs the scenario. Under an older SDK this file compiles to nothing.
//
// The tests record; they do not fail on Siri's choices. The report's per-turn rows (which intent Siri called, with which
// arguments, and what it said) are what goes into FINDING.md.

#if canImport(SiriEvaluations)
import AppIntentsTesting
import Evaluations
import SiriEvaluations
import Testing
import XCTest

private let spike = IntentDefinitions(bundleIdentifier: "software.morten.pbcp.spike")
private let briefMe = spike.intents["BriefMeIntent"]
private let reply = spike.intents["BriefingReplyIntent"]

enum Surface: String, Sendable {
  case foreground = "foreground"
  case background = "background + Live Activity"
  case siriApp = "Siri app"
}

struct BriefingEvaluation: Evaluation {
  let name: String
  let surface: Surface
  let dataset: SiriScenarioLoader

  /// Puts the app where the surface needs it, then runs the scenario through Siri.
  func subject(from sample: SiriScenario) async throws -> SiriScenarioSubject {
    await MainActor.run {
      let app = XCUIApplication(bundleIdentifier: "software.morten.pbcp.spike")
      app.launch()
      app.segmentedControls.buttons[surface.rawValue].tap()
      switch surface {
      case .foreground:
        app.buttons["Start briefing here"].tap()
      case .background:
        app.buttons["Start briefing here"].tap()
        XCUIDevice.shared.press(.home)
      case .siriApp:
        app.terminate()
      }
    }
    return try await SiriService.run(scenario: sample)
  }

  var evaluators: Evaluators { SiriExpectationEvaluator() }

  func aggregateMetrics(using aggregator: inout MetricsAggregator) {
    Self.computeSiriMetrics(into: &aggregator)
  }
}

/// Surface 1: the app in the foreground, the briefing started from its screen.
@Test(.evaluates(BriefingEvaluation(name: "Foreground", surface: .foreground, dataset: SiriScenarioLoader {
  SiriScenario {
    UserTurn("approve") { Calls { reply } }
    UserTurn("next") { Calls { reply } }
    UserTurn("what's the weather") { Calls(.disallowed) { reply } }
    UserTurn("later") { Calls { reply } }
    UserTurn("approve the reply to Anna") { Calls { reply } }
    UserTurn("the second one is done") { Calls { reply } }
    UserTurn("stop") { Calls { reply } }
  }
})))
func foreground() async throws {
  print("Foreground, intents all pass:", EvaluationContext.current.result.aggregateValue(.mean(of: .intentsAllPass)))
}

/// Surface 2: the app in the background, the Live Activity showing.
@Test(.evaluates(BriefingEvaluation(name: "Background with the Live Activity", surface: .background, dataset: SiriScenarioLoader {
  SiriScenario {
    UserTurn("approve") { Calls { reply } }
    UserTurn("next") { Calls { reply } }
    UserTurn("what's the weather") { Calls(.disallowed) { reply } }
    UserTurn("later") { Calls { reply } }
    UserTurn("approve the reply to Anna") { Calls { reply } }
    UserTurn("the second one is done") { Calls { reply } }
    UserTurn("stop") { Calls { reply } }
  }
})))
func backgroundWithLiveActivity() async throws {
  print("Background, intents all pass:", EvaluationContext.current.result.aggregateValue(.mean(of: .intentsAllPass)))
}

/// Surface 3: the conversation in the Siri app, started with the app named.
@Test(.evaluates(BriefingEvaluation(name: "Siri app, after Brief me in Brief spike", surface: .siriApp, dataset: SiriScenarioLoader {
  SiriScenario {
    UserTurn("Brief me in Brief spike") { Calls { briefMe } }
    UserTurn("approve") { Calls { reply } }
    UserTurn("next") { Calls { reply } }
    UserTurn("what's the weather") { Calls(.disallowed) { reply } }
    UserTurn("later") { Calls { reply } }
    UserTurn("approve the reply to Anna") { Calls { reply } }
    UserTurn("the second one is done") { Calls { reply } }
    UserTurn("stop") { Calls { reply } }
  }
})))
func siriApp() async throws {
  print("Siri app, intents all pass:", EvaluationContext.current.result.aggregateValue(.mean(of: .intentsAllPass)))
}
#endif
