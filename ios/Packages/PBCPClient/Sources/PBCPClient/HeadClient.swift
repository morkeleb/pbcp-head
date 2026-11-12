// The head's owner API over HTTP (hand-written; the operations themselves are generated into
// Operations.generated.swift). It holds the only URLSession in the app, sends the owner's session credential
// (`Authorization: Session <access token>`, never a producer token: CLAUDE.md, two credentials never mixed), refreshes
// it once when it expires, and answers every write with a typed outcome instead of throwing.

import Foundation
import PBCPModels

/// A 204: nothing in the body.
public struct NoContent: Codable, Sendable, Equatable {
  public init() {}
}

/// What became of a write, as docs/local-first.md's outbox table reads the head's answer.
public enum WriteOutcome<Value: Sendable & Equatable>: Sendable, Equatable {
  /// 2xx: the head's answer (for an owner action on a card, the protocol card).
  case sent(Value)
  /// 409 on a card: decided or replaced elsewhere; the body is the stored card.
  case conflict(Card)
  /// 403 `reauthentication_required` (RFC 0.9 §4.1 `confirm`): the person must identify themselves again.
  case needsPerson
  /// Any other refusal.
  case refused(status: Int, message: String)
  /// No network, or a 5xx: try again later.
  case offline
}

public enum ClientError: Error, Sendable, Equatable {
  /// No network, or a 5xx.
  case offline
  /// Signed out: no session, or the refresh token was refused.
  case signedOut
  case http(status: Int, error: ErrorBody?)
}

/// Where the session's tokens live: the Keychain in the app (shared with its extensions), memory in tests.
public protocol TokenStore: Sendable {
  func load() async -> SessionTokens?
  func save(_ tokens: SessionTokens?) async
}

