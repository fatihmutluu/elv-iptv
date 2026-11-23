import {
  AdaptiveSheet,
  CtaButton,
  Icon,
  useI18n,
  useTheme,
  webBackdropBlur,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { memo, type ReactElement } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { formatPrePlayLangLabel } from './detail-preplay';

/** Props of {@link DetailPrePlayControls}. */
export interface DetailPrePlayControlsProps {
  readonly audioLang: string;
  readonly subtitleLang: string;
  readonly versionLabel?: string;
  readonly onCycleVersion?: () => void;
  readonly onCycleAudio: () => void;
  readonly onCycleSubtitles: () => void;
  readonly isTv: boolean;
  readonly focusedControl: 'preplay-version' | 'preplay-audio' | 'preplay-subtitles' | null;
}

/**
 * Compact Cinema Quietude pre-play Version, Audio & Subtitle cyclers for VOD Detail screens (`#398`, `#404`).
 * Uses sharp `4px` frosted surfaces (never pill-bubble chips) with crisp 10-ft TV focus rings.
 */
export const DetailPrePlayControls = memo(function DetailPrePlayControlsInner({
  audioLang,
  subtitleLang,
  versionLabel,
  onCycleVersion,
  onCycleAudio,
  onCycleSubtitles,
  isTv,
  focusedControl,
}: DetailPrePlayControlsProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const blur = webBackdropBlur(10);
  const cursor = webCursorPointer();
  const transition = webTransition(theme, 'transform, background-color, border-color, opacity');

  const audioValue = formatPrePlayLangLabel(audioLang, i18n.t);
  const subValue = formatPrePlayLangLabel(subtitleLang, i18n.t);
  const versionFocused = isTv && focusedControl === 'preplay-version';
  const audioFocused = isTv && focusedControl === 'preplay-audio';
  const subFocused = isTv && focusedControl === 'preplay-subtitles';

  const renderControl = (
    testID: string,
    icon: 'layers' | 'audio' | 'subtitles',
    prefix: string,
    value: string,
    focused: boolean,
    onPress: () => void,
  ) => (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={`${prefix}: ${value}`}
      focusable={!isTv}
      onPress={onPress}
      style={({ pressed }) => [
        styles.controlBtn,
        blur,
        cursor,
        transition,
        {
          borderRadius: theme.radius.button,
          backgroundColor: focused ? theme.colors.focusFill : theme.colors.actionGlassBg,
          borderColor: theme.colors.actionGlassBorder,
          opacity: pressed ? 0.85 : 1,
          transform: [
            {
              scale: pressed
                ? theme.reduceMotion
                  ? 1
                  : 0.98
                : focused
                  ? theme.focus.buttonScale
                  : 1,
            },
          ],
        },
      ]}
    >
      <Icon name={icon} size={14} color={theme.colors.textSecondary} />
      <Text numberOfLines={1} style={[theme.typography.caption, { color: theme.colors.textMuted }]}>
        {`${prefix}:`}
      </Text>
      <Text
        numberOfLines={1}
        style={[theme.typography.caption, { color: theme.colors.textPrimary, fontWeight: '600' }]}
      >
        {value}
      </Text>
      {focused ? (
        <View
          pointerEvents="none"
          testID={`${testID}-focus-ring`}
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
  );

  return (
    <View
      testID="detail-preplay-controls"
      style={[styles.controlsRow, { marginTop: theme.spacing.sm, gap: theme.spacing.sm }]}
    >
      {versionLabel !== undefined && onCycleVersion !== undefined
        ? renderControl(
            'detail-preplay-version',
            'layers',
            i18n.t('detail.versionLabel'),
            versionLabel,
            versionFocused,
            onCycleVersion,
          )
        : null}
      {renderControl(
        'detail-preplay-audio',
        'audio',
        i18n.t('detail.prePlayAudio'),
        audioValue,
        audioFocused,
        onCycleAudio,
      )}
      {renderControl(
        'detail-preplay-subtitles',
        'subtitles',
        i18n.t('detail.prePlaySubtitles'),
        subValue,
        subFocused,
        onCycleSubtitles,
      )}
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
  controlsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
  },
  controlBtn: {
    position: 'relative',
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
