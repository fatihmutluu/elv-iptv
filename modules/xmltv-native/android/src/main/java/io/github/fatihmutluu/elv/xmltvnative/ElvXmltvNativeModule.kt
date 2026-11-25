package io.github.fatihmutluu.elv.xmltvnative

import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Expo native module that streams HTTP(S) XMLTV guides off the Hermes JS thread and stages rows
 * directly into SQLite `programmes_next` (`#478`). Never logs URLs, headers, or credentials.
 */
class ElvXmltvNativeModule : Module() {
  private val stager = NativeXmltvStager()

  override fun definition() = ModuleDefinition {
    Name("ElvXmltvNative")

    AsyncFunction("stageXmltv") { options: Map<String, Any?>, promise: Promise ->
      val jobId = options["jobId"] as? String
      val url = options["url"] as? String
      val dbPath = options["dbPath"] as? String
      val sourceId = options["sourceId"] as? String
      val runId = (options["runId"] as? Number)?.toLong()
      val fromMs = (options["fromMs"] as? Number)?.toLong()
      val toMs = (options["toMs"] as? Number)?.toLong()
      if (jobId.isNullOrEmpty() || url.isNullOrEmpty() || dbPath.isNullOrEmpty() ||
        sourceId.isNullOrEmpty() || runId == null || fromMs == null || toMs == null
      ) {
        promise.reject("E_XMLTV_INVALID_REQUEST", "Missing required XMLTV stage parameters", null)
        return@AsyncFunction
      }

      val rawHeaders = options["headers"] as? Map<*, *>
      val headers = HashMap<String, String>()
      if (rawHeaders != null) {
        for ((k, v) in rawHeaders) {
          if (k is String && v is String) headers[k] = v
        }
      }
      val timeoutMs = ((options["timeoutMs"] as? Number)?.toInt() ?: NativeXmltvStager.DEFAULT_TIMEOUT_MS)
        .coerceIn(1_000, 600_000)
      val request = NativeStageRequest(
        jobId = jobId,
        url = url,
        dbPath = dbPath,
        sourceId = sourceId,
        runId = runId,
        fromMs = fromMs,
        toMs = toMs,
        headers = headers,
        ifNoneMatch = options["ifNoneMatch"] as? String,
        ifModifiedSince = options["ifModifiedSince"] as? String,
        defaultTimeZone = options["defaultTimeZone"] as? String,
        timeoutMs = timeoutMs,
      )

      stager.enqueue(request) { outcome ->
        promise.resolve(outcomeToMap(outcome))
      }
    }

    Function("cancelXmltvStage") { jobId: String ->
      stager.cancel(jobId)
    }

    Function("cleanupStageFile") { path: String ->
      NativeXmltvStager.cleanupStageFile(path)
    }

    OnDestroy {
      stager.cancelAll()
    }
  }

  private fun outcomeToMap(outcome: NativeStageOutcome): Map<String, Any?> {
    return when (outcome) {
      is NativeStageOutcome.NotModified -> {
        val map = HashMap<String, Any?>(3)
        map["kind"] = "not-modified"
        if (!outcome.etag.isNullOrEmpty()) map["etag"] = outcome.etag
        if (!outcome.lastModified.isNullOrEmpty()) map["lastModified"] = outcome.lastModified
        map
      }
      is NativeStageOutcome.HttpError -> mapOf(
        "kind" to "http-error",
        "status" to outcome.status,
        "retryable" to outcome.retryable,
        "code" to outcome.code,
      )
      is NativeStageOutcome.Staged -> {
        val channels = outcome.summary.channels.map { ch ->
          val entry = HashMap<String, Any?>(4)
          entry["id"] = ch.id
          entry["names"] = ch.names
          if (!ch.icon.isNullOrEmpty()) entry["icon"] = ch.icon
          if (!ch.lcn.isNullOrEmpty()) entry["lcn"] = ch.lcn
          entry
        }
        val map = HashMap<String, Any?>(10)
        map["kind"] = "staged"
        map["stageDbPath"] = outcome.stageDbPath
        map["channels"] = channels
        map["stagedCounts"] = outcome.summary.stagedCounts
        map["seenProgrammes"] = outcome.summary.seenProgrammes
        map["stagedProgrammes"] = outcome.summary.stagedProgrammes
        map["warnings"] = outcome.summary.warnings
        map["warningCodes"] = outcome.summary.warningCodes
        if (!outcome.etag.isNullOrEmpty()) map["etag"] = outcome.etag
        if (!outcome.lastModified.isNullOrEmpty()) map["lastModified"] = outcome.lastModified
        map
      }
    }
  }
}
