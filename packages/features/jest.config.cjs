const jestExpoPreset = require('jest-expo/jest-preset');

const esmPackages = [
  '.pnpm',
  'react-native',
  '@react-native',
  '@react-native-community',
  'expo',
  '@expo',
  '@expo-google-fonts',
  'react-navigation',
  '@react-navigation',
  '@sentry/react-native',
  'native-base',
  'standard-navigation',
  '@lingui',
  '@formatjs',
  '@messageformat',
].join('|');

module.exports = {
  preset: 'jest-expo',
  transform: {
    ...jestExpoPreset.transform,
    '\\.mjs$': jestExpoPreset.transform['\\.[jt]sx?$'],
  },
  transformIgnorePatterns: [
    `[/\\\\]node_modules[/\\\\](?!(${esmPackages}))`,
    ...jestExpoPreset.transformIgnorePatterns.slice(1),
  ],
  testTimeout: 20_000,
  testMatch: ['<rootDir>/src/**/__tests__/**/*.test.{ts,tsx}'],
};
