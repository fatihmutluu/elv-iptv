import ElvAetherCore
import Foundation
import Testing

@Suite("ExternalDisplayPolicy (#258)")
struct ExternalDisplayPolicyTests {
  @Test("starts inline with unavailable surface and PiP allowed when unbound")
  func initialStateIsInlineAndUnbound() {
    let policy = ExternalDisplayPolicy()
    let transition = policy.currentTransition

    #expect(policy.inlineSurfaceAttached == false)
    #expect(policy.boundEngineId == nil)
    #expect(policy.connectedExternalSceneId == nil)
    #expect(policy.hostedOnExternalDisplay == false)
    #expect(
      transition == ExternalDisplayTransition(
        hostTarget: .inline,
        isExternalDisplayActive: false,
        effectiveSurfaceAvailable: false,
        shouldAllowPip: true
      )
    )
  }

  @Test("routes to external display on connect while playing and preserves surface availability without surface-lost")
  func connectWhilePlayingRoutesToExternalAndBlocksPip() {
    var policy = ExternalDisplayPolicy()
    let attached = policy.setInlineSurfaceAttached(true)
    #expect(attached.effectiveSurfaceAvailable == false)

    let bound = policy.setBoundEngine("engine-1")
    #expect(
      bound == ExternalDisplayTransition(
        hostTarget: .inline,
        isExternalDisplayActive: false,
        effectiveSurfaceAvailable: true,
        shouldAllowPip: true
      )
    )

    let connected = policy.connectExternalScene("ext-scene-1")
    #expect(policy.hostedOnExternalDisplay == true)
    #expect(
      connected == ExternalDisplayTransition(
        hostTarget: .external(sceneId: "ext-scene-1"),
        isExternalDisplayActive: true,
        effectiveSurfaceAvailable: true,
        shouldAllowPip: false
      )
    )

    // Even if inline surface temporarily detaches while externally hosted, effectiveSurfaceAvailable stays true
    let detachedInline = policy.setInlineSurfaceAttached(false)
    #expect(detachedInline.hostTarget == .external(sceneId: "ext-scene-1"))
    #expect(detachedInline.isExternalDisplayActive == true)
    #expect(detachedInline.effectiveSurfaceAvailable == true)
    #expect(detachedInline.shouldAllowPip == false)
  }

  @Test("restores inline playback seamlessly when external display disconnects while playing")
  func disconnectWhilePlayingRestoresInline() {
    var policy = ExternalDisplayPolicy(
      inlineSurfaceAttached: true,
      boundEngineId: "engine-1",
      connectedExternalSceneId: "ext-scene-1"
    )
    #expect(policy.hostedOnExternalDisplay == true)
    #expect(policy.currentTransition.isExternalDisplayActive == true)

    // Disconnecting an unknown/stale scene ID is ignored
    let staleDisconnect = policy.disconnectExternalScene("ext-scene-other")
    #expect(staleDisconnect.hostTarget == .external(sceneId: "ext-scene-1"))
    #expect(staleDisconnect.isExternalDisplayActive == true)

    let restored = policy.disconnectExternalScene("ext-scene-1")
    #expect(policy.connectedExternalSceneId == nil)
    #expect(policy.hostedOnExternalDisplay == false)
    #expect(
      restored == ExternalDisplayTransition(
        hostTarget: .inline,
        isExternalDisplayActive: false,
        effectiveSurfaceAvailable: true,
        shouldAllowPip: true
      )
    )
  }

  @Test("routes immediately to external display when binding an engine while external scene is already connected")
  func bindWhileExternalAlreadyConnectedRoutesImmediately() {
    var policy = ExternalDisplayPolicy()
    let connectedIdle = policy.connectExternalScene("ext-hdmi")
    #expect(policy.connectedExternalSceneId == "ext-hdmi")
    #expect(policy.hostedOnExternalDisplay == false)
    #expect(
      connectedIdle == ExternalDisplayTransition(
        hostTarget: .inline,
        isExternalDisplayActive: false,
        effectiveSurfaceAvailable: false,
        shouldAllowPip: true
      )
    )

    let bound = policy.setBoundEngine("engine-42")
    #expect(policy.hostedOnExternalDisplay == true)
    #expect(
      bound == ExternalDisplayTransition(
        hostTarget: .external(sceneId: "ext-hdmi"),
        isExternalDisplayActive: true,
        effectiveSurfaceAvailable: true,
        shouldAllowPip: false
      )
    )
  }

  @Test("unbind and stop release external host cleanly while remembering the connected external display")
  func unbindReleasesExternalHostAndPreservesConnectedScene() {
    var policy = ExternalDisplayPolicy(
      inlineSurfaceAttached: true,
      boundEngineId: "engine-1",
      connectedExternalSceneId: "ext-1"
    )

    let clearedEngine = policy.setBoundEngine(nil)
    #expect(policy.hostedOnExternalDisplay == false)
    #expect(policy.connectedExternalSceneId == "ext-1")
    #expect(
      clearedEngine == ExternalDisplayTransition(
        hostTarget: .inline,
        isExternalDisplayActive: false,
        effectiveSurfaceAvailable: false,
        shouldAllowPip: true
      )
    )

    // Binding a new engine routes right back to the still-connected display
    let rebound = policy.setBoundEngine("engine-2")
    #expect(rebound.hostTarget == .external(sceneId: "ext-1"))
    #expect(rebound.isExternalDisplayActive == true)
    #expect(rebound.effectiveSurfaceAvailable == true)
    #expect(rebound.shouldAllowPip == false)

    // Full unbind clears both engine and inline attachment while keeping connectedExternalSceneId
    let unbound = policy.unbind()
    #expect(policy.boundEngineId == nil)
    #expect(policy.inlineSurfaceAttached == false)
    #expect(policy.connectedExternalSceneId == "ext-1")
    #expect(policy.hostedOnExternalDisplay == false)
    #expect(unbound.effectiveSurfaceAvailable == false)
    #expect(unbound.shouldAllowPip == true)
  }

  @Test("pauses surface availability cleanly on app backgrounding and resumes on foreground")
  func appBackgroundingPausesSurfaceAvailability() {
    var policy = ExternalDisplayPolicy(
      inlineSurfaceAttached: true,
      boundEngineId: "engine-1",
      connectedExternalSceneId: "ext-1"
    )
    #expect(policy.currentTransition.effectiveSurfaceAvailable == true)

    let bg = policy.setAppInBackground(true)
    #expect(bg.hostTarget == .external(sceneId: "ext-1"))
    #expect(bg.isExternalDisplayActive == true)
    #expect(bg.effectiveSurfaceAvailable == false)
    #expect(bg.shouldAllowPip == false)

    let fg = policy.setAppInBackground(false)
    #expect(fg.hostTarget == .external(sceneId: "ext-1"))
    #expect(fg.isExternalDisplayActive == true)
    #expect(fg.effectiveSurfaceAvailable == true)
    #expect(fg.shouldAllowPip == false)
  }

  @Test("handles repeated connect and disconnect cycles and ignores blank identifiers cleanly")
  func repeatedConnectDisconnectCyclesStayConsistent() {
    var policy = ExternalDisplayPolicy(inlineSurfaceAttached: true, boundEngineId: "engine-1")

    let ignoredBlank = policy.connectExternalScene("   ")
    #expect(ignoredBlank.hostTarget == .inline)
    #expect(ignoredBlank.isExternalDisplayActive == false)

    for cycle in 1...4 {
      let sceneId = "ext-cycle-\(cycle)"
      let connected = policy.connectExternalScene(sceneId)
      #expect(connected.hostTarget == .external(sceneId: sceneId))
      #expect(connected.isExternalDisplayActive == true)
      #expect(connected.effectiveSurfaceAvailable == true)
      #expect(connected.shouldAllowPip == false)

      let disconnected = policy.disconnectExternalScene(sceneId)
      #expect(disconnected.hostTarget == .inline)
      #expect(disconnected.isExternalDisplayActive == false)
      #expect(disconnected.effectiveSurfaceAvailable == true)
      #expect(disconnected.shouldAllowPip == true)
    }

    // Switching directly to a newer external scene ignores late disconnect from the previous scene
    let first = policy.connectExternalScene("ext-a")
    #expect(first.hostTarget == .external(sceneId: "ext-a"))
    let second = policy.connectExternalScene("ext-b")
    #expect(second.hostTarget == .external(sceneId: "ext-b"))
    let lateOldDisconnect = policy.disconnectExternalScene("ext-a")
    #expect(lateOldDisconnect.hostTarget == .external(sceneId: "ext-b"))
    #expect(lateOldDisconnect.isExternalDisplayActive == true)
  }
}
