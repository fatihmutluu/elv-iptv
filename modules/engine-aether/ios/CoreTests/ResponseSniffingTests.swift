import ElvAetherCore
import Foundation
import Testing

@Suite("ResponseSniffing")
struct ResponseSniffingTests {
  private let bom = Data([0xEF, 0xBB, 0xBF])

  private func tsPackets() -> Data {
    var data = Data(count: 188 * 3)
    for start in 0..<3 {
      data[start * 188] = 0x47
      data[start * 188 + 1] = 0x40
    }
    return data
  }

  private func printableTsFromMidPacket() -> Data {
    var bytes = [UInt8](repeating: UInt8(ascii: "x"), count: 1_024)
    for index in 0..<bytes.count {
      let rem = (index - 88) % 188
      let mod = rem < 0 ? rem + 188 : rem
      if mod == 0 {
        bytes[index] = 0x47
      }
    }
    return Data(bytes)
  }

  private var notice: Data {
    Data("Max connections reached".utf8)
  }

  @Test("mpegurl content types are HLS")
  func mpegurlContentTypesAreHls() {
    #expect(isHlsContentType("application/vnd.apple.mpegurl"))
    #expect(isHlsContentType("application/x-mpegURL; charset=utf-8"))
    #expect(isHlsContentType("audio/mpegurl"))
    #expect(isHlsContentType("AUDIO/X-MPEGURL"))
    #expect(!isHlsContentType("video/mp2t"))
    #expect(!isHlsContentType("text/plain"))
    #expect(!isHlsContentType(nil))
  }

  @Test("a progressive notice is found whatever the label says")
  func progressiveNoticeUnderAnyLabel() {
    let labels: [String?] = [
      "video/mp2t",
      "application/octet-stream",
      "video/mp4",
      nil,
      "text/plain",
      "text/html",
      "application/xhtml+xml",
      "application/json",
    ]
    for label in labels {
      #expect(classifyProgressive(contentType: label, prefix: notice) == .notice)
    }
    #expect(classifyProgressive(contentType: nil, prefix: Data("<html><body>Limit</body></html>".utf8)) == .notice)
    #expect(classifyProgressive(contentType: nil, prefix: Data("{\"error\":\"limit\"}".utf8)) == .notice)
    #expect(classifyProgressive(contentType: nil, prefix: Data("Bağlantı sınırı aşıldı\r\n".utf8)) == .notice)
  }

  @Test("progressive media is judged by body bytes under any label")
  func progressiveMediaUnderAnyLabel() {
    #expect(classifyProgressive(contentType: "text/html", prefix: Data()) == .media(formatHint: nil))
    #expect(classifyProgressive(contentType: "text/html; charset=UTF-8", prefix: tsPackets()) == .media(formatHint: "mpegts"))
    let mp4 = Data([0, 0, 0, 0x18]) + Data("ftypmp42".utf8) + Data(count: 16)
    #expect(classifyProgressive(contentType: "text/html", prefix: mp4) == .media(formatHint: nil))
    #expect(classifyProgressive(contentType: "application/xhtml+xml", prefix: tsPackets()) == .media(formatHint: "mpegts"))
    #expect(classifyProgressive(contentType: "application/json", prefix: tsPackets()) == .media(formatHint: "mpegts"))
    #expect(classifyProgressive(contentType: "text/plain", prefix: mp4) == .media(formatHint: nil))
  }

  @Test("a progressive playlist is HLS only by an #EXTM3U body")
  func progressivePlaylistOnlyByBody() {
    #expect(classifyProgressive(contentType: "application/octet-stream", prefix: Data("#EXTM3U\n".utf8)) == .playlist)
    #expect(classifyProgressive(contentType: "text/html", prefix: bom + Data("\r\n  #EXTM3U\r\n".utf8)) == .playlist)
    #expect(classifyProgressive(contentType: "application/vnd.apple.mpegurl", prefix: tsPackets()) == .media(formatHint: "mpegts"))
    #expect(classifyProgressive(contentType: "application/x-mpegURL", prefix: tsPackets()) == .media(formatHint: "mpegts"))
    #expect(classifyProgressive(contentType: "audio/x-mpegurl", prefix: notice) == .notice)
    #expect(classifyProgressive(contentType: "application/vnd.apple.mpegurl", prefix: Data()) == .media(formatHint: nil))
  }

