import type { PlayerEngine } from '@elv/playback';
import { render, screen } from '@testing-library/react-native';
import { Platform, View } from 'react-native';
import { PlayerSurface } from '../PlayerSurface';

jest.mock('@elv/engine-aether', () => ({
  AetherSurface: ({
    testID,
    resizeMode,
    subtitleBottomInsetPx,
  }: {
    testID?: string;
    resizeMode?: string;
    subtitleBottomInsetPx?: number;
  }) => {
    const { View: RNView } = require('react-native');
    return (
      <RNView
        testID={testID ?? 'aether'}
        accessibilityLabel={`aether:${resizeMode ?? ''}:${subtitleBottomInsetPx ?? ''}`}
      />
    );
  },
}));

jest.mock('@elv/engine-media3', () => ({
  Media3Surface: ({
    testID,
    resizeMode,
    subtitleBottomInsetPx,
  }: {
    testID?: string;
    resizeMode?: string;
    subtitleBottomInsetPx?: number;
  }) => {
    const { View: RNView } = require('react-native');
    return (
      <RNView
        testID={testID ?? 'media3'}
        accessibilityLabel={`media3:${resizeMode ?? ''}:${subtitleBottomInsetPx ?? ''}`}
      />
    );
  },
}));

const engine = { release() {} } as unknown as PlayerEngine;

describe('PlayerSurface', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders AetherSurface on Apple platforms (Platform.OS === ios) forwarding resizeMode and subtitleBottomInsetPx', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    await render(
      <View>
        <PlayerSurface
          engine={engine}
          resizeMode="fit"
          subtitleBottomInsetPx={96}
          testID="surface"
        />
      </View>,
    );
    expect(screen.getByTestId('surface')).toHaveProp('accessibilityLabel', 'aether:fit:96');
  });

  it('renders Media3Surface on Android forwarding resizeMode and subtitleBottomInsetPx', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    await render(
      <View>
        <PlayerSurface
          engine={engine}
          resizeMode="fill"
          subtitleBottomInsetPx={120}
          testID="surface"
        />
      </View>,
    );
    expect(screen.getByTestId('surface')).toHaveProp('accessibilityLabel', 'media3:fill:120');
  });
});
