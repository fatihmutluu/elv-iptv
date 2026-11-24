package io.github.fatihmutluu.elv.lanpairing

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.lang.ref.WeakReference

/**
 * Expo native module hosting an ephemeral single-use local-network HTTP server for phone-to-TV
 * QR source pairing (`#50`). Stops and releases sockets automatically on first valid submission,
 * TTL expiry, `stopServer`, or `OnDestroy`.
 */
class ElvLanPairingModule : Module() {
  private val lock = Any()
  private var activeServer: LanPairingHttpServer? = null

  override fun definition() = ModuleDefinition {
    Name("ElvLanPairing")

    Events("onSubmission")

    Function("generateToken") {
      LanPairingPayloadValidator.generateToken()
    }

    AsyncFunction("startServer") { options: Map<String, Any?> ->
      val token = options["token"] as? String
        ?: throw IllegalArgumentException("Missing pairing token")
      val html = options["html"] as? String
        ?: throw IllegalArgumentException("Missing pairing HTML")
      val ttlMs = (options["ttlMs"] as? Number)?.toLong()
        ?: throw IllegalArgumentException("Missing pairing ttlMs")
      val maxBodyBytes = (options["maxBodyBytes"] as? Number)?.toInt()
        ?: LanPairingHttpServer.DEFAULT_MAX_BODY_BYTES
      val maxFailedAttempts = (options["maxFailedAttempts"] as? Number)?.toInt()
        ?: LanPairingHttpServer.DEFAULT_MAX_FAILED_ATTEMPTS

      val weakModule = WeakReference(this@ElvLanPairingModule)
      val server = LanPairingHttpServer(
        token = token,
        html = html,
        ttlMs = ttlMs,
        maxBodyBytes = maxBodyBytes,
        maxFailedAttempts = maxFailedAttempts,
        onSubmission = { body, contentType ->
          val payload = HashMap<String, Any>(2)
          payload["body"] = body
          if (!contentType.isNullOrEmpty()) {
            payload["contentType"] = contentType
          }
          weakModule.get()?.sendEvent("onSubmission", payload)
        },
      )

      val info = synchronized(lock) {
        activeServer?.stop()
        activeServer = null
        val started = server.start()
        activeServer = server
        started
      }

      mapOf(
        "host" to info.host,
        "port" to info.port,
        "url" to info.url,
        "expiresAtMs" to info.expiresAtMs.toDouble(),
      )
    }

    AsyncFunction("stopServer") {
      stopActiveServer()
    }

    OnDestroy {
      stopActiveServer()
    }
  }

  private fun stopActiveServer() {
    val previous = synchronized(lock) {
      val current = activeServer
      activeServer = null
      current
    }
    previous?.stop()
  }
}
