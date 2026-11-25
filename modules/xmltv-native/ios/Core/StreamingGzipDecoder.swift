import Foundation
import zlib

public enum XmltvStreamError: Error, Sendable, Equatable {
  case gzipInitFailed
  case gzipCorrupt
  case cancelled
}

/// Streaming gzip/passthrough decoder backed by system `zlib` (`inflateInit2_` with `15 + 32`).
/// Automatically detects `1f 8b` gzip magic bytes and supports multi-member concatenated `.gz` streams.
public final class StreamingGzipDecoder {
  private enum Mode {
    case undecided
    case passthrough
    case gzip
  }

  private var mode: Mode = .undecided
  private var headerBuf: [UInt8] = []
  private var stream = z_stream()
  private var initialized = false
  private var sawStreamEnd = false
  private var outBuf = [UInt8](repeating: 0, count: 65_536)

  public init() {}

  deinit {
    if initialized {
      inflateEnd(&stream)
      initialized = false
    }
  }

  public func feed(
    _ chunk: UnsafeBufferPointer<UInt8>,
    onBytes: (UnsafeBufferPointer<UInt8>) throws -> Void
  ) throws {
    guard chunk.count > 0 else { return }
    if mode == .undecided {
      headerBuf.append(contentsOf: chunk)
      if headerBuf.count < 2 { return }
      let isGzip = headerBuf[0] == 0x1F && headerBuf[1] == 0x8B
      let pending = headerBuf
      headerBuf.removeAll(keepingCapacity: false)
      if isGzip {
        try initInflater()
        mode = .gzip
        try pending.withUnsafeBufferPointer { ptr in
          try inflateChunk(ptr, onBytes: onBytes)
        }
      } else {
        mode = .passthrough
        try pending.withUnsafeBufferPointer { ptr in
          try onBytes(ptr)
        }
      }
      return
    }
    if mode == .passthrough {
      try onBytes(chunk)
    } else {
      try inflateChunk(chunk, onBytes: onBytes)
    }
  }

  public func finish(onBytes: (UnsafeBufferPointer<UInt8>) throws -> Void) throws {
    defer {
      if initialized {
        inflateEnd(&stream)
        initialized = false
      }
    }
    if mode == .undecided && !headerBuf.isEmpty {
      let pending = headerBuf
      headerBuf.removeAll(keepingCapacity: false)
      mode = .passthrough
      try pending.withUnsafeBufferPointer { ptr in
        try onBytes(ptr)
      }
      return
    }
    if mode == .gzip {
      if initialized && !sawStreamEnd {
        stream.next_in = nil
        stream.avail_in = 0
        while true {
          var produced = 0
          var rc: Int32 = Z_OK
          outBuf.withUnsafeMutableBufferPointer { outPtr in
            stream.next_out = outPtr.baseAddress
            stream.avail_out = uInt(outPtr.count)
            rc = inflate(&stream, Z_FINISH)
            produced = outPtr.count - Int(stream.avail_out)
          }
          if produced > 0 {
            try outBuf.withUnsafeBufferPointer { outPtr in
              try onBytes(UnsafeBufferPointer(start: outPtr.baseAddress, count: produced))
            }
          }
          if rc == Z_STREAM_END {
            sawStreamEnd = true
            break
          }
          if rc == Z_BUF_ERROR || produced == 0 {
            break
          }
          if rc != Z_OK {
            throw XmltvStreamError.gzipCorrupt
          }
        }
      }
      if !sawStreamEnd {
        throw XmltvStreamError.gzipCorrupt
      }
    }
  }

  private func initInflater() throws {
    stream = z_stream()
    let rc = inflateInit2_(&stream, 15 + 32, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size))
    guard rc == Z_OK else { throw XmltvStreamError.gzipInitFailed }
    initialized = true
    sawStreamEnd = false
  }

  private func inflateChunk(
    _ chunk: UnsafeBufferPointer<UInt8>,
    onBytes: (UnsafeBufferPointer<UInt8>) throws -> Void
  ) throws {
    guard let base = chunk.baseAddress, chunk.count > 0 else { return }
    if sawStreamEnd {
      guard inflateReset(&stream) == Z_OK else { throw XmltvStreamError.gzipCorrupt }
      sawStreamEnd = false
    }
    stream.next_in = UnsafeMutablePointer<Bytef>(mutating: base)
    stream.avail_in = uInt(chunk.count)

    while stream.avail_in > 0 {
      var produced = 0
      var rc: Int32 = Z_OK
      outBuf.withUnsafeMutableBufferPointer { outPtr in
        stream.next_out = outPtr.baseAddress
        stream.avail_out = uInt(outPtr.count)
        rc = inflate(&stream, Z_NO_FLUSH)
        produced = outPtr.count - Int(stream.avail_out)
      }
      if produced > 0 {
        try outBuf.withUnsafeBufferPointer { outPtr in
          try onBytes(UnsafeBufferPointer(start: outPtr.baseAddress, count: produced))
        }
      }
      if rc == Z_STREAM_END {
        sawStreamEnd = true
        if stream.avail_in > 0 {
          guard inflateReset(&stream) == Z_OK else { throw XmltvStreamError.gzipCorrupt }
          sawStreamEnd = false
        } else {
          break
        }
      } else if rc == Z_BUF_ERROR {
        if produced == 0 { break }
      } else if rc != Z_OK {
        throw XmltvStreamError.gzipCorrupt
      }
    }
  }
}
