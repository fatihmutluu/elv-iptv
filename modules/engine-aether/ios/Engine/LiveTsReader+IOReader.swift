import AetherEngine
import Foundation

extension LiveTsReader: IOReader {
  public func read(_ buffer: UnsafeMutablePointer<UInt8>?, size: Int32) -> Int32 {
    guard let buffer else { return -1 }
    return read(into: buffer, size: size)
  }

  public func seek(offset: Int64, whence: Int32) -> Int64 {
    -1
  }

  public func makeIndependentReader() -> IOReader? {
    nil
  }

  public var discImageProbeEnabled: Bool {
    false
  }
}
