package io.github.fatihmutluu.elv.media3

import android.graphics.Bitmap
import android.text.Layout
import android.text.SpannableString
import android.text.style.StyleSpan
import android.graphics.Typeface
import androidx.annotation.OptIn
import androidx.media3.common.text.Cue
import androidx.media3.common.util.UnstableApi
import java.nio.charset.Charset
import java.nio.charset.StandardCharsets
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@OptIn(UnstableApi::class)
@RunWith(RobolectricTestRunner::class)
class SubtitleSanitizerTest {
  private fun mojibakeWindows1252(utf8Text: String): String =
    String(utf8Text.toByteArray(StandardCharsets.UTF_8), Charset.forName("windows-1252"))

  private fun mojibakeIso88591(utf8Text: String): String =
    String(utf8Text.toByteArray(StandardCharsets.UTF_8), StandardCharsets.ISO_8859_1)

  @Test
  fun `repairs Turkish UTF-8-as-Windows-1252 and ISO-8859-1 mojibake and is idempotent (#184)`() {
    val turkish = "ğüşiöçĞÜŞİÖÇ — İstanbul’da “güneş” doğuyor!"
    val cp1252Garbled = mojibakeWindows1252(turkish)
    val latin1Garbled = mojibakeIso88591(turkish)

    assertEquals(turkish, sanitizeSubtitleText(cp1252Garbled).toString())
    assertEquals(turkish, sanitizeSubtitleText(latin1Garbled).toString())
    // Idempotent on already-valid UTF-8
    assertEquals(turkish, sanitizeSubtitleText(turkish).toString())
    assertSame(turkish, sanitizeSubtitleText(turkish))
  }

  @Test
  fun `repairs typographic quotes, dashes and European accents without corrupting genuine Latin-1 text (#184)`() {
    val sample = "“It’s fine,” she said — café, naïve, über, español."
    val garbled = mojibakeWindows1252(sample)
    assertEquals(sample, sanitizeSubtitleText(garbled).toString())

    // Genuine German/French/Swedish words containing Ä, Å, Ã, â must remain untouched
    val genuine = listOf("Äpfel im Garten", "Åland islands", "São Paulo", "bâtiment", "öçü", "“Hello’s — world”")
    for (line in genuine) {
      assertEquals(line, sanitizeSubtitleText(line).toString())
      assertSame(line, sanitizeSubtitleText(line))
    }
  }

  @Test
  fun `strips stray U+FFFD replacement characters while preserving valid spans (#184)`() {
    assertEquals("Hello world", sanitizeSubtitleText("Hello\uFFFD world").toString())
    assertEquals("Test", sanitizeSubtitleText("\uFFFDTest\uFFFD").toString())
    assertEquals(
      "“Merhaba” günaydın",
      sanitizeSubtitleText(mojibakeWindows1252("“Merhaba”") + " \uFFFD " + mojibakeWindows1252("günaydın")).toString().replace("  ", " "),
    )

    val spanned = SpannableString("Valid Turkish: ğüşiöç").apply {
      setSpan(StyleSpan(Typeface.ITALIC), 0, 5, 0)
    }
    assertSame("clean spanned text must keep original Spanned instance", spanned, sanitizeSubtitleText(spanned))
  }

  @Test
  fun `sanitizeCues preserves DVB-PGS bitmap cues and Cue layout attributes (#184)`() {
    val bitmap = Bitmap.createBitmap(4, 4, Bitmap.Config.ARGB_8888)
    val bitmapCue = Cue.Builder()
      .setBitmap(bitmap)
      .setPosition(0.5f)
      .setLine(0.8f, Cue.LINE_TYPE_FRACTION)
      .setSize(0.4f)
      .setBitmapHeight(0.1f)
      .build()
    val garbledCue = Cue.Builder()
      .setText(mojibakeWindows1252("Şimdi başlıyor — “Harika”"))
      .setTextAlignment(Layout.Alignment.ALIGN_CENTER)
      .setLine(0.9f, Cue.LINE_TYPE_FRACTION)
      .setPosition(0.5f)
      .setWindowColor(0x80000000.toInt())
      .build()
    val cleanCue = Cue.Builder().setText("Already clean").build()

    val result = sanitizeCues(listOf(bitmapCue, garbledCue, cleanCue))
    assertEquals(3, result.size)
    // Bitmap cue passes through untouched
    assertSame(bitmapCue, result[0])
    assertNull(result[0].text)
    assertSame(bitmap, result[0].bitmap)
    // Garbled cue text is repaired and all layout/styling preserved
    assertEquals("Şimdi başlıyor — “Harika”", result[1].text.toString())
    assertEquals(Layout.Alignment.ALIGN_CENTER, result[1].textAlignment)
    assertEquals(0.9f, result[1].line, 0.0001f)
    assertEquals(0.5f, result[1].position, 0.0001f)
    assertEquals(0x80000000.toInt(), result[1].windowColor)
    // Clean cue passes through untouched
    assertSame(cleanCue, result[2])

    // List with no changes returns original list reference
    val cleanList = listOf(bitmapCue, cleanCue)
    assertSame(cleanList, sanitizeCues(cleanList))
  }

