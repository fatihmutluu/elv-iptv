import {
  type AndroidKeyEvent,
  type AndroidKeySource,
  RemoteKeysProvider,
  THEME_PRESETS,
  ThemeProvider,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { useEffect, useState } from 'react';
import { Platform, StyleSheet, Text, type ViewStyle } from 'react-native';
import { AdaptiveNavShell } from '../AdaptiveNavShell';
import type { NavDestination } from '../types';

const FOUR_DESTINATIONS: readonly NavDestination[] = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'live', label: 'Live TV', icon: 'tv', badge: '4' },
  { id: 'movies', label: 'Movies', icon: 'film' },
  { id: 'series', label: 'Series', icon: 'series' },
];

function flattenStyle(style: unknown): ViewStyle {
  return (StyleSheet.flatten(style as ViewStyle) ?? {}) as ViewStyle;
}

function TrackedAvatar({ counters }: { readonly counters: { mounts: number; unmounts: number } }) {
  useEffect(() => {
    counters.mounts += 1;
    return () => {
      counters.unmounts += 1;
    };
  }, [counters]);
  return <Text>A</Text>;
}

function ProfileDisableTooltipHarness({
  counters,
  triggerRef,
  onPointerEnter,
  onPointerLeave,
}: {
  readonly counters: { mounts: number; unmounts: number };
  readonly triggerRef: { current: unknown };
  readonly onPointerEnter: () => void;
  readonly onPointerLeave: () => void;
}) {
  const [disableTooltip, setDisableTooltip] = useState(false);
  return (
    <ViewportProvider
      value={{
        formFactor: 'desktop',
        orientation: 'landscape',
        inputModality: 'pointer',
        width: 1280,
        height: 720,
      }}
    >
      <ThemeProvider preset="obsidianCrimson">
        <AdaptiveNavShell
          brandTitle="ELV IPTV"
          destinations={FOUR_DESTINATIONS}
          utilities={[
            {
              id: 'profile',
              label: 'Alex',
              icon: 'profile',
              showLabel: false,
              testID: 'nav-utility-profile',
              triggerRef,
              disableTooltip,
              onPointerEnter,
              onPointerLeave,
              renderIcon: () => <TrackedAvatar counters={counters} />,
              onPress: jest.fn(),
            },
          ]}
          activeId="home"
          onSelectDestination={jest.fn()}
        >
          <Text testID="flip-disable-tooltip" onPress={() => setDisableTooltip((v) => !v)}>
            {disableTooltip ? 'disabled' : 'enabled'}
          </Text>
        </AdaptiveNavShell>
      </ThemeProvider>
    </ViewportProvider>
  );
}

