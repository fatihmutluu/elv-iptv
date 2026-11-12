/**
 * Architecture rules from the foundation spec, section 5.2. Paths are relative to the
 * repository root; workspace packages resolve to their real folders through pnpm links.
 */

const PURE = 'domain|sources|data|playback|focus-core';
const WORKSPACE = '^(packages|modules|apps)/';
const npm = (names) => `(^|/)node_modules/(${names})(/|$)|^(${names})(/|$)`;

const PLATFORM_LIBS = npm('react|react-dom|react-native|react-native-web|expo|expo-[^/]+|electron');
const NAVIGATION_LIBS = npm('expo-router|@react-navigation/[^/]+|react-navigation');

/** A layer rule: files under `from` may import workspace code only from the `allowed` packages. */
function layer(name, from, allowed, comment) {
  return {
    name,
    comment,
    severity: 'error',
    from: { path: `^packages/(${from})/` },
    to: { path: WORKSPACE, pathNot: `^packages/(${allowed})/` },
  };
}

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    layer(
      'domain-imports-nothing',
      'domain',
      'domain',
      'domain depends on no other workspace code',
    ),
    {
      name: 'leaf-packages-import-domain-only',
      comment: 'sources, playback, focus-core and i18n may import domain and themselves only',
      severity: 'error',
      from: { path: '^packages/(sources|playback|focus-core|i18n)/' },
      to: { path: WORKSPACE, pathNot: '^packages/(domain|$1)/' },
    },
    layer(
      'data-imports-domain-and-sources',
      'data',
      'domain|sources|data',
      'data builds on domain and sources',
    ),
    layer(
      'ui-kit-imports-low-layers',
      'ui-kit',
      'domain|focus-core|i18n|ui-kit',
      'ui-kit imports domain, focus-core and i18n',
    ),
    {
      name: 'pure-packages-no-platform',
      comment: 'pure packages never import react, react-native, expo or electron',
      severity: 'error',
      from: { path: `^packages/(${PURE})/` },
      to: { path: PLATFORM_LIBS },
    },
    {
      name: 'pure-packages-no-node-builtins',
      comment: 'pure packages never import node:* or core modules; use ports from domain',
      severity: 'error',
      from: { path: `^packages/(${PURE})/` },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'features-no-modules-or-apps',
      comment: 'features never import native modules, apps or expo packages',
      severity: 'error',
      from: { path: '^packages/features/' },
      to: { path: `^(modules|apps)/|${npm('expo|expo-[^/]+')}` },
    },
    {
      name: 'no-feature-to-feature',
      comment: 'a feature folder never imports another feature folder',
      severity: 'error',
      from: { path: '^packages/features/src/([^/]+)/' },
      to: { path: '^packages/features/src/', pathNot: '^packages/features/src/$1/' },
    },
    {
      name: 'modules-import-playback-only',
      comment:
        'native modules import playback types and expo-modules-core, nothing else in the workspace',
      severity: 'error',
      from: { path: '^modules/([^/]+)/' },
      to: { path: WORKSPACE, pathNot: ['^packages/playback/', '^modules/$1/'] },
    },
    {
      name: 'workspace-never-imports-apps',
      comment: 'apps are composition roots; nothing imports them',
      severity: 'error',
      from: { path: '^(packages|modules)/' },
      to: { path: '^apps/' },
    },
    {
      name: 'apps-do-not-import-apps',
      comment: 'each app wires its own modules and stores',
      severity: 'error',
      from: { path: '^apps/([^/]+)/' },
      to: { path: '^apps/', pathNot: '^apps/$1/' },
    },
    {
      name: 'navigation-libs-in-apps-only',
      comment: 'Expo Router and React Navigation live in apps only',
      severity: 'error',
      from: { path: '^(packages|modules)/' },
      to: { path: NAVIGATION_LIBS },
    },
    {
      name: 'no-dev-dependencies-in-src',
      comment: 'shipped sources only use runtime dependencies',
      severity: 'error',
      from: {
        path: '^(packages|modules|apps)/[^/]+/src/',
        pathNot: '\\.(test|spec)\\.[cm]?[jt]sx?$',
      },
      to: { dependencyTypes: ['npm-dev'] },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'not-resolvable',
      comment: 'every import must resolve; a missing dependency declaration shows up here',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|build|coverage|\\.expo|android|ios)/|^tools/test/fixtures/' },
    tsPreCompilationDeps: true,
    combinedDependencies: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types'],
    },
    cache: { folder: 'node_modules/.cache/dependency-cruiser', strategy: 'metadata' },
  },
};
