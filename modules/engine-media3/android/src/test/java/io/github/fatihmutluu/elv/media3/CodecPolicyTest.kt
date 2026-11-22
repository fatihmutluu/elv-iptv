package io.github.fatihmutluu.elv.media3

import android.content.Context
import android.media.MediaCodecInfo.CodecCapabilities
import android.media.MediaCodecInfo.CodecProfileLevel
import android.os.Handler
import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.audio.AudioRendererEventListener
import androidx.media3.exoplayer.mediacodec.MediaCodecInfo
import androidx.media3.exoplayer.mediacodec.MediaCodecSelector
import androidx.media3.exoplayer.metadata.MetadataOutput
import androidx.media3.exoplayer.text.TextOutput
import androidx.media3.exoplayer.video.VideoRendererEventListener
import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@OptIn(UnstableApi::class)
@RunWith(RobolectricTestRunner::class)
class CodecPolicyTest {
  private fun codec(name: String, mime: String, hw: Boolean): MediaCodecInfo =
    MediaCodecInfo.newInstance(
      name,
      mime,
      mime,
      null,
      /* hardwareAccelerated = */ hw,
      /* softwareOnly = */ !hw,
      /* vendor = */ hw,
      /* forceDisableAdaptive = */ false,
      /* forceSecure = */ false,
    )

  private fun audioRendererClassNames(context: Context, softwareAudio: Boolean): List<String> {
    val renderers = createRenderersFactory(context, CodecPolicy(), softwareAudio).createRenderers(
      Handler(Looper.getMainLooper()),
      object : VideoRendererEventListener {},
      object : AudioRendererEventListener {},
      TextOutput {},
      MetadataOutput {},
    )
    return renderers.filter { it.trackType == C.TRACK_TYPE_AUDIO }.map { it.javaClass.name }
  }

  @Test
  fun `orders hardware video decoders ahead of software decoders (#184, #312)`() {
    val swH264 = codec("c2.android.avc.decoder", MimeTypes.VIDEO_H264, hw = false)
    val hwH264 = codec("OMX.amlogic.avc.decoder.awesome", MimeTypes.VIDEO_H264, hw = true)
    val policy = CodecPolicy()
    val ordered = policy.selectDecoders(
      mimeType = MimeTypes.VIDEO_H264,
      decoders = listOf(swH264, hwH264),
      softwareAudio = false,
      ffmpegSupportsMime = false,
      hasDtsPassthrough = false,
    )
    assertEquals(listOf(hwH264.name, swH264.name), ordered.map { it.name })
  }

  @Test
  fun `excludes software UHD decoders on initial pass and unlocks software after repeated hw failure or Rung 4 (#109, #312)`() {
    val hwHevc = codec("c2.goldfish.hevc.decoder", MimeTypes.VIDEO_H265, hw = true)
    val swHevc = codec("c2.android.hevc.decoder", MimeTypes.VIDEO_H265, hw = false)
    val policy = CodecPolicy()

    // Initial pass: hardware-only so transient zap HAL contention retries hardware on Rung 1
    assertEquals(
      listOf(hwHevc.name),
      policy.selectDecoders(MimeTypes.VIDEO_H265, listOf(swHevc, hwHevc), false, false, false).map { it.name },
    )

    // First failure: still retries hardware once on Rung 1
    policy.recordVideoCodecFailure(hwHevc)
    assertEquals(
      listOf(hwHevc.name),
      policy.selectDecoders(MimeTypes.VIDEO_H265, listOf(swHevc, hwHevc), false, false, false).map { it.name },
    )

    // Second failure: unlocks software video fallback and deprioritizes failing hardware codec!
    policy.recordVideoCodecFailure(hwHevc)
    assertEquals(
      listOf(swHevc.name, hwHevc.name),
      policy.selectDecoders(MimeTypes.VIDEO_H265, listOf(hwHevc, swHevc), false, false, false).map { it.name },
    )

    // Software-only device without any hardware HEVC decoder still keeps software on initial pass
    val freshPolicy = CodecPolicy()
    assertEquals(
      listOf(swHevc.name),
      freshPolicy.selectDecoders(MimeTypes.VIDEO_H265, listOf(swHevc), false, false, false).map { it.name },
    )
    // And Rung 4 (softwareAudio = true) unlocks software fallback even before 2 failures
    assertEquals(
      listOf(hwHevc.name, swHevc.name),
      freshPolicy.selectDecoders(MimeTypes.VIDEO_H265, listOf(swHevc, hwHevc), true, false, false).map { it.name },
    )
  }

