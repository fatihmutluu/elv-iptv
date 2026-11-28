import type { CatalogService } from '@elv/data';
import type { KeymapStore, ProfilePreferencesManager } from '@elv/domain';
import type { MessageId } from '@elv/i18n';
import { THEME_PRESET_IDS, type ThemePresetId, useI18n } from '@elv/ui-kit';
import { type ReactElement, type ReactNode, useCallback, useMemo, useRef, useState } from 'react';
import type { AppTab } from './app-shell-state';
import type { SettingsSection } from './settings';
import { KeymapProvider, ProfileProvider, useProfile } from './shared';
import {
  type CatalogUiCache,
  type CommandPaletteSettingsSection,
  type CommandPaletteTab,
  DesktopCommandPalette,
  DesktopShortcutSheet,
  type PreferencesContextValue,
  useDesktopShellShortcuts,
  usePreferences,
} from './shell';

/** Wraps `AppShell` content in `ProfileProvider` and `KeymapProvider`. */
export function AppShellProfileAndKeymapProviders(props: {
  readonly catalog: CatalogService;
  readonly suppressAutoProfilePicker: boolean;
  readonly externalRefreshToken?: number;
  readonly profilePreferences?: ProfilePreferencesManager;
  readonly keymapStore?: KeymapStore;
  readonly children: ReactNode;
}): ReactElement {
  const preferences = usePreferences();
  const profilePrefs = props.profilePreferences ?? preferences.profilePreferences;
  const keymapStore = props.keymapStore ?? preferences.keymapStore;
  return (
    <ProfileProvider
      catalog={props.catalog}
      suppressAutoProfilePicker={props.suppressAutoProfilePicker}
      {...(props.externalRefreshToken !== undefined
        ? { externalRefreshToken: props.externalRefreshToken }
        : {})}
      {...(profilePrefs !== undefined ? { profilePreferences: profilePrefs } : {})}
      {...(keymapStore !== undefined ? { keymapStore } : {})}
    >
      <AppShellKeymapInner {...(keymapStore !== undefined ? { keymapStore } : {})}>
        {props.children}
      </AppShellKeymapInner>
    </ProfileProvider>
  );
}

function AppShellKeymapInner(props: {
  readonly keymapStore?: KeymapStore;
  readonly children: ReactNode;
}): ReactElement {
  const profile = useProfile();
  return (
    <KeymapProvider
      activeProfileId={profile.activeProfileId}
      {...(props.keymapStore !== undefined ? { keymapStore: props.keymapStore } : {})}
    >
      {props.children}
    </KeymapProvider>
  );
}

const THEME_LABEL_KEYS: Readonly<Record<ThemePresetId, MessageId>> = {
  obsidianCrimson: 'settings.theme.obsidianCrimson.label',
  abyssalSapphire: 'settings.theme.abyssalSapphire.label',
  theaterAmber: 'settings.theme.theaterAmber.label',
  velvetViolet: 'settings.theme.velvetViolet.label',
  pitchEmerald: 'settings.theme.pitchEmerald.label',
  highContrast: 'settings.theme.highContrast.label',
};

/** Controller returned by {@link useAppShellDesktopErgonomics}. */
export interface AppShellDesktopErgonomics {
  readonly shortcutSheetOpen: boolean;
  readonly commandPaletteOpen: boolean;
  readonly anyOverlayOpen: boolean;
  readonly closeShortcutSheet: () => void;
  readonly closeCommandPalette: () => void;
  readonly openShortcutSheet: () => void;
  readonly onSelectTab: (tab: CommandPaletteTab) => void;
  readonly onSelectSettingsSection: (section: CommandPaletteSettingsSection) => void;
  readonly onToggleElvMode: () => void;
  readonly elvModeEnabled: boolean;
  readonly canLockParental: boolean;
  readonly onLockParentalControls: () => void;
  readonly onCycleThemePreset: () => void;
  readonly currentThemePresetLabel: string;
  readonly onClearRecentChannels: () => Promise<void>;
}

