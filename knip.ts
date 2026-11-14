import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  workspaces: {
    '.': { entry: ['scripts/*.mjs', '.claude/hooks/*.mjs'], ignoreBinaries: ['gitleaks'] },
    tools: {
      entry: ['bin/*.ts'],
      project: ['bin/**/*.ts', 'src/**/*.ts', 'test/*.ts'],
      ignoreDependencies: ['dependency-cruiser'],
    },
    'apps/tv-mobile': {
      // The storage barrel is consumed by the device catalog service in the next task.
      entry: ['config/*.test.ts', 'src/storage/index.ts'],
      // The TV plugin is loaded by name from app.config.ts; knip infers optional Expo packages.
      ignoreDependencies: ['@react-native-tvos/config-tv', 'expo-updates'],
    },
    'apps/desktop': {
      entry: ['e2e/*.spec.ts'],
      // Needed by the packaging script and by the workspace link to the renderer export.
      ignoreDependencies: ['@elv/desktop-renderer'],
    },
    'apps/desktop/renderer': {
      // Optional Expo packages inferred from app.json.
      ignoreDependencies: ['expo-updates'],
    },
    'packages/ui-kit': {
      // Babel config is read by jest-expo; the preset is a direct devDependency for pnpm's isolated layout.
      entry: ['babel.config.cjs'],
      ignoreDependencies: ['@elv/domain', '@elv/i18n', 'babel-preset-expo'],
    },
    'packages/features': {
      ignoreDependencies: [
        '@elv/domain',
        '@elv/focus-core',
        '@elv/i18n',
        '@elv/ui-kit',
        '@types/react',
        'react',
        'react-native',
      ],
    },
    'packages/*': {
      // Skeleton packages declare their spec 5.2 dependencies before any code imports them.
      ignoreDependencies: ['@elv/domain'],
    },
  },
};

export default config;
