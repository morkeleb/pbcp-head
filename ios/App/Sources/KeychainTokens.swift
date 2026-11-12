// The session's tokens in the Keychain (docs/superpowers/specs/2026-11-10-ios-secretary-design.md "Auth across
// surfaces"): one device, one session, one refresh token. An app group shares it with the extensions when they arrive.

import Foundation
import PBCPClient
import PBCPModels
import Security

actor KeychainTokens: TokenStore {
  private let service = "app.pbcp.session"

  func load() async -> SessionTokens? {
    var result: AnyObject?
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecReturnData as String: true]
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
    return try? PBCPJSON.decoder().decode(SessionTokens.self, from: data)
  }

  func save(_ tokens: SessionTokens?) async {
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
    SecItemDelete(query as CFDictionary)
    guard let tokens, let data = try? PBCPJSON.encoder().encode(tokens) else { return }
    var add = query
    add[kSecValueData as String] = data
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
    SecItemAdd(add as CFDictionary, nil)
  }
}
