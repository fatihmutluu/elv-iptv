import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  workspaces: {
    '.': { entry: ['scripts/*.mjs'], ignoreBinaries: ['gitleaks'] },
    tools: {
      entry: ['bin/*.ts'],
      project: ['bin/**/*.ts', 'src/**/*.ts', 'test/*.ts'],
      ignoreDependencies: ['dependency-cruiser'],
    },
  },
};

export default config;
