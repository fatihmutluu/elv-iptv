import {
  AdaptiveSheet,
  CtaButton,
  hexToRgba,
  Icon,
  Tooltip,
  useI18n,
  useTheme,
  webBackdropBlur,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { type ComponentRef, memo, type ReactElement, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { DetailVersionOption } from './detail-data-helpers';

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
 * Compact Cinema Quietude VOD Version Dropdown (`#404`) shown only when `versions.length > 1`.
 * Opens a dark-glass popover listing every available version with active checkmark, hover
 * highlight, click-outside / Escape dismissal, and 10-ft TV D-pad support.
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
  const blur = webBackdropBlur(10);
  const menuBlur = webBackdropBlur(14);
  const cursor = webCursorPointer();
  const transition = webTransition(theme, 'transform, background-color, border-color, opacity');
  const containerRef = useRef<ComponentRef<typeof View>>(null);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);

  useEffect(() => {
    if (!open) setHoveredKey(null);
  }, [open]);

  useEffect(() => {
    if (!open || Platform.OS !== 'web') return undefined;
    const win = (
      globalThis as {
        window?: {
          addEventListener?: (type: string, fn: (ev: unknown) => void, capture?: boolean) => void;
          removeEventListener?: (
            type: string,
            fn: (ev: unknown) => void,
            capture?: boolean,
          ) => void;
        };
      }
    ).window;
    if (typeof win?.addEventListener !== 'function') return undefined;

    const handleKeyDown = (ev: unknown) => {
      const key = (ev as { key?: string } | null)?.key;
      if (key === 'Escape') onClose();
    };
    const handlePointerDown = (ev: unknown) => {
      const target = (ev as { target?: unknown } | null)?.target;
      const host = containerRef.current as unknown as {
        contains?: (node: unknown) => boolean;
      } | null;
      if (host && typeof host.contains === 'function' && host.contains(target)) return;
      onClose();
    };

    win.addEventListener('keydown', handleKeyDown);
    win.addEventListener('pointerdown', handlePointerDown, true);
    return () => {
      win.removeEventListener?.('keydown', handleKeyDown);
      win.removeEventListener?.('pointerdown', handlePointerDown, true);
    };
  }, [onClose, open]);

  if (versions.length <= 1) return null;

  const versionPrefix = i18n.t('detail.versionLabel');
  const chooseTooltip = i18n.t('detail.version.choose');
  const triggerFocused = isTv && focused && !open;

  return (
    <View
      ref={containerRef}
      testID="detail-preplay-version-dropdown"
      style={[
        styles.dropdownWrap,
        {
          marginTop: theme.spacing.sm,
          zIndex: open ? 40 : 2,
        },
      ]}
    >
      {open ? (
        <Pressable
          testID="detail-preplay-version-backdrop"
          accessibilityRole="button"
          accessibilityLabel={i18n.t('detail.back')}
          focusable={false}
          onPress={onClose}
          style={styles.dismissBackdrop}
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
          <Icon name="layers" size={14} color={theme.colors.textSecondary} />
          <Text
            numberOfLines={1}
            style={[theme.typography.caption, { color: theme.colors.textMuted }]}
          >
            {`${versionPrefix}:`}
          </Text>
          <Text
            numberOfLines={1}
            style={[
              theme.typography.caption,
              { color: theme.colors.textPrimary, fontWeight: '600' },
            ]}
          >
            {activeVersionLabel}
          </Text>
          <Icon name="chevronDown" size={14} color={theme.colors.textSecondary} />
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
        <View
          testID="detail-preplay-version-menu"
          accessibilityRole="menu"
          style={[
            styles.menuPopover,
            menuBlur,
            {
              borderRadius: theme.radius.button,
              backgroundColor: theme.colors.bgElevated,
              borderColor: theme.colors.surfaceBorder,
            },
          ]}
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
        </View>
      ) : null}
    </View>
  );
});

/** Props of {@link DetailSynopsisBlock}. */
export interface DetailSynopsisBlockProps {
  readonly synopsis: string;
  readonly canExpand: boolean;
  readonly expanded: boolean;
  readonly isTv: boolean;
  readonly focused: boolean;
  readonly onToggle?: () => void;
}