  @Test
  fun `filters stub platform DTS decoders when FFmpeg supports DTS and HDMI passthrough is absent (#128)`() {
    val stubDts = codec("OMX.vendor.dts.decoder", MimeTypes.AUDIO_DTS, hw = true)
    val policy = CodecPolicy()
    assertEquals(
      emptyList<MediaCodecInfo>(),
      policy.selectDecoders(MimeTypes.AUDIO_DTS, listOf(stubDts), false, ffmpegSupportsMime = true, hasDtsPassthrough = false),
    )
    assertEquals(
      listOf(stubDts.name),
      policy.selectDecoders(MimeTypes.AUDIO_DTS, listOf(stubDts), false, ffmpegSupportsMime = true, hasDtsPassthrough = true).map { it.name },
    )
    assertEquals(
      listOf(stubDts.name),
      policy.selectDecoders(MimeTypes.AUDIO_DTS, listOf(stubDts), false, ffmpegSupportsMime = false, hasDtsPassthrough = false).map { it.name },
    )
  }

  @Test
  fun `AudioDecoderLookup classifies hardware MediaCodec, software MediaCodec, FFmpeg JNI and unsupported (#331)`() {
    val hwAac = codec("OMX.vendor.aac.decoder", MimeTypes.AUDIO_AAC, hw = true)
    val swOpus = codec("c2.android.opus.decoder", MimeTypes.AUDIO_OPUS, hw = false)
    val stubDts = codec("OMX.vendor.dts.decoder", MimeTypes.AUDIO_DTS, hw = true)
    val policy = CodecPolicy()

    assertEquals(
      AudioDecodePath.HARDWARE_MEDIACODEC,
      policy.resolveAudioDecodePath(MimeTypes.AUDIO_AAC, listOf(hwAac), false, ffmpegSupportsMime = true, hasDtsPassthrough = false),
    )
    assertEquals(
      AudioDecodePath.FFMPEG_JNI,
      policy.resolveAudioDecodePath(MimeTypes.AUDIO_AAC, listOf(hwAac), true, ffmpegSupportsMime = true, hasDtsPassthrough = false),
    )
    assertEquals(
      AudioDecodePath.SOFTWARE_MEDIACODEC,
      policy.resolveAudioDecodePath(MimeTypes.AUDIO_OPUS, listOf(swOpus), false, ffmpegSupportsMime = false, hasDtsPassthrough = false),
    )
    assertEquals(
      AudioDecodePath.FFMPEG_JNI,
      policy.resolveAudioDecodePath(MimeTypes.AUDIO_DTS, listOf(stubDts), false, ffmpegSupportsMime = true, hasDtsPassthrough = false),
    )
    assertEquals(
      AudioDecodePath.UNSUPPORTED,
      policy.resolveAudioDecodePath("audio/x-unknown", emptyList(), false, ffmpegSupportsMime = false, hasDtsPassthrough = false),
    )
  }

  @Test
  fun `builds MediaCodecAudioRenderer then FfmpegAudioRenderer by default and reverses on softwareAudio (#69)`() {
    val app = RuntimeEnvironment.getApplication()
    assertEquals(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_ON, extensionRendererModeFor(false))
    assertEquals(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_PREFER, extensionRendererModeFor(true))
    assertEquals(
      listOf(
        "androidx.media3.exoplayer.audio.MediaCodecAudioRenderer",
        "androidx.media3.decoder.ffmpeg.FfmpegAudioRenderer",
      ),
      audioRendererClassNames(app, softwareAudio = false),
    )
    assertEquals(
      listOf(
        "androidx.media3.decoder.ffmpeg.FfmpegAudioRenderer",
        "androidx.media3.exoplayer.audio.MediaCodecAudioRenderer",
      ),
      audioRendererClassNames(app, softwareAudio = true),
    )
  }

