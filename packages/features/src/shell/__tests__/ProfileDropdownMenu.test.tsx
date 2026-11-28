import type { ProfileRecord } from '@elv/data';
import { createAppI18n } from '@elv/i18n';
import {
  type AndroidKeyEvent,
  type AndroidKeySource,
  buildTheme,
  I18nProvider,
  RemoteKeysProvider,
  ThemeProvider,
  type ViewportOverride,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { createRef } from 'react';
import { Platform, StyleSheet, type ViewStyle } from 'react-native';
import * as desktopDialogTrap from '../../shared/desktop-dialog-trap';
import { ProfileDropdownMenu, type ProfileDropdownMenuProps } from '../ProfileDropdownMenu';

const KEYCODE_DPAD_UP = 19;
const KEYCODE_DPAD_DOWN = 20;
const KEYCODE_DPAD_CENTER = 23;
const KEYCODE_BACK = 4;

const SAMPLE_PROFILES: readonly ProfileRecord[] = [
  {
    id: 'default',
    name: 'Alex',
    avatarToken: 'crimson',
    isKids: false,
    isDefault: true,
    createdAt: 100,
    updatedAt: 100,
  },
  {
    id: 'kids-1',
    name: 'Maya',
    avatarToken: 'amber',
    isKids: true,
    isDefault: false,
    createdAt: 200,
    updatedAt: 200,
  },
];

function flatten(style: unknown): ViewStyle {
  return (StyleSheet.flatten(style as ViewStyle) ?? {}) as ViewStyle;
}

function createAndroidSource() {
  let listener: ((event: AndroidKeyEvent) => void) | null = null;
  const source: AndroidKeySource = {
    addListener(cb) {
      listener = cb;
      return {
        remove() {
          listener = null;
        },
      };
    },
  };
  const sendKey = async (keyCode: number) => {
    await act(async () => {
      listener?.({ keyCode, action: 'down', canceled: false, ageMs: 0 });
      listener?.({ keyCode, action: 'up', canceled: false, ageMs: 10 });
    });
  };
  return { source, sendKey };
}

function renderMenu(
  props: Partial<ProfileDropdownMenuProps> = {},
  opts: {
    viewport?: ViewportOverride;
    preset?: 'obsidianCrimson' | 'highContrast';
    locale?: 'en' | 'tr';
    androidSource?: AndroidKeySource;
  } = {},
) {
  const defaultProps: ProfileDropdownMenuProps = {
    visible: true,
    profiles: SAMPLE_PROFILES,
    activeProfileId: 'default',
    onSelectProfile: jest.fn(),
    onAddProfile: jest.fn(),
    onEditProfiles: jest.fn(),
    onOpenSettings: jest.fn(),
    onSignOut: jest.fn(),
    onClose: jest.fn(),
    ...props,
  };

  const tree = (
    <ViewportProvider
      value={
        opts.viewport ?? {
          formFactor: 'desktop',
          orientation: 'landscape',
          inputModality: 'pointer',
          width: 1280,
          height: 800,
        }
      }
    >
      <ThemeProvider preset={opts.preset ?? 'obsidianCrimson'}>
        <I18nProvider i18n={createAppI18n(opts.locale ?? 'en')}>
          <ProfileDropdownMenu {...defaultProps} />
        </I18nProvider>
      </ThemeProvider>
    </ViewportProvider>
  );

  if (opts.androidSource) {
    return {
      props: defaultProps,
      view: render(<RemoteKeysProvider android={opts.androidSource}>{tree}</RemoteKeysProvider>),
    };
  }
  return {
    props: defaultProps,
    view: render(tree),
  };
}

describe('ProfileDropdownMenu', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders nothing when visible is false', async () => {
    await renderMenu({ visible: false }).view;
    expect(screen.queryByTestId('profile-dropdown-menu')).toBeNull();
  });

  it('renders profiles, + Add new, Edit profiles, Settings, and danger-red Sign out using active theme tokens', async () => {
    const onPointerEnter = jest.fn();
    const onPointerLeave = jest.fn();
    const panelRef = createRef<unknown>();

    await renderMenu(
      {
        activeProfileId: 'kids-1',
        hasGuardPin: true,
        parentalUnlocked: false,
        syncAccountSignedIn: true,
        panelRef,
        panelProps: { onPointerEnter, onPointerLeave },
      },
      { preset: 'highContrast' },
    ).view;

    expect(screen.getByTestId('profile-dropdown-menu')).toBeTruthy();
    expect(screen.getByText('Profiles')).toBeTruthy();
    expect(screen.getByTestId('profile-menu-item-default')).toHaveTextContent(/Alex/);
    expect(screen.getByTestId('profile-menu-item-kids-1')).toHaveTextContent(/Maya/);
    expect(screen.getByTestId('profile-menu-check-kids-1')).toBeTruthy();
    expect(screen.getByTestId('profile-menu-lock-default')).toBeTruthy();
    expect(screen.getByTestId('profile-menu-add-new')).toHaveTextContent('Add new');
    expect(screen.getByTestId('profile-menu-divider')).toBeTruthy();
    expect(screen.getByTestId('profile-menu-edit-profiles')).toHaveTextContent('Edit profiles');
    expect(screen.getByTestId('profile-menu-settings')).toHaveTextContent('Settings');

    const highContrast = buildTheme({ preset: 'highContrast' });
    const signOutBtn = screen.getByTestId('profile-menu-sign-out');
    expect(signOutBtn).toHaveTextContent('Sign out');
    const signOutLabel = screen.getByTestId('profile-menu-sign-out-label');
    expect(StyleSheet.flatten(signOutLabel.props.style).color).toBe(highContrast.colors.liveColor);

    const panel = screen.getByTestId('profile-dropdown-menu-panel');
    expect(flatten(panel.props.style).backgroundColor).toBe(highContrast.colors.glassBg);
    await fireEvent(panel, 'pointerEnter');
    expect(onPointerEnter).toHaveBeenCalledTimes(1);
    await fireEvent(panel, 'pointerLeave');
    expect(onPointerLeave).toHaveBeenCalledTimes(1);
  });

  it('invokes item callbacks and dismisses on click-outside backdrop press and web Escape', async () => {
    const osReplacer = jest.replaceProperty(Platform, 'OS', 'web');
    const listeners = new Map<
      string,
      Set<(e: { key?: string; preventDefault?: () => void }) => void>
    >();
    const origWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      addEventListener: (
        type: string,
        fn: (e: { key?: string; preventDefault?: () => void }) => void,
      ) => {
        const set = listeners.get(type) ?? new Set();
        set.add(fn);
        listeners.set(type, set);
      },
      removeEventListener: (
        type: string,
        fn: (e: { key?: string; preventDefault?: () => void }) => void,
      ) => {
        listeners.get(type)?.delete(fn);
      },
    };

    try {
      const rendered = renderMenu({ pinnedOpen: true });
      await rendered.view;

      const backdrop = screen.getByTestId('profile-dropdown-menu-backdrop', {
        includeHiddenElements: true,
      });
      expect(backdrop.props.tabIndex).toBe(-1);
      expect(backdrop.props.accessible).toBe(false);
      expect(backdrop.props['aria-hidden']).toBe(true);

      await fireEvent.press(screen.getByTestId('profile-menu-item-kids-1'));
      expect(rendered.props.onSelectProfile).toHaveBeenCalledWith('kids-1');
      expect(rendered.props.onClose).toHaveBeenCalledTimes(1);

      await fireEvent.press(screen.getByTestId('profile-menu-add-new'));
      expect(rendered.props.onAddProfile).toHaveBeenCalledTimes(1);

      await fireEvent.press(screen.getByTestId('profile-menu-edit-profiles'));
      expect(rendered.props.onEditProfiles).toHaveBeenCalledTimes(1);

      await fireEvent.press(screen.getByTestId('profile-menu-settings'));
      expect(rendered.props.onOpenSettings).toHaveBeenCalledTimes(1);

      await fireEvent.press(screen.getByTestId('profile-menu-sign-out'));
      expect(rendered.props.onSignOut).toHaveBeenCalledTimes(1);

      await fireEvent.press(
        screen.getByTestId('profile-dropdown-menu-backdrop', { includeHiddenElements: true }),
      );
      expect(rendered.props.onClose).toHaveBeenCalledTimes(6);

      await act(async () => {
        for (const fn of listeners.get('keydown') ?? []) {
          fn({ key: 'Escape', preventDefault: jest.fn() });
        }
      });
      expect(rendered.props.onClose).toHaveBeenCalledTimes(7);
    } finally {
      osReplacer.restore();
      (globalThis as { window?: unknown }).window = origWindow;
    }
  });

  it('renders AdaptiveSheet bottom sheet on Portrait mobile and dismisses on backdrop tap', async () => {
    const rendered = renderMenu(
      {},
      {
        viewport: {
          formFactor: 'phone',
          orientation: 'portrait',
          inputModality: 'touch',
          width: 390,
          height: 844,
          safeArea: { top: 44, bottom: 34 },
        },
        locale: 'tr',
      },
    );
    await rendered.view;

    expect(screen.getByTestId('profile-dropdown-menu-handle')).toBeTruthy();
    expect(screen.getByTestId('profile-dropdown-menu-header')).toHaveTextContent('Profiller');
    expect(screen.getByTestId('profile-menu-add-new')).toHaveTextContent('Yeni ekle');
    expect(screen.getByTestId('profile-menu-edit-profiles')).toHaveTextContent(
      'Profilleri düzenle',
    );
    expect(screen.getByTestId('profile-menu-sign-out')).toHaveTextContent('Çıkış yap');

    await fireEvent.press(screen.getByTestId('profile-dropdown-menu-backdrop'));
    expect(rendered.props.onClose).toHaveBeenCalledTimes(1);
  });

  it('supports 10-ft TV D-pad Up/Down navigation, Select activation, and Back dismiss', async () => {
    const osReplacer = jest.replaceProperty(Platform, 'OS', 'android');
    const isTvSpy = jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
    const android = createAndroidSource();
    try {
      const rendered = renderMenu(
        {},
        {
          viewport: {
            formFactor: 'tv',
            orientation: 'landscape',
            inputModality: 'tv',
            width: 1920,
            height: 1080,
            overscanX: 48,
            overscanY: 27,
          },
          androidSource: android.source,
        },
      );
      await rendered.view;

      expect(
        screen.getByTestId('profile-dropdown-tv-anchor', { includeHiddenElements: true }),
      ).toBeTruthy();

      // Active profile 'default' (index 0) focused initially; Down x4 -> Settings
      // Items: [0: Alex, 1: Maya, 2: Add new, 3: Edit profiles, 4: Settings, 5: Sign out]
      await android.sendKey(KEYCODE_DPAD_DOWN);
      await android.sendKey(KEYCODE_DPAD_DOWN);
      await android.sendKey(KEYCODE_DPAD_DOWN);
      await android.sendKey(KEYCODE_DPAD_DOWN);
      await android.sendKey(KEYCODE_DPAD_CENTER);
      expect(rendered.props.onOpenSettings).toHaveBeenCalledTimes(1);
      expect(rendered.props.onClose).toHaveBeenCalledTimes(1);

      // Down -> Sign out, Up -> back to Settings
      await android.sendKey(KEYCODE_DPAD_DOWN);
      await android.sendKey(KEYCODE_DPAD_UP);
      await android.sendKey(KEYCODE_DPAD_DOWN);
      await android.sendKey(KEYCODE_DPAD_CENTER);
      expect(rendered.props.onSignOut).toHaveBeenCalledTimes(1);

      // Back closes menu cleanly
      await android.sendKey(KEYCODE_BACK);
      expect(rendered.props.onClose).toHaveBeenCalledTimes(3);
    } finally {
      isTvSpy.mockRestore();
      osReplacer.restore();
    }
  });

  it('does not steal focus on hover-open (initialFocus: none) and aligns sibling lock icon with parental/kids gating', async () => {
    const trapSpy = jest.spyOn(desktopDialogTrap, 'useDesktopDialogTrap');
    const osReplacer = jest.replaceProperty(Platform, 'OS', 'web');
    try {
      // Hover-open passes modal: false + initialFocus: none
      const hoverView = await renderMenu({
        pinnedOpen: false,
        activeProfileId: 'default',
        hasGuardPin: true,
        parentalUnlocked: false,
        parentalControlsEnabled: false,
      }).view;

      expect(trapSpy).toHaveBeenLastCalledWith(
        expect.anything(),
        true,
        expect.any(Function),
        expect.objectContaining({ modal: false, initialFocus: 'none', restoreFocus: false }),
      );
      // Adult profile with parentalControlsEnabled=false switches freely -> no sibling lock badge
      expect(screen.queryByTestId('profile-menu-lock-kids-1')).toBeNull();
      await hoverView.unmount();

      // Pinned click-open passes modal: true + initialFocus: first; parentalControlsEnabled=true shows lock badge
      await renderMenu({
        pinnedOpen: true,
        activeProfileId: 'default',
        hasGuardPin: true,
        parentalUnlocked: false,
        parentalControlsEnabled: true,
      }).view;

      expect(trapSpy).toHaveBeenLastCalledWith(
        expect.anything(),
        true,
        expect.any(Function),
        expect.objectContaining({ modal: true, initialFocus: 'first' }),
      );
      expect(screen.getByTestId('profile-menu-lock-kids-1')).toBeTruthy();
    } finally {
      trapSpy.mockRestore();
      osReplacer.restore();
    }
  });
});
