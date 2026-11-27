package io.github.fatihmutluu.elv.qrscanner

import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.ReaderException
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import java.nio.ByteBuffer
import java.util.EnumMap

/**
 * Extracts a compact [width] x [height] Y-plane luminance byte buffer from a YUV_420_888 plane
 * buffer, handling arbitrary [rowStride] padding and [pixelStride] safely without mutating the
 * caller's buffer position.
 */
internal fun extractCompactLuminance(
  buffer: ByteBuffer,
  width: Int,
  height: Int,
  rowStride: Int,
  pixelStride: Int,
  reuse: ByteArray? = null,
): ByteArray {
  if (width <= 0 || height <= 0 || rowStride <= 0 || pixelStride <= 0) {
    return ByteArray(0)
  }
  val needed = width * height
  val out = if (reuse != null && reuse.size == needed) reuse else ByteArray(needed)
  val dup = buffer.duplicate()
  val limit = dup.limit()

  if (pixelStride == 1 && rowStride == width) {
    val copyLen = minOf(needed, maxOf(0, limit - dup.position()))
    if (copyLen > 0) {
      dup.get(out, 0, copyLen)
    }
    return out
  }

  val basePos = dup.position()
  for (row in 0 until height) {
    val rowStart = basePos + row * rowStride
    if (rowStart >= limit) break
    val destOffset = row * width
    if (pixelStride == 1) {
      val copyLen = minOf(width, limit - rowStart)
      dup.position(rowStart)
      dup.get(out, destOffset, copyLen)
    } else {
      for (col in 0 until width) {
        val idx = rowStart + col * pixelStride
        if (idx >= limit) break
        out[destOffset + col] = dup.get(idx)
      }
    }
  }
  return out
}

/** Pure Apache-2.0 ZXing QR decoder over compact luminance frames (`#510`). */
internal class QrCodeFrameDecoder {
  private val reader = QRCodeReader()
  private val hints: Map<DecodeHintType, Any> = EnumMap<DecodeHintType, Any>(DecodeHintType::class.java).apply {
    put(DecodeHintType.CHARACTER_SET, "UTF-8")
    put(DecodeHintType.TRY_HARDER, true)
  }

  fun decode(yData: ByteArray, width: Int, height: Int): String? {
    if (width <= 0 || height <= 0 || yData.size < width * height) {
      return null
    }
    val source = PlanarYUVLuminanceSource(yData, width, height, 0, 0, width, height, false)
    val primary = try {
      reader.decode(BinaryBitmap(HybridBinarizer(source)), hints).text
    } catch (_: ReaderException) {
      null
    } finally {
      reader.reset()
    }
    val primaryTrimmed = primary?.trim()?.takeIf { it.isNotEmpty() }
    if (primaryTrimmed != null) {
      return primaryTrimmed
    }

    val inverted = try {
      reader.decode(BinaryBitmap(HybridBinarizer(source.invert())), hints).text
    } catch (_: ReaderException) {
      null
    } finally {
      reader.reset()
    }
    return inverted?.trim()?.takeIf { it.isNotEmpty() }
  }
}