  @Test
  fun `stripSdhAnnotations strips brackets, nested brackets, speaker labels, and music lines while preserving years, dialogue, Turkish and RTL (#310)`() {
    // Balanced brackets and parentheses
    assertEquals("Hello world", stripSdhAnnotations("[dramatic music] Hello (sighs) world"))
    assertEquals("Hello", stripSdhAnnotations("[laughs [snorts]] Hello"))
    assertEquals("Hello", stripSdhAnnotations("[soft music\nplaying]\nHello"))
    assertEquals("", stripSdhAnnotations("[thunder rumbling]"))
    assertEquals("", stripSdhAnnotations("(footsteps approaching)"))

    // Preserves numeric/year/range expressions inside parentheses
    assertEquals("Released in (2024)", stripSdhAnnotations("Released in (2024)"))
    assertEquals("Episode (1-2) and (1–2)", stripSdhAnnotations("Episode (1-2) and (1–2)"))
    assertEquals("Score (98%)", stripSdhAnnotations("Score (98%)"))

    // Turkish Unicode uppercase speaker labels + dialogue dashes
    assertEquals("Başlıyoruz", stripSdhAnnotations("ŞEF: Başlıyoruz"))
    assertEquals("Merhaba (2024)", stripSdhAnnotations("İSTANBUL: [müzik] Merhaba (2024)"))
    assertEquals("- Hi\n- Yo", stripSdhAnnotations("- JOHN: Hi\n- MARY: Yo"))
    assertEquals("— Stay back.", stripSdhAnnotations("— DR. O'CONNOR: Stay back."))
    assertEquals("- Yo", stripSdhAnnotations("- JOHN: [laughs]\n- MARY: Yo"))

    // Preserves prose colons, timestamps, and RTL uncased text
    assertEquals("Note: meet at 10:30", stripSdhAnnotations("Note: meet at 10:30"))
    assertEquals("مرحبا: أهلا (2024)", stripSdhAnnotations("مرحبا: أهلا (2024)"))
    assertEquals("مرحبا أهلا", stripSdhAnnotations("مرحبا [موسيقى] أهلا"))
    assertEquals("\u2067- Hi\u2069", stripSdhAnnotations("\u2067- \u2066JOHN: Hi\u2069"))

    // Drops lone dashes and music lines
    assertEquals("", stripSdhAnnotations("♪"))
    assertEquals("", stripSdhAnnotations("♫\n♪ ♫"))
    assertEquals("", stripSdhAnnotations("- ♪"))
    assertEquals("", stripSdhAnnotations("-"))
    assertEquals("Keep this line", stripSdhAnnotations("♪ [upbeat music] ♪\nKeep this line\n—"))
  }

  @Test
  fun `sanitizeCues applies SDH filtering after mojibake repair, drops blank cues, and preserves bitmap cues (#310)`() {
    val bitmap = Bitmap.createBitmap(4, 4, Bitmap.Config.ARGB_8888)
    val bitmapCue = Cue.Builder().setBitmap(bitmap).build()
    val mojibakeSdhCue = Cue.Builder()
      .setText(mojibakeWindows1252("ŞEF: [alkış] Şimdi başlıyor (2024)"))
      .build()
    val sdhOnlyCue = Cue.Builder().setText("[dramatic music]\n♪").build()
    val cleanCue = Cue.Builder().setText("Normal dialogue").build()

    val filtered = sanitizeCues(listOf(bitmapCue, mojibakeSdhCue, sdhOnlyCue, cleanCue), filterSdh = true)
    assertEquals(3, filtered.size)
    assertSame(bitmapCue, filtered[0])
    assertEquals("Şimdi başlıyor (2024)", filtered[1].text.toString())
    assertSame(cleanCue, filtered[2])

    // All-blank text cues become empty list so SubtitleView clears cleanly
    assertEquals(emptyList<Cue>(), sanitizeCues(listOf(sdhOnlyCue), filterSdh = true))
  }
}
