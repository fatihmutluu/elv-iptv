import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  workspaces: {
    '.': {
      entry: ['scripts/*.mjs', '.agents/hooks/*.mjs', '.claude/hooks/*.mjs'],
      ignoreBinaries: ['gitleaks'],
    },
    tools: {
      entry: ['bin/*.ts'],
      project: ['bin/**/*.ts', 'src/**/*.ts', 'test/*.ts'],
      ignoreDependencies: ['dependency-cruiser'],
    },
    'apps/tv-mobile': {
      // The catalog barrel is consumed by the menu screens in a later task.
      entry: ['config/*.test.ts', 'src/catalog/index.ts', 'src/storage/index.ts'],
      // The TV plugin is loaded by name from app.config.ts; knip infers optional Expo packages.
      ignoreDependencies: [
        '@elv/sources',
        '@react-native-tvos/config-tv',
        'babel-jest',
        'expo-updates',
      ],
    },
    'apps/desktop': {
      // presenter-probe.ts is the test-only Electron main the presenter spec launches.
      entry: [
        'e2e/*.spec.ts',
        'e2e/presenter-probe.ts',
        'scripts/*.mjs',
        'src/main/main.ts',
        'src/preload/preload.ts',
        'src/utility/catalog-worker.ts',
      ],
      // Needed by the packaging script and by the workspace link to the renderer export.
      ignoreDependencies: ['@elv/desktop-renderer'],
      // Windows system tool used to check that a recorded pid is still the launcher.
      ignoreBinaries: ['tasklist'],
    },
    'apps/desktop/renderer': {
      // The catalog barrel is consumed by the menu screens in a later task.
      entry: ['src/catalog/index.ts'],
      // Optional Expo packages inferred from app.json.
      ignoreDependencies: ['expo-updates'],
    },
    'packages/ui-kit': {
      // Babel config is read by jest-expo; the preset is a direct devDependency for pnpm's isolated layout.
      entry: ['babel.config.cjs'],
      ignoreDependencies: ['@elv/domain', 'babel-jest', 'babel-preset-expo'],
    },
    'packages/features': {
      entry: ['babel.config.cjs'],
      ignoreDependencies: ['babel-jest', 'babel-preset-expo'],
    },
    'packages/*': {
      // Skeleton packages declare their spec 5.2 dependencies before any code imports them.
      ignoreDependencies: ['@elv/domain'],
    },
  },
};

export default config;
