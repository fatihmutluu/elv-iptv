import ElvAetherCore
import Foundation
import Testing

@Suite("EngineCore lifecycle")
@MainActor
struct EngineCoreLifecycleTests {
  @Test("EngineCore holds a weak reference to its EngineSink so driver <-> core never cycles")
  func engineCoreDoesNotRetainSink() {
    let backend = FakeBackend()
    let clock = FakeClock()
    var core: EngineCore?
    weak var weakSink: RecordingSink?

    do {
      let sink = RecordingSink()
      weakSink = sink
      core = EngineCore(backend: backend, sink: sink, uptimeMs: { clock.uptimeMs() })
    }

    #expect(core != nil)
    #expect(weakSink == nil)
    core?.release()
  }

  @Test("surface loss while loaded sends destroyed then surface-lost and the return sends created")
  func surfaceLossAndReturn() {
    let backend = FakeBackend()
    let sink = RecordingSink()
    let clock = FakeClock()
    let core = EngineCore(backend: backend, sink: sink, uptimeMs: { clock.uptimeMs() })

    core.surfaceChanged(available: true)
    #expect(sink.events == [.surface(attempt: 0, change: .created)])

    core.load(LoadRequest(url: "http://h:7878/live/demo/demo/1001.ts"), attempt: 4)
    core.observe(.firstFrame, serial: 1)
    core.observe(.phase(.playing), serial: 1)
    #expect(sink.screenOn)

    sink.events.removeAll()
    core.surfaceChanged(available: false)
    #expect(!sink.screenOn)
    #expect(sink.events.count == 2)
    #expect(sink.events[0] == .surface(attempt: 4, change: .destroyed))
    if case let .error(attempt, mapped) = sink.events[1] {
      #expect(attempt == 4)
      #expect(mapped.code == "surface-lost")
    } else {
      Issue.record("expected surface-lost after surface destroyed")
    }

    sink.events.removeAll()
    backend.calls.removeAll()
    core.surfaceChanged(available: true)
    #expect(sink.events == [.surface(attempt: 4, change: .created)])

    core.retry(5)
    #expect(backend.calls.count == 2)
  }

  @Test("background surface detach clears subtitles, turns screen off, and never emits fatal surface-lost (#426)")
  func backgroundSurfaceDetachDoesNotEmitSurfaceLost() {
    let backend = FakeBackend()
    let sink = RecordingSink()
    let clock = FakeClock()
    let core = EngineCore(backend: backend, sink: sink, uptimeMs: { clock.uptimeMs() })

    core.surfaceChanged(available: true)
    core.load(LoadRequest(url: "http://h:7878/live/demo/demo/1001.ts"), attempt: 4)
    core.observe(.firstFrame, serial: 1)
    core.observe(.phase(.playing), serial: 1)
    #expect(sink.screenOn)

    sink.events.removeAll()
    sink.clearSubtitlesCount = 0
    backend.calls.removeAll()

    core.surfaceChanged(available: false, isBackground: true)
    #expect(!sink.screenOn)
    #expect(sink.clearSubtitlesCount == 1)
    #expect(backend.calls.isEmpty)
    #expect(sink.events == [.surface(attempt: 4, change: .destroyed)])

    // Serial stays active so neither AppState stop() nor a quick foreground return races a fatal error.
    sink.events.removeAll()
    core.surfaceChanged(available: true, isBackground: false)
    #expect(sink.events == [.surface(attempt: 4, change: .created)])
    #expect(sink.screenOn)

    sink.events.removeAll()
    clock.nowMs = 2_000
    core.observe(.phase(.playing), serial: 1)
    #expect(sink.screenOn)
    #expect(sink.events == [.state(attempt: 4, state: .playing)])
  }

