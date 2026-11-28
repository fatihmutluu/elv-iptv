import {
  hexToRgba,
  Icon,
  Tooltip,
  useI18n,
  useTheme,
  webBackdropBlur,
  webCursorPointer,
  webShadow,
  webTransition,
} from '@elv/ui-kit';
import { type ComponentRef, memo, type ReactElement, useEffect, useRef, useState } from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from 'react-native';
import type { DetailVersionOption } from './detail-data-helpers';

/**
 * Registers Escape key and pointer-outside listeners on web for floating detail popovers,
 * cleaning up automatically on close or unmount.
 */
export function attachWebOutsideDismiss(
  active: boolean,
  hostRef: { readonly current: unknown },
  onDismiss: () => void,
  skipEscapeWhenDomTrapRef?: { readonly current: unknown },
): (() => void) | undefined {
  if (!active || Platform.OS !== 'web') return undefined;
  const win = (
    globalThis as {
      window?: {
        addEventListener?: (type: string, fn: (ev: unknown) => void, capture?: boolean) => void;
        removeEventListener?: (type: string, fn: (ev: unknown) => void, capture?: boolean) => void;
      };
    }
  ).window;
  if (typeof win?.addEventListener !== 'function') return undefined;

  const handleKeyDown = (ev: unknown) => {
    const key = (ev as { key?: string } | null)?.key;
    if (key !== 'Escape') return;
    const trapNode = skipEscapeWhenDomTrapRef?.current as { querySelectorAll?: unknown } | null;
    if (trapNode && typeof trapNode.querySelectorAll === 'function') return;
    onDismiss();
  };
  const handlePointerDown = (ev: unknown) => {
    const target = (ev as { target?: unknown } | null)?.target;
    const host = hostRef.current as { contains?: (node: unknown) => boolean } | null;
    if (host && typeof host.contains === 'function' && host.contains(target)) return;
    onDismiss();
  };

  win.addEventListener('keydown', handleKeyDown);
  win.addEventListener('pointerdown', handlePointerDown, true);
  return () => {
    win.removeEventListener?.('keydown', handleKeyDown);
    win.removeEventListener?.('pointerdown', handlePointerDown, true);
  };
}

/** Props of {@link DetailVersionDropdown}. */
export interface DetailVersionDropdownProps {
  readonly versions: readonly DetailVersionOption[];
  readonly activeVersionKey: string;
  readonly activeVersionLabel: string;
  readonly open: boolean;
  readonly isTv: boolean;
  readonly focused: boolean;
  readonly tvHighlightedIndex?: number;
  readonly onToggleOpen: () => void;
  readonly onClose: () => void;
  readonly onSelectVersion: (key: string) => void;
}

/**
 * Full-width Cinema Quietude VOD Version Dropdown (`#404`, Wave R2) positioned cleanly beneath
 * the primary Play CTA only when `versions.length > 1`. Opens a dark-glass popover above the
 * trigger with active checkmark, hover highlight, click-outside / Escape dismissal, and TV D-pad support.
 */
