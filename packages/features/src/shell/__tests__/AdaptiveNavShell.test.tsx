import {
  type AndroidKeyEvent,
  type AndroidKeySource,
  RemoteKeysProvider,
  THEME_PRESETS,
  ThemeProvider,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Platform, StyleSheet, Text, type TextStyle, type ViewStyle } from 'react-native';
import { AdaptiveNavShell } from '../AdaptiveNavShell';
import type { NavDestination, NavUtility } from '../types';

function flattenStyle(style: unknown): ViewStyle {
  return (StyleSheet.flatten(style as ViewStyle) ?? {}) as ViewStyle;
}

const FOUR_DESTINATIONS: readonly NavDestination[] = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'live', label: 'Live TV', icon: 'tv', badge: '4' },
  { id: 'movies', label: 'Movies', icon: 'film' },
  { id: 'series', label: 'Series', icon: 'series' },
];

describe('AdaptiveNavShell', () => {
  beforeEach(() => {
    jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders Landscape frosted top bar with 2px accent active underline, utilities, and no bottom bar', async () => {
    const onSelect = jest.fn();
    const onSearch = jest.fn();
    const onProfiles = jest.fn();
    const utilities: readonly NavUtility[] = [
      {
        id: 'search',
        label: 'Search',
        icon: 'search',
        testID: 'nav-util-search',
        onPress: onSearch,
      },
      {
        id: 'profiles',
        label: 'Profiles',
        icon: 'profile',
        showLabel: false,
        testID: 'nav-util-profiles',
        onPress: onProfiles,
      },
    ];

    await render(
      <ViewportProvider
        value={{ formFactor: 'desktop', orientation: 'landscape', width: 1280, height: 720 }}
      >
        <ThemeProvider preset="obsidianCrimson">
          <AdaptiveNavShell
            brandTitle="ELV IPTV"
            destinations={FOUR_DESTINATIONS}
            utilities={utilities}
            activeId="live"
            onSelectDestination={onSelect}
          >
            <Text testID="shell-child">Body</Text>
          </AdaptiveNavShell>
        </ThemeProvider>
      </ViewportProvider>,
    );

    expect(screen.getByTestId('app-top-nav')).toBeTruthy();
    expect(screen.queryByTestId('app-bottom-nav')).toBeNull();
    expect(screen.getByText('ELV IPTV')).toBeTruthy();
    expect(screen.getByTestId('shell-child')).toBeTruthy();

    expect(screen.getByTestId('nav-tab-live').props.accessibilityState.selected).toBe(true);
    expect(screen.getByTestId('nav-tab-home').props.accessibilityState.selected).toBe(false);
    expect(screen.getByText('4')).toBeTruthy();

    const activeUnderline = flattenStyle(screen.getByTestId('nav-tab-live-underline').props.style);
    expect(activeUnderline.height).toBe(2);
    expect(activeUnderline.backgroundColor).toBe(THEME_PRESETS.obsidianCrimson.accent);

    expect(screen.getByTestId('nav-util-search')).toHaveTextContent('Search');
    expect(screen.getByTestId('nav-util-profiles').props.accessibilityLabel).toBe('Profiles');
    expect(screen.queryByText('Profiles')).toBeNull();

    await fireEvent.press(screen.getByTestId('nav-tab-movies'));
    expect(onSelect).toHaveBeenCalledWith('movies');

    await fireEvent.press(screen.getByTestId('nav-util-search'));
    expect(onSearch).toHaveBeenCalledTimes(1);
  });

  it('hides brand title when showBrand is false', async () => {
    await render(
      <ViewportProvider
        value={{ formFactor: 'desktop', orientation: 'landscape', width: 1280, height: 720 }}
      >
        <AdaptiveNavShell
          brandTitle="ELV IPTV"
          showBrand={false}
          destinations={FOUR_DESTINATIONS}
          activeId="home"
          onSelectDestination={jest.fn()}
        >
          <Text>Body</Text>
        </AdaptiveNavShell>
      </ViewportProvider>,
    );

    expect(screen.queryByText('ELV IPTV')).toBeNull();
  });

  it('renders Portrait compact top bar and safe-area aware bottom frosted tab bar with >=40x40 targets', async () => {
    const onSelect = jest.fn();
    const onSources = jest.fn();

    await render(
      <ViewportProvider
        value={{
          formFactor: 'phone',
          orientation: 'portrait',
          width: 390,
          height: 844,
          safeArea: { top: 44, bottom: 34 },
        }}
      >
        <ThemeProvider preset="obsidianCrimson">
          <AdaptiveNavShell
            brandTitle="ELV IPTV"
            destinations={FOUR_DESTINATIONS}
            utilities={[
              {
                id: 'sources',
                label: 'Sources',
                icon: 'sources',
                showLabel: true,
                testID: 'nav-tab-sources',
                onPress: onSources,
              },
            ]}
            activeId="movies"
            onSelectDestination={onSelect}
          >
            <Text testID="portrait-body">Portrait Content</Text>
          </AdaptiveNavShell>
        </ThemeProvider>
      </ViewportProvider>,
    );

    const topBarStyle = flattenStyle(screen.getByTestId('app-top-nav').props.style);
    expect(topBarStyle.paddingTop).toBe(44);
    expect(Number(topBarStyle.minHeight)).toBeGreaterThanOrEqual(50 + 44);

    const bottomBarStyle = flattenStyle(screen.getByTestId('app-bottom-nav').props.style);
    expect(bottomBarStyle.paddingBottom).toBe(34);
    expect(Number(bottomBarStyle.minHeight)).toBeGreaterThanOrEqual(58 + 34);

    const moviesTab = screen.getByTestId('nav-tab-movies');
    expect(moviesTab.props.accessibilityState.selected).toBe(true);
    const moviesTabStyle = flattenStyle(moviesTab.props.style);
    expect(Number(moviesTabStyle.minHeight)).toBeGreaterThanOrEqual(40);
    expect(Number(moviesTabStyle.minWidth)).toBeGreaterThanOrEqual(40);

    expect(screen.getByTestId('nav-tab-sources')).toHaveTextContent('Sources');

    await fireEvent.press(screen.getByTestId('nav-tab-series'));
    expect(onSelect).toHaveBeenCalledWith('series');

    await fireEvent.press(screen.getByTestId('nav-tab-sources'));
    expect(onSources).toHaveBeenCalledTimes(1);
  });

  it.each([4, 5, 6])(
    'renders dynamic %i-tab configurations without hardcoding slot counts',
    async (count) => {
      const destinations: NavDestination[] = Array.from({ length: count }, (_, idx) => ({
        id: `dest-${idx}`,
        label: `Dest ${idx}`,
        icon: 'layers',
      }));

      await render(
        <ViewportProvider
          value={{ formFactor: 'phone', orientation: 'portrait', width: 390, height: 844 }}
        >
          <AdaptiveNavShell
            brandTitle="ELV IPTV"
            destinations={destinations}
            activeId="dest-0"
            onSelectDestination={jest.fn()}
          >
            <Text>Content</Text>
          </AdaptiveNavShell>
        </ViewportProvider>,
      );

      for (let i = 0; i < count; i += 1) {
        expect(screen.getByTestId(`nav-tab-dest-${i}`)).toHaveTextContent(`Dest ${i}`);
      }
    },
  );

  it('derives all colors dynamically from ThemeProvider including High Contrast AAA', async () => {
    await render(
      <ViewportProvider
        value={{ formFactor: 'tv', orientation: 'landscape', width: 1920, height: 1080 }}
      >
        <ThemeProvider preset="highContrast">
          <AdaptiveNavShell
            brandTitle="ELV IPTV"
            destinations={FOUR_DESTINATIONS}
            activeId="home"
            navFocused
            onSelectDestination={jest.fn()}
          >
            <Text>AAA Body</Text>
          </AdaptiveNavShell>
        </ThemeProvider>
      </ViewportProvider>,
    );

    const rootStyle = flattenStyle(screen.getByTestId('app-shell').props.style);
    expect(rootStyle.backgroundColor).toBe(THEME_PRESETS.highContrast.bgCanvas);

    const activeUnderline = flattenStyle(screen.getByTestId('nav-tab-home-underline').props.style);
    expect(activeUnderline.backgroundColor).toBe(THEME_PRESETS.highContrast.accent);

    const focusedTabStyle = flattenStyle(screen.getByTestId('nav-tab-home').props.style);
    expect(focusedTabStyle.borderColor).toBe(THEME_PRESETS.highContrast.focusRingColor);

    const topNavStyle = flattenStyle(screen.getByTestId('app-top-nav').props.style);
    expect(topNavStyle.paddingHorizontal).toBe(96);
    expect(topNavStyle.paddingTop).toBe(54);
    expect(topNavStyle.minHeight).toBe(112);
  });

  it('cycles across destinations and utilities with TV D-pad Left/Right and exits on Down/Select', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);

    let keyListener: ((e: AndroidKeyEvent) => void) | undefined;
    const androidSource: AndroidKeySource = {
      addListener: (l) => {
        keyListener = l;
        return {
          remove: () => {
            keyListener = undefined;
          },
        };
      },
    };
    const pressKey = async (keyCode: number) => {
      await act(async () => {
        keyListener?.({ action: 'down', keyCode, canceled: false, ageMs: 0 });
        keyListener?.({ action: 'up', keyCode, canceled: false, ageMs: 10 });
      });
    };

    const onSelect = jest.fn();
    const onUtility = jest.fn();
    const onExit = jest.fn();
    const destinations: readonly NavDestination[] = [
      { id: 'live', label: 'Live', icon: 'tv' },
      { id: 'movies', label: 'Movies', icon: 'film' },
    ];
    const utilities: readonly NavUtility[] = [
      {
        id: 'sources',
        label: 'Sources',
        icon: 'sources',
        testID: 'nav-tab-sources',
        onPress: onUtility,
      },
    ];

    const view = await render(
      <RemoteKeysProvider android={androidSource}>
        <ViewportProvider
          value={{ formFactor: 'tv', orientation: 'landscape', width: 1920, height: 1080 }}
        >
          <AdaptiveNavShell
            brandTitle="ELV IPTV"
            destinations={destinations}
            utilities={utilities}
            activeId="movies"
            navFocused
            onSelectDestination={onSelect}
            onExitNavFocus={onExit}
          >
            <Text>TV Body</Text>
          </AdaptiveNavShell>
        </ViewportProvider>
      </RemoteKeysProvider>,
    );

    expect(screen.getByTestId('nav-tv-focus-anchor', { includeHiddenElements: true })).toBeTruthy();

    // Right from index 1 ('movies') -> index 2 ('sources' utility)
    await pressKey(22);
    expect(onUtility).toHaveBeenCalledTimes(1);

    // Rerender with sources active so Left moves back to 'movies' and Right wraps to 'live'
    await view.rerender(
      <RemoteKeysProvider android={androidSource}>
        <ViewportProvider
          value={{ formFactor: 'tv', orientation: 'landscape', width: 1920, height: 1080 }}
        >
          <AdaptiveNavShell
            brandTitle="ELV IPTV"
            destinations={destinations}
            utilities={[
              {
                id: 'sources',
                label: 'Sources',
                icon: 'sources',
                active: true,
                testID: 'nav-tab-sources',
                onPress: onUtility,
              },
            ]}
            activeId="sources"
            navFocused
            onSelectDestination={onSelect}
            onExitNavFocus={onExit}
          >
            <Text>TV Body</Text>
          </AdaptiveNavShell>
        </ViewportProvider>
      </RemoteKeysProvider>,
    );

    // Right from last item ('sources') wraps to index 0 ('live')
    await pressKey(22);
    expect(onSelect).toHaveBeenLastCalledWith('live');

    // Left from 'sources' moves to index 1 ('movies')
    await pressKey(21);
    expect(onSelect).toHaveBeenLastCalledWith('movies');

    // Down exits nav focus
    await pressKey(20);
    expect(onExit).toHaveBeenCalledTimes(1);

    // Select also exits nav focus
    await pressKey(23);
    expect(onExit).toHaveBeenCalledTimes(2);
  });

  it('keeps a visible TV focus ring when activeId matches no item, omits empty PortraitBottomBar, and shows Portrait badges', async () => {
    const view = await render(
      <ThemeProvider preset="highContrast">
        <ViewportProvider
          value={{ formFactor: 'tv', orientation: 'landscape', width: 1920, height: 1080 }}
        >
          <AdaptiveNavShell
            brandTitle="ELV IPTV"
            destinations={[
              { id: 'live', label: 'Live', icon: 'tv' },
              { id: 'movies', label: 'Movies', icon: 'film' },
            ]}
            activeId="detail-view"
            navFocused
            onSelectDestination={jest.fn()}
          >
            <Text>Detail</Text>
          </AdaptiveNavShell>
        </ViewportProvider>
      </ThemeProvider>,
    );
    const firstStyle = flattenStyle(screen.getByTestId('nav-tab-live').props.style);
    expect(firstStyle.borderColor).toBe(THEME_PRESETS.highContrast.focusRingColor);

    await view.rerender(
      <ThemeProvider>
        <ViewportProvider
          value={{ formFactor: 'phone', orientation: 'portrait', width: 390, height: 844 }}
        >
          <AdaptiveNavShell
            brandTitle="ELV IPTV"
            destinations={[]}
            activeId=""
            onSelectDestination={jest.fn()}
          >
            <Text>Empty</Text>
          </AdaptiveNavShell>
        </ViewportProvider>
      </ThemeProvider>,
    );
    expect(screen.queryByTestId('app-bottom-nav')).toBeNull();

    await view.rerender(
      <ThemeProvider>
        <ViewportProvider
          value={{ formFactor: 'phone', orientation: 'portrait', width: 390, height: 844 }}
        >
          <AdaptiveNavShell
            brandTitle="ELV IPTV"
            destinations={[{ id: 'live', label: 'Live', icon: 'tv', badge: 'HD' }]}
            activeId="live"
            onSelectDestination={jest.fn()}
          >
            <Text>Portrait</Text>
          </AdaptiveNavShell>
        </ViewportProvider>
      </ThemeProvider>,
    );
    expect(screen.getByText('HD')).toBeTruthy();
  });

  it('styles multi-word brandTitle with leading accent mark inside one outer Text and positions top bar absolutely when overlay is true', async () => {
    const view = await render(
      <ViewportProvider
        value={{ formFactor: 'desktop', orientation: 'landscape', width: 1280, height: 720 }}
      >
        <ThemeProvider preset="obsidianCrimson">
          <AdaptiveNavShell
            brandTitle="ELV IPTV"
            destinations={FOUR_DESTINATIONS}
            activeId="home"
            overlay
            frosted={false}
            onSelectDestination={jest.fn()}
          >
            <Text>Hero Content</Text>
          </AdaptiveNavShell>
        </ThemeProvider>
      </ViewportProvider>,
    );

    expect(screen.getByText('ELV IPTV')).toBeTruthy();
    const accentNode = screen.getByTestId('app-brand-accent');
    expect(accentNode).toHaveTextContent('ELV');
    const accentStyle = (StyleSheet.flatten(accentNode.props.style as TextStyle) ??
      {}) as TextStyle;
    expect(accentStyle.color).toBe(THEME_PRESETS.obsidianCrimson.accent);

    const overlayStyle = flattenStyle(screen.getByTestId('app-top-nav').props.style);
    expect(overlayStyle.position).toBe('absolute');
    expect(overlayStyle.top).toBe(0);
    expect(overlayStyle.left).toBe(0);
    expect(overlayStyle.right).toBe(0);
    expect(overlayStyle.zIndex).toBe(35);

    await view.rerender(
      <ViewportProvider
        value={{ formFactor: 'desktop', orientation: 'landscape', width: 1280, height: 720 }}
      >
        <ThemeProvider preset="obsidianCrimson">
          <AdaptiveNavShell
            brandTitle="ELV IPTV"
            destinations={FOUR_DESTINATIONS}
            activeId="home"
            overlay={false}
            onSelectDestination={jest.fn()}
          >
            <Text>Flow Content</Text>
          </AdaptiveNavShell>
        </ThemeProvider>
      </ViewportProvider>,
    );

    const flowStyle = flattenStyle(screen.getByTestId('app-top-nav').props.style);
    expect(flowStyle.position).not.toBe('absolute');
  });

  it('enforces >=40x40 touch targets on landscape touch viewports for links and utilities', async () => {
    await render(
      <ViewportProvider
        value={{
          formFactor: 'phone',
          orientation: 'landscape',
          inputModality: 'touch',
          width: 844,
          height: 390,
        }}
      >
        <ThemeProvider preset="obsidianCrimson">
          <AdaptiveNavShell
            brandTitle="ELV IPTV"
            destinations={FOUR_DESTINATIONS}
            utilities={[
              {
                id: 'search',
                label: 'Search',
                icon: 'search',
                showLabel: false,
                testID: 'nav-util-search',
                onPress: jest.fn(),
              },
              {
                id: 'sources',
                label: 'Sources',
                icon: 'sources',
                showLabel: true,
                testID: 'nav-util-sources',
                onPress: jest.fn(),
              },
            ]}
            activeId="home"
            onSelectDestination={jest.fn()}
          >
            <Text>Landscape Touch</Text>
          </AdaptiveNavShell>
        </ThemeProvider>
      </ViewportProvider>,
    );

    const linkStyle = flattenStyle(screen.getByTestId('nav-tab-home').props.style);
    expect(Number(linkStyle.minHeight)).toBeGreaterThanOrEqual(40);
    expect(Number(linkStyle.minWidth)).toBeGreaterThanOrEqual(40);

    const iconUtilStyle = flattenStyle(screen.getByTestId('nav-util-search').props.style);
    expect(Number(iconUtilStyle.minHeight)).toBeGreaterThanOrEqual(40);
    expect(Number(iconUtilStyle.minWidth)).toBeGreaterThanOrEqual(40);

    const labeledUtilStyle = flattenStyle(screen.getByTestId('nav-util-sources').props.style);
    expect(Number(labeledUtilStyle.minHeight)).toBeGreaterThanOrEqual(40);
    expect(Number(labeledUtilStyle.minWidth)).toBeGreaterThanOrEqual(40);
  });
});
