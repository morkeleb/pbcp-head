// swift-tools-version: 6.2
// The iOS app's packages (ios/README.md). Generated code comes from model/model.json (`pnpm generate` at the repo
// root); the module graph runs one way: PBCPModels ← PBCPStore, PBCPClient ← PBCPSync ← App.

import PackageDescription

let strict: [SwiftSetting] = [.treatAllWarnings(as: .error)]

let package = Package(
  name: "PBCP",
  platforms: [.iOS(.v18), .macOS(.v15)],
  products: [
    .library(name: "PBCPModels", targets: ["PBCPModels"]),
    .library(name: "PBCPStore", targets: ["PBCPStore"]),
    .library(name: "PBCPClient", targets: ["PBCPClient"]),
    .library(name: "PBCPSync", targets: ["PBCPSync"]),
  ],
  dependencies: [
    .package(url: "https://github.com/groue/GRDB.swift.git", exact: "7.6.1"),
  ],
  targets: [
    .target(name: "PBCPModels", path: "Packages/PBCPModels/Sources/PBCPModels", swiftSettings: strict),
    .target(
      name: "PBCPStore",
      dependencies: ["PBCPModels", .product(name: "GRDB", package: "GRDB.swift")],
      path: "Packages/PBCPStore/Sources/PBCPStore",
      swiftSettings: strict
    ),
    .target(name: "PBCPClient", dependencies: ["PBCPModels"], path: "Packages/PBCPClient/Sources/PBCPClient", swiftSettings: strict),
    .target(name: "PBCPSync", dependencies: ["PBCPModels", "PBCPStore", "PBCPClient"], path: "Packages/PBCPSync/Sources/PBCPSync", swiftSettings: strict),
    .testTarget(name: "PBCPStoreTests", dependencies: ["PBCPModels", "PBCPStore"], path: "Packages/PBCPStore/Tests/PBCPStoreTests", swiftSettings: strict),
    .testTarget(name: "PBCPSyncTests", dependencies: ["PBCPModels", "PBCPStore", "PBCPClient", "PBCPSync"], path: "Packages/PBCPSync/Tests/PBCPSyncTests", swiftSettings: strict),
  ]
)
