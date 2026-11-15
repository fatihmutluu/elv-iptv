import { useI18n } from '@elv/ui-kit';
import type { ReactElement } from 'react';
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
      style={[styles.detailPane, isTv && detailFocused ? styles.detailPaneFocused : null]}
    >
      {isPhone ? (
        <View style={styles.detailToolbar}>
          <Pressable
            testID="notices-back-to-list"
            accessibilityRole="button"
            accessibilityLabel={backLabel}
            onPress={onBackToList}
            style={styles.backButton}
          >
            <Text style={styles.backButtonText}>{backLabel}</Text>
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
              style={[styles.detailName, isTv ? styles.detailNameTv : null]}
            >
              {selected.name}
            </Text>
            {detailMetaRows.map(([key, text]) => (
              <Text
                key={key}
                testID={`notices-detail-${key}`}
                style={[styles.detailMeta, isTv ? styles.detailMetaTv : null]}
              >
                {text}
              </Text>
            ))}
            <Text
              testID="notices-detail-modification"
              style={[styles.detailSection, isTv ? styles.detailSectionTv : null]}
            >
              {selected.modificationNote ?? i18n.t('notices.unmodified')}
            </Text>
            <Text
              testID="notices-detail-text"
              style={[styles.detailText, isTv ? styles.detailSectionTv : null]}
            >
              {selected.noticeText}
            </Text>
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}
