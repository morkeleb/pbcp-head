// THROWAWAY (ios/Spike, deleted when FINDING.md is written). The briefing's three items, built as MeCard values from
// model/fixtures (copied into the bundle), so the entities Siri sees are the real types. No head, no network, no store.

import Foundation
import PBCPModels

enum SpikeItems {
  /// A decision with two options (approve is the default), a task, and a decision with no default.
  static func load(bundle: Bundle = .main) -> [MeCard] {
    func fixture(_ name: String) -> MeCard? {
      guard let url = bundle.url(forResource: name, withExtension: "json"),
            let file = try? JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any],
            let value = file["value"], let data = try? JSONSerialization.data(withJSONObject: value) else { return nil }
      return try? PBCPJSON.decoder().decode(MeCard.self, from: data)
    }
    var anna = fixture("decision-private")
    anna?.sensitivity = .normal
    anna?.effectiveSensitivity = .normal
    anna?.actions = [.object(CardActionObject(id: "approve", label: "Approve", default: true)), .object(CardActionObject(id: "reject", label: "Reject"))]
    var bins = fixture("task-confirm")
    bins?.title = "Take the bins out"
    bins?.sensitivity = .normal
    bins?.effectiveSensitivity = .normal
    var newsletter = fixture("card-minimal")
    newsletter?.id = "mail:inbox:newsletter-1"
    newsletter?.title = "Unsubscribe from the weekly newsletter"
    newsletter?.actions = [.string("approve"), .string("reject")]
    return [anna, bins, newsletter].compactMap { $0 }
  }

  /// "approve, or reject?" with the default first, from the card's actions; "done, or later?" for a task.
  static func options(_ card: MeCard) -> String {
    if card.kind == .task { return "done, or later?" }
    let ids: [(String, Bool)] = (card.actions ?? []).map {
      switch $0 {
      case .string(let id): (id, false)
      case .object(let o): (o.label?.lowercased() ?? o.id, o.default == true)
      }
    }
    let ordered = ids.filter(\.1) + ids.filter { !$0.1 }
    let names = ordered.map(\.0)
    return names.count > 1 ? names.dropLast().joined(separator: ", ") + ", or \(names.last!)?" : (names.first ?? "next") + "?"
  }
}