/** Coordinates desktop keyboard shortcut sheet (`?`/`F1`), command palette (`Ctrl/Cmd+K`), and recent-channel clear in `AppShell`. */
export function useAppShellDesktopErgonomics(opts: {
  readonly isPlayerOpen: boolean;
  readonly hasOtherModalOverlay: boolean;
  readonly preferences: PreferencesContextValue;
  readonly profile: ReturnType<typeof useProfile>;
  readonly catalog: CatalogService;
  readonly uiCache: CatalogUiCache;
  readonly onBumpUserState: () => void;
  readonly onSelectTab: (tab: AppTab, focusContent?: boolean) => void;
  readonly onOpenSettingsSection: (section: SettingsSection) => void;
}): AppShellDesktopErgonomics {
  const {
    isPlayerOpen,
    hasOtherModalOverlay,
    preferences,
    profile,
    catalog,
    uiCache,
    onBumpUserState,
    onSelectTab,
    onOpenSettingsSection,
  } = opts;
  const i18n = useI18n();
  const [shortcutSheetOpen, setShortcutSheetOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const shortcutSheetOpenRef = useRef(shortcutSheetOpen);
  shortcutSheetOpenRef.current = shortcutSheetOpen;
  const commandPaletteOpenRef = useRef(commandPaletteOpen);
  commandPaletteOpenRef.current = commandPaletteOpen;

  const closeShortcutSheet = useCallback(() => setShortcutSheetOpen(false), []);
  const closeCommandPalette = useCallback(() => setCommandPaletteOpen(false), []);
  const openShortcutSheet = useCallback(() => {
    setCommandPaletteOpen(false);
    setShortcutSheetOpen(true);
  }, []);
  const toggleShortcutSheet = useCallback(() => {
    if (commandPaletteOpenRef.current) return;
    setShortcutSheetOpen((open) => !open);
  }, []);
  const toggleCommandPalette = useCallback(() => {
    setShortcutSheetOpen(false);
    setCommandPaletteOpen((open) => !open);
  }, []);
  const openSearch = useCallback(() => {
    if (commandPaletteOpenRef.current || shortcutSheetOpenRef.current) return;
    onSelectTab('search', true);
  }, [onSelectTab]);

  useDesktopShellShortcuts({
    isPlayerOpen,
    hasModalOverlay: hasOtherModalOverlay,
    onToggleShortcutSheet: toggleShortcutSheet,
    onToggleCommandPalette: toggleCommandPalette,
    onOpenSearch: openSearch,
  });

  const handlePaletteTab = useCallback(
    (tab: CommandPaletteTab) => onSelectTab(tab, true),
    [onSelectTab],
  );
  const handlePaletteSettings = useCallback(
    (section: CommandPaletteSettingsSection) => onOpenSettingsSection(section),
    [onOpenSettingsSection],
  );
  const handleToggleElvMode = useCallback(() => {
    void preferences.updatePreferences({
      elvModeEnabled: !preferences.preferences.elvModeEnabled,
    });
  }, [preferences]);
  const handleCycleThemePreset = useCallback(() => {
    const idx = THEME_PRESET_IDS.indexOf(preferences.preferences.themePreset as ThemePresetId);
    const next = THEME_PRESET_IDS[(idx + 1) % THEME_PRESET_IDS.length] ?? THEME_PRESET_IDS[0];
    if (next) void preferences.updatePreferences({ themePreset: next });
  }, [preferences]);

  const currentThemePresetLabel = useMemo(() => {
    const preset = preferences.preferences.themePreset as ThemePresetId;
    const key = THEME_LABEL_KEYS[preset] ?? THEME_LABEL_KEYS.obsidianCrimson;
    return i18n.t(key);
  }, [i18n, preferences.preferences.themePreset]);

  const canLockParental =
    Boolean(profile.parentalSettings?.enabled) && Boolean(profile.parentalUnlocked);
  const onClearRecentChannels = useCallback(async () => {
    await catalog.clearRecentChannels?.();
    uiCache.clearHome?.();
    onBumpUserState();
  }, [catalog, onBumpUserState, uiCache]);

  return {
    shortcutSheetOpen,
    commandPaletteOpen,
    anyOverlayOpen: shortcutSheetOpen || commandPaletteOpen,
    closeShortcutSheet,
    closeCommandPalette,
    openShortcutSheet,
    onSelectTab: handlePaletteTab,
    onSelectSettingsSection: handlePaletteSettings,
    onToggleElvMode: handleToggleElvMode,
    elvModeEnabled: preferences.preferences.elvModeEnabled,
    canLockParental,
    onLockParentalControls: profile.lockParentalNow,
    onCycleThemePreset: handleCycleThemePreset,
    currentThemePresetLabel,
    onClearRecentChannels,
  };
}

/** Renders the desktop Shortcut Cheat Sheet (`?`/`F1`) and Command Palette (`Ctrl/Cmd+K`) overlays. */
export function AppShellDesktopOverlays(props: {
  readonly desktop?: AppShellDesktopErgonomics;
}): ReactElement | null {
  const { desktop } = props;
  if (!desktop) return null;
  return (
    <>
      <DesktopShortcutSheet
        visible={desktop.shortcutSheetOpen}
        onClose={desktop.closeShortcutSheet}
      />
      <DesktopCommandPalette
        visible={desktop.commandPaletteOpen}
        onClose={desktop.closeCommandPalette}
        onSelectTab={desktop.onSelectTab}
        onSelectSettingsSection={desktop.onSelectSettingsSection}
        onToggleElvMode={desktop.onToggleElvMode}
        elvModeEnabled={desktop.elvModeEnabled}
        canLockParental={desktop.canLockParental}
        onLockParentalControls={desktop.onLockParentalControls}
        onCycleThemePreset={desktop.onCycleThemePreset}
        currentThemePresetLabel={desktop.currentThemePresetLabel}
        onOpenShortcutSheet={desktop.openShortcutSheet}
      />
    </>
  );
}
