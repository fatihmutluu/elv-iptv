/** Deterministic third-party software notices; regenerate with `pnpm notices:sync`. */
export interface ThirdPartyNotice {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly platforms: readonly string[];
  readonly sourceUrl: string;
  readonly modificationNote?: string;
  readonly noticeText: string;
}

/** Offline third-party notices covering shipped native engines and bundled runtime packages. */
export const THIRD_PARTY_NOTICES: readonly ThirdPartyNotice[] = [
  {
    id: 'aether-engine',
    name: 'AetherEngine',
    version: '7.66.1',
    license: 'LGPL-3.0-or-later WITH App-Store-DRM-exception',
    platforms: ['iOS', 'iPadOS', 'tvOS'],
    sourceUrl: 'https://github.com/superuser404notfound/AetherEngine/tree/7.66.1',
    modificationNote:
      'Unmodified upstream tag 7.66.1 integrated via Swift Package Manager with optional traits disabled. Our Xcode build phase strips framework headers, thins architectures, signs, and copies dSYMs without modifying AetherEngine source or binaries.',
    noticeText:
      'AetherEngine 7.66.1 (https://github.com/superuser404notfound/AetherEngine)\n\nLicensed under the GNU Lesser General Public License v3.0 or later (LGPL-3.0-or-later) with the upstream App Store and DRM distribution exception covering AetherEngine Swift/Objective-C code.\n\nCorresponding upstream source code for tag 7.66.1 is available at https://github.com/superuser404notfound/AetherEngine/tree/7.66.1.\n\nDynamic LGPL media and codec frameworks (AetherLibavcodec.framework, AetherLibavfilter.framework, AetherLibavformat.framework, AetherLibavutil.framework, AetherLibdav1d.framework, AetherLibswresample.framework, AetherLibswscale.framework, AetherLibzimg.framework, AetherLibzvbi.framework) remain dynamically linked in Frameworks/ under their respective licenses.',
  },
  {
    id: 'aether-ffmpeg',
    name: 'FFmpeg & Dynamic Frameworks (AetherLib*.framework)',
    version: '7.66.1',
    license: 'LGPL-2.1-or-later',
    platforms: ['iOS', 'iPadOS', 'tvOS'],
    sourceUrl: 'https://ffmpeg.org/',
    modificationNote:
      'Unmodified dynamic XCFramework slices from AetherEngine 7.66.1 (AetherLibavcodec.framework, AetherLibavfilter.framework, AetherLibavformat.framework, AetherLibavutil.framework, AetherLibdav1d.framework, AetherLibswresample.framework, AetherLibswscale.framework, AetherLibzimg.framework, AetherLibzvbi.framework), lipo-thinned to target architectures and code-signed in Frameworks/ (@rpath) without --enable-gpl or --enable-nonfree.',
    noticeText:
      'FFmpeg and companion dynamic media frameworks (AetherLibavcodec.framework, AetherLibavfilter.framework, AetherLibavformat.framework, AetherLibavutil.framework, AetherLibdav1d.framework, AetherLibswresample.framework, AetherLibswscale.framework, AetherLibzimg.framework, AetherLibzvbi.framework) bundled via AetherEngine 7.66.1.\n\nThis software uses libraries from the FFmpeg project under the GNU Lesser General Public License version 2.1 or later (LGPL-2.1-or-later), linked dynamically without GPL or nonfree components.\n\nUpstream FFmpeg source code: https://ffmpeg.org/ | Apple XCFramework build scripts and tags: https://github.com/superuser404notfound/FFmpegBuild and https://github.com/superuser404notfound/AetherEngine/tree/7.66.1.',
  },
  {
    id: 'aether-codecs',
    name: 'libdovi, dav1d, zimg & zvbi (Apple Codec Libraries)',
    version: '7.66.1',
    license: '(MIT OR Apache-2.0) AND BSD-2-Clause AND WTFPL AND LGPL-2.1-or-later',
    platforms: ['iOS', 'iPadOS', 'tvOS'],
    sourceUrl: 'https://github.com/superuser404notfound/AetherEngine/tree/7.66.1',
    modificationNote: 'Unmodified codec libraries distributed with AetherEngine 7.66.1.',
    noticeText:
      'libdovi — Copyright (c) quietvoid and contributors. Licensed under MIT OR Apache-2.0 (https://github.com/quietvoid/dovi_tool).\n\ndav1d (AetherLibdav1d.framework) — Copyright (c) 2018-2026 VideoLAN and dav1d authors. Licensed under the BSD 2-Clause License (https://code.videolan.org/videolan/dav1d).\n\nzimg (AetherLibzimg.framework) — Copyright (c) sekrit-twc. Licensed under the WTFPL v2 public-domain-equivalent permissive license (https://github.com/sekrit-twc/zimg).\n\nzvbi (AetherLibzvbi.framework) — Copyright (c) Michael H. Schimek and contributors. Dynamically linked under the GNU Lesser General Public License v2.1 or later (https://github.com/zapping-vbi/zvbi).',
  },
  {
    id: 'androidx-media3',
    name: 'AndroidX Media3',
    version: '1.11.1',
    license: 'Apache-2.0',
    platforms: ['Android', 'Android TV', 'Fire OS'],
    sourceUrl: 'https://github.com/androidx/media/tree/1.11.1',
    modificationNote:
      'Unmodified AndroidX Media3 1.11.1 Maven libraries and upstream decoder_ffmpeg JNI/Java sources (commit 8c6678b657ede1e7883fc164ef73ed483c7796c3).',
    noticeText:
      'Copyright (C) The Android Open Source Project (AndroidX Media3 1.11.1).\n\nLicensed under the Apache License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0).\n\nUpstream source code: https://github.com/androidx/media/tree/1.11.1.',
  },
  {
    id: 'ffmpeg-media3',
    name: 'FFmpeg (Android Media3 Audio Extension)',
    version: '9.0.2',
    license: 'LGPL-2.1-or-later',
    platforms: ['Android', 'Android TV', 'Fire OS'],
    sourceUrl: 'https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz',
    modificationNote:
      'Unmodified FFmpeg 9.0.2 source compiled as dynamic 16 KB-aligned ELF shared libraries (libavutil.so, libswresample.so, libavcodec.so, libffmpegJNI.so) without --enable-gpl or --enable-nonfree via tools/ffmpeg-media3/build-android.sh and ffmpeg-media3.yml (fatihmutluu/elv-iptv, run 43707260644).',
    noticeText:
      'This software uses libraries from the FFmpeg project (9.0.2) under the GNU Lesser General Public License v2.1 or later (LGPL-2.1-or-later), linked dynamically on Android.\n\nEnabled audio decoders: aac, ac3, alac, dca, eac3, flac, mlp, mp2, mp3, opus, pcm_alaw, pcm_mulaw, truehd, vorbis.\n\nFFmpeg source archive: https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz | Reproducible build script and CI workflow: https://github.com/fatihmutluu/elv-iptv/blob/main/.github/workflows/ffmpeg-media3.yml.',
  },
  {
    id: 'libass-android',
    name: 'libass-android (ass-media, libass, FriBidi, HarfBuzz, FreeType)',
    version: '0.6.0-beta01',
    license: 'MIT AND ISC AND LGPL-2.1-or-later AND FTL',
    platforms: ['Android', 'Android TV', 'Fire OS'],
    sourceUrl: 'https://github.com/peerless2012/libass-android',
    modificationNote:
      'Unmodified Maven Central artifacts (io.github.peerless2012:ass-media:0.6.0-beta01, ass-kt:0.6.0-beta01, ass:0.6.0-beta01) providing dynamically loaded libass.so for native ASS/SSA OpenGL subtitle overlay on Android Media3 without GPL components.',
    noticeText:
      'libass-android / ass-media 0.6.0-beta01 (https://github.com/peerless2012/libass-android) — Licensed under the MIT License.\n\nDynamically loaded native subtitle renderer packaging libass (ISC), FriBidi (LGPL-2.1-or-later), HarfBuzz (Old-MIT), FreeType (FreeType License / FTL), libunibreak (Zlib), and libpng (libpng License).\n\nUpstream source code and build recipes: https://github.com/peerless2012/libass-android and https://github.com/libass/libass.',
  },
  {
    id: 'desktop-libmpv',
    name: 'libmpv & FFmpeg (Desktop Player Runtime)',
    version: '0.42.0',
    license: 'LGPL-2.1-or-later AND ISC AND MIT AND FTL',
    platforms: ['Windows', 'macOS'],
    sourceUrl: 'https://github.com/mpv-player/mpv/releases/tag/v0.42.0',
    modificationNote:
      'Runs out-of-process over JSON IPC. Windows uses pinned upstream LGPL release (https://github.com/mpv-player/mpv/releases/download/v0.42.0/libmpv-v0.42.0-x86_64-w64-mingw32-lgpl.zip) loaded dynamically via LoadLibraryExW, alongside reproducible Windows x64 LGPL CI build recipe in tools/mpv-runtime/build-windows.sh (mpv-runtime.yml). macOS arm64 builds mpv 0.42.0 (-Dgpl=false) and FFmpeg 9.0.2 (without --enable-gpl or --enable-nonfree) via mpv-runtime.yml (fatihmutluu/elv-iptv, run 44996151000) with upstream compile-fix backport (video/out/mac/view.swift) documented in tools/mpv-runtime/versions.json.',
    noticeText:
      'mpv / libmpv 0.42.0 and FFmpeg 9.0.2 — Licensed under the GNU Lesser General Public License v2.1 or later (LGPL-2.1-or-later), executed in a separate helper process and dynamically linked on Windows and macOS.\n\nWindows LGPL binary & source release: https://github.com/mpv-player/mpv/releases/download/v0.42.0/libmpv-v0.42.0-x86_64-w64-mingw32-lgpl.zip.\n\nReproducible Windows & macOS LGPL build recipes (tools/mpv-runtime/build-windows.sh, tools/mpv-runtime/build-macos.sh), source pins, and SHA-256 digests: https://github.com/fatihmutluu/elv-iptv/blob/main/.github/workflows/mpv-runtime.yml and https://github.com/fatihmutluu/elv-iptv/blob/main/tools/mpv-runtime/versions.json (FFmpeg source: https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz).\n\nBundled libraries in Windows & macOS mpv runtimes: libmpv 0.42.0 (LGPL-2.1-or-later), FFmpeg 9.0.2 (LGPL-2.1-or-later), libplacebo 7.387.0 (LGPL-2.1-or-later), FriBidi 1.0.18 (LGPL-2.1-or-later), libass 0.17.5 (ISC), HarfBuzz 15.1.0 (Old-MIT), FreeType 2.15.0 (FTL), LuaJIT 2.1 (MIT).',
  },
  {
    id: 'atkinson-hyperlegible-next',
    name: 'Atkinson Hyperlegible Next',
    version: 'bundled',
    license: 'OFL-1.1',
    platforms: [
      'Android',
      'Android TV',
      'Fire OS',
      'iOS',
      'iPadOS',
      'tvOS',
      'Windows',
      'macOS',
      'Linux',
    ],
    sourceUrl: 'https://github.com/googlefonts/atkinson-hyperlegible-next',
    modificationNote:
      'Unmodified Regular and Bold TTF binaries bundled for high-legibility UI and subtitle rendering.',
    noticeText:
      'Copyright 2020-2024 The Atkinson Hyperlegible Next Project Authors (https://github.com/googlefonts/atkinson-hyperlegible-next)\n\nThis Font Software is licensed under the SIL Open Font License, Version 1.1.\nThis license is copied below, and is also available with a FAQ at:\nhttps://openfontlicense.org\n\n\n-----------------------------------------------------------\nSIL OPEN FONT LICENSE Version 1.1 - 26 February 2007\n-----------------------------------------------------------\n\nPREAMBLE\nThe goals of the Open Font License (OFL) are to stimulate worldwide\ndevelopment of collaborative font projects, to support the font creation\nefforts of academic and linguistic communities, and to provide a free and\nopen framework in which fonts may be shared and improved in partnership\nwith others.\n\nThe OFL allows the licensed fonts to be used, studied, modified and\nredistributed freely as long as they are not sold by themselves. The\nfonts, including any derivative works, can be bundled, embedded, \nredistributed and/or sold with any software provided that any reserved\nnames are not used by derivative works. The fonts and derivatives,\nhowever, cannot be released under any other type of license. The\nrequirement for fonts to remain under this license does not apply\nto any document created using the fonts or their derivatives.\n\nDEFINITIONS\n"Font Software" refers to the set of files released by the Copyright\nHolder(s) under this license and clearly marked as such. This may\ninclude source files, build scripts and documentation.\n\n"Reserved Font Name" refers to any names specified as such after the\ncopyright statement(s).\n\n"Original Version" refers to the collection of Font Software components as\ndistributed by the Copyright Holder(s).\n\n"Modified Version" refers to any derivative made by adding to, deleting,\nor substituting -- in part or in whole -- any of the components of the\nOriginal Version, by changing formats or by porting the Font Software to a\nnew environment.\n\n"Author" refers to any designer, engineer, programmer, technical\nwriter or other person who contributed to the Font Software.\n\nPERMISSION & CONDITIONS\nPermission is hereby granted, free of charge, to any person obtaining\na copy of the Font Software, to use, study, copy, merge, embed, modify,\nredistribute, and sell modified and unmodified copies of the Font\nSoftware, subject to the following conditions:\n\n1) Neither the Font Software nor any of its individual components,\nin Original or Modified Versions, may be sold by itself.\n\n2) Original or Modified Versions of the Font Software may be bundled,\nredistributed and/or sold with any software, provided that each copy\ncontains the above copyright notice and this license. These can be\nincluded either as stand-alone text files, human-readable headers or\nin the appropriate machine-readable metadata fields within text or\nbinary files as long as those fields can be easily viewed by the user.\n\n3) No Modified Version of the Font Software may use the Reserved Font\nName(s) unless explicit written permission is granted by the corresponding\nCopyright Holder. This restriction only applies to the primary font name as\npresented to the users.\n\n4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font\nSoftware shall not be used to promote, endorse or advertise any\nModified Version, except to acknowledge the contribution(s) of the\nCopyright Holder(s) and the Author(s) or with their explicit written\npermission.\n\n5) The Font Software, modified or unmodified, in part or in whole,\nmust be distributed entirely under this license, and must not be\ndistributed under any other license. The requirement for fonts to\nremain under this license does not apply to any document created\nusing the Font Software.\n\nTERMINATION\nThis license becomes null and void if any of the above conditions are\nnot met.\n\nDISCLAIMER\nTHE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,\nEXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF\nMERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT\nOF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE\nCOPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,\nINCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL\nDAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING\nFROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM\nOTHER DEALINGS IN THE FONT SOFTWARE.',
  },
  {
    id: 'opendyslexic',
    name: 'OpenDyslexic',
    version: 'bundled',
    license: 'OFL-1.1',
    platforms: [
      'Android',
      'Android TV',
      'Fire OS',
      'iOS',
      'iPadOS',
      'tvOS',
      'Windows',
      'macOS',
      'Linux',
    ],
    sourceUrl: 'https://github.com/antijingoist/opendyslexic',
    modificationNote:
      'Unmodified Regular and Bold OTF binaries bundled for dyslexia-friendly UI and subtitle rendering.',
    noticeText:
      'Copyright (c) 2019-07-29, Abbie Gonzalez (https://abbiecod.es|support@abbiecod.es),\nwith Reserved Font Name OpenDyslexic.\nCopyright (c) 12/2012 - 2019\nThis Font Software is licensed under the SIL Open Font License, Version 1.1.\nThis license is copied below, and is also available with a FAQ at:\nhttp://scripts.sil.org/OFL\n\n\n-----------------------------------------------------------\nSIL OPEN FONT LICENSE Version 1.1 - 26 February 2007\n-----------------------------------------------------------\n\nPREAMBLE\nThe goals of the Open Font License (OFL) are to stimulate worldwide\ndevelopment of collaborative font projects, to support the font creation\nefforts of academic and linguistic communities, and to provide a free and\nopen framework in which fonts may be shared and improved in partnership\nwith others.\n\nThe OFL allows the licensed fonts to be used, studied, modified and\nredistributed freely as long as they are not sold by themselves. The\nfonts, including any derivative works, can be bundled, embedded, \nredistributed and/or sold with any software provided that any reserved\nnames are not used by derivative works. The fonts and derivatives,\nhowever, cannot be released under any other type of license. The\nrequirement for fonts to remain under this license does not apply\nto any document created using the fonts or their derivatives.\n\nDEFINITIONS\n"Font Software" refers to the set of files released by the Copyright\nHolder(s) under this license and clearly marked as such. This may\ninclude source files, build scripts and documentation.\n\n"Reserved Font Name" refers to any names specified as such after the\ncopyright statement(s).\n\n"Original Version" refers to the collection of Font Software components as\ndistributed by the Copyright Holder(s).\n\n"Modified Version" refers to any derivative made by adding to, deleting,\nor substituting -- in part or in whole -- any of the components of the\nOriginal Version, by changing formats or by porting the Font Software to a\nnew environment.\n\n"Author" refers to any designer, engineer, programmer, technical\nwriter or other person who contributed to the Font Software.\n\nPERMISSION & CONDITIONS\nPermission is hereby granted, free of charge, to any person obtaining\na copy of the Font Software, to use, study, copy, merge, embed, modify,\nredistribute, and sell modified and unmodified copies of the Font\nSoftware, subject to the following conditions:\n\n1) Neither the Font Software nor any of its individual components,\nin Original or Modified Versions, may be sold by itself.\n\n2) Original or Modified Versions of the Font Software may be bundled,\nredistributed and/or sold with any software, provided that each copy\ncontains the above copyright notice and this license. These can be\nincluded either as stand-alone text files, human-readable headers or\nin the appropriate machine-readable metadata fields within text or\nbinary files as long as those fields can be easily viewed by the user.\n\n3) No Modified Version of the Font Software may use the Reserved Font\nName(s) unless explicit written permission is granted by the corresponding\nCopyright Holder. This restriction only applies to the primary font name as\npresented to the users.\n\n4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font\nSoftware shall not be used to promote, endorse or advertise any\nModified Version, except to acknowledge the contribution(s) of the\nCopyright Holder(s) and the Author(s) or with their explicit written\npermission.\n\n5) The Font Software, modified or unmodified, in part or in whole,\nmust be distributed entirely under this license, and must not be\ndistributed under any other license. The requirement for fonts to\nremain under this license does not apply to any document created\nusing the Font Software.\n\nTERMINATION\nThis license becomes null and void if any of the above conditions are\nnot met.\n\nDISCLAIMER\nTHE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,\nEXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF\nMERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT\nOF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE\nCOPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,\nINCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL\nDAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING\nFROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM\nOTHER DEALINGS IN THE FONT SOFTWARE.',
  },
  {
    id: 'npm-better-sqlite3',
    name: 'better-sqlite3',
    version: '13.0.3',
    license: 'MIT',
    platforms: ['Windows', 'macOS', 'Linux'],
    sourceUrl: 'https://github.com/WiseLibs/better-sqlite3',
    noticeText:
      'The MIT License (MIT)\n\nCopyright (c) 2017 Joshua Wise\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.\n\nIncludes SQLite C library (Public Domain — https://www.sqlite.org/copyright.html).',
  },
  {
    id: 'npm-electron',
    name: 'electron',
    version: '45.3.1',
    license: 'MIT',
    platforms: ['Windows', 'macOS', 'Linux'],
    sourceUrl: 'https://github.com/electron/electron',
    noticeText:
      'Copyright (c) Electron contributors\nCopyright (c) 2013-2020 GitHub Inc.\n\nPermission is hereby granted, free of charge, to any person obtaining\na copy of this software and associated documentation files (the\n"Software"), to deal in the Software without restriction, including\nwithout limitation the rights to use, copy, modify, merge, publish,\ndistribute, sublicense, and/or sell copies of the Software, and to\npermit persons to whom the Software is furnished to do so, subject to\nthe following conditions:\n\nThe above copyright notice and this permission notice shall be\nincluded in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,\nEXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF\nMERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND\nNONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE\nLIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION\nOF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION\nWITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.',
  },
  {
    id: 'npm-expo',
    name: 'expo',
    version: '58.0.25',
    license: 'MIT',
    platforms: [
      'Android',
      'Android TV',
      'Fire OS',
      'iOS',
      'iPadOS',
      'tvOS',
      'Windows',
      'macOS',
      'Linux',
    ],
    sourceUrl: 'https://github.com/expo/expo',
    noticeText:
      'The MIT License (MIT)\n\nCopyright (c) 2015-present 650 Industries, Inc. (aka Expo)\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.',
  },
  {
    id: 'npm-expo-build-properties',
    name: 'expo-build-properties',
    version: '58.0.12',
    license: 'MIT',
    platforms: ['Android', 'Android TV', 'Fire OS', 'iOS', 'iPadOS', 'tvOS'],
    sourceUrl: 'https://github.com/expo/expo',
    noticeText:
      'The MIT License (MIT)\n\nCopyright (c) 2015-present 650 Industries, Inc. (aka Expo)\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.',
  },
  {
    id: 'npm-expo-constants',
    name: 'expo-constants',
    version: '58.0.16',
    license: 'MIT',
    platforms: ['Android', 'Android TV', 'Fire OS', 'iOS', 'iPadOS', 'tvOS'],
    sourceUrl: 'https://github.com/expo/expo',
    noticeText:
      'The MIT License (MIT)\n\nCopyright (c) 2015-present 650 Industries, Inc. (aka Expo)\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.',
  },
  {
    id: 'npm-expo-localization',
    name: 'expo-localization',
    version: '58.0.5',
    license: 'MIT',
    platforms: ['Android', 'Android TV', 'Fire OS', 'iOS', 'iPadOS', 'tvOS'],
    sourceUrl: 'https://github.com/expo/expo',
    noticeText:
      'The MIT License (MIT)\n\nCopyright (c) 2015-present 650 Industries, Inc. (aka Expo)\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.',
  },
  {
    id: 'npm-expo-metro-runtime',
    name: '@expo/metro-runtime',
    version: '58.0.17',
    license: 'MIT',
    platforms: ['Windows', 'macOS', 'Linux'],
    sourceUrl: 'https://github.com/expo/expo',
    noticeText:
      'The MIT License (MIT)\n\nCopyright (c) 2015-present 650 Industries, Inc. (aka Expo)\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.',
  },
  {
    id: 'npm-expo-modules-core',
    name: 'expo-modules-core',
    version: '58.1.0',
    license: 'MIT',
    platforms: ['Android', 'Android TV', 'Fire OS', 'iOS', 'iPadOS', 'tvOS'],
    sourceUrl: 'https://github.com/expo/expo',
    noticeText:
      'The MIT License (MIT)\n\nCopyright (c) 2015-present 650 Industries, Inc. (aka Expo)\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.',
  },
  {
    id: 'npm-expo-secure-store',
    name: 'expo-secure-store',
    version: '58.0.3',
    license: 'MIT',
    platforms: ['Android', 'Android TV', 'Fire OS', 'iOS', 'iPadOS', 'tvOS'],
    sourceUrl: 'https://github.com/expo/expo',
    noticeText:
      'The MIT License (MIT)\n\nCopyright (c) 2015-present 650 Industries, Inc. (aka Expo)\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.',
  },
  {
    id: 'npm-expo-status-bar',
    name: 'expo-status-bar',
    version: '58.0.5',
    license: 'MIT',
    platforms: ['Android', 'Android TV', 'Fire OS', 'iOS', 'iPadOS', 'tvOS'],
    sourceUrl: 'https://github.com/expo/expo',
    noticeText:
      'The MIT License (MIT)\n\nCopyright (c) 2015-present 650 Industries, Inc. (aka Expo)\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.',
  },
  {
    id: 'npm-formatjs-intl-pluralrules',
    name: '@formatjs/intl-pluralrules',
    version: '7.0.4',
    license: 'MIT',
    platforms: [
      'Android',
      'Android TV',
      'Fire OS',
      'iOS',
      'iPadOS',
      'tvOS',
      'Windows',
      'macOS',
      'Linux',
    ],
    sourceUrl: 'https://github.com/formatjs/formatjs',
    noticeText:
      'MIT License\n\nCopyright (c) 2023 FormatJS\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.',
  },
  {
    id: 'npm-lingui-core',
    name: '@lingui/core',
    version: '6.12.0',
    license: 'MIT',
    platforms: [
      'Android',
      'Android TV',
      'Fire OS',
      'iOS',
      'iPadOS',
      'tvOS',
      'Windows',
      'macOS',
      'Linux',
    ],
    sourceUrl: 'https://github.com/lingui/js-lingui',
    noticeText:
      'The MIT License (MIT)\n\nCopyright (c) 2017-2022 Tomáš Ehrlich, (c) 2022-2023 Crowdin.\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in\nall copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN\nTHE SOFTWARE.',
  },
  {
    id: 'npm-op-engineering-op-sqlite',
    name: '@op-engineering/op-sqlite',
    version: '19.0.5',
    license: 'MIT',
    platforms: ['Android', 'Android TV', 'Fire OS', 'iOS', 'iPadOS', 'tvOS'],
    sourceUrl: 'https://github.com/OP-Engineering/op-sqlite',
    noticeText:
      'Copyright 2021 Oscar Franco\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.\n\nIncludes SQLite C library (Public Domain — https://www.sqlite.org/copyright.html).',
  },
  {
    id: 'npm-react',
    name: 'react',
    version: '19.3.0',
    license: 'MIT',
    platforms: [
      'Android',
      'Android TV',
      'Fire OS',
      'iOS',
      'iPadOS',
      'tvOS',
      'Windows',
      'macOS',
      'Linux',
    ],
    sourceUrl: 'https://github.com/react/react',
    noticeText:
      'MIT License\n\nCopyright (c) Meta Platforms, Inc. and affiliates.\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.',
  },
  {
    id: 'npm-react-dom',
    name: 'react-dom',
    version: '19.3.0',
    license: 'MIT',
    platforms: ['Windows', 'macOS', 'Linux'],
    sourceUrl: 'https://github.com/react/react',
    noticeText:
      'MIT License\n\nCopyright (c) Meta Platforms, Inc. and affiliates.\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.',
  },
  {
    id: 'npm-react-native',
    name: 'react-native (react-native-tvos)',
    version: '0.88.1-0',
    license: 'MIT',
    platforms: [
      'Android',
      'Android TV',
      'Fire OS',
      'iOS',
      'iPadOS',
      'tvOS',
      'Windows',
      'macOS',
      'Linux',
    ],
    sourceUrl: 'https://github.com/react-native-tvos/react-native-tvos',
    noticeText:
      'MIT License\n\nCopyright (c) Meta Platforms, Inc. and affiliates.\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.',
  },
  {
    id: 'npm-react-native-tvos-config-tv',
    name: '@react-native-tvos/config-tv',
    version: '0.1.7',
    license: 'MIT',
    platforms: ['Android TV', 'Fire OS', 'tvOS'],
    sourceUrl: 'https://github.com/react-native-tvos/config-tv',
    noticeText:
      '@react-native-tvos/config-tv — Licensed under MIT.\nSource: https://github.com/react-native-tvos/config-tv',
  },
  {
    id: 'npm-react-native-web',
    name: 'react-native-web',
    version: '0.21.4',
    license: 'MIT',
    platforms: ['Windows', 'macOS', 'Linux'],
    sourceUrl: 'https://github.com/necolas/react-native-web',
    noticeText:
      'MIT License\n\nCopyright (c) Nicolas Gallagher.\nCopyright (c) Meta Platforms, Inc. and affiliates.\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.',
  },
];
