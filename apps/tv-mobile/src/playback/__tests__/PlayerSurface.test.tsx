import type { SubtitleStyleConfig } from '@elv/domain';
import type { PlayerEngine } from '@elv/playback';
import { render, screen } from '@testing-library/react-native';
import { Platform, View } from 'react-native';
import { PlayerSurface } from '../PlayerSurface';

jest.mock('@elv/engine-aether', () => ({
  AetherSurface: ({
    testID,
    resizeMode,
    subtitleBottomInsetPx,
    subtitleFontFamily,
    subtitleStyle,
    osdVisible,
  }: {
    testID?: string;
    resizeMode?: string;
    subtitleBottomInsetPx?: number;
    subtitleFontFamily?: string;
    subtitleStyle?: SubtitleStyleConfig;
    osdVisible?: boolean;
  }) => {
    const { View: RNView } = require('react-native');
    const styleKey = subtitleStyle
      ? `${subtitleStyle.fontSize}/${subtitleStyle.textColor}/${subtitleStyle.backgroundColor}/${subtitleStyle.edgeStyle}/${subtitleStyle.verticalPosition}`
      : '';
    return (
      <RNView
        testID={testID ?? 'aether'}
        accessibilityLabel={`aether:${resizeMode ?? ''}:${subtitleBottomInsetPx ?? ''}:${osdVisible ?? ''}:${subtitleFontFamily ?? ''}:${styleKey}`}
      />
    );
  },
}));

jest.mock('@elv/engine-media3', () => ({
  Media3Surface: ({
    testID,
    resizeMode,
    subtitleBottomInsetPx,
    subtitleFontFamily,
    subtitleStyle,
    surfaceRecreationToken,
    useTextureView,
  }: {
    testID?: string;
    resizeMode?: string;
    subtitleBottomInsetPx?: number;
    subtitleFontFamily?: string;
    subtitleStyle?: SubtitleStyleConfig;
    surfaceRecreationToken?: number;
    useTextureView?: boolean;
  }) => {
    const { View: RNView } = require('react-native');
    const styleKey = subtitleStyle
      ? `${subtitleStyle.fontSize}/${subtitleStyle.textColor}/${subtitleStyle.backgroundColor}/${subtitleStyle.edgeStyle}/${subtitleStyle.verticalPosition}`
      : '';
    return (
      <RNView
        testID={testID ?? 'media3'}
        accessibilityLabel={`media3:${resizeMode ?? ''}:${subtitleBottomInsetPx ?? ''}:${surfaceRecreationToken ?? ''}:${useTextureView ?? ''}:${subtitleFontFamily ?? ''}:${styleKey}`}
      />
    );
  },
}));

const engine = { release() {} } as unknown as PlayerEngine;

const CUSTOM_STYLE: SubtitleStyleConfig = {
  fontSize: 'large',
  textColor: 'yellow',
  backgroundColor: 'opaque',
  edgeStyle: 'dropShadow',
  verticalPosition: 'raised',
};

describe('PlayerSurface', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders AetherSurface on Apple platforms (Platform.OS === ios) forwarding resizeMode, subtitleBottomInsetPx, subtitleFontFamily, subtitleStyle, and osdVisible (#163, #32)', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    const view = await render(
      <View>
        <PlayerSurface
          engine={engine}
          resizeMode="fit"
          subtitleBottomInsetPx={96}
          subtitleFontFamily="atkinson"
          osdVisible={false}
          testID="surface"
        />
      </View>,
    );
    expect(screen.getByTestId('surface')).toHaveProp(
      'accessibilityLabel',
      'aether:fit:96:false:atkinson:',
    );

    await view.rerender(
      <View>
        <PlayerSurface
          engine={engine}
          resizeMode="fill"
          subtitleBottomInsetPx={0}
          subtitleFontFamily="opendyslexic"
          subtitleStyle={CUSTOM_STYLE}
          osdVisible
          testID="surface"
        />
      </View>,
    );
    expect(screen.getByTestId('surface')).toHaveProp(
      'accessibilityLabel',
      'aether:fill:0:true:opendyslexic:large/yellow/opaque/dropShadow/raised',
    );
  });

  it('renders Media3Surface on Android forwarding resizeMode, subtitleBottomInsetPx, subtitleFontFamily, subtitleStyle, surfaceRecreationToken, and useTextureView (#144, #163, #262, #32)', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    await render(
      <View>
        <PlayerSurface
          engine={engine}
          resizeMode="fill"
          subtitleBottomInsetPx={120}
          subtitleFontFamily="atkinson"
          subtitleStyle={CUSTOM_STYLE}
          surfaceRecreationToken={3}
          useTextureView
          testID="surface"
        />
      </View>,
    );
    expect(screen.getByTestId('surface')).toHaveProp(
      'accessibilityLabel',
      'media3:fill:120:3:true:atkinson:large/yellow/opaque/dropShadow/raised',
    );
  });
});
