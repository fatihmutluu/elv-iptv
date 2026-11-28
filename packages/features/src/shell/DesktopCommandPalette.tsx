import {
  Icon,
  type IconName,
  TABULAR_NUMS_STYLE,
  useI18n,
  useTheme,
  webBackdropBlur,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import {
  type ComponentRef,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useDesktopDialogTrap } from '../shared/desktop-dialog-trap';
import { formatShortcutModifier, isMacPlatform } from './useDesktopShellShortcuts';

/** Primary tabs reachable from {@link DesktopCommandPalette}. */
export type CommandPaletteTab = 'home' | 'live' | 'movie' | 'series' | 'search' | 'library';

/** Settings sections reachable from {@link DesktopCommandPalette}. */
export type CommandPaletteSettingsSection =
  | 'appearance'
  | 'elvMode'
  | 'playback'
  | 'liveTv'
  | 'profiles'
  | 'sources'
  | 'account'
  | 'feedback'
  | 'licenses';

/** Single executable command rendered inside {@link DesktopCommandPalette}. */
export interface CommandPaletteItem {
  readonly id: string;
  readonly group: 'tabs' | 'settings' | 'actions';
  readonly groupLabel: string;
  readonly label: string;
  readonly keywords: string;
  readonly icon: IconName;
  readonly shortcutHint?: string;
  readonly testID: string;
  readonly run: () => void;
}

/** Props of {@link DesktopCommandPalette}. */
export interface DesktopCommandPaletteProps {
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly onSelectTab: (tab: CommandPaletteTab) => void;
  readonly onSelectSettingsSection: (section: CommandPaletteSettingsSection) => void;
  readonly onToggleElvMode: () => void;
  readonly elvModeEnabled?: boolean;
  /** Shown only when parental controls are enabled and currently unlocked. */
  readonly canLockParental?: boolean;
  readonly onLockParentalControls?: () => void;
  readonly onCycleThemePreset: () => void;
  readonly currentThemePresetLabel?: string;
  readonly onOpenShortcutSheet: () => void;
  readonly platform?: string;
}

function normalizePaletteQuery(value: string): string {
  return value
    .replace(/İ/g, 'i')
    .replace(/I/g, 'i')
    .replace(/ı/g, 'i')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

/** Filters command palette items case- and Turkish-diacritic-insensitively by label, group, or keywords. */
export function filterCommandPaletteItems(
  items: readonly CommandPaletteItem[],
  query: string,
): readonly CommandPaletteItem[] {
  const needle = normalizePaletteQuery(query);
  if (needle.length === 0) return items;
  const tokens = needle.split(/\s+/).filter(Boolean);
  return items.filter((item) => {
    const haystack = normalizePaletteQuery(`${item.label} ${item.groupLabel} ${item.keywords}`);
    return tokens.every((tok) => haystack.includes(tok));
  });
}

/**
 * Cinema Quietude v2 frosted desktop command palette (`Ctrl/Cmd+K`) providing instant keyboard
 * navigation across tabs, Settings sections, ELV Mode, parental lock, theme presets, and shortcuts.
 */
export function DesktopCommandPalette({
  visible,
  onClose,
  onSelectTab,
  onSelectSettingsSection,
  onToggleElvMode,
  elvModeEnabled = false,
  canLockParental = false,
  onLockParentalControls,
  onCycleThemePreset,
  currentThemePresetLabel,
  onOpenShortcutSheet,
  platform,
}: DesktopCommandPaletteProps): ReactElement | null {
  const theme = useTheme();
  const i18n = useI18n();
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const dialogRef = useRef<ComponentRef<typeof View> | null>(null);
  const inputRef = useRef<ComponentRef<typeof TextInput> | null>(null);
  const executedRef = useRef(false);
  const mac = useMemo(() => isMacPlatform(platform), [platform]);
  const mod = formatShortcutModifier(mac);

  useDesktopDialogTrap(dialogRef, visible, onClose);

  useEffect(() => {
    if (!visible) return;
    executedRef.current = false;
    setQuery('');
    setActiveIndex(0);
    inputRef.current?.focus?.();
  }, [visible]);

  const allItems = useMemo<readonly CommandPaletteItem[]>(() => {
    const tabsGroup = i18n.t('desktop.palette.group.tabs');
    const settingsGroup = i18n.t('desktop.palette.group.settings');
    const actionsGroup = i18n.t('desktop.palette.group.actions');

    const tabs: CommandPaletteItem[] = [
      {
        id: 'tab-home',
        group: 'tabs',
        groupLabel: tabsGroup,
        label: i18n.t('nav.home'),
        keywords: 'home ana sayfa start',
        icon: 'home',
        testID: 'command-palette-item-tab-home',
        run: () => onSelectTab('home'),
      },
      {
        id: 'tab-live',
        group: 'tabs',
        groupLabel: tabsGroup,
        label: i18n.t('nav.live'),
        keywords: 'live tv canli yayin channels epg guide',
        icon: 'tv',
        testID: 'command-palette-item-tab-live',
        run: () => onSelectTab('live'),
      },
      {
        id: 'tab-movie',
        group: 'tabs',
        groupLabel: tabsGroup,
        label: i18n.t('nav.movies'),
        keywords: 'movies filmler vod cinema',
        icon: 'film',
        testID: 'command-palette-item-tab-movie',
        run: () => onSelectTab('movie'),
      },
      {
        id: 'tab-series',
        group: 'tabs',
        groupLabel: tabsGroup,
        label: i18n.t('nav.series'),
        keywords: 'series diziler episodes shows',
        icon: 'series',
        testID: 'command-palette-item-tab-series',
        run: () => onSelectTab('series'),
      },
      {
        id: 'tab-search',
        group: 'tabs',
        groupLabel: tabsGroup,
        label: i18n.t('nav.search'),
        keywords: 'search ara find',
        icon: 'search',
        shortcutHint: '/',
        testID: 'command-palette-item-tab-search',
        run: () => onSelectTab('search'),
      },
      {
        id: 'tab-library',
        group: 'tabs',
        groupLabel: tabsGroup,
        label: i18n.t('nav.library'),
        keywords: 'library my list kitaplik listem favorites collections downloads',
        icon: 'library',
        testID: 'command-palette-item-tab-library',
        run: () => onSelectTab('library'),
      },
    ];

    const settingsSections: ReadonlyArray<{
      readonly section: CommandPaletteSettingsSection;
      readonly label: string;
      readonly icon: IconName;
      readonly keywords: string;
    }> = [
      {
        section: 'appearance',
        label: i18n.t('settings.section.appearance'),
        icon: 'layers',
        keywords: 'appearance gorunum theme language font',
      },
      {
        section: 'elvMode',
        label: i18n.t('settings.section.elvMode'),
        icon: 'star',
        keywords: 'elv mode enrichment metadata',
      },
      {
        section: 'playback',
        label: i18n.t('settings.section.playback'),
        icon: 'play',
        keywords: 'playback oynatma audio subtitles speed buffer',
      },
      {
        section: 'liveTv',
        label: i18n.t('settings.section.liveTv'),
        icon: 'tv',
        keywords: 'live tv guide epg canli rehber',
      },
      {
        section: 'profiles',
        label: i18n.t('settings.section.profiles'),
        icon: 'profile',
        keywords: 'profiles profiller kids parental pin',
      },
      {
        section: 'sources',
        label: i18n.t('settings.section.sources'),
        icon: 'sources',
        keywords: 'sources kaynaklar m3u xtream playlist import',
      },
      {
        section: 'account',
        label: i18n.t('settings.section.account'),
        icon: 'refresh',
        keywords: 'account sync hesap esitleme qr',
      },
      {
        section: 'feedback',
        label: i18n.t('settings.section.feedback'),
        icon: 'like',
        keywords: 'feedback geri bildirim telemetry diagnostics',
      },
      {
        section: 'licenses',
        label: i18n.t('settings.section.licenses'),
        icon: 'info',
        keywords: 'about licenses hakkinda lisanslar version',
      },
    ];

    const settingsItems: CommandPaletteItem[] = settingsSections.map((entry) => ({
      id: `settings-${entry.section}`,
      group: 'settings',
      groupLabel: settingsGroup,
      label: entry.label,
      keywords: `settings ayarlar ${entry.keywords}`,
      icon: entry.icon,
      testID: `command-palette-item-settings-${entry.section}`,
      run: () => onSelectSettingsSection(entry.section),
    }));

    const actions: CommandPaletteItem[] = [
      {
        id: 'action-elv-mode',
        group: 'actions',
        groupLabel: actionsGroup,
        label: i18n.t(
          elvModeEnabled ? 'desktop.palette.action.elvModeOn' : 'desktop.palette.action.elvModeOff',
        ),
        keywords: 'toggle elv mode ac kapat',
        icon: 'star',
        testID: 'command-palette-item-action-elv-mode',
        run: onToggleElvMode,
      },
      ...(canLockParental && onLockParentalControls !== undefined
        ? [
            {
              id: 'action-lock-parental',
              group: 'actions' as const,
              groupLabel: actionsGroup,
              label: i18n.t('desktop.palette.action.lockParental'),
              keywords: 'lock parental controls pin ebeveyn kilitle',
              icon: 'lock' as const,
              testID: 'command-palette-item-action-lock-parental',
              run: onLockParentalControls,
            },
          ]
        : []),
      {
        id: 'action-cycle-theme',
        group: 'actions',
        groupLabel: actionsGroup,
        label:
          currentThemePresetLabel !== undefined && currentThemePresetLabel.length > 0
            ? `${i18n.t('desktop.palette.action.cycleTheme')} (${currentThemePresetLabel})`
            : i18n.t('desktop.palette.action.cycleTheme'),
        keywords: 'cycle theme preset color tema degistir high contrast',
        icon: 'layers',
        testID: 'command-palette-item-action-cycle-theme',
        run: onCycleThemePreset,
      },
      {
        id: 'action-shortcuts',
        group: 'actions',
        groupLabel: actionsGroup,
        label: i18n.t('desktop.palette.action.openShortcuts'),
        keywords: 'keyboard shortcuts klavye kisayollari help',
        icon: 'keypad',
        shortcutHint: '?',
        testID: 'command-palette-item-action-shortcuts',
        run: onOpenShortcutSheet,
      },
    ];

    return [...tabs, ...settingsItems, ...actions];
  }, [
    canLockParental,
    currentThemePresetLabel,
    elvModeEnabled,
    i18n,
    onCycleThemePreset,
    onLockParentalControls,
    onOpenShortcutSheet,
    onSelectSettingsSection,
    onSelectTab,
    onToggleElvMode,
  ]);

  const filtered = useMemo(() => filterCommandPaletteItems(allItems, query), [allItems, query]);

  const handleQueryChange = useCallback((next: string) => {
    setQuery(next);
    setActiveIndex(0);
  }, []);

  const executeItem = useCallback(
    (item: CommandPaletteItem | undefined) => {
      if (!item || executedRef.current) return;
      executedRef.current = true;
      onClose();
      item.run();
    },
    [onClose],
  );

  const navStateRef = useRef({ filtered, activeIndex, executeItem, onClose });
  navStateRef.current = { filtered, activeIndex, executeItem, onClose };

  useEffect(() => {
    if (!visible || (Platform.OS as string) !== 'web') return;
    type PaletteKeyEvent = {
      key?: string;
      keyCode?: number;
      isComposing?: boolean;
      defaultPrevented?: boolean;
      ctrlKey?: boolean;
      metaKey?: boolean;
      altKey?: boolean;
      preventDefault?: () => void;
      stopPropagation?: () => void;
    };
    const win = (
      globalThis as {
        window?: {
          addEventListener?: (t: string, fn: (e: PaletteKeyEvent) => void) => void;
          removeEventListener?: (t: string, fn: (e: PaletteKeyEvent) => void) => void;
        };
      }
    ).window;
    if (!win?.addEventListener || !win.removeEventListener) return;

    const onKeyDown = (e: PaletteKeyEvent): void => {
      if (e.isComposing === true || e.key === 'Process' || e.keyCode === 229) return;
      const s = navStateRef.current;
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault?.();
        e.stopPropagation?.();
        s.onClose();
        return;
      }
      if (e.key === 'Escape') {
        if (e.defaultPrevented) return;
        e.preventDefault?.();
        e.stopPropagation?.();
        s.onClose();
        return;
      }
      if (s.filtered.length === 0) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault?.();
        setActiveIndex((prev) => (prev + 1) % s.filtered.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault?.();
        setActiveIndex((prev) => (prev - 1 + s.filtered.length) % s.filtered.length);
      } else if (e.key === 'Enter') {
        e.preventDefault?.();
        s.executeItem(s.filtered[s.activeIndex]);
      }
    };

    win.addEventListener('keydown', onKeyDown);
    return () => {
      win.removeEventListener?.('keydown', onKeyDown);
    };
  }, [visible]);

  if (!visible) return null;

  const cursorPointer = webCursorPointer();
  const rowTransition = webTransition(theme, 'background-color, border-color');
  const backdropWebProps =
    (Platform.OS as string) === 'web' ? ({ tabIndex: -1 } as Record<string, unknown>) : undefined;

  return (
    <View
      ref={dialogRef}
      testID="desktop-command-palette"
      style={[styles.overlay, { backgroundColor: theme.colors.overlayBackdrop }]}
    >
      <Pressable
        testID="desktop-command-palette-backdrop"
        accessible={false}
        aria-hidden
        focusable={false}
        {...backdropWebProps}
        onPress={onClose}
        style={styles.backdropHit}
      />

      <View
        testID="desktop-command-palette-dialog"
        role="dialog"
        aria-modal
        aria-label={i18n.t('desktop.palette.title')}
        style={[
          styles.panel,
          {
            backgroundColor: theme.colors.bgElevated,
            borderColor: theme.colors.glassBorder,
            borderRadius: theme.radius.modal,
          },
          webBackdropBlur(20),
        ]}
      >
        <View
          style={[
            styles.inputRow,
            {
              borderBottomColor: theme.colors.surfaceBorder,
              paddingHorizontal: theme.spacing.md,
              paddingVertical: theme.spacing.sm,
            },
          ]}
        >
          <Icon name="search" size={18} color={theme.colors.textSecondary} />
          <TextInput
            ref={inputRef}
            testID="command-palette-input"
            value={query}
            onChangeText={handleQueryChange}
            placeholder={i18n.t('desktop.palette.placeholder')}
            placeholderTextColor={theme.colors.textMuted}
            accessibilityLabel={i18n.t('desktop.palette.title')}
            autoFocus
            style={[theme.typography.body, styles.input, { color: theme.colors.textPrimary }]}
          />
          <View
            style={[
              styles.shortcutPill,
              {
                backgroundColor: theme.colors.bgSurface,
                borderColor: theme.colors.surfaceBorder,
                borderRadius: theme.radius.button,
              },
            ]}
          >
            <Text
              style={[
                theme.typography.micro,
                TABULAR_NUMS_STYLE,
                { color: theme.colors.textSecondary },
              ]}
            >
              {`${mod} + K`}
            </Text>
          </View>
        </View>

        <ScrollView
          testID="command-palette-list"
          style={styles.listScroll}
          contentContainerStyle={{ padding: theme.spacing.xs }}
        >
          {filtered.length === 0 ? (
            <View testID="command-palette-empty" style={styles.emptyBox}>
              <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>
                {i18n.t('desktop.palette.empty')}
              </Text>
            </View>
          ) : (
            filtered.map((item, idx) => {
              const selected = idx === activeIndex;
              return (
                <Pressable
                  key={item.id}
                  testID={item.testID}
                  accessibilityRole="menuitem"
                  accessibilityLabel={`${item.groupLabel}: ${item.label}`}
                  accessibilityState={{ selected }}
                  onHoverIn={() => setActiveIndex(idx)}
                  onPress={() => executeItem(item)}
                  style={[
                    styles.itemRow,
                    cursorPointer,
                    rowTransition,
                    {
                      borderRadius: theme.radius.card,
                      backgroundColor: selected ? theme.colors.subtleHighlight : 'transparent',
                      borderColor: selected ? theme.colors.accent : 'transparent',
                    },
                  ]}
                >
                  <Icon
                    name={item.icon}
                    size={16}
                    color={selected ? theme.colors.accent : theme.colors.textSecondary}
                  />
                  <View style={styles.itemCopy}>
                    <Text
                      numberOfLines={1}
                      style={[
                        theme.typography.title,
                        { color: theme.colors.textPrimary, fontWeight: selected ? '700' : '500' },
                      ]}
                    >
                      {item.label}
                    </Text>
                  </View>
                  <Text style={[theme.typography.caption, { color: theme.colors.textMuted }]}>
                    {item.groupLabel}
                  </Text>
                  {item.shortcutHint !== undefined ? (
                    <View
                      style={[
                        styles.shortcutPill,
                        {
                          backgroundColor: theme.colors.bgCard,
                          borderColor: theme.colors.glassBorder,
                          borderRadius: theme.radius.button,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          theme.typography.micro,
                          TABULAR_NUMS_STYLE,
                          { color: theme.colors.textPrimary },
                        ]}
                      >
                        {item.shortcutHint}
                      </Text>
                    </View>
                  ) : null}
                </Pressable>
              );
            })
          )}
        </ScrollView>

        <View
          style={[
            styles.footer,
            {
              borderTopColor: theme.colors.surfaceBorder,
              paddingHorizontal: theme.spacing.md,
              paddingVertical: theme.spacing.xs,
            },
          ]}
        >
          <Text style={[theme.typography.caption, { color: theme.colors.textMuted }]}>
            {i18n.t('desktop.palette.hint')}
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 84,
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingTop: 88,
    paddingHorizontal: 24,
    paddingBottom: 24,
  },
  backdropHit: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  panel: {
    width: '100%',
    maxWidth: 580,
    maxHeight: '74%',
    borderWidth: 1,
    zIndex: 1,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  input: {
    flex: 1,
    minHeight: 36,
    paddingVertical: 4,
  },
  listScroll: {
    maxHeight: 380,
  },
  emptyBox: {
    paddingVertical: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
  },
  itemCopy: {
    flex: 1,
    minWidth: 0,
  },
  shortcutPill: {
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
