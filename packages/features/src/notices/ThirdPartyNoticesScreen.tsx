import { createFocusStore, type FocusStore, type KeyEvent } from '@elv/focus-core';
import { ElvList, type ListSource, useFormFactor, useI18n, useKeyInterpreter } from '@elv/ui-kit';
import { type ReactElement, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { THIRD_PARTY_NOTICES, type ThirdPartyNotice } from './notices-data';
import { noticesStyles as styles } from './notices-styles';

const NOTICES_LIST_ID = 'notices-list';
const PARKED_SCOPE_ID = '__notices_parked__';
const PARKED_LIST_ID = '__notices_parked_list__';
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
}

function createNoticesListSource(items: readonly ThirdPartyNotice[]): ListSource<ThirdPartyNotice> {
  return {
    count: () => items.length,
    get: (index) => (index >= 0 && index < items.length ? items[index] : undefined),
    prefetch: () => undefined,
    onChange: () => () => undefined,
  };
}

function syncNoticesScopeActive(store: FocusStore, isActiveScope: boolean): void {
  const scopes = store.getState().scopes;
  const isParked = scopes[scopes.length - 1]?.id === PARKED_SCOPE_ID;
  if (!isActiveScope) {
    if (!isParked) {
      store.pushScope(
        PARKED_SCOPE_ID,
        [{ id: PARKED_LIST_ID, count: 0, index: 0, orientation: 'vertical', pageSize: 1 }],
        PARKED_LIST_ID,
      );
    }
    return;
  }
  if (isParked) store.popScope();
  if (!store.isActive(NOTICES_LIST_ID)) store.activate(NOTICES_LIST_ID);
}

function NoticesTvKeyBridge({ onEvent }: { onEvent: (event: KeyEvent) => void }): ReactElement {
  useKeyInterpreter(onEvent);
  return (
    <View
      testID="notices-tv-focus-anchor"
      focusable
      hasTVPreferredFocus
      style={styles.tvFocusAnchor}
    />
  );
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
}: ThirdPartyNoticesScreenProps): ReactElement {
  const formFactor = useFormFactor();
  const i18n = useI18n();
  const isTv = formFactor === 'tv';
  const isPhone = formFactor === 'phone';
  const visibleRows = isPhone ? VISIBLE_ROWS_PHONE : VISIBLE_ROWS_DEFAULT;
  const rowHeight = isTv ? ROW_HEIGHT_TV : ROW_HEIGHT_POINTER;

  const [selectedIndex, setSelectedIndex] = useState(0);
  const [detailFocused, setDetailFocused] = useState(false);

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
  const detailFocusedRef = useRef(detailFocused);
  detailFocusedRef.current = detailFocused;
  const detailScrollRef = useRef<ScrollToTarget | null>(null);
  const detailOffsetRef = useRef(0);

  const bindDetailScrollRef = useCallback((node: unknown) => {
    detailScrollRef.current = node as ScrollToTarget | null;
  }, []);

  useLayoutEffect(() => {
    if (!isTv) return;
    syncNoticesScopeActive(store, isActiveScope);
    if (!isActiveScope && detailFocusedRef.current) {
      detailFocusedRef.current = false;
      setDetailFocused(false);
    }
  }, [isActiveScope, isTv, store]);

  const handleSelectNotice = useCallback((index: number) => {
    detailOffsetRef.current = 0;
    detailScrollRef.current?.scrollTo({ y: 0, animated: false });
    setSelectedIndex(index);
  }, []);

  const handleDetailScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    detailOffsetRef.current = Math.max(0, event.nativeEvent.contentOffset.y);
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
            const nextOffset = Math.max(0, detailOffsetRef.current + delta);
            detailOffsetRef.current = nextOffset;
            detailScrollRef.current?.scrollTo({ y: nextOffset, animated: false });
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

  const renderRow = useCallback(
    (item: ThirdPartyNotice | undefined, active: boolean) => (
      <View
        testID={item !== undefined ? `notices-item-${item.id}` : undefined}
        style={[styles.row, active ? styles.rowActive : null]}
      >
        <Text
          numberOfLines={1}
          style={[
            styles.rowTitle,
            isTv ? styles.rowTitleTv : null,
            active ? styles.rowTitleActive : null,
          ]}
        >
          {item?.name ?? ''}
        </Text>
        <Text
          numberOfLines={1}
          style={[
            styles.rowMeta,
            isTv ? styles.rowMetaTv : null,
            active ? styles.rowMetaActive : null,
          ]}
        >
          {item !== undefined ? `${item.version} · ${item.license}` : ''}
        </Text>
      </View>
    ),
    [isTv],
  );

  const detailMetaRows =
    selected === undefined
      ? []
      : ([
          ['version', `${i18n.t('notices.version')}: ${selected.version}`],
          ['license', `${i18n.t('notices.license')}: ${selected.license}`],
          ['platforms', `${i18n.t('notices.platforms')}: ${selected.platforms.join(', ')}`],
          ['source', `${i18n.t('notices.source')}: ${selected.sourceUrl}`],
        ] as const);

  return (
    <View
      testID="notices-screen"
      accessibilityLabel={i18n.t('notices.title')}
      style={[styles.root, isTv ? styles.rootTv : null]}
    >
      {isTv && isActiveScope ? <NoticesTvKeyBridge onEvent={handleTvKey} /> : null}

      <View style={styles.header}>
        <Text style={[styles.title, isTv ? styles.titleTv : null]}>{i18n.t('notices.title')}</Text>
        <Text
          testID="notices-lgpl-summary"
          style={[styles.summary, isTv ? styles.summaryTv : null]}
        >
          {i18n.t('notices.lgplSummary')}
        </Text>
      </View>

      <View style={[styles.panes, isPhone ? styles.panesPhone : styles.panesSplit]}>
        <View
          style={[
            styles.listPane,
            isPhone ? styles.listPanePhone : isTv ? styles.listPaneTv : styles.listPaneWide,
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
            onActivateIndex={handleSelectNotice}
            renderRow={renderRow}
            rowLabel={rowLabel}
            testID="notices-list"
          />
        </View>

        <View
          testID="notices-detail"
          accessibilityState={{ selected: isTv && detailFocused }}
          style={[styles.detailPane, isTv && detailFocused ? styles.detailPaneFocused : null]}
        >
          <ScrollView
            ref={bindDetailScrollRef}
            testID="notices-detail-scroll"
            onScroll={handleDetailScroll}
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
      </View>
    </View>
  );
}
