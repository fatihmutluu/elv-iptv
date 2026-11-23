// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "ElvRemoteKeysCore",
  platforms: [
    .macOS(.v14),
    .iOS(.v18),
    .tvOS(.v18),
  ],
  products: [
    .library(name: "ElvRemoteKeysCore", targets: ["ElvRemoteKeysCore"]),
  ],
  targets: [
    .target(
      name: "ElvRemoteKeysCore",
      path: "Core",
      swiftSettings: [.swiftLanguageMode(.v6)]
    ),
    .testTarget(
      name: "ElvRemoteKeysCoreTests",
      dependencies: ["ElvRemoteKeysCore"],
      path: "CoreTests",
      swiftSettings: [.swiftLanguageMode(.v6)]
    ),
  ]
)
