import type { PlayerEngine } from '@elv/playback';
import { render, screen } from '@testing-library/react-native';
import { Platform, View } from 'react-native';
import { PlayerSurface } from '../PlayerSurface';

jest.mock('@elv/engine-aether', () => ({
  AetherSurface: ({ testID, resizeMode }: { testID?: string; resizeMode?: string }) => {
    const { View: RNView } = require('react-native');
    return <RNView testID={testID ?? 'aether'} accessibilityLabel={`aether:${resizeMode ?? ''}`} />;
  },
}));

jest.mock('@elv/engine-media3', () => ({
  Media3Surface: ({ testID, resizeMode }: { testID?: string; resizeMode?: string }) => {
    const { View: RNView } = require('react-native');
    return <RNView testID={testID ?? 'media3'} accessibilityLabel={`media3:${resizeMode ?? ''}`} />;
  },
}));

const engine = { release() {} } as unknown as PlayerEngine;

describe('PlayerSurface', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders AetherSurface on Apple platforms (Platform.OS === ios)', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    await render(
      <View>
        <PlayerSurface engine={engine} resizeMode="fit" testID="surface" />
      </View>,
    );
    expect(screen.getByTestId('surface')).toHaveProp('accessibilityLabel', 'aether:fit');
  });

  it('renders Media3Surface on Android', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    await render(
      <View>
        <PlayerSurface engine={engine} resizeMode="fill" testID="surface" />
      </View>,
    );
    expect(screen.getByTestId('surface')).toHaveProp('accessibilityLabel', 'media3:fill');
  });
});