export const DetailVersionDropdown = memo(function DetailVersionDropdownInner({
  versions,
  activeVersionKey,
  activeVersionLabel,
  open,
  isTv,
  focused,
  tvHighlightedIndex = 0,
  onToggleOpen,
  onClose,
  onSelectVersion,
}: DetailVersionDropdownProps): ReactElement | null {
  const theme = useTheme();
  const i18n = useI18n();
  const blur = webBackdropBlur(12);
  const menuBlur = webBackdropBlur(16);
  const cursor = webCursorPointer();
  const transition = webTransition(theme, 'transform, background-color, border-color, opacity');
  const containerRef = useRef<ComponentRef<typeof View>>(null);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);

  useEffect(() => {
    if (!open) setHoveredKey(null);
  }, [open]);

  useEffect(() => attachWebOutsideDismiss(open, containerRef, onClose), [onClose, open]);

  if (versions.length <= 1) return null;

  const versionPrefix = i18n.t('detail.versionLabel');
  const chooseTooltip = i18n.t('detail.version.choose');
  const triggerFocused = isTv && focused && !open;

  return (
    <View
      ref={containerRef}
      testID="detail-preplay-version-dropdown"
      style={[styles.dropdownWrap, { zIndex: open ? 40 : 2 }]}
    >
      {open ? (
        <Pressable
          testID="detail-preplay-version-backdrop"
          accessibilityRole="button"
          accessibilityLabel={i18n.t('detail.back')}
          focusable={false}
          onPress={onClose}
          style={
            Platform.OS === 'web'
              ? ({
                  position: 'fixed',
                  top: 0,
                  right: 0,
                  bottom: 0,
                  left: 0,
                  zIndex: 1,
                } as unknown as ViewStyle)
              : styles.dismissBackdrop
          }
        />
      ) : null}

      <Tooltip content={chooseTooltip} disabled={isTv || open}>
        <Pressable
          testID="detail-preplay-version"
          accessibilityRole="button"
          accessibilityLabel={`${versionPrefix}: ${activeVersionLabel}`}
          accessibilityState={{ expanded: open }}
          focusable={!isTv}
          onPress={onToggleOpen}
          style={({ pressed }) => [
            styles.controlBtn,
            blur,
            cursor,
            transition,
            {
              borderRadius: theme.radius.button,
              backgroundColor:
                triggerFocused || open ? theme.colors.focusFill : theme.colors.actionGlassBg,
              borderColor: open ? theme.colors.accent : theme.colors.actionGlassBorder,
              opacity: pressed ? 0.85 : 1,
              transform: [
                {
                  scale: pressed
                    ? theme.reduceMotion
                      ? 1
                      : 0.98
                    : triggerFocused
                      ? theme.focus.buttonScale
                      : 1,
                },
              ],
            },
          ]}
        >
          <View style={styles.controlLabelGroup}>
            <Icon name="layers" size={16} color={theme.colors.textSecondary} />
            <Text
              numberOfLines={1}
              style={[theme.typography.caption, { color: theme.colors.textMuted }]}
            >
              {`${versionPrefix}:`}
            </Text>
            <Text
              numberOfLines={1}
              style={[
                theme.typography.title,
                styles.controlValueText,
                { color: theme.colors.textPrimary },
              ]}
            >
              {activeVersionLabel}
            </Text>
          </View>
          <Icon name="chevronDown" size={16} color={theme.colors.textSecondary} />
          {triggerFocused ? (
            <View
              pointerEvents="none"
              testID="detail-preplay-version-focus-ring"
              style={[
                styles.focusRing,
                {
                  borderRadius: theme.radius.button,
                  borderWidth: theme.focus.ringWidth,
                  borderColor: theme.colors.focusRingColor,
                },
              ]}
            />
          ) : null}
        </Pressable>
      </Tooltip>

      {open ? (
        <ScrollView
          testID="detail-preplay-version-menu"
          accessibilityRole="menu"
          showsVerticalScrollIndicator={false}
          style={[
            styles.menuPopover,
            menuBlur,
            webShadow('0 18px 48px rgba(0, 0, 0, 0.72)'),
            {
              borderRadius: theme.radius.card,
              backgroundColor: theme.colors.glassBg,
              borderColor: theme.colors.glassBorder,
            },
          ]}
          contentContainerStyle={styles.menuListContent}
        >
          {versions.map((option, idx) => {
            const label = option.versionLabel || option.title;
            const isSelected = option.key === activeVersionKey;
            const isTvFocused = isTv && tvHighlightedIndex === idx;
            const isHovered = hoveredKey === option.key;
            return (
              <Pressable
                key={option.key}
                testID={`detail-preplay-version-option-${idx}`}
                accessibilityRole="menuitem"
                accessibilityLabel={label}
                accessibilityState={{ selected: isSelected }}
                focusable={!isTv}
                onHoverIn={() => setHoveredKey(option.key)}
                onHoverOut={() => setHoveredKey((cur) => (cur === option.key ? null : cur))}
                onPress={() => {
                  onSelectVersion(option.key);
                  onClose();
                }}
                style={({ pressed }) => [
                  styles.menuOption,
                  cursor,
                  transition,
                  {
                    borderRadius: theme.radius.button,
                    backgroundColor: isTvFocused
                      ? theme.colors.focusFill
                      : isHovered
                        ? theme.colors.actionGlassHoverBg
                        : isSelected
                          ? theme.colors.accentTint
                          : 'transparent',
                    opacity: pressed ? 0.85 : 1,
                  },
                ]}
              >
                <View style={styles.menuOptionContent}>
                  <Text
                    numberOfLines={1}
                    style={[
                      theme.typography.caption,
                      styles.menuOptionLabel,
                      {
                        color: isSelected ? theme.colors.textPrimary : theme.colors.textSecondary,
                        fontWeight: isSelected ? '600' : '500',
                      },
                    ]}
                  >
                    {label}
                  </Text>
                  {option.sourceName !== undefined && option.sourceName.trim() !== '' ? (
                    <Text
                      testID={`detail-preplay-version-source-${idx}`}
                      numberOfLines={1}
                      style={[theme.typography.caption, { color: theme.colors.textMuted }]}
                    >
                      {i18n.t('elv.source.from', { source: option.sourceName })}
                    </Text>
                  ) : null}
                  {option.isFake4k === true ||
                  (option.verifiedResolution !== null && option.verifiedResolution !== undefined) ||
                  option.isUnreliable === true ? (
                    <View style={styles.versionBadgesRow}>
                      {option.isFake4k === true && option.verifiedResolution ? (
                        <Text
                          testID={`detail-preplay-version-fake4k-${idx}`}
                          style={[
                            theme.typography.caption,
                            styles.versionBadge,
                            {
                              borderRadius: theme.radius.pill,
                              color: theme.colors.liveColor,
                              backgroundColor: hexToRgba(theme.colors.liveColor, 0.14),
                            },
                          ]}
                        >
                          {i18n.t('elv.quality.fake4k', {
                            resolution: option.verifiedResolution,
                          })}
                        </Text>
                      ) : option.verifiedResolution ? (
                        <Text
                          testID={`detail-preplay-version-verified-${idx}`}
                          style={[
                            theme.typography.caption,
                            styles.versionBadge,
                            {
                              borderRadius: theme.radius.pill,
                              color: theme.colors.successColor,
                              backgroundColor: hexToRgba(theme.colors.successColor, 0.14),
                            },
                          ]}
                        >
                          {i18n.t('elv.quality.verified', {
                            resolution: option.verifiedResolution,
                          })}
                        </Text>
                      ) : null}
                      {option.isUnreliable === true ? (
                        <Text
                          testID={`detail-preplay-version-unreliable-${idx}`}
                          style={[
                            theme.typography.caption,
                            styles.versionBadge,
                            {
                              borderRadius: theme.radius.pill,
                              color: theme.colors.liveColor,
                              backgroundColor: hexToRgba(theme.colors.liveColor, 0.14),
                            },
                          ]}
                        >
                          {i18n.t('elv.quality.unreliable')}
                        </Text>
                      ) : null}
                    </View>
                  ) : null}
                </View>
                {isSelected ? (
                  <Icon
                    testID={`detail-preplay-version-check-${idx}`}
                    name="check"
                    size={14}
                    color={theme.colors.accent}
                  />
                ) : null}
                {isTvFocused ? (
                  <View
                    pointerEvents="none"
                    testID={`detail-preplay-version-option-${idx}-focus-ring`}
                    style={[
                      styles.optionFocusRing,
                      {
                        borderRadius: theme.radius.button,
                        borderWidth: theme.focus.ringWidth,
                        borderColor: theme.colors.focusRingColor,
                      },
                    ]}
                  />
                ) : null}
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  dropdownWrap: {
    position: 'relative',
    width: '100%',
    alignSelf: 'stretch',
  },
  dismissBackdrop: {
    position: 'absolute',
    top: -1200,
    bottom: -1200,
    left: -1200,
    right: -1200,
    zIndex: 1,
  },
  controlBtn: {
    position: 'relative',
    zIndex: 2,
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    minHeight: 48,
  },
  controlLabelGroup: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minWidth: 0,
  },
  controlValueText: {
    flexShrink: 1,
    fontWeight: '600',
  },
  focusRing: {
    position: 'absolute',
    top: -3,
    bottom: -3,
    left: -3,
    right: -3,
  },
  menuPopover: {
    position: 'absolute',
    bottom: '100%',
    left: 0,
    right: 0,
    marginBottom: 6,
    maxHeight: 240,
    borderWidth: 1,
    zIndex: 5,
  },
  menuListContent: {
    padding: 4,
    gap: 2,
  },
  menuOption: {
    position: 'relative',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    minHeight: 36,
  },
  menuOptionContent: {
    flex: 1,
    gap: 2,
  },
  menuOptionLabel: {
    flexShrink: 1,
  },
  versionBadgesRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    marginTop: 2,
  },
  versionBadge: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    fontSize: 11,
    fontWeight: '600',
    overflow: 'hidden',
  },
  optionFocusRing: {
    position: 'absolute',
    top: -2,
    bottom: -2,
    left: -2,
    right: -2,
  },
});