  @Test("allowDetachedSurface keeps foreground detach non-terminal, preserves clock, and restores screenOn on reattach (#117)")
  func allowDetachedSurfaceForegroundDetachAndReattach() {
    let backend = FakeBackend()
    let sink = RecordingSink()
    let clock = FakeClock()
    let core = EngineCore(backend: backend, sink: sink, uptimeMs: { clock.uptimeMs() })

    #expect(!core.allowDetachedSurface)
    #expect(!core.isSurfaceDetached)

    core.surfaceChanged(available: true)
    core.load(LoadRequest(url: "http://h:7878/movie/demo/demo/200010.mp4", live: false), attempt: 2)
    core.observe(.firstFrame, serial: 1)
    core.observe(.phase(.playing), serial: 1)
    #expect(sink.screenOn)

    core.setAllowDetachedSurface(true)
    #expect(core.allowDetachedSurface)

    sink.events.removeAll()
    sink.clearSubtitlesCount = 0
    backend.calls.removeAll()

    // Foreground detach while allowDetachedSurface is enabled must be non-terminal.
    core.surfaceChanged(available: false, isBackground: false)
    #expect(core.isSurfaceDetached)
    #expect(!sink.screenOn)
    #expect(sink.clearSubtitlesCount == 1)
    #expect(backend.calls.isEmpty)
    #expect(sink.events == [.surface(attempt: 2, change: .destroyed)])

    // Playback and clock continue on the same serial while detached without turning screenOn back on.
    sink.events.removeAll()
    clock.nowMs = 2_500
    core.observe(.clock(positionSeconds: 12.0, rate: 1.0, durationSeconds: 600.0, liveEdgeSeconds: nil), serial: 1)
    core.observe(.phase(.playing), serial: 1)
    #expect(!sink.screenOn)
    #expect(
      sink.events == [
        .clock(attempt: 2, anchor: ClockAnchorOut(positionMs: 12_000, atMs: 2_500, rate: 1.0, durationMs: 600_000)),
        .state(attempt: 2, state: .playing),
      ]
    )

    // Reattaching surface clears isSurfaceDetached, emits .created, and immediately restores screenOn.
    sink.events.removeAll()
    core.surfaceChanged(available: true, isBackground: false)
    #expect(!core.isSurfaceDetached)
    #expect(sink.events == [.surface(attempt: 2, change: .created)])
    #expect(sink.screenOn)

