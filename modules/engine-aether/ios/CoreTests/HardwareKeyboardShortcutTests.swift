import ElvAetherCore
import Foundation
import Testing

@Suite("HardwareKeyboardShortcut (#415)")
struct HardwareKeyboardShortcutTests {
  @Test("maps playback keys accurately across live and VOD streams")
  func mapsKeysForLiveAndVod() {
    var mapper = HardwareKeyboardMapper()
    #expect(mapper.map(input: .space, modifiersHaveCommandOrControl: false, isLive: true, isTextInputFocused: false, nowMs: 1_000) == .playPause)
    #expect(mapper.map(input: .leftArrow, modifiersHaveCommandOrControl: false, isLive: false, isTextInputFocused: false, nowMs: 1_000) == .seekBack)
    #expect(mapper.map(input: .rightArrow, modifiersHaveCommandOrControl: false, isLive: false, isTextInputFocused: false, nowMs: 1_000) == .seekForward)
    #expect(mapper.map(input: .upArrow, modifiersHaveCommandOrControl: false, isLive: true, isTextInputFocused: false, nowMs: 1_000) == .channelUp)
    #expect(mapper.map(input: .downArrow, modifiersHaveCommandOrControl: false, isLive: true, isTextInputFocused: false, nowMs: 1_000) == .channelDown)
    #expect(mapper.map(input: .upArrow, modifiersHaveCommandOrControl: false, isLive: false, isTextInputFocused: false, nowMs: 1_000) == .volumeUp)
    #expect(mapper.map(input: .downArrow, modifiersHaveCommandOrControl: false, isLive: false, isTextInputFocused: false, nowMs: 1_000) == .volumeDown)
    #expect(mapper.map(input: .character("m"), modifiersHaveCommandOrControl: false, isLive: false, isTextInputFocused: false, nowMs: 1_000) == .mute)
    #expect(mapper.map(input: .character("M"), modifiersHaveCommandOrControl: false, isLive: false, isTextInputFocused: false, nowMs: 1_600) == .mute)
    #expect(mapper.map(input: .character("f"), modifiersHaveCommandOrControl: false, isLive: false, isTextInputFocused: false, nowMs: 1_000) == .aspect)
    #expect(mapper.map(input: .character("F"), modifiersHaveCommandOrControl: false, isLive: false, isTextInputFocused: false, nowMs: 1_600) == .aspect)
    #expect(mapper.map(input: .escape, modifiersHaveCommandOrControl: false, isLive: true, isTextInputFocused: false, nowMs: 1_000) == .back)
    #expect(mapper.map(input: .character("x"), modifiersHaveCommandOrControl: false, isLive: false, isTextInputFocused: false, nowMs: 1_000) == nil)
  }

  @Test("yields unconditionally when a text input is focused or Command/Control modifier is held")
  func yieldsToTextInputAndSystemModifiers() {
    var mapper = HardwareKeyboardMapper()
    let inputs: [HardwareKeyInput] = [
      .space, .leftArrow, .rightArrow, .upArrow, .downArrow, .character("m"), .character("f"), .escape,
    ]
    for input in inputs {
      #expect(
        mapper.map(input: input, modifiersHaveCommandOrControl: false, isLive: true, isTextInputFocused: true, nowMs: 1_000) == nil
      )
      #expect(
        mapper.map(input: input, modifiersHaveCommandOrControl: true, isLive: true, isTextInputFocused: false, nowMs: 1_000) == nil
      )
    }
    #expect(
      mapper.map(input: .space, modifiersHaveCommandOrControl: false, isLive: true, isTextInputFocused: false, nowMs: .nan) == nil
    )
  }

  @Test("throttles arrow repeats to 200 ms while enforcing 550 ms toggle cooldown across iPadOS key-repeat delay")
  func throttlesArrowsAndRejectsToggleAutoRepeat() {
    var mapper = HardwareKeyboardMapper(repeatThrottleMs: 200, toggleCooldownMs: 550)

    // Arrow key steps smoothly at >= 200 ms cadence while suppressing intermediate ticks.
    #expect(mapper.map(input: .rightArrow, modifiersHaveCommandOrControl: false, isLive: false, isTextInputFocused: false, nowMs: 1_000) == .seekForward)
    #expect(mapper.map(input: .rightArrow, modifiersHaveCommandOrControl: false, isLive: false, isTextInputFocused: false, nowMs: 1_080) == nil)
    #expect(mapper.map(input: .rightArrow, modifiersHaveCommandOrControl: false, isLive: false, isTextInputFocused: false, nowMs: 1_199) == nil)
    #expect(mapper.map(input: .rightArrow, modifiersHaveCommandOrControl: false, isLive: false, isTextInputFocused: false, nowMs: 1_200) == .seekForward)
    // Switching immediately to opposite arrow is not blocked by rightArrow throttle.
    #expect(mapper.map(input: .leftArrow, modifiersHaveCommandOrControl: false, isLive: false, isTextInputFocused: false, nowMs: 1_210) == .seekBack)

    // Toggle keys ignore explicit isRepeat and iPadOS's ~450 ms initial repeat delay + sustained hold stream.
    #expect(mapper.map(input: .space, modifiersHaveCommandOrControl: false, isLive: false, isTextInputFocused: false, nowMs: 2_000) == .playPause)
    // Pressing a different toggle key (M) immediately after Space is never blocked by Space's cooldown.
    #expect(mapper.map(input: .character("m"), modifiersHaveCommandOrControl: false, isLive: false, isTextInputFocused: false, nowMs: 2_040) == .mute)
    #expect(mapper.map(input: .space, modifiersHaveCommandOrControl: false, isLive: false, isTextInputFocused: false, nowMs: 2_450) == nil)
    #expect(mapper.map(input: .space, modifiersHaveCommandOrControl: false, isLive: false, isTextInputFocused: false, isRepeat: true, nowMs: 3_100) == nil)
    #expect(mapper.map(input: .space, modifiersHaveCommandOrControl: false, isLive: false, isTextInputFocused: false, nowMs: 3_160) == nil)
    #expect(mapper.map(input: .space, modifiersHaveCommandOrControl: false, isLive: false, isTextInputFocused: false, nowMs: 3_220) == nil)
    // Once key is released and tapped again after >= 550 ms, toggle succeeds.
    #expect(mapper.map(input: .space, modifiersHaveCommandOrControl: false, isLive: false, isTextInputFocused: false, nowMs: 3_770) == .playPause)

    // reset() clears throttle state immediately.
    mapper.reset()
    #expect(mapper.map(input: .space, modifiersHaveCommandOrControl: false, isLive: false, isTextInputFocused: false, nowMs: 3_780) == .playPause)
  }
}
