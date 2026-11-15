# Simulator format gaps

2026-11-14. Formats the simulator corpus does not generate, from the
[simulator corpus spec](../superpowers/specs/2026-11-14-sim-corpus-design.md) section 6; checked against FFmpeg 9.0.1.

| Format | Why not generated | Revisit |
|---|---|---|
| DVB bitmap subtitles in TS, PGS in MKV | no text-to-bitmap path in FFmpeg (verified); no PGS encoder | #74 |
| Teletext subtitles, CEA-608/708 captions | no encoder | #74 |
| Subtitles in TS for the subtitle recipe | follows from the two rows above; WebVTT in TS is not a standard carriage | #74 |
| HLS alternate audio renditions (`TYPE=AUDIO`) | not generated; audio stays muxed (two PIDs) | #73 if needed |
| ASS/SSA tracks in MKV | FFmpeg can write them; styling belongs to #32 | #32 |
| MP2 in MP4 | the muxer writes the generic MPEG audio object type; readers may label it MP3, so the movie is MKV | — |
| Resolution change in MP4/MKV | the sample entry or codec private data describes the first resolution; the change is in-band | #74 |
| Default subtitle in MP4 | the muxer marks the first text track enabled although no disposition is set | — |
| DTS, TrueHD | experimental encoders; rare on IPTV | — |
