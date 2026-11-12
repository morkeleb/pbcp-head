// What the generated models stand on (hand-written, not generated): any JSON value, a field that is both optional and
// nullable, the head's timestamps, and the coding helpers that keep "absent", "null" and producers' own fields apart,
// so a card decodes and encodes back to the same JSON the head sent (model/README.md, "Fixtures").

import Foundation

/// Any JSON value: a producer's own fields (the protocol keeps them), an outbox body, WebAuthn options.
public enum JSONValue: Codable, Sendable, Equatable, Hashable {
  case null
  case bool(Bool)
  case int(Int)
  case double(Double)
  case string(String)
  case array([JSONValue])
  case object([String: JSONValue])

  public init(from decoder: any Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() { self = .null }
    else if let b = try? c.decode(Bool.self) { self = .bool(b) }
    else if let i = try? c.decode(Int.self) { self = .int(i) }
    else if let d = try? c.decode(Double.self) { self = .double(d) }
    else if let s = try? c.decode(String.self) { self = .string(s) }
    else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
    else { self = .object(try c.decode([String: JSONValue].self)) }
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.singleValueContainer()
    switch self {
    case .null: try c.encodeNil()
    case .bool(let b): try c.encode(b)
    case .int(let i): try c.encode(i)
    case .double(let d): try c.encode(d)
    case .string(let s): try c.encode(s)
    case .array(let a): try c.encode(a)
    case .object(let o): try c.encode(o)
    }
  }
}

/// A field that may be absent, present and null, or present with a value (`T | null`, optional): `Nullable<T>?`.
public enum Nullable<Wrapped: Codable & Sendable & Equatable>: Codable, Sendable, Equatable {
  case null
  case value(Wrapped)

  public var value: Wrapped? {
    if case .value(let v) = self { return v }
    return nil
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.singleValueContainer()
    self = c.decodeNil() ? .null : .value(try c.decode(Wrapped.self))
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.singleValueContainer()
    switch self {
    case .null: try c.encodeNil()
    case .value(let v): try c.encode(v)
    }
  }
}

/// An RFC 3339 UTC timestamp as the head wrote it. The text is kept exactly, so it encodes back unchanged; `date`
/// reads it (with or without fractional seconds).
public struct Timestamp: Codable, Sendable, Equatable, Hashable, Comparable, RawRepresentable {
  public var rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
  public init(_ date: Date) { self.rawValue = date.formatted(.iso8601) }

  public var date: Date? {
    (try? Date(rawValue, strategy: .iso8601)) ?? (try? Date(rawValue, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)))
  }

  public init(from decoder: any Decoder) throws { rawValue = try decoder.singleValueContainer().decode(String.self) }
  public func encode(to encoder: any Encoder) throws {
    var c = encoder.singleValueContainer()
    try c.encode(rawValue)
  }
  public static func < (a: Timestamp, b: Timestamp) -> Bool { (a.date ?? .distantPast) < (b.date ?? .distantPast) }
}

/// A coding key by name, for tagged unions and producers' own fields.
public struct AnyKey: CodingKey, Hashable, Sendable {
  public var stringValue: String
  public var intValue: Int? { nil }
  public init(_ s: String) { stringValue = s }
  public init?(stringValue: String) { self.stringValue = stringValue }
  public init?(intValue: Int) { nil }
}

extension KeyedDecodingContainer {
  /// Absent → nil; present and null → `.null`; present → `.value`.
  public func decodeNullable<T: Codable & Sendable & Equatable>(_: T.Type, forKey key: Key) throws -> Nullable<T>? {
    guard contains(key) else { return nil }
    return try decodeNil(forKey: key) ? .null : .value(decode(T.self, forKey: key))
  }
}

extension KeyedEncodingContainer {
  /// Absent stays absent; `.null` writes null.
  public mutating func encodeNullable<T: Codable & Sendable & Equatable>(_ v: Nullable<T>?, forKey key: Key) throws {
    guard let v else { return }
    switch v {
    case .null: try encodeNil(forKey: key)
    case .value(let x): try encode(x, forKey: key)
    }
  }

  /// A required field that may be null: always written, as null when nil.
  public mutating func encodeOrNull<T: Encodable>(_ v: T?, forKey key: Key) throws {
    if let v { try encode(v, forKey: key) } else { try encodeNil(forKey: key) }
  }
}

extension Decoder {
  /// Every field the type does not name, as it came.
  public func extras(known: [String]) throws -> [String: JSONValue] {
    let c = try container(keyedBy: AnyKey.self)
    let skip = Set(known)
    var out: [String: JSONValue] = [:]
    for k in c.allKeys where !skip.contains(k.stringValue) { out[k.stringValue] = try c.decode(JSONValue.self, forKey: k) }
    return out
  }
}

extension Encoder {
  public func encodeExtras(_ extra: [String: JSONValue]) throws {
    guard !extra.isEmpty else { return }
    var c = container(keyedBy: AnyKey.self)
    for (k, v) in extra { try c.encode(v, forKey: AnyKey(k)) }
  }
}

/// The JSON coders the head's wire format needs: keys as the model names them, no slash escaping.
public enum PBCPJSON {
  public static func encoder() -> JSONEncoder {
    let e = JSONEncoder()
    e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return e
  }
  public static func decoder() -> JSONDecoder { JSONDecoder() }
}

/// RFC 0.9 §9: a card's sensitivity raised by the owner's floors, never lowered: the highest of the card's own value
/// and every floor that covers it. A port of @pbcp/core's `effectiveSensitivity`, so the device computes what the head does.
public func effectiveSensitivity(_ own: Sensitivity?, _ floors: [Sensitivity?]) -> Sensitivity {
  let order = Sensitivity.allCases
  return ([own] + floors).compactMap { $0 }.reduce(Sensitivity.normal) { max, s in
    (order.firstIndex(of: s) ?? 0) > (order.firstIndex(of: max) ?? 0) ? s : max
  }
}

extension Floors {
  /// The effective sensitivity of a card from `producer` carrying `labels`, with `own` as the producer sent it.
  public func effective(own: Sensitivity?, producer: String, labels: [String]) -> Sensitivity {
    effectiveSensitivity(own, [producers[producer]] + labels.map { self.labels[$0] } + [all])
  }
}

/// A meta row's key and the type of its value (the model's `Meta`): `store.meta(Meta.cursor)` is an `Int?`.
public struct MetaKey<Value: Codable & Sendable & Equatable>: Sendable, Hashable {
  public let name: String
  public init(_ name: String) { self.name = name }
}
