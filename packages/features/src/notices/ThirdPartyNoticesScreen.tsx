import { createFocusStore, type FocusStore, type KeyEvent } from '@elv/focus-core';
import {
  ElvList,
  TABULAR_NUMS_STYLE,
  TvFocusAnchor,
  useFormFactor,
  useI18n,
  useKeyInterpreter,
  useTheme,
  useViewport,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { type ReactElement, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Text,
  View,
} from 'react-native';
import { NoticesDetailPane } from './NoticesDetailPane';
import { THIRD_PARTY_NOTICES, type ThirdPartyNotice } from './notices-data';
import { createNoticesListSource, NOTICES_LIST_ID, syncNoticesScopeActive } from './notices-scope';
import { noticesStyles as styles } from './notices-styles';

const VISIBLE_ROWS_DEFAULT = 10;
const VISIBLE_ROWS_PHONE = 6;
const ROW_HEIGHT_TV = 60;
const ROW_HEIGHT_POINTER = 54;
const DETAIL_SCROLL_STEP = 140;

interface ScrollToTarget {
  scrollTo(options: { y?: number; animated?: boolean }): void;
}

/** Props of {@link ThirdPartyNoticesScreen}. */
export interface ThirdPartyNoticesScreenProps {
  /** Override notice entries (defaults to bundled {@link THIRD_PARTY_NOTICES}). */
  notices?: readonly ThirdPartyNotice[];
  /** Invoked when the user presses Back from the top-level notices list. */
  onBack?: () => void;
  /** Invoked when TV D-pad Up reaches the top edge of the list to focus the shell tab bar. */
  onFocusTopNav?: () => void;
  /** Whether this screen owns TV remote focus (`false` while Top Nav owns focus). */
  isActiveScope?: boolean;
  /** Optional observer notified with the clamped Y offset when TV D-pad step-scrolls the detail pane. */
  onDetailStepScroll?: (offsetY: number) => void;
  /** When true, omits outer canvas background and padding for embedding inside SettingsScreen. */
  embedded?: boolean;
}

function NoticesTvKeyBridge({ onEvent }: { onEvent: (event: KeyEvent) => void }): ReactElement {
  useKeyInterpreter(onEvent);
  return <TvFocusAnchor testID="notices-tv-focus-anchor" />;
}

/**
 * Offline third-party software notices screen for phone, tablet, TV, and desktop.
 * Displays the LGPL relinking summary, pinned native engine provenance, and bundled runtime
 * package licenses without making any network requests.
 */
export function ThirdPartyNoticesScreen({
  notices = THIRD_PARTY_NOTICES,
  onBack,
  onFocusTopNav,
  isActiveScope = true,
  onDetailStepScroll,
  embedded = false,
}: ThirdPartyNoticesScreenProps): ReactElement {
  const formFactor = useFormFactor();
  const i18n = useI18n();
  const theme = useTheme();
  const viewport = useViewport();
  const isTv = formFactor === 'tv';
  const isPhone = formFactor === 'phone';
  const rowHeight = isTv ? ROW_HEIGHT_TV : ROW_HEIGHT_POINTER;
  const defaultVisibleRows = isPhone ? VISIBLE_ROWS_PHONE : VISIBLE_ROWS_DEFAULT;

  const [selectedIndex, setSelectedIndex] = useState(0);
  const [detailFocused, setDetailFocused] = useState(false);
  const [phonePane, setPhonePane] = useState<'list' | 'detail'>('list');
  const [measuredListHeight, setMeasuredListHeight] = useState(0);

  const visibleRows =
    measuredListHeight > 0
      ? Math.max(1, Math.floor(measuredListHeight / rowHeight))
      : defaultVisibleRows;

  const safeSelected =
    notices.length > 0 ? Math.min(Math.max(0, Math.floor(selectedIndex)), notices.length - 1) : 0;
  const selected = notices[safeSelected];
  const source = useMemo(() => createNoticesListSource(notices), [notices]);

  const storeRef = useRef<FocusStore | null>(null);
  if (storeRef.current === null) {
    storeRef.current = createFocusStore({
      id: 'notices-scope',
      lists: [
        {
          id: NOTICES_LIST_ID,
          count: notices.length,
          index: 0,
          orientation: 'vertical',
          pageSize: visibleRows,
        },
      ],
      active: NOTICES_LIST_ID,
    });
  }
  const store = storeRef.current;

  const noticesRef = useRef(notices);
  noticesRef.current = notices;
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  const onFocusTopNavRef = useRef(onFocusTopNav);
  onFocusTopNavRef.current = onFocusTopNav;
  const onDetailStepScrollRef = useRef(onDetailStepScroll);
  onDetailStepScrollRef.current = onDetailStepScroll;
  const detailFocusedRef = useRef(detailFocused);
  detailFocusedRef.current = detailFocused;
  const detailScrollRef = useRef<ScrollToTarget | null>(null);
  const detailOffsetRef = useRef(0);
  const detailViewportHeightRef = useRef(0);
  const detailContentHeightRef = useRef(0);

  const bindDetailScrollRef = useCallback((node: unknown) => {
    detailScrollRef.current = node as ScrollToTarget | null;
  }, []);

  useLayoutEffect(() => {
    if (!isTv) return;
    const effectiveDetailFocused = isActiveScope && detailFocused;
    if (!isActiveScope && detailFocusedRef.current) {
      detailFocusedRef.current = false;
      setDetailFocused(false);
    }
    syncNoticesScopeActive(store, isActiveScope && !effectiveDetailFocused);
  }, [detailFocused, isActiveScope, isTv, store]);

  const handleListPaneLayout = useCallback((event: LayoutChangeEvent) => {
    const height = Math.floor(event.nativeEvent.layout.height);
    if (height > 0) {
      setMeasuredListHeight((prev) => (prev === height ? prev : height));
    }
  }, []);

  const handleSelectNotice = useCallback((index: number) => {
    detailOffsetRef.current = 0;
    detailContentHeightRef.current = 0;
    detailScrollRef.current?.scrollTo({ y: 0, animated: false });
    setSelectedIndex(index);
  }, []);

  const handleActivateNotice = useCallback(
    (index: number) => {
      handleSelectNotice(index);
      if (isPhone) setPhonePane('detail');
    },
    [handleSelectNotice, isPhone],
  );

  const handleBackToList = useCallback(() => {
    setPhonePane('list');
  }, []);

  const handleDetailScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    detailOffsetRef.current = Math.max(0, event.nativeEvent.contentOffset.y);
  }, []);

  const handleDetailScrollLayout = useCallback((event: LayoutChangeEvent) => {
    detailViewportHeightRef.current = Math.max(0, event.nativeEvent.layout.height);
  }, []);

  const handleDetailContentSizeChange = useCallback((_width: number, height: number) => {
    detailContentHeightRef.current = Math.max(0, height);
  }, []);

  const handleTvKey = useCallback(
    (event: KeyEvent) => {
      if (detailFocusedRef.current) {
        if (event.kind === 'press' && (event.key === 'back' || event.key === 'left')) {
          detailFocusedRef.current = false;
          setDetailFocused(false);
          return;
        }
        if (event.kind === 'press' || event.kind === 'repeat') {
          let delta = 0;
          if (event.key === 'down') delta = DETAIL_SCROLL_STEP;
          else if (event.key === 'up') delta = -DETAIL_SCROLL_STEP;
          else if (event.key === 'channelDown') delta = DETAIL_SCROLL_STEP * 2;
          else if (event.key === 'channelUp') delta = -DETAIL_SCROLL_STEP * 2;
          if (delta !== 0) {
            const vh = detailViewportHeightRef.current;
            const ch = detailContentHeightRef.current;
            const rawNext = Math.max(0, detailOffsetRef.current + delta);
            const nextOffset = vh > 0 && ch > 0 ? Math.min(rawNext, Math.max(0, ch - vh)) : rawNext;
            detailOffsetRef.current = nextOffset;
            detailScrollRef.current?.scrollTo({ y: nextOffset, animated: false });
            onDetailStepScrollRef.current?.(nextOffset);
          }
        }
        return;
      }

      if (noticesRef.current.length === 0) {
        if (event.kind === 'press' && event.key === 'back') {
          (onBackRef.current ?? onFocusTopNavRef.current)?.();
        } else if (event.kind === 'press' && (event.key === 'up' || event.key === 'channelUp')) {
          (onFocusTopNavRef.current ?? onBackRef.current)?.();
        }
        return;
      }

      for (const intent of store.dispatch(event)) {
        if (
          intent.kind === 'edge' &&
          intent.side === 'start' &&
          (event.key === 'up' || event.key === 'channelUp')
        ) {
          (onFocusTopNavRef.current ?? onBackRef.current)?.();
        } else if (intent.kind === 'select') {
          detailFocusedRef.current = true;
          setDetailFocused(true);
        } else if (intent.kind === 'back') {
          (onBackRef.current ?? onFocusTopNavRef.current)?.();
        } else if (
          intent.kind === 'key' &&
          intent.event.kind === 'press' &&
          intent.event.key === 'right'
        ) {
          detailFocusedRef.current = true;
          setDetailFocused(true);
        }
      }
    },
    [store],
  );

  const rowLabel = useCallback(
    (item: ThirdPartyNotice | undefined, index: number) =>
      item !== undefined ? `${item.name} ${item.version} (${item.license})` : `#${index + 1}`,
    [],
  );

  const rowTransition = webTransition(theme, 'background-color');
  const rowCursor = webCursorPointer();

  const renderRow = useCallback(
    (item: ThirdPartyNotice | undefined, active: boolean) => (
      <View
        testID={item !== undefined ? `notices-item-${item.id}` : undefined}
        style={[
          styles.row,
          {
            backgroundColor: active ? theme.colors.accentTint : 'transparent',
            borderLeftWidth: active ? 3 : 0,
            borderLeftColor: active ? theme.colors.accent : 'transparent',
          },
          rowTransition,
          rowCursor,
        ]}
      >
        <Text
          numberOfLines={1}
          style={[
            theme.typography.title,
            { color: active ? theme.colors.textPrimary : theme.colors.textSecondary },
            isTv ? styles.rowTitleTv : null,
          ]}
        >
          {item?.name ?? ''}
        </Text>
        <Text
          numberOfLines={1}
          style={[
            theme.typography.caption,
            TABULAR_NUMS_STYLE,
            { color: active ? theme.colors.textSecondary : theme.colors.textMuted },
            isTv ? styles.rowMetaTv : null,
          ]}
        >
          {item !== undefined ? `${item.version} · ${item.license}` : ''}
        </Text>
      </View>
    ),
    [isTv, theme, rowTransition, rowCursor],
  );

  const showListPane = !isPhone || phonePane === 'list';
  const showDetailPane = !isPhone || phonePane === 'detail';
  const basePadX = isTv ? 48 : 16;
  const basePadY = isTv ? 20 : 16;
  const standalonePadding = {
    paddingTop: Math.max(basePadY, viewport.overscan.y, viewport.safeArea.top),
    paddingBottom: Math.max(basePadY, viewport.overscan.y, viewport.safeArea.bottom),
    paddingLeft: Math.max(basePadX, viewport.overscan.x, viewport.safeArea.left),
    paddingRight: Math.max(basePadX, viewport.overscan.x, viewport.safeArea.right),
  };

  return (
    <View
      testID="notices-screen"
      accessibilityLabel={i18n.t('notices.title')}
      style={[
        styles.root,
        isTv ? styles.rootTvGap : null,
        embedded ? styles.rootEmbedded : standalonePadding,
        { backgroundColor: embedded ? 'transparent' : theme.colors.bgCanvas },
      ]}
    >
      {isTv && isActiveScope ? <NoticesTvKeyBridge onEvent={handleTvKey} /> : null}

      {!embedded ? (
        <View style={styles.header}>
          <Text
            style={[
              theme.typography.h2,
              { color: theme.colors.textPrimary },
              isTv ? styles.titleTv : null,
            ]}
          >
            {i18n.t('notices.title')}
          </Text>
          <Text
            testID="notices-lgpl-summary"
            style={[
              theme.typography.body,
              { color: theme.colors.textSecondary },
              isTv ? styles.summaryTv : null,
            ]}
          >
            {i18n.t('notices.lgplSummary')}
          </Text>
        </View>
      ) : null}

      <View style={[styles.panes, isPhone ? styles.panesPhone : styles.panesSplit]}>
        {showListPane ? (
          <View
            testID="notices-list-pane"
            onLayout={handleListPaneLayout}
            style={[
              styles.listPane,
              {
                backgroundColor: theme.colors.bgSurface,
                borderColor: theme.colors.surfaceBorder,
                borderRadius: theme.radius.card,
              },
              isPhone
                ? styles.listPanePhone
                : isTv
                  ? embedded
                    ? styles.listPaneTvEmbedded
                    : styles.listPaneTv
                  : embedded
                    ? styles.listPaneWideEmbedded
                    : styles.listPaneWide,
            ]}
          >
            <ElvList
              listId={NOTICES_LIST_ID}
              store={store}
              source={source}
              rowHeight={rowHeight}
              visibleRows={visibleRows}
              selectedIndex={safeSelected}
              onSelectIndex={handleSelectNotice}
              onActivateIndex={handleActivateNotice}
              renderRow={renderRow}
              rowLabel={rowLabel}
              testID="notices-list"
            />
          </View>
        ) : null}

        {showDetailPane ? (
          <NoticesDetailPane
            selected={selected}
            isTv={isTv}
            isPhone={isPhone}
            detailFocused={detailFocused}
            bindScrollRef={bindDetailScrollRef}
            onScroll={handleDetailScroll}
            onScrollLayout={handleDetailScrollLayout}
            onContentSizeChange={handleDetailContentSizeChange}
            onBackToList={handleBackToList}
          />
        ) : null}
      </View>
    </View>
  );
}
