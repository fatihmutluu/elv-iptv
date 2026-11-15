# DefaultRenderersFactory instantiates FfmpegAudioRenderer via Class.forName + reflection.
# R8 full mode requires an unconditional -keep on the class and constructor, not -keepclassmembers.
-keep class androidx.media3.decoder.ffmpeg.FfmpegAudioRenderer {
  public <init>(
    android.os.Handler,
    androidx.media3.exoplayer.audio.AudioRendererEventListener,
    androidx.media3.exoplayer.audio.AudioSink
  );
}

# libffmpegJNI.so's JNI_OnLoad eagerly calls RegisterNatives on FfmpegLibrary and
# FfmpegAudioDecoder and GetMethodID on growOutputBuffer when System.loadLibrary runs.
-keep,includedescriptorclasses class androidx.media3.decoder.ffmpeg.FfmpegLibrary {
  native <methods>;
}

-keep,includedescriptorclasses class androidx.media3.decoder.ffmpeg.FfmpegAudioDecoder {
  native <methods>;
  private java.nio.ByteBuffer growOutputBuffer(androidx.media3.decoder.SimpleDecoderOutputBuffer, int);
}
