import {
  TABULAR_NUMS_STYLE,
  useI18n,
  useTheme,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { type ReactElement, useCallback, useState } from 'react';
import {
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';
import type { ThirdPartyNotice } from './notices-data';
import { noticesStyles as styles } from './notices-styles';

interface NoticesDetailPaneProps {
  selected: ThirdPartyNotice | undefined;
  isTv: boolean;
  isPhone: boolean;
  detailFocused: boolean;
  bindScrollRef: (node: unknown) => void;
  onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onScrollLayout: (event: LayoutChangeEvent) => void;
  onContentSizeChange: (width: number, height: number) => void;
  onBackToList: () => void;
}

/** Scrollable license & LGPL provenance detail pane shared across phone drilldown and split layouts. */
export function NoticesDetailPane({
  selected,
  isTv,
  isPhone,
  detailFocused,
  bindScrollRef,
  onScroll,
  onScrollLayout,
  onContentSizeChange,
  onBackToList,
}: NoticesDetailPaneProps): ReactElement {
  const i18n = useI18n();
  const theme = useTheme();
  const [backHovered, setBackHovered] = useState(false);
  const handleBackHoverIn = useCallback(() => setBackHovered(true), []);
  const handleBackHoverOut = useCallback(() => setBackHovered(false), []);

  const transition = webTransition(theme, 'background-color, border-color, opacity');
  const cursor = webCursorPointer();

  const detailMetaRows =
    selected === undefined
      ? []
      : ([
          ['version', `${i18n.t('notices.version')}: ${selected.version}`],
          ['license', `${i18n.t('notices.license')}: ${selected.license}`],
          ['platforms', `${i18n.t('notices.platforms')}: ${selected.platforms.join(', ')}`],
          ['source', `${i18n.t('notices.source')}: ${selected.sourceUrl}`],
        ] as const);

  const backLabel = i18n.t('notices.backToList');

  return (
    <View
      testID="notices-detail"
      accessibilityState={{ selected: isTv && detailFocused }}
      style={[
        styles.detailPane,
        {
          backgroundColor: theme.colors.bgSurface,
          borderColor:
            isTv && detailFocused ? theme.colors.focusRingColor : theme.colors.surfaceBorder,
          borderWidth: isTv && detailFocused ? theme.focus.ringWidth : 1,
          borderRadius: theme.radius.card,
        },
        transition,
      ]}
    >
      {isPhone ? (
        <View style={[styles.detailToolbar, { borderBottomColor: theme.colors.surfaceBorder }]}>
          <Pressable
            testID="notices-back-to-list"
            accessibilityRole="button"
            accessibilityLabel={backLabel}
            onPress={onBackToList}
            onHoverIn={handleBackHoverIn}
            onHoverOut={handleBackHoverOut}
            style={({ pressed }) => [
              styles.backButton,
              {
                backgroundColor:
                  backHovered || pressed
                    ? theme.colors.actionGlassHoverBg
                    : theme.colors.actionGlassBg,
                borderColor: theme.colors.actionGlassBorder,
                borderRadius: theme.radius.button,
              },
              pressed ? styles.backButtonPressed : null,
              transition,
              cursor,
            ]}
          >
            <Text style={[theme.typography.title, { color: theme.colors.textPrimary }]}>
              {backLabel}
            </Text>
          </Pressable>
        </View>
      ) : null}

      <ScrollView
        ref={bindScrollRef}
        testID="notices-detail-scroll"
        onScroll={onScroll}
        onLayout={onScrollLayout}
        onContentSizeChange={onContentSizeChange}
        scrollEventThrottle={32}
        {...(isTv ? { focusable: false } : {})}
        contentContainerStyle={styles.detailContent}
      >
        {selected !== undefined ? (
          <>
            <Text
              testID="notices-detail-name"
              style={[
                theme.typography.h2,
                styles.detailName,
                { color: theme.colors.textPrimary },
                isTv ? styles.detailNameTv : null,
              ]}
            >
              {selected.name}
            </Text>
            {detailMetaRows.map(([key, text]) => (
              <Text
                key={key}
                testID={`notices-detail-${key}`}
                style={[
                  theme.typography.caption,
                  TABULAR_NUMS_STYLE,
                  { color: theme.colors.textSecondary },
                  isTv ? styles.detailMetaTv : null,
                ]}
              >
                {text}
              </Text>
            ))}
            <Text
              testID="notices-detail-modification"
              style={[
                theme.typography.body,
                styles.detailSection,
                {
                  color: theme.colors.textSecondary,
                  borderTopColor: theme.colors.surfaceBorder,
                },
                isTv ? styles.detailSectionTv : null,
              ]}
            >
              {selected.modificationNote ?? i18n.t('notices.unmodified')}
            </Text>
            <Text
              testID="notices-detail-text"
              style={[
                theme.typography.caption,
                styles.detailText,
                {
                  color: theme.colors.textPrimary,
                  borderTopColor: theme.colors.surfaceBorder,
                },
                isTv ? styles.detailSectionTv : null,
              ]}
            >
              {selected.noticeText}
            </Text>
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}
