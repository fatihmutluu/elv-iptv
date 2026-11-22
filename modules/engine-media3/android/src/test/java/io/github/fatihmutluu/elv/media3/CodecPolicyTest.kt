package io.github.fatihmutluu.elv.media3

import android.content.Context
import android.content.ContextWrapper
import android.media.MediaCodecInfo.CodecCapabilities
import android.media.MediaCodecInfo.CodecProfileLevel
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.audio.AudioCapabilities
import androidx.media3.exoplayer.audio.AudioRendererEventListener
import androidx.media3.exoplayer.mediacodec.MediaCodecInfo
import androidx.media3.exoplayer.mediacodec.MediaCodecSelector
import androidx.media3.exoplayer.metadata.MetadataOutput
import androidx.media3.exoplayer.text.TextOutput
import androidx.media3.exoplayer.video.MediaCodecVideoRenderer
import androidx.media3.exoplayer.video.VideoRendererEventListener
import java.util.Locale
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
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

  private fun audioRendererClassNames(
    context: Context,
    softwareAudio: Boolean,
    decoderMode: VideoDecoderMode = VideoDecoderMode.AUTO,
  ): List<String> {
    val renderers = createRenderersFactory(
      context = context,
      codecPolicy = CodecPolicy(),
      softwareAudio = softwareAudio,
      decoderMode = decoderMode,
    ).createRenderers(
      Handler(Looper.getMainLooper()),
      object : VideoRendererEventListener {},
      object : AudioRendererEventListener {},
      TextOutput {},
      MetadataOutput {},
    )
    return renderers.filter { it.trackType == C.TRACK_TYPE_AUDIO }.map { it.javaClass.name }
  }

  private fun buildVideoRenderer(
    policy: CodecPolicy = CodecPolicy(),
    softwareAudio: Boolean = false,
    preferHevc: Boolean = false,
    quirks: DeviceQuirks = DeviceQuirks("Generic", "Generic", "Phone", "qcom", "kona", "SM8250"),
    decoderMode: VideoDecoderMode = VideoDecoderMode.AUTO,
  ): PolicyVideoRenderer {
    val app = RuntimeEnvironment.getApplication()
    val renderers = createRenderersFactory(
      context = app,
      codecPolicy = policy,
      softwareAudio = softwareAudio,
      preferHevcOverDolbyVision = preferHevc,
      deviceQuirks = quirks,
      decoderMode = decoderMode,
    ).createRenderers(
      Handler(Looper.getMainLooper()),
      object : VideoRendererEventListener {},
      object : AudioRendererEventListener {},
      TextOutput {},
      MetadataOutput {},
    )
    return renderers.filterIsInstance<PolicyVideoRenderer>().single()
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

    assertEquals(
      listOf(hwHevc.name),
      policy.selectDecoders(MimeTypes.VIDEO_H265, listOf(swHevc, hwHevc), false, false, false).map { it.name },
    )

    policy.recordVideoCodecFailure(hwHevc)
    assertEquals(
      listOf(hwHevc.name),
      policy.selectDecoders(MimeTypes.VIDEO_H265, listOf(swHevc, hwHevc), false, false, false).map { it.name },
    )

    policy.recordVideoCodecFailure(hwHevc)
    assertEquals(
      listOf(swHevc.name, hwHevc.name),
      policy.selectDecoders(MimeTypes.VIDEO_H265, listOf(hwHevc, swHevc), false, false, false).map { it.name },
    )

    val freshPolicy = CodecPolicy()
    assertEquals(
      listOf(swHevc.name),
      freshPolicy.selectDecoders(MimeTypes.VIDEO_H265, listOf(swHevc), false, false, false).map { it.name },
    )
    assertEquals(
      listOf(hwHevc.name, swHevc.name),
      freshPolicy.selectDecoders(MimeTypes.VIDEO_H265, listOf(swHevc, hwHevc), true, false, false).map { it.name },
    )
  }

  @Test
  fun `PolicyVideoRenderer filters software decoders only when healthy hardware confirms format support (#184)`() {
    val app = RuntimeEnvironment.getApplication()
    val hwH264 = codec("c2.qti.avc.decoder", MimeTypes.VIDEO_H264, hw = true)
    val swGoogle = codec("OMX.google.h264.decoder", MimeTypes.VIDEO_H264, hw = false)
    val swAndroid = codec("c2.android.avc.decoder", MimeTypes.VIDEO_H264, hw = false)
    val format1080 = Format.Builder()
      .setSampleMimeType(MimeTypes.VIDEO_H264)
      .setWidth(1920)
      .setHeight(1080)
      .build()
    val selector = MediaCodecSelector { _, _, _ -> listOf(hwH264, swGoogle, swAndroid) }

    // 1. Hardware confirms format -> software decoders stripped
    val policy = CodecPolicy()
    val confirmedRenderer = PolicyVideoRenderer(
      builder = MediaCodecVideoRenderer.Builder(app),
      appContext = app,
      codecPolicy = policy,
      softwareAudio = false,
      preferHevcOverDolbyVision = false,
      formatSupportChecker = { info, _ -> info.name == hwH264.name },
    )
    assertEquals(
      listOf(hwH264.name),
      confirmedRenderer.resolveDecoderInfosForTest(selector, format1080).map { it.name },
    )

    // 2. Hardware rejects format (e.g. unsupported profile/level) -> software fallback preserved
    val rejectedRenderer = PolicyVideoRenderer(
      builder = MediaCodecVideoRenderer.Builder(app),
      appContext = app,
      codecPolicy = policy,
      softwareAudio = false,
      preferHevcOverDolbyVision = false,
      formatSupportChecker = { _, _ -> false },
    )
    assertEquals(
      listOf(hwH264.name, swGoogle.name, swAndroid.name),
      rejectedRenderer.resolveDecoderInfosForTest(selector, format1080).map { it.name },
    )

    // 3. Repeatedly failing hardware -> software fallback preserved even if formatSupportChecker says true
    policy.recordVideoCodecFailure(hwH264)
    policy.recordVideoCodecFailure(hwH264)
    assertEquals(
      listOf(hwH264.name, swGoogle.name, swAndroid.name),
      confirmedRenderer.resolveDecoderInfosForTest(selector, format1080).map { it.name },
    )
  }

  @Test
  fun `end-to-end PolicyVideoRenderer with CodecPolicy H265 selector strips SW when HW supports and preserves SW when HW rejects (#109, #184, #312)`() {
    val app = RuntimeEnvironment.getApplication()
    val swHevc = codec("c2.android.hevc.decoder", MimeTypes.VIDEO_H265, hw = false)
    val hwHevc = codec("c2.amlogic.hevc.decoder", MimeTypes.VIDEO_H265, hw = true)
    val hevc4k10 = Format.Builder()
      .setSampleMimeType(MimeTypes.VIDEO_H265)
      .setCodecs("hev1.2.4.L153.B0")
      .setWidth(3840)
      .setHeight(2160)
      .build()
    val platformSelector = MediaCodecSelector { mimeType, _, _ ->
      if (mimeType == MimeTypes.VIDEO_H265) listOf(swHevc, hwHevc) else emptyList()
    }
    val policy = CodecPolicy()
    val policySelector = policy.createSelector(
      context = app,
      softwareAudio = false,
      preferHevcOverDolbyVision = false,
      stripHeavySoftwareWithoutFormatCheck = false,
      baseSelector = platformSelector,
    )

    // Selector passes ordered [hw, sw] into PolicyVideoRenderer without blindly stripping SW for H.265
    assertEquals(
      listOf(hwHevc.name, swHevc.name),
      policySelector.getDecoderInfos(MimeTypes.VIDEO_H265, false, false).map { it.name },
    )

    // 1. Healthy HW confirms H.265 Format -> PolicyVideoRenderer strips SW (enforcing #109/#184/#312)
    val hwSupportedRenderer = PolicyVideoRenderer(
      builder = MediaCodecVideoRenderer.Builder(app),
      appContext = app,
      codecPolicy = policy,
      softwareAudio = false,
      preferHevcOverDolbyVision = false,
      formatSupportChecker = { info, _ -> info.name == hwHevc.name },
    )
    assertEquals(
      listOf(hwHevc.name),
      hwSupportedRenderer.resolveDecoderInfosForTest(policySelector, hevc4k10).map { it.name },
    )

    // 2. HW rejects H.265 profile/level/resolution (or null caps) -> SW fallback preserved on pass 1!
    val hwRejectedRenderer = PolicyVideoRenderer(
      builder = MediaCodecVideoRenderer.Builder(app),
      appContext = app,
      codecPolicy = policy,
      softwareAudio = false,
      preferHevcOverDolbyVision = false,
      formatSupportChecker = { _, _ -> false },
    )
    assertEquals(
      listOf(hwHevc.name, swHevc.name),
      hwRejectedRenderer.resolveDecoderInfosForTest(policySelector, hevc4k10).map { it.name },
    )

    // 3. After repeated HW failure (>= 2), SW moves ahead of failing HW even if formatSupportChecker says true
    policy.recordVideoCodecFailure(hwHevc)
    policy.recordVideoCodecFailure(hwHevc)
    assertEquals(
      listOf(swHevc.name, hwHevc.name),
      hwSupportedRenderer.resolveDecoderInfosForTest(policySelector, hevc4k10).map { it.name },
    )
  }

  @Test
  fun `probeHardwareHevc4kFromEntries distinguishes 4K HW HEVC decoders from encoders, 1080p HW and SW codecs (#150)`() {
    assertFalse(probeHardwareHevc4kFromEntries(emptyList()))
    assertFalse(
      probeHardwareHevc4kFromEntries(
        listOf(
          HevcCodecProbeEntry("c2.android.hevc.decoder", isEncoder = false, isHardwareAccelerated = false, isSoftwareOnly = true, supportedTypes = listOf(MimeTypes.VIDEO_H265), supports4k = true),
          HevcCodecProbeEntry("c2.qti.hevc.encoder", isEncoder = true, isHardwareAccelerated = true, isSoftwareOnly = false, supportedTypes = listOf(MimeTypes.VIDEO_H265), supports4k = true),
          HevcCodecProbeEntry("c2.amlogic.hevc.decoder", isEncoder = false, isHardwareAccelerated = true, isSoftwareOnly = false, supportedTypes = listOf(MimeTypes.VIDEO_H265), supports4k = false),
          HevcCodecProbeEntry("c2.qti.avc.decoder", isEncoder = false, isHardwareAccelerated = true, isSoftwareOnly = false, supportedTypes = listOf(MimeTypes.VIDEO_H264), supports4k = true),
        )
      )
    )
    assertTrue(
      probeHardwareHevc4kFromEntries(
        listOf(
          HevcCodecProbeEntry("c2.amlogic.hevc.decoder.awesome", isEncoder = false, isHardwareAccelerated = true, isSoftwareOnly = false, supportedTypes = listOf(MimeTypes.VIDEO_H265), supports4k = true),
        )
      )
    )

    // Off-UI-thread startHardwareHevc4kProbe executes on HandlerThread without crashing and defaults false before completion
    val policy = CodecPolicy()
    assertFalse(policy.supportsHardwareHevc4k)
    val thread = HandlerThread("hevc-probe-test").apply { start() }
    try {
      val handler = Handler(thread.looper)
      policy.startHardwareHevc4kProbe(handler)
      policy.startHardwareHevc4kProbe(handler) // idempotent
      val done = CountDownLatch(1)
      handler.post { done.countDown() }
      assertTrue(done.await(5, TimeUnit.SECONDS))
    } finally {
      thread.quitSafely()
    }
  }

  @Test
  fun `DeviceQuirks detects Amlogic and Sony Bravia and applies CodecMaxValues floor and Bravia drop limits (#261)`() {
    val amlogicQuirks = DeviceQuirks("Google", "google", "Chromecast", "amlogic", "sabrina", "S905D3")
    val braviaQuirks = DeviceQuirks("Sony", "Sony", "BRAVIA 4K VH2", "mt5895", "bravia", "MT5895")
    val genericQuirks = DeviceQuirks("Google", "google", "Pixel 8", "shiba", "shiba", "Tensor G3")

    assertTrue(amlogicQuirks.isAmlogic)
    assertFalse(amlogicQuirks.isSonyBravia)
    assertTrue(braviaQuirks.isSonyBravia)
    assertFalse(braviaQuirks.isAmlogic)
    assertFalse(genericQuirks.isAmlogic)
    assertFalse(genericQuirks.isSonyBravia)

    // Amlogic floors 720p CodecMaxValues to >= 1920x1089 and scales inputSize for 720p -> 1080p transitions
    val amlRenderer = buildVideoRenderer(quirks = amlogicQuirks)
    val genericRenderer = buildVideoRenderer(quirks = genericQuirks)
    val amlCodec = codec("OMX.amlogic.avc.decoder.awesome", MimeTypes.VIDEO_H264, hw = true)
    val qtiCodec = codec("c2.qti.avc.decoder", MimeTypes.VIDEO_H264, hw = true)
    val hd720 = Format.Builder()
      .setSampleMimeType(MimeTypes.VIDEO_H264)
      .setWidth(1280)
      .setHeight(720)
      .build()
    val uhd4k = Format.Builder()
      .setSampleMimeType(MimeTypes.VIDEO_H264)
      .setWidth(3840)
      .setHeight(2160)
      .build()

    val amlMax720 = amlRenderer.resolveCodecMaxValuesForTest(qtiCodec, hd720)
    assertTrue(amlMax720.width >= 1920)
    assertTrue(amlMax720.height >= 1089)
    assertTrue(amlMax720.inputSize >= 1_500_000)

    // Amlogic codec name triggers floor even if DeviceQuirks hardware string didn't match
    val codecNameFloor = genericRenderer.resolveCodecMaxValuesForTest(amlCodec, hd720)
    assertTrue(codecNameFloor.width >= 1920)
    assertTrue(codecNameFloor.height >= 1089)

    // 4K streams on Amlogic keep full 3840x2160 bounds (never clamped downward)
    val amlMax4k = amlRenderer.resolveCodecMaxValuesForTest(amlCodec, uhd4k)
    assertEquals(3840, amlMax4k.width)
    assertEquals(2160, amlMax4k.height)

    // Generic non-Amlogic device keeps 1280x720 untouched
    val genericMax720 = genericRenderer.resolveCodecMaxValuesForTest(qtiCodec, hd720)
    assertEquals(1280, genericMax720.width)
    assertEquals(720, genericMax720.height)

    // Broken output-surface codec workaround
    assertTrue(amlRenderer.codecNeedsSetOutputSurfaceWorkaroundForTest("OMX.amlogic.avc.decoder.awesome"))
    assertTrue(genericRenderer.codecNeedsSetOutputSurfaceWorkaroundForTest("OMX.allwinner.video.decoder.avc"))
    assertFalse(amlRenderer.codecNeedsSetOutputSurfaceWorkaroundForTest("c2.android.avc.decoder"))

    // Sony Bravia widens drop threshold (-60 ms) and breaks consecutive drop cascades after 2 drops
    val braviaRenderer = buildVideoRenderer(quirks = braviaQuirks)
    // -45 ms late: generic drops (<-30 ms), Bravia renders smoothly
    assertTrue(genericRenderer.shouldDropOutputBufferForTest(-45_000L, 1_000L))
    assertFalse(braviaRenderer.shouldDropOutputBufferForTest(-45_000L, 1_000L))

    // -80 ms late: Bravia allows at most 2 consecutive drops, then forces render on 3rd frame to stop cascade
    assertTrue(braviaRenderer.shouldDropOutputBufferForTest(-80_000L, 1_000L))
    assertTrue(braviaRenderer.shouldDropOutputBufferForTest(-80_000L, 2_000L))
    assertFalse("3rd consecutive drop must be suppressed on Bravia", braviaRenderer.shouldDropOutputBufferForTest(-80_000L, 3_000L))

    // Keyframe drop threshold widened on Bravia (-1000 ms vs -500 ms)
    assertTrue(genericRenderer.shouldDropBuffersToKeyframeForTest(-600_000L, 1_000L))
    assertFalse(braviaRenderer.shouldDropBuffersToKeyframeForTest(-600_000L, 1_000L))
    assertTrue(braviaRenderer.shouldDropBuffersToKeyframeForTest(-1_200_000L, 1_000L))
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
    assertFalse(supportsDolbyVisionProfile7(listOf(dv81Only)))
    assertTrue(supportsDolbyVisionProfile81(listOf(dv81Only)))
    assertTrue(supportsDolbyVisionProfile7(listOf(dv7Capable)))

    assertTrue(shouldFallbackDolbyVisionToHevc("dvhe.07.06", listOf(dv81Only), false, false))
    assertFalse(shouldFallbackDolbyVisionToHevc("dvhe.07.06", listOf(dv7Capable), false, false))
    assertTrue(shouldFallbackDolbyVisionToHevc("dvhe.08.06", listOf(dv7Capable), true, false))

    val hwHevc = codec("c2.vendor.hevc.decoder", MimeTypes.VIDEO_H265, hw = true)
    val swHevc = codec("c2.android.hevc.decoder", MimeTypes.VIDEO_H265, hw = false)
    val policy = CodecPolicy()

    assertEquals(
      listOf(dv81Only.name),
      policy.selectDecoders(MimeTypes.VIDEO_DOLBY_VISION, listOf(dv81Only), false, false, false, false, listOf(swHevc, hwHevc)).map { it.name },
    )
    assertEquals(
      listOf(hwHevc.name),
      policy.selectDecoders(MimeTypes.VIDEO_DOLBY_VISION, listOf(dv81Only), false, false, false, true, listOf(swHevc, hwHevc)).map { it.name },
    )
    policy.recordVideoCodecFailure(dv81Only)
    assertTrue(policy.isDolbyVisionFallbackActive)
    assertEquals(
      listOf(hwHevc.name),
      policy.selectDecoders(MimeTypes.VIDEO_DOLBY_VISION, listOf(dv81Only), false, false, false, false, listOf(swHevc, hwHevc)).map { it.name },
    )
    policy.clearDolbyVisionFallback()
    assertFalse(policy.isDolbyVisionFallbackActive)
  }

  @Test
  fun `production PolicyVideoRenderer proactively falls back to HEVC for DV Profile 7 when unsupported and respects tr-TR locale (#189)`() {
    val caps81 = CodecCapabilities().apply {
      profileLevels = arrayOf(CodecProfileLevel().apply { profile = CodecProfileLevel.DolbyVisionProfileDvheSt })
    }
    val caps7 = CodecCapabilities().apply {
      profileLevels = arrayOf(CodecProfileLevel().apply { profile = CodecProfileLevel.DolbyVisionProfileDvheDtb })
    }
    val dv81Only = MediaCodecInfo.newInstance("c2.vendor.dv81.decoder", MimeTypes.VIDEO_DOLBY_VISION, MimeTypes.VIDEO_DOLBY_VISION, caps81, true, false, true, false, false)
    val dv7Capable = MediaCodecInfo.newInstance("c2.vendor.dv7.decoder", MimeTypes.VIDEO_DOLBY_VISION, MimeTypes.VIDEO_DOLBY_VISION, caps7, true, false, true, false, false)
    val hwHevc = codec("c2.vendor.hevc.decoder", MimeTypes.VIDEO_H265, hw = true)
    val dv7Format = Format.Builder()
      .setSampleMimeType(MimeTypes.VIDEO_DOLBY_VISION)
      .setCodecs("DVHE.07.06")
      .setWidth(3840)
      .setHeight(2160)
      .build()

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
      assertEquals(listOf(hwHevc.name), defaultRenderer.resolveDecoderInfosForTest(selectorDv81Only, dv7Format).map { it.name })
      assertEquals(listOf(dv7Capable.name), defaultRenderer.resolveDecoderInfosForTest(selectorDv7Capable, dv7Format).map { it.name })

      val preferHevcRenderer = buildVideoRenderer(CodecPolicy(), preferHevc = true)
      assertEquals(listOf(hwHevc.name), preferHevcRenderer.resolveDecoderInfosForTest(selectorDv7Capable, dv7Format).map { it.name })
    } finally {
      Locale.setDefault(previousLocale)
    }
  }

  @Test
  fun `caches AudioCapabilities via receiver and uses cached DTS passthrough without IPC (#438)`() {
    val app = RuntimeEnvironment.getApplication()
    val policy = CodecPolicy()
    var ipcQueries = 0
    val countingContext = object : ContextWrapper(app) {
      override fun getSystemService(name: String): Any? {
        ipcQueries += 1
        throw AssertionError("must not query synchronous AudioCapabilities IPC while cached")
      }
    }

    policy.updateAudioCapabilitiesForTest(AudioCapabilities(intArrayOf(C.ENCODING_DTS), 6))
    assertTrue(policy.hasDtsPassthrough(countingContext, MimeTypes.AUDIO_DTS))
    assertTrue(policy.hasDtsPassthrough(countingContext, MimeTypes.AUDIO_DTS_EXPRESS))
    assertFalse(policy.hasDtsPassthrough(countingContext, MimeTypes.AUDIO_DTS_HD))
    assertEquals(0, ipcQueries)

    policy.updateAudioCapabilitiesForTest(AudioCapabilities(intArrayOf(C.ENCODING_DTS_HD), 8))
    assertTrue(policy.hasDtsPassthrough(countingContext, MimeTypes.AUDIO_DTS))
    assertTrue(policy.hasDtsPassthrough(countingContext, MimeTypes.AUDIO_DTS_HD))
    assertEquals(0, ipcQueries)

    policy.updateAudioCapabilitiesForTest(AudioCapabilities.DEFAULT_AUDIO_CAPABILITIES)
    assertFalse(policy.hasDtsPassthrough(countingContext, MimeTypes.AUDIO_DTS))
    assertFalse(policy.hasDtsPassthrough(countingContext, MimeTypes.AUDIO_DTS_HD))
    assertEquals(0, ipcQueries)

    policy.updateAudioCapabilitiesForTest(null)
    val thread = HandlerThread("codec-policy-test").apply { start() }
    try {
      val handler = Handler(thread.looper)
      policy.startAudioCapabilities(app, handler)
      policy.startAudioCapabilities(app, handler)
      val synced = CountDownLatch(1)
      handler.post { synced.countDown() }
      assertTrue(synced.await(5, TimeUnit.SECONDS))
      assertFalse(policy.hasDtsPassthrough(countingContext, MimeTypes.AUDIO_DTS))
      assertEquals(0, ipcQueries)
      policy.stopAudioCapabilities()
      policy.stopAudioCapabilities()
    } finally {
      thread.quitSafely()
    }
  }

  @Test
  fun `extensionRendererModeFor prefers extension renderers on softwareAudio or SOFTWARE video decoderMode (#411)`() {
    val app = RuntimeEnvironment.getApplication()
    assertEquals(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_ON, extensionRendererModeFor(false, VideoDecoderMode.AUTO))
    assertEquals(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_ON, extensionRendererModeFor(false, VideoDecoderMode.HARDWARE))
    assertEquals(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_PREFER, extensionRendererModeFor(false, VideoDecoderMode.SOFTWARE))
    assertEquals(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_PREFER, extensionRendererModeFor(true, VideoDecoderMode.AUTO))
    assertEquals(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_PREFER, extensionRendererModeFor(true, VideoDecoderMode.HARDWARE))
    assertEquals(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_PREFER, extensionRendererModeFor(true, VideoDecoderMode.SOFTWARE))

    assertEquals(
      listOf("androidx.media3.decoder.ffmpeg.FfmpegAudioRenderer", "androidx.media3.exoplayer.audio.MediaCodecAudioRenderer"),
      audioRendererClassNames(app, softwareAudio = false, decoderMode = VideoDecoderMode.SOFTWARE),
    )
    assertEquals(
      listOf("androidx.media3.exoplayer.audio.MediaCodecAudioRenderer", "androidx.media3.decoder.ffmpeg.FfmpegAudioRenderer"),
      audioRendererClassNames(app, softwareAudio = false, decoderMode = VideoDecoderMode.HARDWARE),
    )
  }

  @Test
  fun `selectDecoders enforces AUTO, HARDWARE and SOFTWARE video decoder modes including Dolby Vision fallback (#411)`() {
    val hwHevcHealthy = codec("c2.qti.hevc.decoder", MimeTypes.VIDEO_H265, hw = true)
    val hwHevcFailing = codec("c2.vendor.hevc.decoder", MimeTypes.VIDEO_H265, hw = true)
    val swHevc = codec("c2.android.hevc.decoder", MimeTypes.VIDEO_H265, hw = false)
    val hwAvc = codec("c2.qti.avc.decoder", MimeTypes.VIDEO_H264, hw = true)
    val swAvc = codec("OMX.google.h264.decoder", MimeTypes.VIDEO_H264, hw = false)
    val dvHw = codec("c2.vendor.dv.decoder", MimeTypes.VIDEO_DOLBY_VISION, hw = true)
    val policy = CodecPolicy()

    // SOFTWARE selects SW immediately without waiting for HW crashes (even on heavy H.265)
    assertEquals(
      listOf(swHevc.name),
      policy.selectDecoders(MimeTypes.VIDEO_H265, listOf(hwHevcHealthy, swHevc), false, false, false, stripHeavySoftwareWithoutFormatCheck = true, decoderMode = VideoDecoderMode.SOFTWARE).map { it.name },
    )
    assertEquals(
      listOf(swAvc.name),
      policy.selectDecoders(MimeTypes.VIDEO_H264, listOf(hwAvc, swAvc), false, false, false, decoderMode = VideoDecoderMode.SOFTWARE).map { it.name },
    )

    // SOFTWARE falls back to HW (healthy ahead of failing) when zero SW decoders exist
    policy.recordVideoCodecFailure(hwHevcFailing)
    policy.recordVideoCodecFailure(hwHevcFailing)
    assertEquals(
      listOf(hwHevcHealthy.name, hwHevcFailing.name),
      policy.selectDecoders(MimeTypes.VIDEO_H265, listOf(hwHevcFailing, hwHevcHealthy), false, false, false, decoderMode = VideoDecoderMode.SOFTWARE).map { it.name },
    )

    // HARDWARE strictly excludes software decoders even when failing HW is present or only SW exists
    assertEquals(
      listOf(hwHevcHealthy.name, hwHevcFailing.name),
      policy.selectDecoders(MimeTypes.VIDEO_H265, listOf(swHevc, hwHevcFailing, hwHevcHealthy), false, false, false, decoderMode = VideoDecoderMode.HARDWARE).map { it.name },
    )
    assertEquals(
      emptyList<String>(),
      policy.selectDecoders(MimeTypes.VIDEO_H265, listOf(swHevc), false, false, false, decoderMode = VideoDecoderMode.HARDWARE).map { it.name },
    )

    // Dolby Vision fallback recursion forwards decoderMode to HEVC selection
    assertEquals(
      listOf(swHevc.name),
      policy.selectDecoders(MimeTypes.VIDEO_DOLBY_VISION, listOf(dvHw), false, false, false, preferHevcOverDolbyVision = true, hevcFallbackDecoders = listOf(hwHevcHealthy, swHevc), decoderMode = VideoDecoderMode.SOFTWARE).map { it.name },
    )
    assertEquals(
      listOf(hwHevcHealthy.name),
      policy.selectDecoders(MimeTypes.VIDEO_DOLBY_VISION, listOf(dvHw), false, false, false, preferHevcOverDolbyVision = true, hevcFallbackDecoders = listOf(hwHevcHealthy, swHevc), decoderMode = VideoDecoderMode.HARDWARE).map { it.name },
    )

    // Audio selection stays governed by softwareAudio regardless of video decoderMode
    val hwAac = codec("OMX.vendor.aac.decoder", MimeTypes.AUDIO_AAC, hw = true)
    val swAac = codec("c2.android.aac.decoder", MimeTypes.AUDIO_AAC, hw = false)
    assertEquals(
      listOf(hwAac.name, swAac.name),
      policy.selectDecoders(MimeTypes.AUDIO_AAC, listOf(hwAac, swAac), false, false, false, decoderMode = VideoDecoderMode.SOFTWARE).map { it.name },
    )
  }

  @Test
  fun `PolicyVideoRenderer enforces AUTO, HARDWARE and SOFTWARE decoderMode (#411)`() {
    val app = RuntimeEnvironment.getApplication()
    val hwHealthy = codec("c2.qti.avc.decoder", MimeTypes.VIDEO_H264, hw = true)
    val hwFailing = codec("c2.vendor.avc.decoder", MimeTypes.VIDEO_H264, hw = true)
    val swAndroid = codec("c2.android.avc.decoder", MimeTypes.VIDEO_H264, hw = false)
    val format1080 = Format.Builder().setSampleMimeType(MimeTypes.VIDEO_H264).setWidth(1920).setHeight(1080).build()
    val mixedSelector = MediaCodecSelector { _, _, _ -> listOf(hwFailing, hwHealthy, swAndroid) }
    val hwOnlySelector = MediaCodecSelector { _, _, _ -> listOf(hwHealthy) }
    val swOnlySelector = MediaCodecSelector { _, _, _ -> listOf(swAndroid) }
    val policy = CodecPolicy().apply {
      recordVideoCodecFailure(hwFailing)
      recordVideoCodecFailure(hwFailing)
    }

    val autoRenderer = PolicyVideoRenderer(
      MediaCodecVideoRenderer.Builder(app), app, policy, false, false,
      formatSupportChecker = { info, _ -> info.name == hwHealthy.name },
      decoderMode = VideoDecoderMode.AUTO,
    )
    assertEquals(listOf(hwHealthy.name), autoRenderer.resolveDecoderInfosForTest(mixedSelector, format1080).map { it.name })

    val hwRenderer = PolicyVideoRenderer(
      MediaCodecVideoRenderer.Builder(app), app, policy, false, false,
      formatSupportChecker = { _, _ -> false },
      decoderMode = VideoDecoderMode.HARDWARE,
    )
    assertEquals(listOf(hwHealthy.name, hwFailing.name), hwRenderer.resolveDecoderInfosForTest(mixedSelector, format1080).map { it.name })
    assertEquals(emptyList<String>(), hwRenderer.resolveDecoderInfosForTest(swOnlySelector, format1080).map { it.name })

    val swRenderer = PolicyVideoRenderer(
      MediaCodecVideoRenderer.Builder(app), app, policy, false, false,
      formatSupportChecker = { _, _ -> true },
      decoderMode = VideoDecoderMode.SOFTWARE,
    )
    assertEquals(listOf(swAndroid.name), swRenderer.resolveDecoderInfosForTest(mixedSelector, format1080).map { it.name })
    assertEquals(listOf(hwHealthy.name), swRenderer.resolveDecoderInfosForTest(hwOnlySelector, format1080).map { it.name })

    assertEquals(VideoDecoderMode.SOFTWARE, buildVideoRenderer(decoderMode = VideoDecoderMode.SOFTWARE).decoderModeForTest)
    assertEquals(VideoDecoderMode.HARDWARE, buildVideoRenderer(decoderMode = VideoDecoderMode.HARDWARE).decoderModeForTest)
  }
}