  @Test("progressive media is mpegts on TS sync and nil hint on other binary or empty")
  func progressiveMediaClassification() {
    #expect(classifyProgressive(contentType: "video/mp2t", prefix: tsPackets()) == .media(formatHint: "mpegts"))
    #expect(classifyProgressive(contentType: nil, prefix: tsPackets()) == .media(formatHint: "mpegts"))
    let twoPackets = Data(tsPackets().prefix(188 * 2))
    #expect(classifyProgressive(contentType: nil, prefix: twoPackets) == .media(formatHint: nil))
    let threeSyncs = Data(tsPackets().prefix(188 * 2 + 1))
    #expect(classifyProgressive(contentType: nil, prefix: threeSyncs) == .media(formatHint: "mpegts"))
    let mp4 = Data([0, 0, 0, 0x18]) + Data("ftypmp42".utf8) + Data(count: 16)
    #expect(classifyProgressive(contentType: "application/octet-stream", prefix: mp4) == .media(formatHint: nil))
    #expect(classifyProgressive(contentType: nil, prefix: Data()) == .media(formatHint: nil))
  }

  @Test("MPEG-TS that starts mid-packet is found by the sync search")
  func midPacketTsSyncFound() {
    let joined = printableTsFromMidPacket()
    #expect(classifyProgressive(contentType: "video/mp2t", prefix: joined) == .media(formatHint: "mpegts"))
    #expect(classifyProgressive(contentType: nil, prefix: joined) == .media(formatHint: "mpegts"))
  }

  @Test("two G characters 188 bytes apart in a long notice are no sync pattern")
  func twoGsInLongNoticeAreNotSync() {
    var bytes = [UInt8](repeating: UInt8(ascii: "a"), count: 600)
    bytes[0] = UInt8(ascii: "G")
    bytes[188] = UInt8(ascii: "G")
    #expect(classifyProgressive(contentType: "video/mp2t", prefix: Data(bytes)) == .notice)
  }

  @Test("a short notice with G at 0 and 188 needs a third sync byte to be MPEG-TS")
  func shortNoticeWithTwoGsIsNotice() {
    var bytes = [UInt8](repeating: UInt8(ascii: "a"), count: 250)
    bytes[0] = UInt8(ascii: "G")
    bytes[188] = UInt8(ascii: "G")
    #expect(classifyProgressive(contentType: "video/mp2t", prefix: Data(bytes)) == .notice)
    #expect(classifyProgressive(contentType: nil, prefix: Data(bytes)) == .notice)
  }

  @Test("invalid UTF-8 binary streams with high bytes 0x80 to 0xFF are classified as media, not text notices")
  func invalidUtf8BinaryIsMedia() {
    var adts = [UInt8](repeating: UInt8(ascii: "A"), count: 256)
    adts[0] = 0xFF
    adts[1] = 0xF1
    #expect(classifyProgressive(contentType: "audio/aac", prefix: Data(adts)) == .media(formatHint: nil))

    let bareCont = Data([0x80, UInt8(ascii: "x"), UInt8(ascii: "y")])
    let overlong = Data([0xC0, 0x80, UInt8(ascii: "z")])
    #expect(classifyProgressive(contentType: nil, prefix: bareCont) == .media(formatHint: nil))
    #expect(classifyProgressive(contentType: nil, prefix: overlong) == .media(formatHint: nil))

    var padded = [UInt8](repeating: UInt8(ascii: "a"), count: 1_024)
    padded[1_023] = 0xC4
    #expect(classifyProgressive(contentType: "video/mp2t", prefix: Data(padded)) == .notice)
  }
}
