#if os(iOS)
import UIKit

/// Returns `true` when any text-editing control (`UITextField`, `UITextView`, `UISearchBar`, or `UITextInput`)
/// inside any window of `window`'s scene (including modal/alert windows) is currently first responder, using strictly public UIKit APIs (`#415`).
@MainActor
func isAnyTextInputFirstResponder(in window: UIWindow?) -> Bool {
  guard let window else { return false }
  if let sceneWindows = window.windowScene?.windows, !sceneWindows.isEmpty {
    return sceneWindows.contains { containsTextInputFirstResponder(in: $0) }
  }
  return containsTextInputFirstResponder(in: window)
}

@MainActor
private func containsTextInputFirstResponder(in view: UIView) -> Bool {
  if view.isFirstResponder {
    if view is UITextField || view is UITextView || view is UISearchBar || view is UITextInput {
      return true
    }
  }
  for subview in view.subviews {
    if containsTextInputFirstResponder(in: subview) {
      return true
    }
  }
  return false
}

/// Builds and translates iOS/iPadOS `UIKeyCommand` playback shortcuts (`#415`).
@MainActor
enum AetherKeyCommandHost {
  static func makePlaybackKeyCommands(action: Selector) -> [UIKeyCommand] {
    let inputs: [String] = [
      " ",
      UIKeyCommand.inputLeftArrow,
      UIKeyCommand.inputRightArrow,
      UIKeyCommand.inputUpArrow,
      UIKeyCommand.inputDownArrow,
      "m",
      "f",
      UIKeyCommand.inputEscape,
    ]
    return inputs.map { input in
      let command = UIKeyCommand(input: input, modifierFlags: [], action: action)
      if #available(iOS 15.0, *) {
        command.wantsPriorityOverSystemBehavior = true
      }
      return command
    }
  }

  static func mapInput(from command: UIKeyCommand) -> HardwareKeyInput? {
    guard let input = command.input, !input.isEmpty else { return nil }
    switch input {
    case " ":
      return .space
    case UIKeyCommand.inputLeftArrow:
      return .leftArrow
    case UIKeyCommand.inputRightArrow:
      return .rightArrow
    case UIKeyCommand.inputUpArrow:
      return .upArrow
    case UIKeyCommand.inputDownArrow:
      return .downArrow
    case UIKeyCommand.inputEscape:
      return .escape
    default:
      return .character(input)
    }
  }

  static func hasCommandOrControl(_ flags: UIKeyModifierFlags) -> Bool {
    flags.contains(.command) || flags.contains(.control)
  }

  /// Registers text-input begin/end editing observers so playback views immediately yield and reclaim keyboard focus.
  static func installTextEditingObservers(
    onBeginEditing: @escaping @MainActor @Sendable () -> Void,
    onEndEditing: @escaping @MainActor @Sendable () -> Void
  ) -> [NSObjectProtocol] {
    let center = NotificationCenter.default
    let beginHandler: @Sendable (Notification) -> Void = { _ in
      AetherBackend.onMainActor(onBeginEditing)
    }
    let endHandler: @Sendable (Notification) -> Void = { _ in
      AetherBackend.onMainActor(onEndEditing)
    }
    return [
      center.addObserver(forName: UITextField.textDidBeginEditingNotification, object: nil, queue: nil, using: beginHandler),
      center.addObserver(forName: UITextView.textDidBeginEditingNotification, object: nil, queue: nil, using: beginHandler),
      center.addObserver(forName: UITextField.textDidEndEditingNotification, object: nil, queue: nil, using: endHandler),
      center.addObserver(forName: UITextView.textDidEndEditingNotification, object: nil, queue: nil, using: endHandler),
    ]
  }
}

extension AetherSurfaceView {
  @MainActor
  func reportCurrentSafeAreaInsets() {
    let source = window?.safeAreaInsets ?? safeAreaInsets
    AppleModuleEventHub.shared.reportSafeAreaInsets(
      SurfaceEdgeInsets(
        top: Double(source.top),
        left: Double(source.left),
        bottom: Double(source.bottom),
        right: Double(source.right)
      )
    )
  }

  @MainActor
  func resignKeyboardFocus() {
    keyboardMapper.reset()
    if isFirstResponder {
      resignFirstResponder()
    }
  }

  @MainActor
  func refreshKeyboardResponder() {
    let eligible = window != nil
      && !isAppInBackground
      && boundEngine != nil
      && !isAnyTextInputFirstResponder(in: window)
    if !eligible {
      resignKeyboardFocus()
      return
    }
    DispatchQueue.main.async { [weak self] in
      MainActor.assumeIsolated {
        guard let self, self.canBecomeFirstResponder, !self.isFirstResponder else { return }
        _ = self.becomeFirstResponder()
      }
    }
  }

  @objc
  func handlePlaybackKeyCommand(_ command: UIKeyCommand) {
    MainActor.assumeIsolated {
      guard let engine = boundEngine, window != nil, !isAppInBackground else { return }
      if isAnyTextInputFirstResponder(in: window) {
        resignKeyboardFocus()
        return
      }
      guard let input = AetherKeyCommandHost.mapInput(from: command) else { return }
      let nowMs = ProcessInfo.processInfo.systemUptime * 1_000.0
      guard let action = keyboardMapper.map(
        input: input,
        modifiersHaveCommandOrControl: AetherKeyCommandHost.hasCommandOrControl(command.modifierFlags),
        isLive: engine.isCurrentlyLive(),
        isTextInputFocused: false,
        nowMs: nowMs
      ) else {
        return
      }
      AppleModuleEventHub.shared.emitHardwareKey(action.rawValue)
    }
  }
}
#endif