/** Truncated Detail Hero synopsis with an accessible `Read more` / `Show less` trigger (`#398`). */
export const DetailSynopsisBlock = memo(function DetailSynopsisBlockInner({
  synopsis,
  canExpand,
  expanded,
  isTv,
  focused,
  onToggle,
}: DetailSynopsisBlockProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const cursor = webCursorPointer();
  const transition = webTransition(theme, 'background-color, opacity');
  const toggleLabel = expanded ? i18n.t('detail.readLess') : i18n.t('detail.readMore');

  return (
    <>
      <Text
        testID="detail-synopsis"
        numberOfLines={4}
        style={[
          theme.typography.body,
          styles.synopsis,
          { color: theme.colors.textSecondary, marginTop: theme.spacing.sm },
        ]}
      >
        {synopsis}
      </Text>
      {canExpand && onToggle ? (
        <Pressable
          testID="detail-synopsis-toggle"
          accessibilityRole="button"
          accessibilityLabel={toggleLabel}
          focusable={!isTv}
          onPress={onToggle}
          style={({ pressed }) => [
            styles.synopsisToggle,
            cursor,
            transition,
            {
              marginTop: theme.spacing.xs,
              borderRadius: theme.radius.button,
              backgroundColor: focused ? theme.colors.focusFill : 'transparent',
              opacity: pressed ? 0.75 : 1,
            },
          ]}
        >
          <Text
            style={[
              theme.typography.caption,
              { color: theme.colors.textPrimary, fontWeight: '600' },
            ]}
          >
            {toggleLabel}
          </Text>
          {focused ? (
            <View
              pointerEvents="none"
              testID="detail-synopsis-toggle-focus-ring"
              style={[
                styles.synopsisFocusRing,
                {
                  borderRadius: theme.radius.button,
                  borderWidth: theme.focus.ringWidth,
                  borderColor: theme.colors.focusRingColor,
                },
              ]}
            />
          ) : null}
        </Pressable>
      ) : null}
    </>
  );
});

/** Props of {@link DetailSynopsisSheet}. */
export interface DetailSynopsisSheetProps {
  readonly visible: boolean;
  readonly title: string;
  readonly synopsis: string;
  readonly isTv: boolean;
  readonly onDismiss: () => void;
}

/**
 * TV-safe accessible `AdaptiveSheet` modal reader for long Detail synopses (`#398`).
 * Keeps full untruncated plot text scrollable without disturbing 10-ft TV D-pad traversal or
 * desktop hero geometry.
 */
export const DetailSynopsisSheet = memo(function DetailSynopsisSheetInner({
  visible,
  title,
  synopsis,
  isTv,
  onDismiss,
}: DetailSynopsisSheetProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();

  return (
    <AdaptiveSheet
      visible={visible}
      testID="detail-synopsis-sheet"
      title={i18n.t('detail.synopsisTitle')}
      popoverWidth={440}
      onDismiss={onDismiss}
    >
      <Text
        numberOfLines={2}
        style={[theme.typography.h2, { color: theme.colors.textPrimary, marginBottom: 8 }]}
      >
        {title}
      </Text>
      <ScrollView style={styles.synopsisScroll} showsVerticalScrollIndicator>
        <Text
          testID="detail-synopsis-full"
          style={[theme.typography.body, { color: theme.colors.textSecondary }]}
        >
          {synopsis}
        </Text>
      </ScrollView>
      <View style={[styles.sheetFooter, { marginTop: theme.spacing.md }]}>
        <CtaButton
          testID="detail-synopsis-close"
          variant="secondary"
          label={i18n.t('detail.readLess')}
          focusable={!isTv}
          focused={isTv}
          onPress={onDismiss}
        />
      </View>
    </AdaptiveSheet>
  );
});

const styles = StyleSheet.create({
  dropdownWrap: {
    position: 'relative',
    alignSelf: 'flex-start',
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
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    minHeight: 34,
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
    top: '100%',
    left: 0,
    marginTop: 6,
    minWidth: 200,
    maxWidth: 320,
    padding: 4,
    borderWidth: 1,
    zIndex: 3,
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
    minHeight: 34,
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
  synopsisScroll: {
    maxHeight: 280,
  },
  synopsis: {
    maxWidth: 640,
  },
  synopsisToggle: {
    position: 'relative',
    alignSelf: 'flex-start',
    paddingVertical: 4,
    paddingHorizontal: 6,
  },
  synopsisFocusRing: {
    position: 'absolute',
    top: -2,
    bottom: -2,
    left: -2,
    right: -2,
  },
  sheetFooter: {
    alignItems: 'flex-end',
  },
});
