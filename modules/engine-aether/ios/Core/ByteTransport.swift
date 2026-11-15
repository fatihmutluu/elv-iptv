import Foundation

/// Events delivered by a `ByteTransport` for one HTTP stream request.
public protocol ByteTransportDelegate: AnyObject, Sendable {
  func transportDidReceive(status: Int, contentType: String?)
  func transportDidReceive(_ data: Data)
  func transportDidComplete(error: ReaderFailure?)
}

/// Abstract forward-only HTTP byte stream used by `LiveTsReader`.
public protocol ByteTransport: AnyObject, Sendable {
  func start(url: URL, headers: [String: String], delegate: ByteTransportDelegate)
  func cancel()
  func suspend()
  func resume()
}
