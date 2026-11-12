// swift-models (templates/Models.generated.swift.ejs loads this): ios/Packages/PBCPModels/Sources/PBCPModels/Models.generated.swift, every entity of the model as Codable,
// Sendable, Equatable Swift, snake_case keys as the head's JSON has them. Core's card fields are read from @pbcp/core's
// schema when this runs (lib/swift.ts), never copied into the model.

import type { Model } from '../lib/model';
import { declText, SWIFT_HEADER, swiftModel } from '../lib/swift';

export function emit(m: Model): string {
  return `${SWIFT_HEADER('swift-models')}\nimport Foundation\n\n${swiftModel(m).map(declText).join('\n')}`;
}
