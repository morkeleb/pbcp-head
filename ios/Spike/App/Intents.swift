// THROWAWAY. The intents the gate measures. Under the iOS 27.3 beta SDK the briefing intents are tools Siri AI can
// call (`@AppIntent(.tool)`, as Apple's "Bringing custom actions and content to Siri" says); under an older SDK they are
// plain app intents, so the spike still builds and its App Shortcuts work with classic Siri. The bodies are shared
// (BriefingReplyBody); only the declarations are written twice, because an attribute cannot be conditional on its own.

import AppIntents
import Foundation

/// The utterance's event. The free-text fallback is the intent's `text` parameter.
enum ReplyEvent: String, AppEnum {
  case approve, reject, done, next, later, stop, `repeat`

  static let typeDisplayRepresentation: TypeDisplayRepresentation = "Briefing reply"
  static let caseDisplayRepresentations: [ReplyEvent: DisplayRepresentation] = [
    .approve: DisplayRepresentation(title: "approve", synonyms: ["yes", "send it", "go ahead"]),
    .reject: DisplayRepresentation(title: "reject", synonyms: ["no", "don't"]),
    .done: DisplayRepresentation(title: "done", synonyms: ["did it", "tick it", "it's done"]),
    .next: DisplayRepresentation(title: "next", synonyms: ["skip", "move on"]),
    .later: DisplayRepresentation(title: "later", synonyms: ["tomorrow", "snooze it"]),
    .stop: DisplayRepresentation(title: "stop", synonyms: ["that's enough", "pause"]),
    .repeat: DisplayRepresentation(title: "repeat", synonyms: ["say that again", "again"]),
  ]

  var spike: SpikeEvent { SpikeEvent(rawValue: rawValue) ?? .unknown }
}

// --- the shared bodies ------------------------------------------------------------------------------------------------

protocol BriefMeBody: AppIntent {
  var briefing: SpikeBriefing { get }
}

extension BriefMeBody {
  func perform() async throws -> some IntentResult & ProvidesDialog {
    let fg = await SpikeRuntime.appInForeground()
    let line = await briefing.start(intent: String(describing: Self.self), appInForeground: fg, liveActivity: SpikeRuntime.liveActivityActive)
    await SpikeRuntime.update(briefing, line: line)
    return .result(dialog: IntentDialog(stringLiteral: line))
  }
}

protocol BriefingReplyBody: AppIntent {
  var event: ReplyEvent? { get }
  var text: String? { get }
  var position: Int? { get }
  var decision: DecisionEntity? { get }
  var task: TaskEntity? { get }
  var briefing: SpikeBriefing { get }
}

extension BriefingReplyBody {
  func perform() async throws -> some IntentResult & ProvidesDialog {
    let fg = await SpikeRuntime.appInForeground()
    let named = decision?.id ?? task?.id
    let line = await briefing.reply(event?.spike ?? .unknown, text: text, position: position, named: named, intent: String(describing: Self.self), appInForeground: fg, liveActivity: SpikeRuntime.liveActivityActive)
    await SpikeRuntime.update(briefing, line: line)
    return .result(dialog: IntentDialog(stringLiteral: line))
  }
}

// --- the declarations -------------------------------------------------------------------------------------------------

#if canImport(SiriEvaluations)
@AppIntent(.tool)
struct BriefMeIntent: BriefMeBody, LiveActivityIntent {
  static let title: LocalizedStringResource = "Brief me"
  static let description = IntentDescription("Starts the spoken briefing, or picks it up where it stopped: reads the first open item and asks for an answer. While it runs, a Live Activity shows the item.")
  @Dependency var briefing: SpikeBriefing
  init() {}
}

@AppIntent(.tool)
struct BriefingReplyIntent: BriefingReplyBody {
  static let title: LocalizedStringResource = "Answer the briefing"
  static let description = IntentDescription("While a briefing is running, answers its current item and returns the next thing to say. Use it for short replies such as approve, reject, done, next, later, repeat or stop, and for a reply that names an item.")
  @Parameter(title: "Reply", description: "The answer: approve, reject, done, next, later, repeat or stop") var event: ReplyEvent?
  @Parameter(title: "What was said", description: "The person's words, when they are none of the replies") var text: String?
  @Parameter(title: "Item number", description: "Which item, counting from 1, when the person names one by position (the second one)") var position: Int?
  @Parameter(title: "Decision", description: "The decision the person names, if any") var decision: DecisionEntity?
  @Parameter(title: "Task", description: "The task the person names, if any") var task: TaskEntity?
  @Dependency var briefing: SpikeBriefing
  init() {}
}

