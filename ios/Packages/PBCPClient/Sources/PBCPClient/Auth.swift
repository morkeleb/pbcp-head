// Written once by Clay (swift-client, a touch file) and never overwritten: edit it freely.
//
// Sign in with Apple and the passkey assertion are platform code (AuthenticationServices), not shapes, so they live
// here and not in the model. HeadClient takes what they produce: an Apple identity token for POST /api/auth/apple, and
// a WebAuthn assertion for POST /api/auth/passkey/login or /step-up (docs/trust.md "Sensitivity": a passkey sign-in
// counts as identifying again; the at-rest design's step two will also take the passkey's PRF output here).

import Foundation
import PBCPModels

/// What the app's sign-in UI gives the client. The app implements it with ASAuthorizationController.
public protocol Authenticator: Sendable {
  /// Sign in with Apple: the identity token, its audience the app's bundle id (the head lists it in APPLE_CLIENT_ID).
  func appleIdentityToken() async throws -> String
  /// A passkey assertion for the head's options (step-up or sign-in), as WebAuthn AuthenticationResponseJSON.
  func passkeyAssertion(options: JSONValue) async throws -> JSONValue
}

extension HeadClient {
  /// The person identifies themselves again (RFC 0.9 §4.1 \`confirm\`): options, the assertion, then the step-up. The
  /// session counts as re-identified for \`window_seconds\`.
  public func identifyAgain(with authenticator: any Authenticator) async throws -> StepUpResult {
    let options = try await stepUpOptions()
    let response = try await authenticator.passkeyAssertion(options: options.options)
    return try await stepUp(StepUpRequest(state: options.state, response: response))
  }
}
