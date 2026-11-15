// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "ElvAetherCore",
  platforms: [
    .macOS(.v14),
    .iOS(.v18),
    .tvOS(.v18),
  ],
  products: [
    .library(name: "ElvAetherCore", targets: ["ElvAetherCore"]),
  ],
  targets: [
    .target(
      name: "ElvAetherCore",
      path: "Core",
      swiftSettings: [.swiftLanguageMode(.v5)]
    ),
    .testTarget(
      name: "ElvAetherCoreTests",
      dependencies: ["ElvAetherCore"],
      path: "CoreTests",
      swiftSettings: [.swiftLanguageMode(.v5)]
    ),
  ]
)
