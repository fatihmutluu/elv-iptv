import { render, screen } from '@testing-library/react-native';
import { Platform, View } from 'react-native';
import { UiAdaptersProvider } from '../../adapters';
import { ThemeProvider } from '../../theme';
import { Icon } from '../Icon';
import { ICON_PATHS, type IconName } from '../paths';

const WAVE_C1_ICONS: readonly IconName[] = [
  'skipBack10',
  'skipForward10',
  'moon',
  'chapters',
  'skipPrev',
  'skipNext',
  'pip',
  'multiview',
  'miniplayer',
  'popout',
  'dock',
];

describe('Icon rendering for Wave C1 cinema player icons', () => {
  it('passes pure 24x24 vector IconSpec shapes to UiAdapters.renderSvg for every new icon', async () => {
    const renderSvg = jest.fn(({ spec, size }: { spec: { viewBox: string }; size: number }) => (
      <View testID={`svg-${size}-${spec.viewBox}`} />
    ));

    await render(
      <ThemeProvider>
        <UiAdaptersProvider adapters={{ renderSvg }}>
          {WAVE_C1_ICONS.map((name) => (
            <Icon
              key={name}
              name={name}
              size={22}
              accessibilityLabel={name}
              testID={`icon-${name}`}
            />
          ))}
        </UiAdaptersProvider>
      </ThemeProvider>,
    );

    expect(renderSvg).toHaveBeenCalledTimes(WAVE_C1_ICONS.length);
    for (const [idx, name] of WAVE_C1_ICONS.entries()) {
      expect(screen.getByTestId(`icon-${name}`)).toBeTruthy();
      expect(renderSvg).toHaveBeenNthCalledWith(
        idx + 1,
        expect.objectContaining({
          spec: ICON_PATHS[name],
          size: 22,
          strokeWidth: 1.8,
        }),
      );
    }
  });

  it('renders inline web SVG with only path/circle/rect elements and no text nodes', async () => {
    const originalOs = Platform.OS;
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
    try {
      const rendered = await render(
        <ThemeProvider>
          {WAVE_C1_ICONS.map((name) => (
            <Icon key={name} name={name} size={24} testID={`web-icon-${name}`} />
          ))}
        </ThemeProvider>,
      );

      const tree = rendered.toJSON();
      const json = JSON.stringify(tree);
      expect(json).toContain('"type":"svg"');
      expect(json).not.toContain('"type":"text"');
      for (const name of WAVE_C1_ICONS) {
        expect(screen.getByTestId(`web-icon-${name}`)).toBeTruthy();
      }
    } finally {
      Object.defineProperty(Platform, 'OS', { configurable: true, value: originalOs });
    }
  });
});