  @Test
  fun `detects Dolby Vision Profile 7 codecs, checks profile capabilities, and falls back to HEVC (#189)`() {
    assertTrue(isDolbyVisionProfile7Codec("dvhe.07.06"))
    assertTrue(isDolbyVisionProfile7Codec("DVH1.07.09"))
    assertTrue(isDolbyVisionProfile7Codec("ec-3, dvhe.07.06"))
    assertFalse(isDolbyVisionProfile7Codec("dvhe.08.06"))
    assertFalse(isDolbyVisionProfile7Codec("dvh1.05.06"))
    assertFalse(isDolbyVisionProfile7Codec("hev1.1.6.L93.B0"))
    assertFalse(isDolbyVisionProfile7Codec(null))
    assertFalse(isDolbyVisionProfile7Codec(""))

    val caps81 = CodecCapabilities().apply {
      profileLevels = arrayOf(CodecProfileLevel().apply { profile = CodecProfileLevel.DolbyVisionProfileDvheSt })
    }
    val caps7 = CodecCapabilities().apply {
      profileLevels = arrayOf(CodecProfileLevel().apply { profile = CodecProfileLevel.DolbyVisionProfileDvheDtb })
    }
    val dv81Only = MediaCodecInfo.newInstance(
      "c2.vendor.dv.decoder",
      MimeTypes.VIDEO_DOLBY_VISION,
      MimeTypes.VIDEO_DOLBY_VISION,
      caps81,
      /* hardwareAccelerated = */ true,
      /* softwareOnly = */ false,
      /* vendor = */ true,
      /* forceDisableAdaptive = */ false,
      /* forceSecure = */ false,
    )
    val dv7Capable = MediaCodecInfo.newInstance(
      "c2.vendor.dv7.decoder",
      MimeTypes.VIDEO_DOLBY_VISION,
      MimeTypes.VIDEO_DOLBY_VISION,
      caps7,
      /* hardwareAccelerated = */ true,
      /* softwareOnly = */ false,
      /* vendor = */ true,
      /* forceDisableAdaptive = */ false,
      /* forceSecure = */ false,
    )
    assertFalse(supportsDolbyVisionProfile7(listOf(dv81Only)))
    assertTrue(supportsDolbyVisionProfile81(listOf(dv81Only)))
    assertTrue(supportsDolbyVisionProfile7(listOf(dv7Capable)))

    assertTrue(
      shouldFallbackDolbyVisionToHevc(
        codecs = "dvhe.07.06",
        dvDecoders = listOf(dv81Only),
        preferHevcOverDolbyVision = false,
        dvFallbackLatched = false,
      )
    )
    assertFalse(
      shouldFallbackDolbyVisionToHevc(
        codecs = "dvhe.07.06",
        dvDecoders = listOf(dv7Capable),
        preferHevcOverDolbyVision = false,
        dvFallbackLatched = false,
      )
    )
    assertTrue(
      shouldFallbackDolbyVisionToHevc(
        codecs = "dvhe.08.06",
        dvDecoders = listOf(dv7Capable),
        preferHevcOverDolbyVision = true,
        dvFallbackLatched = false,
      )
    )

    val hwHevc = codec("c2.vendor.hevc.decoder", MimeTypes.VIDEO_H265, hw = true)
    val swHevc = codec("c2.android.hevc.decoder", MimeTypes.VIDEO_H265, hw = false)
    val policy = CodecPolicy()

    // Default without preference or failure keeps DV decoder
    assertEquals(
      listOf(dv81Only.name),
      policy.selectDecoders(
        mimeType = MimeTypes.VIDEO_DOLBY_VISION,
        decoders = listOf(dv81Only),
        softwareAudio = false,
        ffmpegSupportsMime = false,
        hasDtsPassthrough = false,
        preferHevcOverDolbyVision = false,
        hevcFallbackDecoders = listOf(swHevc, hwHevc),
      ).map { it.name },
    )

    // Explicit preferHevcOverDolbyVision switches VIDEO_DOLBY_VISION to HEVC base-layer hardware decoder
    assertEquals(
      listOf(hwHevc.name),
      policy.selectDecoders(
        mimeType = MimeTypes.VIDEO_DOLBY_VISION,
        decoders = listOf(dv81Only),
        softwareAudio = false,
        ffmpegSupportsMime = false,
        hasDtsPassthrough = false,
        preferHevcOverDolbyVision = true,
        hevcFallbackDecoders = listOf(swHevc, hwHevc),
      ).map { it.name },
    )

    // Recording a DV video decoder failure latches HEVC fallback for subsequent preparations
    policy.recordVideoCodecFailure(dv81Only)
    assertTrue(policy.isDolbyVisionFallbackActive)
    assertEquals(
      listOf(hwHevc.name),
      policy.selectDecoders(
        mimeType = MimeTypes.VIDEO_DOLBY_VISION,
        decoders = listOf(dv81Only),
        softwareAudio = false,
        ffmpegSupportsMime = false,
        hasDtsPassthrough = false,
        preferHevcOverDolbyVision = false,
        hevcFallbackDecoders = listOf(swHevc, hwHevc),
      ).map { it.name },
    )

    // Clearing fallback restores DV selection for the next distinct channel
    policy.clearDolbyVisionFallback()
    assertFalse(policy.isDolbyVisionFallbackActive)
    assertEquals(
      listOf(dv81Only.name),
      policy.selectDecoders(
        mimeType = MimeTypes.VIDEO_DOLBY_VISION,
        decoders = listOf(dv81Only),
        softwareAudio = false,
        ffmpegSupportsMime = false,
        hasDtsPassthrough = false,
        preferHevcOverDolbyVision = false,
        hevcFallbackDecoders = listOf(swHevc, hwHevc),
      ).map { it.name },
    )
  }

