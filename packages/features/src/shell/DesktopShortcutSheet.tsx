import type { MessageId } from '@elv/i18n';
import {
  Icon,
  TABULAR_NUMS_STYLE,
  useI18n,
  useTheme,
  webBackdropBlur,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { type ComponentRef, type ReactElement, useMemo, useRef } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useDesktopDialogTrap } from '../shared/desktop-dialog-trap';
import { formatShortcutModifier, isMacPlatform } from './useDesktopShellShortcuts';

/** Props of {@link DesktopShortcutSheet}. */
export interface DesktopShortcutSheetProps {
  readonly visible: boolean;
  readonly onClose: () => void;
  /** Optional platform override (e.g. `'MacIntel'` vs `'Win32'`) for OS-aware modifier keycaps. */
  readonly platform?: string;
}

interface ShortcutRowSpec {
  readonly id: string;
  readonly labelKey: MessageId;
  readonly keys: readonly string[];
}

interface ShortcutGroupSpec {
  readonly id: string;
  readonly titleKey: MessageId;
  readonly rows: readonly ShortcutRowSpec[];
}

function buildShortcutGroups(mac: boolean): readonly ShortcutGroupSpec[] {
  const mod = formatShortcutModifier(mac);
  return [
    {
      id: 'navigation',
      titleKey: 'desktop.shortcuts.group.navigation',
      rows: [
        {
          id: 'back',
          labelKey: 'desktop.shortcuts.item.back',
          keys: [mac ? '⌘ + [' : 'Alt + ←'],
        },
        {
          id: 'mouse-back',
          labelKey: 'desktop.shortcuts.item.mouseBack',
          keys: ['Mouse 4'],
        },
        {
          id: 'close-overlay',
          labelKey: 'desktop.shortcuts.item.closeOverlay',
          keys: ['Esc'],
        },
      ],
    },
    {
      id: 'search',
      titleKey: 'desktop.shortcuts.group.search',
      rows: [
        {
          id: 'command-palette',
          labelKey: 'desktop.shortcuts.item.commandPalette',
          keys: [`${mod} + K`],
        },
        {
          id: 'search',
          labelKey: 'desktop.shortcuts.item.search',
          keys: ['/', `${mod} + F`],
        },
        {
          id: 'shortcut-sheet',
          labelKey: 'desktop.shortcuts.item.shortcutSheet',
          keys: ['?', 'F1'],
        },
      ],
    },
    {
      id: 'display',
      titleKey: 'desktop.shortcuts.group.display',
      rows: [
        {
          id: 'zoom-in',
          labelKey: 'desktop.shortcuts.item.zoomIn',
          keys: [`${mod} + +`],
        },
        {
          id: 'zoom-out',
          labelKey: 'desktop.shortcuts.item.zoomOut',
          keys: [`${mod} + -`],
        },
        {
          id: 'zoom-reset',
          labelKey: 'desktop.shortcuts.item.zoomReset',
          keys: [`${mod} + 0`],
        },
      ],
    },
    {
      id: 'player',
      titleKey: 'desktop.shortcuts.group.player',
      rows: [
        {
          id: 'play-pause',
          labelKey: 'desktop.shortcuts.item.playPause',
          keys: ['Space', 'K'],
        },
        {
          id: 'seek-step',
          labelKey: 'desktop.shortcuts.item.seekStep',
          keys: ['J / L', '← / →'],
        },
        {
          id: 'seek-coarse',
          labelKey: 'desktop.shortcuts.item.seekCoarse',
          keys: ['Shift + ← / →'],
        },
        {
          id: 'fullscreen',
          labelKey: 'desktop.shortcuts.item.fullscreen',
          keys: ['F'],
        },
        {
          id: 'mute',
          labelKey: 'desktop.shortcuts.item.mute',
          keys: ['M'],
        },
        {
          id: 'tracks',
          labelKey: 'desktop.shortcuts.item.tracks',
          keys: ['C'],
        },
        {
          id: 'always-on-top',
          labelKey: 'desktop.shortcuts.item.alwaysOnTop',
          keys: ['T'],
        },
        {
          id: 'channels',
          labelKey: 'desktop.shortcuts.item.channels',
          keys: ['G'],
        },
        {
          id: 'prev-channel',
          labelKey: 'desktop.shortcuts.item.prevChannel',
          keys: ['P'],
        },
        {
          id: 'info-stats',
          labelKey: 'desktop.shortcuts.item.infoStats',
          keys: ['I', 'Shift + I'],
        },
      ],
    },
  ];
}

/**
 * Cinema Quietude v2 frosted modal displaying grouped desktop navigation, search/palette, zoom,
 * and player keyboard shortcuts with OS-aware modifiers (`⌘` on macOS, `Ctrl` on Windows/Linux).
 */
