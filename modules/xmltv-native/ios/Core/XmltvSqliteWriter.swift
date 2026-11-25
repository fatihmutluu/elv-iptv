import Foundation
import SQLite3

public enum XmltvSqliteError: Error, Sendable, Equatable {
  case openFailed(Int32)
  case execFailed(Int32)
  case prepareFailed(Int32)
  case stepFailed(Int32)
}

private let sqliteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

/// Direct `libsqlite3` writer staging `StagedProgrammeRow` records into a brand-new temp SQLite
/// database (never opening `catalog.db`) in 2,500-row transactions.
public final class XmltvSqliteWriter {
  public static let defaultBatchSize = 2_500
  private static let maxJobIdLen = 96

  private static let createTableSql =
    "CREATE TABLE programmes_next (" +
    "source_id TEXT NOT NULL, " +
    "guide_id TEXT NOT NULL, " +
    "start INTEGER NOT NULL, " +
    "stop INTEGER NOT NULL, " +
    "title TEXT NOT NULL, " +
    "sub_title TEXT, " +
    "description TEXT, " +
    "categories_json TEXT, " +
    "episode_num TEXT, " +
    "icon TEXT, " +
    "run_id INTEGER NOT NULL, " +
    "genre TEXT, " +
    "flags INTEGER NOT NULL DEFAULT 0, " +
    "rating_system TEXT, " +
    "rating_value TEXT, " +
    "title_fold TEXT NOT NULL DEFAULT '', " +
    "description_fold TEXT NOT NULL DEFAULT '', " +
    "PRIMARY KEY (source_id, guide_id, start)" +
    ") WITHOUT ROWID;"

  private static let insertSql =
    "INSERT OR REPLACE INTO programmes_next " +
    "(source_id, guide_id, start, stop, title, sub_title, description, categories_json, " +
    "episode_num, icon, run_id, genre, flags, rating_system, rating_value, title_fold, description_fold) " +
    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"

  public static func stageDbPath(for dbPath: String, jobId: String) -> String {
    var safe = ""
    safe.reserveCapacity(min(jobId.count, maxJobIdLen))
    for scalar in jobId.unicodeScalars {
      if safe.count >= maxJobIdLen { break }
      let v = scalar.value
      let allowed =
        (v >= 65 && v <= 90) || (v >= 97 && v <= 122) ||
        (v >= 48 && v <= 57) || v == 95 || v == 45
      safe.append(allowed ? Character(scalar) : "_")
    }
    if safe.isEmpty { safe = "job" }
    return "\(dbPath).xmltv-stage-\(safe).db"
  }

  public static func isValidStageFilePath(_ path: String) -> Bool {
    guard !path.isEmpty, !path.contains("\0") else { return false }
    let name = (path as NSString).lastPathComponent
    guard name.hasSuffix(".db") else { return false }
    let withoutExt = name.dropLast(3)
    guard let marker = withoutExt.range(of: ".xmltv-stage-", options: .backwards) else {
      return false
    }
    let jobPart = withoutExt[marker.upperBound...]
    guard !jobPart.isEmpty else { return false }
    for scalar in jobPart.unicodeScalars {
      let v = scalar.value
      let allowed =
        (v >= 65 && v <= 90) || (v >= 97 && v <= 122) ||
        (v >= 48 && v <= 57) || v == 95 || v == 45
      if !allowed { return false }
    }
    return true
  }

  public static func cleanupStageFile(_ path: String) {
    guard isValidStageFilePath(path) else { return }
    let fm = FileManager.default
    for suffix in ["", "-wal", "-shm", "-journal"] {
      let candidate = path + suffix
      if fm.fileExists(atPath: candidate) {
        try? fm.removeItem(atPath: candidate)
      }
    }
  }

  public let stageDbPath: String
  private var db: OpaquePointer?
  private var stmt: OpaquePointer?
  private let batchSize: Int
  private var inTransaction = false
  private var batchCount = 0

