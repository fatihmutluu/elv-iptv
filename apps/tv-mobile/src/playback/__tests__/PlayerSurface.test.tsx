import type { PlayerEngine } from '@elv/playback';
import { render, screen } from '@testing-library/react-native';
import { Platform, View } from 'react-native';
import { PlayerSurface } from '../PlayerSurface';

jest.mock('@elv/engine-aether', () => ({
  AetherSurface: ({
    testID,
    resizeMode,
    subtitleBottomInsetPx,
    osdVisible,
  }: {
    testID?: string;
    resizeMode?: string;
    subtitleBottomInsetPx?: number;
    osdVisible?: boolean;
  }) => {
    const { View: RNView } = require('react-native');
    return (
      <RNView
        testID={testID ?? 'aether'}
        accessibilityLabel={`aether:${resizeMode ?? ''}:${subtitleBottomInsetPx ?? ''}:${osdVisible ?? ''}`}
      />
    );
  },
}));

jest.mock('@elv/engine-media3', () => ({
  Media3Surface: ({
    testID,
    resizeMode,
    subtitleBottomInsetPx,
    surfaceRecreationToken,
    useTextureView,
  }: {
    testID?: string;
    resizeMode?: string;
    subtitleBottomInsetPx?: number;
    surfaceRecreationToken?: number;
    useTextureView?: boolean;
  }) => {
    const { View: RNView } = require('react-native');
    return (
      <RNView
        testID={testID ?? 'media3'}
        accessibilityLabel={`media3:${resizeMode ?? ''}:${subtitleBottomInsetPx ?? ''}:${surfaceRecreationToken ?? ''}:${useTextureView ?? ''}`}
      />
    );
  },
}));

const engine = { release() {} } as unknown as PlayerEngine;

describe('PlayerSurface', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders AetherSurface on Apple platforms (Platform.OS === ios) forwarding resizeMode, subtitleBottomInsetPx, and osdVisible', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    const view = await render(
      <View>
        <PlayerSurface
          engine={engine}
          resizeMode="fit"
          subtitleBottomInsetPx={96}
          osdVisible={false}
          testID="surface"
        />
      </View>,
    );
    expect(screen.getByTestId('surface')).toHaveProp('accessibilityLabel', 'aether:fit:96:false');

    await view.rerender(
      <View>
        <PlayerSurface
          engine={engine}
          resizeMode="fill"
          subtitleBottomInsetPx={0}
          osdVisible
          testID="surface"
        />
      </View>,
    );
    expect(screen.getByTestId('surface')).toHaveProp('accessibilityLabel', 'aether:fill:0:true');
  });

  it('renders Media3Surface on Android forwarding resizeMode, subtitleBottomInsetPx, surfaceRecreationToken, and useTextureView (#144, #262)', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    await render(
      <View>
        <PlayerSurface
          engine={engine}
          resizeMode="fill"
          subtitleBottomInsetPx={120}
          surfaceRecreationToken={3}
          useTextureView
          testID="surface"
        />
      </View>,
    );
    expect(screen.getByTestId('surface')).toHaveProp(
      'accessibilityLabel',
      'media3:fill:120:3:true',
    );
  });
});