export function DesktopShortcutSheet({
  visible,
  onClose,
  platform,
}: DesktopShortcutSheetProps): ReactElement | null {
  const theme = useTheme();
  const i18n = useI18n();
  const dialogRef = useRef<ComponentRef<typeof View> | null>(null);
  const mac = useMemo(() => isMacPlatform(platform), [platform]);
  const groups = useMemo(() => buildShortcutGroups(mac), [mac]);

  useDesktopDialogTrap(dialogRef, visible, onClose);

  if (!visible) return null;

  const cursorPointer = webCursorPointer();
  const closeTransition = webTransition(theme, 'background-color, border-color');

  const backdropWebProps =
    (Platform.OS as string) === 'web' ? ({ tabIndex: -1 } as Record<string, unknown>) : undefined;

  return (
    <View
      ref={dialogRef}
      testID="desktop-shortcut-sheet"
      style={[styles.overlay, { backgroundColor: theme.colors.overlayBackdrop }]}
    >
      <Pressable
        testID="desktop-shortcut-sheet-backdrop"
        accessible={false}
        aria-hidden
        focusable={false}
        {...backdropWebProps}
        onPress={onClose}
        style={styles.backdropHit}
      />

      <View
        testID="desktop-shortcut-sheet-dialog"
        role="dialog"
        aria-modal
        aria-label={i18n.t('desktop.shortcuts.title')}
        style={[
          styles.panel,
          {
            backgroundColor: theme.colors.bgElevated,
            borderColor: theme.colors.glassBorder,
            borderRadius: theme.radius.modal,
            padding: theme.spacing.lg,
            gap: theme.spacing.md,
          },
          webBackdropBlur(20),
        ]}
      >
        <View style={styles.headerRow}>
          <View style={styles.headerText}>
            <Text
              testID="desktop-shortcut-sheet-title"
              accessibilityRole="header"
              style={[theme.typography.h2, { color: theme.colors.textPrimary }]}
            >
              {i18n.t('desktop.shortcuts.title')}
            </Text>
            <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
              {i18n.t('desktop.shortcuts.subtitle')}
            </Text>
          </View>
          <Pressable
            testID="desktop-shortcut-sheet-close"
            accessibilityRole="button"
            accessibilityLabel={i18n.t('desktop.shortcuts.close')}
            onPress={onClose}
            style={({ pressed }) => [
              styles.closeButton,
              cursorPointer,
              closeTransition,
              {
                borderRadius: theme.radius.button,
                backgroundColor: pressed ? theme.colors.subtleHighlight : 'transparent',
                borderColor: theme.colors.surfaceBorder,
              },
            ]}
          >
            <Icon name="close" size={18} color={theme.colors.textPrimary} />
          </Pressable>
        </View>

        <ScrollView style={styles.scrollArea} contentContainerStyle={styles.groupsGrid}>
          {groups.map((group) => (
            <View
              key={group.id}
              testID={`desktop-shortcut-group-${group.id}`}
              style={[styles.groupCard, { gap: theme.spacing.xs }]}
            >
              <View style={styles.groupHeading}>
                <View style={[styles.accentBar, { backgroundColor: theme.colors.accent }]} />
                <Text style={[theme.typography.title, { color: theme.colors.textPrimary }]}>
                  {i18n.t(group.titleKey)}
                </Text>
              </View>

              <View
                style={[
                  styles.rowsBox,
                  {
                    backgroundColor: theme.colors.bgSurface,
                    borderColor: theme.colors.surfaceBorder,
                    borderRadius: theme.radius.card,
                  },
                ]}
              >
                {group.rows.map((row, index) => (
                  <View
                    key={row.id}
                    style={[
                      styles.row,
                      index > 0
                        ? {
                            borderTopWidth: StyleSheet.hairlineWidth,
                            borderTopColor: theme.colors.surfaceBorder,
                          }
                        : undefined,
                    ]}
                  >
                    <Text
                      numberOfLines={1}
                      style={[
                        theme.typography.body,
                        styles.rowLabel,
                        { color: theme.colors.textSecondary },
                      ]}
                    >
                      {i18n.t(row.labelKey)}
                    </Text>
                    <View style={styles.keycapRow}>
                      {row.keys.map((keycap) => (
                        <View
                          key={keycap}
                          style={[
                            styles.keycap,
                            {
                              backgroundColor: theme.colors.bgCard,
                              borderColor: theme.colors.glassBorder,
                              borderRadius: theme.radius.button,
                            },
                          ]}
                        >
                          <Text
                            style={[
                              theme.typography.caption,
                              TABULAR_NUMS_STYLE,
                              { color: theme.colors.textPrimary, fontWeight: '600' },
                            ]}
                          >
                            {keycap}
                          </Text>
                        </View>
                      ))}
                    </View>
                  </View>
                ))}
              </View>
            </View>
          ))}
        </ScrollView>
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
    zIndex: 82,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
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
    maxWidth: 740,
    maxHeight: '86%',
    borderWidth: 1,
    zIndex: 1,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  headerText: {
    flex: 1,
    gap: 2,
  },
  closeButton: {
    width: 34,
    height: 34,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scrollArea: {
    flexShrink: 1,
  },
  groupsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 16,
  },
  groupCard: {
    flexGrow: 1,
    flexBasis: 310,
  },
  groupHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  accentBar: {
    width: 3,
    height: 14,
    borderRadius: 2,
  },
  rowsBox: {
    borderWidth: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 12,
  },
  rowLabel: {
    flex: 1,
  },
  keycapRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexShrink: 0,
  },
  keycap: {
    borderWidth: 1,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
});
