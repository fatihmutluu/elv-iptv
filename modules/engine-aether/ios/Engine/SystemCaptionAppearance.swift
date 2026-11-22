import CoreGraphics
import CoreText
import Foundation
import MediaAccessibility
import UIKit

/// Reads system caption accessibility settings from `MediaAccessibility` (`MACaptionAppearance`) on iOS, iPadOS, and tvOS.
struct SystemCaptionAppearanceSource: CaptionAppearanceSource {
  func readCaptionAppearance() -> CaptionAppearanceStyle? {
    let fallback = CaptionAppearanceStyle.default

    var fgBehavior: MACaptionAppearanceBehavior = .useContentIfAvailable
    let fgColor = MACaptionAppearanceCopyForegroundColor(.user, &fgBehavior).takeRetainedValue()
    var fgOpacityBehavior: MACaptionAppearanceBehavior = .useContentIfAvailable
    let fgOpacity = Double(MACaptionAppearanceGetForegroundOpacity(.user, &fgOpacityBehavior))
    let foreground: CaptionAppearanceColor
    if fgBehavior == .useValue || fgOpacityBehavior == .useValue {
      let base = (fgBehavior == .useValue ? Self.toCaptionColor(fgColor) : nil) ?? fallback.foreground
      let alpha = (fgOpacityBehavior == .useValue && fgOpacity.isFinite) ? fgOpacity : base.alpha
      foreground = CaptionAppearanceColor(red: base.red, green: base.green, blue: base.blue, alpha: alpha)
    } else {
      foreground = fallback.foreground
    }

    var bgBehavior: MACaptionAppearanceBehavior = .useContentIfAvailable
    let bgColor = MACaptionAppearanceCopyBackgroundColor(.user, &bgBehavior).takeRetainedValue()
    var bgOpacityBehavior: MACaptionAppearanceBehavior = .useContentIfAvailable
    let bgOpacity = Double(MACaptionAppearanceGetBackgroundOpacity(.user, &bgOpacityBehavior))
    let background: CaptionAppearanceColor
    if bgBehavior == .useValue || bgOpacityBehavior == .useValue {
      let base = (bgBehavior == .useValue ? Self.toCaptionColor(bgColor) : nil) ?? fallback.background
      let alpha = (bgOpacityBehavior == .useValue && bgOpacity.isFinite) ? bgOpacity : base.alpha
      background = CaptionAppearanceColor(red: base.red, green: base.green, blue: base.blue, alpha: alpha)
    } else {
      background = fallback.background
    }

    var winBehavior: MACaptionAppearanceBehavior = .useContentIfAvailable
    let winColor = MACaptionAppearanceCopyWindowColor(.user, &winBehavior).takeRetainedValue()
    var winOpacityBehavior: MACaptionAppearanceBehavior = .useContentIfAvailable
    let winOpacity = Double(MACaptionAppearanceGetWindowOpacity(.user, &winOpacityBehavior))
    let window: CaptionAppearanceColor?
    if winBehavior == .useValue || winOpacityBehavior == .useValue {
      if let base = Self.toCaptionColor(winColor) {
        let alpha = (winOpacityBehavior == .useValue && winOpacity.isFinite) ? winOpacity : base.alpha
        window = alpha > 0.01 ? CaptionAppearanceColor(red: base.red, green: base.green, blue: base.blue, alpha: alpha) : nil
      } else {
        window = nil
      }
    } else {
      window = nil
    }

    var sizeBehavior: MACaptionAppearanceBehavior = .useContentIfAvailable
    let rawSize = Double(MACaptionAppearanceGetRelativeCharacterSize(.user, &sizeBehavior))
    let relativeCharacterSize = (sizeBehavior == .useValue && rawSize.isFinite && rawSize > 0)
      ? rawSize
      : fallback.relativeCharacterSize

    var fontBehavior: MACaptionAppearanceBehavior = .useContentIfAvailable
    let fontDescriptor = MACaptionAppearanceCopyFontDescriptorForStyle(.user, &fontBehavior, .default).takeRetainedValue()
    let fontName: String?
    if fontBehavior == .useValue {
      fontName = CTFontDescriptorCopyAttribute(fontDescriptor, kCTFontNameAttribute) as? String
    } else {
      fontName = nil
    }

    return CaptionAppearanceStyle(
      foreground: foreground,
      background: background,
      window: window,
      relativeCharacterSize: relativeCharacterSize,
      fontName: fontName
    )
  }

  private static func toCaptionColor(_ cgColor: CGColor) -> CaptionAppearanceColor? {
    let srgbSpace = CGColorSpace(name: CGColorSpace.sRGB)
    let converted = srgbSpace.flatMap {
      cgColor.converted(to: $0, intent: .defaultIntent, options: nil)
    } ?? cgColor
    guard let components = converted.components else { return nil }
    if components.count >= 4 {
      return CaptionAppearanceColor(
        red: Double(components[0]),
        green: Double(components[1]),
        blue: Double(components[2]),
        alpha: Double(components[3])
      )
    }
    if components.count == 2 {
      return CaptionAppearanceColor(
        red: Double(components[0]),
        green: Double(components[0]),
        blue: Double(components[0]),
        alpha: Double(components[1])
      )
    }
    return nil
  }
}

/// Observes system caption preference changes and app activation to refresh `CaptionAppearanceStyle`.
final class SystemCaptionAppearanceObserver: @unchecked Sendable {
  private let lock = NSLock()
  private var tokens: [NSObjectProtocol] = []

  init(onChange: @escaping @MainActor @Sendable () -> Void) {
    let center = NotificationCenter.default
    let captionNotification = Notification.Name(kMACaptionAppearanceSettingsChangedNotification as String)
    let handler: @Sendable (Notification) -> Void = { _ in
      AetherBackend.onMainActor {
        onChange()
      }
    }
    let settingsToken = center.addObserver(forName: captionNotification, object: nil, queue: .main, using: handler)
    let activeToken = center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main, using: handler)
    lock.withLock {
      tokens = [settingsToken, activeToken]
    }
  }

  deinit {
    dispose()
  }

  func dispose() {
    let drained: [NSObjectProtocol] = lock.withLock {
      let out = tokens
      tokens.removeAll()
      return out
    }
    for token in drained {
      NotificationCenter.default.removeObserver(token)
    }
  }
}
