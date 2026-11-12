// What the generated store does that is behaviour, not shape (hand-written; the model carries no behaviour):
// the head's sanitised HTML as text, a command laid over a card before the head has it, and a command's body as JSON.

import Foundation
import PBCPModels

// --- the rendered body as text ------------------------------------------------------------------------------------------

/// The head's sanitised HTML (RFC §3.1's restricted profile, rendered on receipt) as an AttributedString, without
/// WebKit, so it runs on the store's actor and never on the main thread. Paragraphs, headings, lists, emphasis, code
/// and links; anything else keeps its text.
public enum StoreText {
  public static func attributed(html: String) -> AttributedString {
    var out = AttributedString()
    var bold = 0, italic = 0, code = 0
    var link: URL?
    var listDepth = 0
    var pendingBreak = ""
    var i = html.startIndex
    func emit(_ s: String) {
      guard !s.isEmpty else { return }
      if !pendingBreak.isEmpty, !out.characters.isEmpty { out.append(AttributedString(pendingBreak)) }
      pendingBreak = ""
      var run = AttributedString(s)
      var intent: InlinePresentationIntent = []
      if bold > 0 { intent.insert(.stronglyEmphasized) }
      if italic > 0 { intent.insert(.emphasized) }
      if code > 0 { intent.insert(.code) }
      if !intent.isEmpty { run.inlinePresentationIntent = intent }
      if let link { run.link = link }
      out.append(run)
    }
    func block(_ s: String) { if !out.characters.isEmpty { pendingBreak = s } }
    while i < html.endIndex {
      if html[i] == "<", let close = html[i...].firstIndex(of: ">") {
        let tag = String(html[html.index(after: i)..<close])
        let closing = tag.hasPrefix("/")
        let name = tag.drop(while: { $0 == "/" }).prefix(while: { $0.isLetter || $0.isNumber }).lowercased()
        switch name {
        case "p", "div", "blockquote", "pre", "table", "tr": block("\n\n")
        case "h1", "h2", "h3", "h4", "h5", "h6":
          block("\n\n")
          bold += closing ? -1 : 1
        case "br": pendingBreak = "\n"
        case "ul", "ol": listDepth += closing ? -1 : 1; block("\n")
        case "li": if !closing { block("\n"); emit(String(repeating: "  ", count: max(0, listDepth - 1)) + "• ") }
        case "strong", "b": bold += closing ? -1 : 1
        case "em", "i": italic += closing ? -1 : 1
        case "code": code += closing ? -1 : 1
        case "a":
          if closing { link = nil } else if let href = attribute("href", in: tag) { link = URL(string: href) }
        case "img": if let alt = attribute("alt", in: tag), !alt.isEmpty { emit("[\(alt)]") }
        default: break
        }
        bold = max(0, bold); italic = max(0, italic); code = max(0, code)
        i = html.index(after: close)
      } else {
        let next = html[i...].firstIndex(of: "<") ?? html.endIndex
        emit(decodeEntities(String(html[i..<next])))
        i = next
      }
    }
    return out
  }

  /// The text alone, for the search index.
  public static func plain(_ text: AttributedString) -> String { String(text.characters) }

  static func attribute(_ name: String, in tag: String) -> String? {
    guard let r = tag.range(of: "\(name)=\"") else { return nil }
    let rest = tag[r.upperBound...]
    return rest.firstIndex(of: "\"").map { decodeEntities(String(rest[..<$0])) }
  }

  static func decodeEntities(_ s: String) -> String {
    guard s.contains("&") else { return s }
    var out = s
    for (e, c) in [("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""), ("&#39;", "'"), ("&#x27;", "'"), ("&nbsp;", "\u{00A0}"), ("&amp;", "&")] {
      out = out.replacingOccurrences(of: e, with: c)
    }
    return out
  }
}

// --- the outbox laid over a card ------------------------------------------------------------------------------------------

extension MeCard {
  /// What a command does to a card on the device, at once, before the head has it: the card settles as it would online
  /// (the web store's `apply`, app/(ui)/local/store.ts).
  public func applying(_ row: OutboxRow) -> MeCard {
    var c = self
    let body = row.body
    switch row.action {
    case .decide:
      c.state = .decided
      if case .string(let d)? = body["decision"] { c.decision = d }
      c.decidedAt = row.at
      if case .string(let e)? = body["edited_proposal"], !e.isEmpty { c.editedProposal = e }
      if case .string(let m)? = body["comment"], !m.isEmpty { c.comment = m }
    case .ack:
      c.acknowledgedAt = row.at
    case .snooze:
      if case .string(let until)? = body["until"] {
        c.snoozedUntil = until
      } else {
        let preset: SnoozePreset
        if case .string(let p)? = body["preset"], let known = SnoozePreset(rawValue: p) { preset = known } else { preset = .tomorrow }
        c.snoozedUntil = presetUntil(preset, now: Timestamp(rawValue: row.at).date ?? .now).rawValue
      }
    case .unsnooze:
      c.snoozedUntil = nil
    }
    return c
  }
}

/// Where a snooze preset lands on the device's clock until the head answers with its own (lib/settings-me.ts
/// snoozeUntil: tonight 18:00, tomorrow's brief 05:30, next week 05:30).
public func presetUntil(_ preset: SnoozePreset, now: Date, calendar: Calendar = .current) -> Timestamp {
  let (days, hour, minute): (Int, Int, Int) = switch preset {
  case .tonight: (0, 18, 0)
  case .tomorrow: (1, 5, 30)
  case .nextWeek: (7, 5, 30)
  }
  let day = calendar.date(byAdding: .day, value: days, to: now) ?? now
  return Timestamp(calendar.date(bySettingHour: hour, minute: minute, second: 0, of: day) ?? day)
}

// --- a command as an outbox row ---------------------------------------------------------------------------------------------

extension Command {
  /// The row's action: the command's tag.
  public var action: OutboxAction {
    switch self {
    case .decide: .decide
    case .ack: .ack
    case .snooze: .snooze
    case .unsnooze: .unsnooze
    }
  }

  /// The body as the route takes it, as JSON.
  public func bodyJSON() throws -> [String: JSONValue] {
    let all = try PBCPJSON.decoder().decode([String: JSONValue].self, from: PBCPJSON.encoder().encode(self))
    if case .object(let body)? = all["body"] { return body }
    return [:]
  }
}
