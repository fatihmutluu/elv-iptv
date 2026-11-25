// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "ElvXmltvCore",
  platforms: [
    .macOS(.v14),
    .iOS(.v18),
    .tvOS(.v18),
  ],
  products: [
    .library(name: "ElvXmltvCore", targets: ["ElvXmltvCore"]),
  ],
  targets: [
    .target(
      name: "ElvXmltvCore",
      path: "Core",
      swiftSettings: [.swiftLanguageMode(.v6)],
      linkerSettings: [
        .linkedLibrary("sqlite3"),
        .linkedLibrary("z"),
      ]
    ),
    .testTarget(
      name: "ElvXmltvCoreTests",
      dependencies: ["ElvXmltvCore"],
      path: "CoreTests",
      swiftSettings: [.swiftLanguageMode(.v6)]
    ),
  ]
)