describe('AdaptiveNavShell Wave R1 utility cluster', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('forwards pointer hover callbacks and disableTooltip on NavUtility items cleanly', async () => {
    const onPointerEnter = jest.fn();
    const onPointerLeave = jest.fn();
    const onHoverIn = jest.fn();
    const onHoverOut = jest.fn();
    const triggerRef = { current: null as unknown };

    await render(
      <ViewportProvider
        value={{
          formFactor: 'desktop',
          orientation: 'landscape',
          inputModality: 'pointer',
          width: 1280,
          height: 720,
        }}
      >
        <ThemeProvider preset="obsidianCrimson">
          <AdaptiveNavShell
            brandTitle="ELV IPTV"
            destinations={FOUR_DESTINATIONS}
            utilities={[
              {
                id: 'profile',
                label: 'Alex',
                icon: 'profile',
                showLabel: false,
                testID: 'nav-utility-profile',
                triggerRef,
                disableTooltip: true,
                onHoverIn,
                onHoverOut,
                onPointerEnter,
                onPointerLeave,
                onPress: jest.fn(),
              },
            ]}
            activeId="home"
            onSelectDestination={jest.fn()}
          >
            <Text>Body</Text>
          </AdaptiveNavShell>
        </ThemeProvider>
      </ViewportProvider>,
    );

    const profileBtn = screen.getByTestId('nav-utility-profile');
    await fireEvent(profileBtn, 'pointerEnter');
    await fireEvent(profileBtn, 'pointerLeave');
    await fireEvent(profileBtn, 'hoverIn');
    await fireEvent(profileBtn, 'hoverOut');

    expect(onPointerEnter).toHaveBeenCalledTimes(1);
    expect(onPointerLeave).toHaveBeenCalledTimes(1);
    expect(onHoverIn).toHaveBeenCalledTimes(1);
    expect(onHoverOut).toHaveBeenCalledTimes(1);
  });

  it('moves TV focus ring onto activateOnSelectOnly utilities without firing onPress until Select', async () => {
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
    const onPopup = jest.fn();
    await render(
      <RemoteKeysProvider android={androidSource}>
        <ViewportProvider
          value={{ formFactor: 'tv', orientation: 'landscape', width: 1920, height: 1080 }}
        >
          <ThemeProvider preset="highContrast">
            <AdaptiveNavShell
              brandTitle="ELV IPTV"
              destinations={[
                { id: 'home', label: 'Home', icon: 'home' },
                { id: 'series', label: 'Series', icon: 'series' },
              ]}
              utilities={[
                {
                  id: 'search',
                  label: 'Search',
                  icon: 'search',
                  showLabel: false,
                  activateOnSelectOnly: true,
                  testID: 'nav-utility-search',
                  onPress: onPopup,
                },
              ]}
              activeId="series"
              navFocused
              onSelectDestination={onSelect}
            >
              <Text>TV Body</Text>
            </AdaptiveNavShell>
          </ThemeProvider>
        </ViewportProvider>
      </RemoteKeysProvider>,
    );

    // Right moves focus ring to 'search' utility without firing onPopup yet
    await pressKey(22);
    expect(onPopup).not.toHaveBeenCalled();
    expect(flattenStyle(screen.getByTestId('nav-utility-search').props.style).borderColor).toBe(
      THEME_PRESETS.highContrast.focusRingColor,
    );

    // Select triggers onPopup
    await pressKey(23);
    expect(onPopup).toHaveBeenCalledTimes(1);
  });

  it('keeps nav-utility-profile Pressable mounted across disableTooltip toggles and binds triggerRef outside Tooltip', async () => {
    const osReplacer = jest.replaceProperty(Platform, 'OS', 'web');
    const counters = { mounts: 0, unmounts: 0 };
    const onPointerEnter = jest.fn();
    const onPointerLeave = jest.fn();
    const triggerRef = { current: null as unknown };

    try {
      await render(
        <ProfileDisableTooltipHarness
          counters={counters}
          triggerRef={triggerRef}
          onPointerEnter={onPointerEnter}
          onPointerLeave={onPointerLeave}
        />,
      );
      expect(counters.mounts).toBe(1);
      expect(counters.unmounts).toBe(0);
      expect(triggerRef.current).not.toBeNull();

      const outerTrigger = screen.getByTestId('nav-utility-profile-trigger');
      await fireEvent(outerTrigger, 'pointerEnter');
      expect(onPointerEnter).toHaveBeenCalledTimes(1);

      await fireEvent.press(screen.getByTestId('flip-disable-tooltip'));
      expect(counters.mounts).toBe(1);
      expect(counters.unmounts).toBe(0);
      expect(triggerRef.current).not.toBeNull();

      await fireEvent.press(screen.getByTestId('flip-disable-tooltip'));
      expect(counters.mounts).toBe(1);
      expect(counters.unmounts).toBe(0);

      await fireEvent(screen.getByTestId('nav-utility-profile-trigger'), 'pointerLeave');
      expect(onPointerLeave).toHaveBeenCalledTimes(1);
    } finally {
      osReplacer.restore();
    }
  });
});
