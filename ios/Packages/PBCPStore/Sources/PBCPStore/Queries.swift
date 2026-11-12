// Written once by Clay (swift-store, a touch file) and never overwritten: edit it freely.
//
// The hand-tuned reads a screen needs beyond the generated ones. They run on the Store actor like every other read; a
// screen gets their results as values, never the database.

import Foundation
import GRDB
import PBCPModels

extension Store {
  /// Cards whose day is in [from, to] and whose kind is \`kind\`, with the outbox laid over.
  public func cards(from: String, to: String, kind: CardKind) throws -> [MeCard] {
    try cards(from: from, to: to).filter { $0.kind == kind }
  }
}
