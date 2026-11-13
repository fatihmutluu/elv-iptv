import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  workspaces: {
    '.': { entry: ['scripts/*.mjs'], ignoreBinaries: ['gitleaks'] },
    tools: {
      entry: ['bin/*.ts'],
      project: ['bin/**/*.ts', 'src/**/*.ts', 'test/*.ts'],
      ignoreDependencies: ['dependency-cruiser'],
    },
    'apps/tv-mobile': {
      entry: ['config/*.test.ts'],
      // The TV plugin is loaded by name from app.config.ts; knip infers optional Expo packages.
      ignoreDependencies: ['@react-native-tvos/config-tv', 'expo-updates'],
    },
    'packages/ui-kit': {
      // Skeleton: spec 5.2 dependencies and the react-native toolchain arrive before any code.
      ignoreDependencies: [
        '@elv/domain',
        '@elv/focus-core',
        '@elv/i18n',
        '@types/react',
        'react',
        'react-native',
      ],
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
      ignoreDependencies: ['@elv/domain', '@elv/sources'],
    },
  },
};

export default config;