public actor HeadClient {
  /// The head's origin, e.g. https://pbcp.vercel.app.
  public let base: URL
  /// The only URLSession in the app. Internal: no view or view model can reach it (ios/README.md).
  let session: URLSession
  let tokens: any TokenStore
  private var refreshing: Task<SessionTokens, any Error>?

  public init(base: URL, tokens: any TokenStore, configuration: URLSessionConfiguration = .default) {
    self.base = base
    self.tokens = tokens
    self.session = URLSession(configuration: configuration)
  }

  // --- sign-in, refresh, step-up (not /api/me, so not in the OpenAPI document) ---

  /// POST /api/auth/apple: Sign in with Apple. The session starts re-identified (docs/trust.md).
  public func signInWithApple(idToken: String, deviceName: String) async throws -> SessionTokens {
    let t: SessionTokens = try await auth("/api/auth/apple", ["id_token": .string(idToken), "platform": .string("ios"), "name": .string(deviceName)])
    await tokens.save(t)
    return t
  }

  /// POST /api/auth/refresh, one at a time: the head rotates refresh tokens and signs a device out when an old one comes
  /// back, so concurrent callers share one refresh. A network failure never signs out.
  public func refresh() async throws -> SessionTokens {
    if let refreshing { return try await refreshing.value }
    let task = Task { () throws -> SessionTokens in
      guard let current = await tokens.load() else { throw ClientError.signedOut }
      do {
        let t: SessionTokens = try await auth("/api/auth/refresh", ["refresh_token": .string(current.refreshToken)])
        await tokens.save(t)
        return t
      } catch ClientError.http(let status, _) where status == 401 {
        await tokens.save(nil)
        throw ClientError.signedOut
      }
    }
    refreshing = task
    defer { refreshing = nil }
    return try await task.value
  }

  /// POST /api/auth/passkey/step-up/options: a challenge to identify yourself again (RFC 0.9 §4.5).
  public func stepUpOptions() async throws -> StepUpOptions {
    try await read(StepUpOptions.self, "POST", "/api/auth/passkey/step-up/options", query: [])
  }

  /// POST /api/auth/passkey/step-up: the session counts as re-identified for `window_seconds`.
  public func stepUp(_ body: StepUpRequest) async throws -> StepUpResult {
    let (status, data) = try await send("POST", "/api/auth/passkey/step-up", query: [], body: body)
    guard (200..<300).contains(status) else { throw ClientError.http(status: status, error: try? PBCPJSON.decoder().decode(ErrorBody.self, from: data)) }
    return try PBCPJSON.decoder().decode(StepUpResult.self, from: data)
  }

  // --- what the generated operations call ---

  func read<T: Decodable>(_: T.Type, _ method: String, _ path: String, query: [(String, String?)]) async throws -> T {
    let (status, data) = try await send(method, path, query: query, body: Optional<NoContent>.none)
    guard (200..<300).contains(status) else {
      if status >= 500 { throw ClientError.offline }
      throw ClientError.http(status: status, error: try? PBCPJSON.decoder().decode(ErrorBody.self, from: data))
    }
    if T.self == Data.self, let d = data as? T { return d }
    if T.self == NoContent.self, let n = NoContent() as? T { return n }
    return try PBCPJSON.decoder().decode(T.self, from: data)
  }

  func write<T: Decodable & Sendable & Equatable, B: Encodable>(_: T.Type, _ method: String, _ path: String, query: [(String, String?)], body: B?, conflictIsCard: Bool, expect: Int) async -> WriteOutcome<T> {
    let status: Int, data: Data
    do { (status, data) = try await send(method, path, query: query, body: body) } catch { return .offline }
    if status >= 500 { return .offline }
    if (200..<300).contains(status) {
      if T.self == NoContent.self, let n = NoContent() as? T { return .sent(n) }
      guard let value = try? PBCPJSON.decoder().decode(T.self, from: data) else { return .refused(status: status, message: "the head's answer did not decode") }
      return .sent(value)
    }
    let error = try? PBCPJSON.decoder().decode(ErrorBody.self, from: data)
    if status == 409, conflictIsCard, let card = try? PBCPJSON.decoder().decode(Card.self, from: data) { return .conflict(card) }
    if status == 403, error?.error == "reauthentication_required" { return .needsPerson }
    return .refused(status: status, message: error?.message ?? "the head refused it (\(status))")
  }

  /// One request with the session; on 401 one refresh and one retry. Throws `offline` when the network fails.
  func send<B: Encodable>(_ method: String, _ path: String, query: [(String, String?)], body: B?) async throws -> (Int, Data) {
    let first = try await attempt(method, path, query: query, body: body, tokens: await tokens.load())
    guard first.0 == 401 else { return first }
    return try await attempt(method, path, query: query, body: body, tokens: try await refresh())
  }

  private func attempt<B: Encodable>(_ method: String, _ path: String, query: [(String, String?)], body: B?, tokens t: SessionTokens?) async throws -> (Int, Data) {
    var url = URLComponents(url: base.appending(path: path), resolvingAgainstBaseURL: false)!
    url.percentEncodedPath = base.path(percentEncoded: true).replacing(/\/$/, with: "") + path
    let items = query.compactMap { k, v in v.map { URLQueryItem(name: k, value: $0) } }
    if !items.isEmpty { url.queryItems = items }
    var req = URLRequest(url: url.url!)
    req.httpMethod = method
    req.setValue(TimeZone.current.identifier, forHTTPHeaderField: "X-Timezone")
    if let t { req.setValue("Session \(t.accessToken)", forHTTPHeaderField: "Authorization") }
    if let body {
      req.setValue("application/json", forHTTPHeaderField: "Content-Type")
      req.httpBody = try PBCPJSON.encoder().encode(body)
    }
    do {
      let (data, response) = try await session.data(for: req)
      return ((response as? HTTPURLResponse)?.statusCode ?? 0, data)
    } catch {
      throw ClientError.offline
    }
  }

  private func auth<T: Decodable>(_ path: String, _ body: [String: JSONValue]) async throws -> T {
    let (status, data) = try await attempt("POST", path, query: [], body: body, tokens: nil)
    guard (200..<300).contains(status) else {
      if status >= 500 { throw ClientError.offline }
      throw ClientError.http(status: status, error: try? PBCPJSON.decoder().decode(ErrorBody.self, from: data))
    }
    return try PBCPJSON.decoder().decode(T.self, from: data)
  }

  /// A path segment, percent-encoded (a card id contains `:`).
  static func segment(_ s: String) -> String {
    s.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? s
  }
}
