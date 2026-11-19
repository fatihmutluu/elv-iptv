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
