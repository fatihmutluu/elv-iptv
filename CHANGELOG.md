# Changelog

## 0.1.0 (2026-11-14)


### Features

* add the focus core and the 100k TV list gate ([#42](https://github.com/fatihmutluu/elv-iptv/issues/42)) ([6714df2](https://github.com/fatihmutluu/elv-iptv/commit/6714df21c7c95560534572f737eb88770cf7e763))
* **app:** add Expo app for phone, tablet and TV ([c913e7f](https://github.com/fatihmutluu/elv-iptv/commit/c913e7f97441f6da6e6cbebabb1388afb1935e0f))
* **data:** import catalogs and guides into SQLite ([#41](https://github.com/fatihmutluu/elv-iptv/issues/41)) ([e306ddc](https://github.com/fatihmutluu/elv-iptv/commit/e306ddc2a76d11a34ec61ced533bb776c23157d2))
* **desktop:** add Electron app with react-native-web renderer ([d733521](https://github.com/fatihmutluu/elv-iptv/commit/d73352188cdae73faf142ac7b71c6072b4573332))
* forward raw Android TV remote keys to the focus core ([#47](https://github.com/fatihmutluu/elv-iptv/issues/47)) ([b1ca381](https://github.com/fatihmutluu/elv-iptv/commit/b1ca3811826ead2f28932c4cf3fcec5842aea21c))
* **sources:** stream playlists and guides and add a tolerant Xtream client ([#38](https://github.com/fatihmutluu/elv-iptv/issues/38)) ([45a2cdc](https://github.com/fatihmutluu/elv-iptv/commit/45a2cdc354e15bdd7c685fe16363c7aab904eb0a))
* **tools:** add a local stream simulator ([#36](https://github.com/fatihmutluu/elv-iptv/issues/36)) ([90c3c2d](https://github.com/fatihmutluu/elv-iptv/commit/90c3c2db429529cf0d2f5623726493ec9197e42a))
* **tools:** add a simulator format corpus, subtitles and runtime faults ([#86](https://github.com/fatihmutluu/elv-iptv/issues/86)) ([6971156](https://github.com/fatihmutluu/elv-iptv/commit/6971156f00dc94ad7e1b90f6c3d2df557ea46cb8))
* **tv-mobile:** store the catalog on the device and import sources there ([#78](https://github.com/fatihmutluu/elv-iptv/issues/78)) ([59783ac](https://github.com/fatihmutluu/elv-iptv/commit/59783ac159a62d5438ea8ad3601abbfff20be27e))


### Bug Fixes

* **app:** centralize shared versions in a pnpm catalog and document policies ([d758894](https://github.com/fatihmutluu/elv-iptv/commit/d7588942168d44eab751b7a049c22226a0881209))
* **claude:** anchor deny rules at the project root and quiet scaffold ([85f5c6d](https://github.com/fatihmutluu/elv-iptv/commit/85f5c6d1243159955b103d8cc3abb08b88d4d9e7))
* **claude:** close force-push hook gaps and lint scaffold output ([58b5505](https://github.com/fatihmutluu/elv-iptv/commit/58b5505751db0614c4f7f46d61c1080597500a5c))
* **desktop:** return 404 for missing renderer files ([5e738b1](https://github.com/fatihmutluu/elv-iptv/commit/5e738b1fcdafc249498048ba7947d850e930a1df))
* **tools:** catch aliased platform imports in dependency rules ([49f3fc7](https://github.com/fatihmutluu/elv-iptv/commit/49f3fc73331a1d896330a4a8834fb59a96b1b4a5))
* **tools:** harden dev-env isolation, surface warnings and enforce agent doc limits ([c476ecd](https://github.com/fatihmutluu/elv-iptv/commit/c476ecda86f0c3bc6cb80cd4d831eb4921749d6e))
* **tools:** name a Linux install option in the gitleaks hint ([d4005f9](https://github.com/fatihmutluu/elv-iptv/commit/d4005f9c36b27e18f74f930ee6007464ca91ea53))
* **tools:** re-run prebuild when the native target changes ([f9c8505](https://github.com/fatihmutluu/elv-iptv/commit/f9c8505db975945d4f57cbf2b171dbf18936d75f))
* **tv-mobile:** allow plain HTTP for user-supplied sources ([#80](https://github.com/fatihmutluu/elv-iptv/issues/80)) ([01d77f1](https://github.com/fatihmutluu/elv-iptv/commit/01d77f1f150b0c75aefc73caa57ac6d3ff75a048))
* **tv-mobile:** start the tvOS gate from a launch argument ([#45](https://github.com/fatihmutluu/elv-iptv/issues/45)) ([972741d](https://github.com/fatihmutluu/elv-iptv/commit/972741d8ab2b4df94cef8103cba4a62af5b5d4d5))