  @Test
  fun `production PolicyVideoRenderer proactively falls back to HEVC for DV Profile 7 when unsupported and respects tr-TR locale (#189)`() {
    val app = RuntimeEnvironment.getApplication()
    val caps81 = CodecCapabilities().apply {
      profileLevels = arrayOf(CodecProfileLevel().apply { profile = CodecProfileLevel.DolbyVisionProfileDvheSt })
    }
    val caps7 = CodecCapabilities().apply {
      profileLevels = arrayOf(CodecProfileLevel().apply { profile = CodecProfileLevel.DolbyVisionProfileDvheDtb })
    }
    val dv81Only = MediaCodecInfo.newInstance(
      "c2.vendor.dv81.decoder",
      MimeTypes.VIDEO_DOLBY_VISION,
      MimeTypes.VIDEO_DOLBY_VISION,
      caps81,
      true,
      false,
      true,
      false,
      false,
    )
    val dv7Capable = MediaCodecInfo.newInstance(
      "c2.vendor.dv7.decoder",
      MimeTypes.VIDEO_DOLBY_VISION,
      MimeTypes.VIDEO_DOLBY_VISION,
      caps7,
      true,
      false,
      true,
      false,
      false,
    )
    val hwHevc = codec("c2.vendor.hevc.decoder", MimeTypes.VIDEO_H265, hw = true)
    val dv7Format = Format.Builder()
      .setSampleMimeType(MimeTypes.VIDEO_DOLBY_VISION)
      .setCodecs("DVHE.07.06")
      .setWidth(3840)
      .setHeight(2160)
      .build()

    fun buildVideoRenderer(policy: CodecPolicy, preferHevc: Boolean): PolicyVideoRenderer {
      val renderers = createRenderersFactory(app, policy, softwareAudio = false, preferHevcOverDolbyVision = preferHevc)
        .createRenderers(
          Handler(Looper.getMainLooper()),
          object : VideoRendererEventListener {},
          object : AudioRendererEventListener {},
          TextOutput {},
          MetadataOutput {},
        )
      return renderers.filterIsInstance<PolicyVideoRenderer>().single()
    }

    val selectorDv81Only = MediaCodecSelector { mimeType, _, _ ->
      when (mimeType) {
        MimeTypes.VIDEO_DOLBY_VISION -> listOf(dv81Only)
        MimeTypes.VIDEO_H265 -> listOf(hwHevc)
        else -> emptyList()
      }
    }
    val selectorDv7Capable = MediaCodecSelector { mimeType, _, _ ->
      when (mimeType) {
        MimeTypes.VIDEO_DOLBY_VISION -> listOf(dv7Capable)
        MimeTypes.VIDEO_H265 -> listOf(hwHevc)
        else -> emptyList()
      }
    }

    val previousLocale = Locale.getDefault()
    try {
      Locale.setDefault(Locale.forLanguageTag("tr-TR"))
      assertTrue(isDolbyVisionProfile7Codec("DVHE.07.06"))
      assertTrue(isDolbyVisionProfile7Codec("DVH1.07.09"))

      val defaultRenderer = buildVideoRenderer(CodecPolicy(), preferHevc = false)
      // DV Profile 7 stream on DV 8.1-only device proactively selects HEVC base-layer decoder!
      assertEquals(
        listOf(hwHevc.name),
        defaultRenderer.resolveDecoderInfosForTest(selectorDv81Only, dv7Format).map { it.name },
      )
      // DV Profile 7 stream on Profile 7-capable device keeps native DV decoder!
      assertEquals(
        listOf(dv7Capable.name),
        defaultRenderer.resolveDecoderInfosForTest(selectorDv7Capable, dv7Format).map { it.name },
      )
      // Explicit preferHevcOverDolbyVision=true selects HEVC even on a Profile 7-capable device
      val preferHevcRenderer = buildVideoRenderer(CodecPolicy(), preferHevc = true)
      assertEquals(
        listOf(hwHevc.name),
        preferHevcRenderer.resolveDecoderInfosForTest(selectorDv7Capable, dv7Format).map { it.name },
      )
    } finally {
      Locale.setDefault(previousLocale)
    }
  }
}