  public init(stageDbPath: String, batchSize: Int = XmltvSqliteWriter.defaultBatchSize) throws {
    self.stageDbPath = stageDbPath
    self.batchSize = max(1, batchSize)
    Self.removeFileAndSidecars(stageDbPath)
    var handle: OpaquePointer?
    let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE
    let openRc = sqlite3_open_v2(stageDbPath, &handle, flags, nil)
    guard openRc == SQLITE_OK, let opened = handle else {
      if let handle { sqlite3_close(handle) }
      Self.removeFileAndSidecars(stageDbPath)
      throw XmltvSqliteError.openFailed(openRc)
    }
    self.db = opened
    do {
      try exec("PRAGMA journal_mode = OFF;")
      try exec("PRAGMA synchronous = OFF;")
      try exec("PRAGMA temp_store = MEMORY;")
      try exec(Self.createTableSql)
      var prepared: OpaquePointer?
      let prepRc = sqlite3_prepare_v2(opened, Self.insertSql, -1, &prepared, nil)
      guard prepRc == SQLITE_OK, let compiled = prepared else {
        throw XmltvSqliteError.prepareFailed(prepRc)
      }
      self.stmt = compiled
      try exec("BEGIN IMMEDIATE;")
      self.inTransaction = true
    } catch {
      close()
      Self.removeFileAndSidecars(stageDbPath)
      throw error
    }
  }

  deinit {
    close()
  }

  public func write(_ row: StagedProgrammeRow) throws {
    guard let stmt else { throw XmltvSqliteError.prepareFailed(SQLITE_MISUSE) }
    sqlite3_reset(stmt)
    sqlite3_clear_bindings(stmt)

    bindText(stmt, 1, row.sourceId)
    bindText(stmt, 2, row.guideId)
    sqlite3_bind_int64(stmt, 3, row.start)
    sqlite3_bind_int64(stmt, 4, row.stop)
    bindText(stmt, 5, row.title)
    bindOptionalText(stmt, 6, row.subTitle)
    bindOptionalText(stmt, 7, row.description)
    bindOptionalText(stmt, 8, row.categoriesJson)
    bindOptionalText(stmt, 9, row.episodeNum)
    bindOptionalText(stmt, 10, row.icon)
    sqlite3_bind_int64(stmt, 11, row.runId)
    bindOptionalText(stmt, 12, row.genre)
    sqlite3_bind_int(stmt, 13, row.flags)
    bindOptionalText(stmt, 14, row.ratingSystem)
    bindOptionalText(stmt, 15, row.ratingValue)
    bindText(stmt, 16, row.titleFold)
    bindText(stmt, 17, row.descriptionFold)

    let stepRc = sqlite3_step(stmt)
    guard stepRc == SQLITE_DONE else {
      throw XmltvSqliteError.stepFailed(stepRc)
    }
    batchCount += 1
    if batchCount >= batchSize {
      try exec("COMMIT;")
      inTransaction = false
      batchCount = 0
      try exec("BEGIN IMMEDIATE;")
      inTransaction = true
    }
  }

  public func finish() throws {
    if inTransaction {
      try exec("COMMIT;")
      inTransaction = false
      batchCount = 0
    }
    close()
  }

  public func abort() {
    if inTransaction, let db {
      sqlite3_exec(db, "ROLLBACK;", nil, nil, nil)
      inTransaction = false
      batchCount = 0
    }
    close()
    Self.removeFileAndSidecars(stageDbPath)
  }

  public func close() {
    if inTransaction, let db {
      sqlite3_exec(db, "ROLLBACK;", nil, nil, nil)
      inTransaction = false
    }
    if let stmt {
      sqlite3_finalize(stmt)
      self.stmt = nil
    }
    if let db {
      sqlite3_close(db)
      self.db = nil
    }
  }

  private static func removeFileAndSidecars(_ path: String) {
    let fm = FileManager.default
    for suffix in ["", "-wal", "-shm", "-journal"] {
      let candidate = path + suffix
      if fm.fileExists(atPath: candidate) {
        try? fm.removeItem(atPath: candidate)
      }
    }
  }

  private func exec(_ sql: String) throws {
    guard let db else { throw XmltvSqliteError.execFailed(SQLITE_MISUSE) }
    let rc = sqlite3_exec(db, sql, nil, nil, nil)
    guard rc == SQLITE_OK else {
      throw XmltvSqliteError.execFailed(rc)
    }
  }

  private func bindText(_ stmt: OpaquePointer, _ index: Int32, _ value: String) {
    _ = value.withCString { cstr in
      sqlite3_bind_text(stmt, index, cstr, -1, sqliteTransient)
    }
  }

  private func bindOptionalText(_ stmt: OpaquePointer, _ index: Int32, _ value: String?) {
    if let value {
      bindText(stmt, index, value)
    } else {
      sqlite3_bind_null(stmt, index)
    }
  }
}
