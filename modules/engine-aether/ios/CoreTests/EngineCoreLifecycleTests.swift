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
}
