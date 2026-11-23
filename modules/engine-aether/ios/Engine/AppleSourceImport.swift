import Foundation

#if os(iOS)
import UIKit
import UniformTypeIdentifiers

private let maxLocalPlaylistBytes = 64 * 1024 * 1024
private let playlistReadChunkBytes = 64 * 1024

enum ApplePlaylistImportError: LocalizedError {
  case tooLarge(limitBytes: Int)
  case unreadable

  var errorDescription: String? {
    switch self {
    case let .tooLarge(limitBytes):
      return "Local playlist exceeds \(limitBytes) byte limit."
    case .unreadable:
      return "Unable to read the selected playlist file."
    }
  }
}

private func readBoundedSecurityScopedPlaylist(url: URL) throws -> [String: String] {
  let accessed = url.startAccessingSecurityScopedResource()
  defer {
    if accessed {
      url.stopAccessingSecurityScopedResource()
    }
  }

  if let values = try? url.resourceValues(forKeys: [.fileSizeKey]),
     let size = values.fileSize,
     size > maxLocalPlaylistBytes
  {
    throw ApplePlaylistImportError.tooLarge(limitBytes: maxLocalPlaylistBytes)
  }

  guard let handle = try? FileHandle(forReadingFrom: url) else {
    throw ApplePlaylistImportError.unreadable
  }
  defer { try? handle.close() }

  var buffer = Data()
  while true {
    guard let chunk = try handle.read(upToCount: playlistReadChunkBytes), !chunk.isEmpty else {
      break
    }
    if buffer.count + chunk.count > maxLocalPlaylistBytes {
      throw ApplePlaylistImportError.tooLarge(limitBytes: maxLocalPlaylistBytes)
    }
    buffer.append(chunk)
  }

  let rawName = url.lastPathComponent.trimmingCharacters(in: .whitespacesAndNewlines)
  let name = rawName.isEmpty ? "playlist.m3u" : rawName
  return [
    "name": name,
    "base64": buffer.base64EncodedString(),
  ]
}

@MainActor
private final class AppleDocumentPickerCoordinator:
  NSObject,
  UIDocumentPickerDelegate,
  UIAdaptivePresentationControllerDelegate
{
  static let shared = AppleDocumentPickerCoordinator()

  private var pendingCompletion: (@Sendable (Result<[String: String]?, Error>) -> Void)?

  func present(completion: @escaping @Sendable (Result<[String: String]?, Error>) -> Void) {
    guard let presenter = Self.topViewController() else {
      completion(.success(nil))
      return
    }
    finishPending(with: .success(nil))
    pendingCompletion = completion

    var contentTypes: [UTType] = [.m3uPlaylist, .plainText, .gzip, .data]
    if let m3u8 = UTType(filenameExtension: "m3u8") {
      contentTypes.insert(m3u8, at: 0)
    }

    let picker = UIDocumentPickerViewController(forOpeningContentTypes: contentTypes, asCopy: false)
    picker.delegate = self
    picker.allowsMultipleSelection = false
    picker.presentationController?.delegate = self
    presenter.present(picker, animated: true)
  }

  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    guard let completion = takePending() else { return }
    guard let url = urls.first else {
      completion(.success(nil))
      return
    }
    DispatchQueue.global(qos: .userInitiated).async {
      do {
        let payload = try readBoundedSecurityScopedPlaylist(url: url)
        completion(.success(payload))
      } catch {
        completion(.failure(error))
      }
    }
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    finishPending(with: .success(nil))
  }

  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
    finishPending(with: .success(nil))
  }

  private func takePending() -> (@Sendable (Result<[String: String]?, Error>) -> Void)? {
    let completion = pendingCompletion
    pendingCompletion = nil
    return completion
  }

  private func finishPending(with result: Result<[String: String]?, Error>) {
    takePending()?(result)
  }

  private static func topViewController() -> UIViewController? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let activeScene = scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
    let keyWindow = activeScene?.windows.first { $0.isKeyWindow } ?? activeScene?.windows.first
    var current = keyWindow?.rootViewController
    while let presented = current?.presentedViewController {
      current = presented
    }
    return current
  }
}

/// iOS clipboard and document-picker bridge (zero storage permissions, 64 MiB cap, #51).
@MainActor
enum AppleSourceImport {
  static func readClipboardText() -> String? {
    guard let text = UIPasteboard.general.string, !text.isEmpty else { return nil }
    return text
  }

  static func pickPlaylistFile(
    completion: @escaping @Sendable (Result<[String: String]?, Error>) -> Void
  ) {
    AppleDocumentPickerCoordinator.shared.present(completion: completion)
  }
}
#else
/// tvOS / non-iOS no-op stub keeping Swift 6 & tvOS Xcode builds 100% clean (#51).
@MainActor
enum AppleSourceImport {
  static func readClipboardText() -> String? {
    nil
  }

  static func pickPlaylistFile(
    completion: @escaping @Sendable (Result<[String: String]?, Error>) -> Void
  ) {
    completion(.success(nil))
  }
}
#endif