    // Reattaching while paused keeps screenOn disabled.
    core.pause(3)
    core.observe(.phase(.paused), serial: 1)
    core.surfaceChanged(available: false, isBackground: false)
    #expect(core.isSurfaceDetached)
    sink.events.removeAll()
    core.surfaceChanged(available: true, isBackground: false)
    #expect(!core.isSurfaceDetached)
    #expect(sink.events == [.surface(attempt: 3, change: .created)])
    #expect(!sink.screenOn)
  }

  @Test("allowDetachedSurface persists across load and retry, resets isSurfaceDetached on lifecycle boundaries, and toggles back to fatal surface-lost (#117)")
  func allowDetachedSurfacePersistenceAndToggleOff() {
    let backend = FakeBackend()
    let sink = RecordingSink()
    let clock = FakeClock()
    let core = EngineCore(backend: backend, sink: sink, uptimeMs: { clock.uptimeMs() })

    core.setAllowDetachedSurface(true)
    core.surfaceChanged(available: true)
    core.load(LoadRequest(url: "http://h:7878/live/demo/demo/1001.ts"), attempt: 1)
    core.observe(.firstFrame, serial: 1)
    core.observe(.phase(.playing), serial: 1)
    #expect(core.allowDetachedSurface)

    // Retry preserves allowDetachedSurface = true.
    core.retry(2)
    core.observe(.firstFrame, serial: 2)
    core.observe(.phase(.playing), serial: 2)
    #expect(core.allowDetachedSurface)

    // Detach and verify stop/recreate reset isSurfaceDetached while preserving allowDetachedSurface.
    core.surfaceChanged(available: false, isBackground: false)
    #expect(core.isSurfaceDetached)
    core.stop(3)
    #expect(!core.isSurfaceDetached)
    #expect(core.allowDetachedSurface)

    core.surfaceChanged(available: true)
    core.load(LoadRequest(url: "http://h:7878/live/demo/demo/1002.ts"), attempt: 4)
    core.observe(.firstFrame, serial: 4)
    core.observe(.phase(.playing), serial: 4)
    core.surfaceChanged(available: false, isBackground: false)
    #expect(core.isSurfaceDetached)
    #expect(core.recreate(5))
    #expect(!core.isSurfaceDetached)
    #expect(core.allowDetachedSurface)

    // Toggling allowDetachedSurface off restores fatal foreground surface-lost detection.
    core.setAllowDetachedSurface(false)
    #expect(!core.allowDetachedSurface)
    core.surfaceChanged(available: true)
    core.load(LoadRequest(url: "http://h:7878/live/demo/demo/1003.ts"), attempt: 6)
    core.observe(.firstFrame, serial: 6)
    core.observe(.phase(.playing), serial: 6)

    sink.events.removeAll()
    backend.calls.removeAll()
    core.surfaceChanged(available: false, isBackground: false)
    #expect(!core.isSurfaceDetached)
    #expect(!sink.screenOn)
    #expect(backend.calls == [.stopMedia])
    #expect(sink.events.count == 2)
    #expect(sink.events[0] == .surface(attempt: 6, change: .destroyed))
    if case let .error(attempt, mapped) = sink.events[1] {
      #expect(attempt == 6)
      #expect(mapped.code == "surface-lost")
    } else {
      Issue.record("expected fatal surface-lost once allowDetachedSurface is toggled off")
    }

    // Release clears isSurfaceDetached and ignores subsequent toggles.
    core.setAllowDetachedSurface(true)
    core.surfaceChanged(available: true)
    core.surfaceChanged(available: false, isBackground: false)
    #expect(core.isSurfaceDetached)
    core.release()
    #expect(!core.isSurfaceDetached)
    core.setAllowDetachedSurface(false)
    #expect(core.allowDetachedSurface)
  }

  @Test("AirPlay external playback stays non-terminal on local surface detach and restores screenOn only after local return (#117)")
  func airPlayExternalPlaybackDetachedSurfaceSafety() {
    let backend = FakeBackend()
    let sink = RecordingSink()
    let clock = FakeClock()
    let core = EngineCore(backend: backend, sink: sink, uptimeMs: { clock.uptimeMs() })

    core.surfaceChanged(available: true)
    core.load(LoadRequest(url: "http://h:7878/live/demo/demo/1001.m3u8", live: true), attempt: 1)
    core.observe(.firstFrame, serial: 1)
    core.observe(.phase(.playing), serial: 1)
    core.observe(.externalPlayback(true), serial: 1)
    #expect(!sink.screenOn)
    #expect(!core.allowDetachedSurface)

    sink.events.removeAll()
    backend.calls.removeAll()

    // Foreground local surface detach during AirPlay must not emit surface-lost or stop playback.
    core.surfaceChanged(available: false, isBackground: false)
    #expect(core.isSurfaceDetached)
    #expect(backend.calls.isEmpty)
    #expect(sink.events == [.surface(attempt: 1, change: .destroyed)])

    // Reattaching while AirPlay is still active keeps screenOn off.
    sink.events.removeAll()
    core.surfaceChanged(available: true, isBackground: false)
    #expect(!core.isSurfaceDetached)
    #expect(sink.events == [.surface(attempt: 1, change: .created)])
    #expect(!sink.screenOn)

    // Detaching again, ending AirPlay while detached keeps screenOn off until surface reattaches.
    core.surfaceChanged(available: false, isBackground: false)
    #expect(core.isSurfaceDetached)
    sink.events.removeAll()
    core.observe(.externalPlayback(false), serial: 1)
    #expect(sink.events == [.externalPlayback(attempt: 1, active: false)])
    #expect(!sink.screenOn)

    sink.events.removeAll()
    core.surfaceChanged(available: true, isBackground: false)
    #expect(!core.isSurfaceDetached)
    #expect(sink.events == [.surface(attempt: 1, change: .created)])
    #expect(sink.screenOn)
  }

  @Test("rapid load, stop, and surfaceChanged sequences fence out stale serial observations (#117)")
  func rapidLifecycleAndSurfaceTransitionsNeverLeakStaleSerials() {
    let backend = FakeBackend()
    let sink = RecordingSink()
    let clock = FakeClock()
    let core = EngineCore(backend: backend, sink: sink, uptimeMs: { clock.uptimeMs() })

    core.setAllowDetachedSurface(true)
    core.surfaceChanged(available: true)
    core.load(LoadRequest(url: "http://h:7878/live/demo/demo/1001.ts"), attempt: 1) // serial 1
    core.surfaceChanged(available: false, isBackground: false)
    core.load(LoadRequest(url: "http://h:7878/live/demo/demo/1002.ts"), attempt: 2) // serial 2
    core.stop(3) // serial 3
    core.load(LoadRequest(url: "http://h:7878/live/demo/demo/1003.ts"), attempt: 4) // serial 4
    core.surfaceChanged(available: true, isBackground: false)

    sink.events.removeAll()

    // Stale observations from superseded serials 1, 2, and 3 must be dropped completely.
    for staleSerial in [1, 2, 3] {
      core.observe(.opened, serial: staleSerial)
      core.observe(.firstFrame, serial: staleSerial)
      core.observe(.phase(.playing), serial: staleSerial)
      core.observe(.clock(positionSeconds: 99.0, rate: 1.0, durationSeconds: nil, liveEdgeSeconds: nil), serial: staleSerial)
      core.observe(.externalPlayback(true), serial: staleSerial)
      core.observe(.failure(.liveSourceReset), serial: staleSerial)
    }
    #expect(sink.events.isEmpty)

    // Active serial 4 delivers normally.
    clock.nowMs = 3_000
    core.observe(.firstFrame, serial: 4)
    core.observe(.phase(.playing), serial: 4)
    #expect(
      sink.events == [
        .firstFrame(attempt: 4, atMs: 3_000),
        .state(attempt: 4, state: .playing),
      ]
    )

    // Fatal foreground surface loss increments serial and blocks any trailing observations for serial 4.
    core.setAllowDetachedSurface(false)
    core.surfaceChanged(available: false, isBackground: false)
    sink.events.removeAll()
    core.observe(.phase(.playing), serial: 4)
    core.observe(.clock(positionSeconds: 10.0, rate: 1.0, durationSeconds: nil, liveEdgeSeconds: nil), serial: 4)
    core.observe(.failure(.liveSourceReset), serial: 4)
    #expect(sink.events.isEmpty)
  }

  @Test("the screen stays on across a zap from a playing media")
  func screenStaysOnAcrossZap() {
    let backend = FakeBackend()
    let sink = RecordingSink()
    let clock = FakeClock()
    let core = EngineCore(backend: backend, sink: sink, uptimeMs: { clock.uptimeMs() })

    core.load(LoadRequest(url: "http://h:7878/live/demo/demo/1001.ts"), attempt: 1)
    core.observe(.firstFrame, serial: 1)
    core.observe(.phase(.playing), serial: 1)
    #expect(sink.screenOn)

    core.load(LoadRequest(url: "http://h:7878/live/demo/demo/1002.ts"), attempt: 2)
    core.observe(.opened, serial: 2)
    core.observe(.ready, serial: 2)
    #expect(sink.screenOn)
  }

  @Test("recreate rebuilds the backend idle; a failed rebuild returns false and emits engine-wedged")
  func recreateRebuildsOrReportsWedged() {
    let backend = FakeBackend()
    let sink = RecordingSink()
    let clock = FakeClock()
    let core = EngineCore(backend: backend, sink: sink, uptimeMs: { clock.uptimeMs() })

    core.load(LoadRequest(url: "http://h:7878/live/demo/demo/1001.ts"), attempt: 1)
    sink.events.removeAll()
    backend.calls.removeAll()

    #expect(core.recreate(2))
    #expect(backend.calls == [.stopMedia, .rebuild])
    #expect(sink.events.isEmpty)

    backend.shouldFailRebuild = true
    #expect(!core.recreate(3))
    #expect(sink.events.count == 1)
    if case let .error(attempt, mapped) = sink.events.first {
      #expect(attempt == 3)
      #expect(mapped.code == "engine-wedged")
    } else {
      Issue.record("expected engine-wedged on failed rebuild")
    }
  }

  @Test("stop and release silence the engine and turn the screen off")
  func stopAndReleaseSilenceEngine() {
    let backend = FakeBackend()
    let sink = RecordingSink()
    let clock = FakeClock()
    let core = EngineCore(backend: backend, sink: sink, uptimeMs: { clock.uptimeMs() })

    core.load(LoadRequest(url: "http://h:7878/live/demo/demo/1001.ts"), attempt: 1)
    core.observe(.firstFrame, serial: 1)
    core.observe(.phase(.playing), serial: 1)
    #expect(sink.screenOn)

    sink.events.removeAll()
    core.stop(2)
    #expect(!sink.screenOn)
    core.observe(.phase(.ended), serial: 1)
    #expect(sink.events.isEmpty)

    backend.calls.removeAll()
    core.release()
    #expect(backend.calls == [.stopMedia, .dispose])

    backend.calls.removeAll()
    core.load(LoadRequest(url: "http://h:7878/live/demo/demo/1002.ts"), attempt: 3)
    core.play(4)
    core.pause(5)
    core.stop(6)
    core.release()
    #expect(backend.calls.isEmpty)
    #expect(sink.events.isEmpty)
  }
}
