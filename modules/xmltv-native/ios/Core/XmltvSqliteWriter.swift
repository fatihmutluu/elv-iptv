import Foundation
import SQLite3

public enum XmltvSqliteError: Error, Sendable, Equatable {
  case openFailed(Int32)
  case execFailed(Int32)
  case prepareFailed(Int32)
  case stepFailed(Int32)
}

private let sqliteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

/// Direct `libsqlite3` writer staging `StagedProgrammeRow` records into `programmes_next`
/// using a prepared `INSERT OR REPLACE` statement in 2,500-row `BEGIN IMMEDIATE` transactions.
public final class XmltvSqliteWriter {
  public static let defaultBatchSize = 2_500

  private static let insertSql =
    "INSERT OR REPLACE INTO programmes_next " +
    "(source_id, guide_id, start, stop, title, sub_title, description, categories_json, " +
    "episode_num, icon, run_id, genre, flags, rating_system, rating_value, title_fold, description_fold) " +
    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"

  private var db: OpaquePointer?
  private var stmt: OpaquePointer?
  private let batchSize: Int
  private var inTransaction = false
  private var batchCount = 0

  public init(dbPath: String, batchSize: Int = XmltvSqliteWriter.defaultBatchSize) throws {
    self.batchSize = max(1, batchSize)
    var handle: OpaquePointer?
    let openRc = sqlite3_open_v2(dbPath, &handle, SQLITE_OPEN_READWRITE, nil)
    guard openRc == SQLITE_OK, let opened = handle else {
      if let handle { sqlite3_close(handle) }
      throw XmltvSqliteError.openFailed(openRc)
    }
    self.db = opened
    do {
      try exec("PRAGMA busy_timeout = 5000;")
      try exec("PRAGMA synchronous = NORMAL;")
      try exec("PRAGMA temp_store = MEMORY;")
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