/// The "while locked: read only" run: an approve that needs the device unlocked first.
@AppIntent(.tool)
struct ApproveWithUnlockIntent: BriefingReplyBody {
  static let title: LocalizedStringResource = "Approve, after unlocking"
  static let description = IntentDescription("Approves the briefing's current decision. It needs the person to unlock the device first.")
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
  var event: ReplyEvent? { .approve }
  var text: String? { nil }
  var position: Int? { nil }
  var decision: DecisionEntity? { nil }
  var task: TaskEntity? { nil }
  @Dependency var briefing: SpikeBriefing
  init() {}
}
#else
struct BriefMeIntent: BriefMeBody, LiveActivityIntent {
  static let title: LocalizedStringResource = "Brief me"
  static let description = IntentDescription("Starts the spoken briefing, or picks it up where it stopped: reads the first open item and asks for an answer. While it runs, a Live Activity shows the item.")
  @Dependency var briefing: SpikeBriefing
  init() {}
}

struct BriefingReplyIntent: BriefingReplyBody {
  static let title: LocalizedStringResource = "Answer the briefing"
  static let description = IntentDescription("While a briefing is running, answers its current item and returns the next thing to say. Use it for short replies such as approve, reject, done, next, later, repeat or stop, and for a reply that names an item.")
  @Parameter(title: "Reply") var event: ReplyEvent?
  @Parameter(title: "What was said") var text: String?
  @Parameter(title: "Item number") var position: Int?
  @Parameter(title: "Decision") var decision: DecisionEntity?
  @Parameter(title: "Task") var task: TaskEntity?
  @Dependency var briefing: SpikeBriefing
  init() {}
}

struct ApproveWithUnlockIntent: BriefingReplyBody {
  static let title: LocalizedStringResource = "Approve, after unlocking"
  static let description = IntentDescription("Approves the briefing's current decision. It needs the person to unlock the device first.")
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
  var event: ReplyEvent? { .approve }
  var text: String? { nil }
  var position: Int? { nil }
  var decision: DecisionEntity? { nil }
  var task: TaskEntity? { nil }
  @Dependency var briefing: SpikeBriefing
  init() {}
}
#endif

/// Ends the briefing and its Live Activity. Not a tool: "stop" is the reply intent's to take, so this is reached by its
/// App Shortcut phrase only and the two never compete for the word.
struct StopBriefingIntent: AppIntent {
  static let title: LocalizedStringResource = "Stop the briefing"
  static let description = IntentDescription("Ends the briefing and its Live Activity.")
  @Dependency var briefing: SpikeBriefing
  init() {}

  func perform() async throws -> some IntentResult & ProvidesDialog {
    let fg = await SpikeRuntime.appInForeground()
    let line = await briefing.reply(.stop, text: nil, position: nil, named: nil, intent: "StopBriefingIntent", appInForeground: fg, liveActivity: SpikeRuntime.liveActivityActive)
    await SpikeRuntime.endActivity()
    return .result(dialog: IntentDialog(stringLiteral: line))
  }
}

/// The other candidate the design names: one intent that keeps the turn open by asking for each reply with
/// `requestValue`, instead of relying on Siri to route a new utterance to the reply intent.
struct GuidedBriefingIntent: AppIntent, LiveActivityIntent {
  static let title: LocalizedStringResource = "Brief me step by step"
  static let description = IntentDescription("Runs the whole briefing in one conversation, asking for an answer to each item in turn.")
  @Parameter(title: "Reply") var reply: ReplyEvent?
  @Dependency var briefing: SpikeBriefing
  init() {}

  func perform() async throws -> some IntentResult & ProvidesDialog {
    var line = await briefing.start(intent: "GuidedBriefingIntent", appInForeground: await SpikeRuntime.appInForeground(), liveActivity: SpikeRuntime.liveActivityActive)
    await SpikeRuntime.update(briefing, line: line)
    while await briefing.position != nil, await !briefing.paused {
      let answer = try await $reply.requestValue(IntentDialog(stringLiteral: line))
      line = await briefing.reply(answer.spike, text: nil, position: nil, named: nil, intent: "GuidedBriefingIntent.requestValue", appInForeground: await SpikeRuntime.appInForeground(), liveActivity: SpikeRuntime.liveActivityActive)
      await SpikeRuntime.update(briefing, line: line)
    }
    return .result(dialog: IntentDialog(stringLiteral: line))
  }
}

struct SpikeShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(intent: BriefMeIntent(), phrases: ["Brief me in \(.applicationName)", "Start my briefing in \(.applicationName)"], shortTitle: "Brief me", systemImageName: "text.bubble")
    AppShortcut(intent: GuidedBriefingIntent(), phrases: ["Brief me step by step in \(.applicationName)"], shortTitle: "Step by step", systemImageName: "list.number")
    AppShortcut(intent: StopBriefingIntent(), phrases: ["Stop the briefing in \(.applicationName)"], shortTitle: "Stop", systemImageName: "stop.circle")
    AppShortcut(intent: ApproveWithUnlockIntent(), phrases: ["Approve with unlock in \(.applicationName)"], shortTitle: "Approve (unlock)", systemImageName: "lock")
  }
}
