package io.github.fatihmutluu.elv.qrscanner

import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.nio.ByteBuffer

class QrScannerDecoderTest {
  private fun renderQrLuminance(payload: String, size: Int = 256): ByteArray {
    val matrix = QRCodeWriter().encode(payload, BarcodeFormat.QR_CODE, size, size)
    val bytes = ByteArray(size * size)
    for (y in 0 until size) {
      for (x in 0 until size) {
        bytes[y * size + x] = if (matrix.get(x, y)) 0x10.toByte() else 0xF0.toByte()
      }
    }
    return bytes
  }

  @Test
  fun decodesStandardAndInvertedQrLuminancePayloads() {
    val expected = "elviptv://pair?c=12345678&pk=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"
    val width = 256
    val height = 256
    val normal = renderQrLuminance(expected, width)
    val decoder = QrCodeFrameDecoder()

    assertEquals(expected, decoder.decode(normal, width, height))

    val inverted = ByteArray(normal.size) { idx -> (255 - (normal[idx].toInt() and 0xFF)).toByte() }
    assertEquals(expected, decoder.decode(inverted, width, height))
  }

  @Test
  fun extractsCompactLuminanceAcrossStridedBuffersAndReturnsNullForBlankFrames() {
    val width = 256
    val height = 256
    val rowStride = 320
    val expected = "elviptv://pair?c=87654321&pk=XYZ"
    val compact = renderQrLuminance(expected, width)

    // Pad each row with dummy bytes to simulate hardware YUV_420_888 rowStride > width,
    // leaving the final row unpadded just like Android ImageProxy plane buffers.
    val stridedSize = (height - 1) * rowStride + width
    val buffer = ByteBuffer.allocate(stridedSize)
    for (row in 0 until height) {
      buffer.position(row * rowStride)
      buffer.put(compact, row * width, width)
    }
    buffer.rewind()

    val extracted = extractCompactLuminance(buffer, width, height, rowStride, pixelStride = 1)
    assertEquals(width * height, extracted.size)

    val decoder = QrCodeFrameDecoder()
    assertEquals(expected, decoder.decode(extracted, width, height))
    assertNull(decoder.decode(ByteArray(width * height) { 0x80.toByte() }, width, height))
  }
}
