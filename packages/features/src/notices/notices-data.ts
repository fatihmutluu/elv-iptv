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
    id: 'desktop-libmpv',
    name: 'libmpv & FFmpeg (Desktop Player Runtime)',
    version: '0.42.0',
    license: 'LGPL-2.1-or-later AND ISC AND MIT AND FTL',
    platforms: ['Windows', 'macOS'],
    sourceUrl: 'https://github.com/mpv-player/mpv/releases/tag/v0.42.0',
    modificationNote:
      'Runs out-of-process over JSON IPC. Windows uses unmodified upstream LGPL release (https://github.com/mpv-player/mpv/releases/download/v0.42.0/libmpv-v0.42.0-x86_64-w64-mingw32-lgpl.zip) loaded dynamically via LoadLibraryExW. macOS arm64 builds mpv 0.42.0 (-Dgpl=false) and FFmpeg 9.0.2 (without --enable-gpl or --enable-nonfree) via mpv-runtime.yml (fatihmutluu/elv-iptv, run 43641362989) with upstream compile-fix backport (video/out/mac/view.swift) documented in tools/mpv-runtime/versions.json.',
    noticeText:
      'mpv / libmpv 0.42.0 and FFmpeg 9.0.2 — Licensed under the GNU Lesser General Public License v2.1 or later (LGPL-2.1-or-later), executed in a separate helper process and dynamically linked.\n\nWindows LGPL binary & source release: https://github.com/mpv-player/mpv/releases/download/v0.42.0/libmpv-v0.42.0-x86_64-w64-mingw32-lgpl.zip.\n\nmacOS LGPL build recipe, source pins, and SHA-256 digests: https://github.com/fatihmutluu/elv-iptv/blob/main/.github/workflows/mpv-runtime.yml and https://github.com/fatihmutluu/elv-iptv/blob/main/tools/mpv-runtime/versions.json (FFmpeg source: https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz).\n\nCompanion libraries in macOS runtime: libplacebo 7.387.0 (LGPL-2.1-or-later), fribidi 1.0.18 (LGPL-2.1-or-later), libass 0.17.5 (ISC), HarfBuzz 15.1.0 (Old-MIT), FreeType 2.15.0 (FTL), LuaJIT 2.1 (MIT).',
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
