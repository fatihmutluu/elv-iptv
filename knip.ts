import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  workspaces: {
    '.': { entry: ['scripts/*.mjs'], ignoreBinaries: ['gitleaks'] },
    tools: {
      entry: ['bin/*.ts'],
      project: ['bin/**/*.ts', 'src/**/*.ts', 'test/*.ts'],
      ignoreDependencies: ['dependency-cruiser'],
    },
    'packages/*': {
      // Skeleton packages declare their spec 5.2 dependencies before any code imports them.
      ignoreDependencies: ['@elv/domain', '@elv/sources'],
    },
  },
};

export default config;
