import type { NowNextEntry } from '@elv/data';
import type { KeyEvent } from '@elv/focus-core';
import type { AppI18n } from '@elv/i18n';
import {
  AdaptiveSheet,
  ArtworkImage,
  type FormFactor,
  IconButton,
  SkeletonBox,
  TABULAR_NUMS_STYLE,
  useKeyInterpreter,
  useTheme,
  useViewport,
  webBackdropBlur,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import {
  type ComponentRef,
  type MutableRefObject,
  type ReactElement,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { LiveChannelPlaylist, PlayableEntry } from '../ports/play-target';
import { ChannelDrawerScheduleBox } from './ChannelDrawerScheduleBox';
import { useDesktopDialogTrap } from './desktop-dialog-trap';

const CHANNEL_DRAWER_WINDOW_SIZE = 25;
const CHANNEL_ROW_PITCH = 46;
const MAX_CACHED_SCHEDULES = 60;
const MAX_CACHED_ENTRIES = 75;

/** Imperative navigation handle used by `PlayerScreen` to route TV D-pad input cleanly (`#57`). */
export interface ChannelDrawerNavHandle {
  readonly move: (delta: 1 | -1) => void;
  readonly switchTab: (dir: -1 | 1) => void;
  readonly select: () => void;
}

/** Props of {@link PlayerChannelDrawer}. */
export interface PlayerChannelDrawerProps {
  readonly visible: boolean;
  /** When true (desktop child-HWND docked layout), docks in flex flow; when false (floating), overlays on the left (`Decision #40`). */
  readonly docked?: boolean;
  readonly playlist: LiveChannelPlaylist | undefined;
  readonly currentItemKey: string;
  readonly formFactor: FormFactor;
  readonly isTv: boolean;
  readonly i18n: AppI18n;
  readonly fetchNowNext?: (itemKey: string) => Promise<NowNextEntry | null>;
  /** Optional recent-channels loader for the `All | Recent` filter toggle (`#53`). */
  readonly fetchRecentChannels?: () => Promise<readonly PlayableEntry[]>;
  /** Optional parent-owned navigation handle for unified `usePlayerControls` TV key routing (`#57`). */
  readonly navigationRef?: MutableRefObject<ChannelDrawerNavHandle | null>;
  readonly onSelectChannel: (entry: PlayableEntry, index?: number) => void;
  readonly onClose: () => void;
}

/** Computes a bounded inclusive `[start, end]` channel window centered on `focusIndex`. */
export function computeChannelWindow(
  totalCount: number,
  focusIndex: number,
  windowSize = CHANNEL_DRAWER_WINDOW_SIZE,
): { readonly start: number; readonly end: number } {
  if (totalCount <= 0 || windowSize <= 0) return { start: 0, end: -1 };
  const clamped = Math.max(0, Math.min(totalCount - 1, focusIndex));
  if (totalCount <= windowSize) return { start: 0, end: totalCount - 1 };
  const start = Math.max(
    0,
    Math.min(totalCount - windowSize, clamped - Math.floor(windowSize / 2)),
  );
  return { start, end: Math.min(totalCount - 1, start + windowSize - 1) };
}

interface KeyEventLike {
  readonly key?: string;
  readonly target?: unknown;
  preventDefault?: () => void;
  stopPropagation?: () => void;
}

function isInteractiveButtonTarget(target: unknown): boolean {
  if (typeof target !== 'object' || target === null) return false;
  const el = target as {
    readonly tagName?: unknown;
    readonly role?: unknown;
    getAttribute?: (name: string) => string | null;
  };
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  if (tag === 'BUTTON' || tag === 'A') return true;
  const role = el.getAttribute?.('role') ?? (typeof el.role === 'string' ? el.role : null);
  return role === 'button';
}

function ChannelDrawerTvKeyFallback({
  onMove,
  onSwitchTab,
  onSelect,
  onClose,
}: {
  readonly onMove: (delta: 1 | -1) => void;
  readonly onSwitchTab: (dir: -1 | 1) => void;
  readonly onSelect: () => void;
  readonly onClose: () => void;
}): null {
  useKeyInterpreter((event: KeyEvent) => {
    if (event.kind === 'press' && event.key === 'back') {
      onClose();
      return true;
    }
    if (
      (event.kind === 'press' || event.kind === 'repeat') &&
      (event.key === 'up' || event.key === 'down')
    ) {
      onMove(event.key === 'down' ? 1 : -1);
      return true;
    }
    if (event.kind === 'press' && (event.key === 'left' || event.key === 'right')) {
      onSwitchTab(event.key === 'right' ? 1 : -1);
      return true;
    }
    if (event.kind === 'press' && event.key === 'select') {
      onSelect();
      return true;
    }
    return false;
  });
  return null;
}

/**
 * In-player live Channel & Schedule Drawer (`#57`): flex-docked on `desktop` (HWND-safe),
 * left glass panel with click-outside backdrop on floating desktop/TV/landscape, and
 * `AdaptiveSheet` on portrait mobile/tablet.
 */
export function PlayerChannelDrawer({
  visible,
  docked = true,
  playlist,
  currentItemKey,
  formFactor,
  isTv,
  i18n,
  fetchNowNext,
  fetchRecentChannels,
  navigationRef,
  onSelectChannel,
  onClose,
}: PlayerChannelDrawerProps): ReactElement | null {
  const theme = useTheme();
  const viewport = useViewport();
  const safeFontScale = Number.isFinite(theme.fontScale) ? Math.max(1, theme.fontScale) : 1;
  const channelRowPitch = Math.round(CHANNEL_ROW_PITCH * safeFontScale);
  const isWebDesktop = formFactor === 'desktop' && (Platform.OS as string) === 'web';
  const isPortraitOverlay =
    !isTv && formFactor !== 'desktop' && viewport.orientation === 'portrait';
  const desktopPanelRef = useRef<ComponentRef<typeof View> | null>(null);
  const listScrollRef = useRef<ComponentRef<typeof ScrollView> | null>(null);
  useDesktopDialogTrap(desktopPanelRef, visible && isWebDesktop, onClose, {
    modal: false,
    initialFocus: 'container',
  });

  const totalCount = playlist?.count ?? 0;
  const initialIndex =
    totalCount > 0 ? Math.max(0, Math.min(totalCount - 1, playlist?.currentIndex ?? 0)) : 0;

  const [filterTab, setFilterTab] = useState<'all' | 'recent'>('all');
  const [recentEntries, setRecentEntries] = useState<readonly PlayableEntry[]>([]);
  const filterTabRef = useRef(filterTab);
  filterTabRef.current = filterTab;
  const recentEntriesRef = useRef(recentEntries);
  recentEntriesRef.current = recentEntries;

  const isRecentTab = filterTab === 'recent' && fetchRecentChannels !== undefined;
  const activeCount = isRecentTab ? recentEntries.length : totalCount;

  const [focusedIndex, setFocusedIndex] = useState(initialIndex);
  const [entriesByIndex, setEntriesByIndex] = useState<ReadonlyMap<number, PlayableEntry>>(
    () => new Map(),
  );
  const [scheduleByKey, setScheduleByKey] = useState<ReadonlyMap<string, NowNextEntry | null>>(
    () => new Map(),
  );

  const scheduleCacheRef = useRef<Map<string, NowNextEntry | null>>(new Map());
  const entriesCacheRef = useRef<Map<number, PlayableEntry>>(new Map());
  const lastPlaylistRef = useRef(playlist);
  const wasVisibleRef = useRef(false);
  const focusedIndexRef = useRef(focusedIndex);
  focusedIndexRef.current = focusedIndex;
  const onSelectRef = useRef(onSelectChannel);
  onSelectRef.current = onSelectChannel;

  const moveFocus = (delta: 1 | -1): void => {
    const count =
      filterTabRef.current === 'recent' && fetchRecentChannels !== undefined
        ? recentEntriesRef.current.length
        : totalCount;
    if (count <= 0) return;
    setFocusedIndex((prev) => Math.max(0, Math.min(count - 1, prev + delta)));
  };
  const switchTab = (dir: -1 | 1): void => {
    if (fetchRecentChannels === undefined) return;
    const nextTab: 'all' | 'recent' = dir > 0 ? 'recent' : 'all';
    if (filterTabRef.current === nextTab) return;
    filterTabRef.current = nextTab;
    setFilterTab(nextTab);
    setFocusedIndex(nextTab === 'all' ? initialIndex : 0);
  };
  const selectFocused = (): void => {
    const idx = focusedIndexRef.current;
    if (filterTabRef.current === 'recent' && fetchRecentChannels !== undefined) {
      const entry = recentEntriesRef.current[idx];
      if (entry !== undefined) onSelectRef.current(entry, undefined);
      return;
    }
    const entry = entriesCacheRef.current.get(idx);
    if (entry !== undefined) onSelectRef.current(entry, idx);
  };

  if (navigationRef !== undefined) {
    navigationRef.current = visible ? { move: moveFocus, switchTab, select: selectFocused } : null;
  }

  useEffect(
    () => () => {
      if (navigationRef !== undefined) navigationRef.current = null;
    },
    [navigationRef],
  );

  useEffect(() => {
    if (visible && !wasVisibleRef.current) {
      setFilterTab('all');
      setFocusedIndex(initialIndex);
    }
    wasVisibleRef.current = visible;
  }, [initialIndex, visible]);

  useEffect(() => {
    if (!visible || !isRecentTab || fetchRecentChannels === undefined) return;
    let cancelled = false;
    void fetchRecentChannels()
      .then((rows) => {
        if (cancelled) return;
        setRecentEntries(rows);
        setFocusedIndex(0);
      })
      .catch(() => {
        if (!cancelled) setRecentEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchRecentChannels, isRecentTab, visible]);

  const { start: windowStart, end: windowEnd } = useMemo(
    () => computeChannelWindow(totalCount, focusedIndex, CHANNEL_DRAWER_WINDOW_SIZE),
    [focusedIndex, totalCount],
  );

  useEffect(() => {
    if (!visible || totalCount <= 0) return;
    const localIdx = Math.max(0, focusedIndex - windowStart);
    listScrollRef.current?.scrollTo?.({
      y: Math.max(0, (localIdx - 2) * channelRowPitch),
      animated: false,
    });
  }, [channelRowPitch, focusedIndex, totalCount, visible, windowStart]);

  useEffect(() => {
    if (lastPlaylistRef.current !== playlist) {
      lastPlaylistRef.current = playlist;
      entriesCacheRef.current = new Map();
      setEntriesByIndex(new Map());
    }
    if (!visible || playlist === undefined || windowEnd < windowStart) return;
    let cancelled = false;
    const missing: number[] = [];
    for (let i = windowStart; i <= windowEnd; i++) {
      if (!entriesCacheRef.current.has(i)) missing.push(i);
    }
    if (missing.length === 0) return;
    void Promise.all(missing.map(async (idx) => [idx, await playlist.getAt(idx)] as const)).then(
      (loaded) => {
        if (cancelled) return;
        const cache = new Map(entriesCacheRef.current);
        for (const [idx, entry] of loaded) {
          if (entry !== undefined) cache.set(idx, entry);
        }
        if (cache.size > MAX_CACHED_ENTRIES) {
          for (const idx of cache.keys()) {
            if (
              idx < windowStart - CHANNEL_DRAWER_WINDOW_SIZE ||
              idx > windowEnd + CHANNEL_DRAWER_WINDOW_SIZE
            ) {
              cache.delete(idx);
            }
          }
        }
        entriesCacheRef.current = cache;
        setEntriesByIndex(cache);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [playlist, visible, windowEnd, windowStart]);

  const focusedEntry = isRecentTab ? recentEntries[focusedIndex] : entriesByIndex.get(focusedIndex);
  const focusedKey = focusedEntry?.itemKey;

  useEffect(() => {
    if (!visible || focusedKey === undefined || fetchNowNext === undefined) return;
    if (scheduleCacheRef.current.has(focusedKey)) return;
    let cancelled = false;
    void fetchNowNext(focusedKey).then((entry) => {
      if (cancelled) return;
      const cache = new Map(scheduleCacheRef.current);
      cache.set(focusedKey, entry);
      while (cache.size > MAX_CACHED_SCHEDULES) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
      scheduleCacheRef.current = cache;
      setScheduleByKey(cache);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchNowNext, focusedKey, visible]);

  if (!visible) return null;

  const focusedSchedule = focusedKey !== undefined ? scheduleByKey.get(focusedKey) : undefined;
  const headerTitle = i18n.t('player.channelList');

  const handleKeyDown = (event: KeyEventLike): void => {
    const key = event.key;
    if (key === 'Escape' || key === 'Backspace') {
      event.preventDefault?.();
      event.stopPropagation?.();
      onClose();
      return;
    }
    if ((key === 'ArrowLeft' || key === 'ArrowRight') && fetchRecentChannels !== undefined) {
      event.preventDefault?.();
      event.stopPropagation?.();
      switchTab(key === 'ArrowRight' ? 1 : -1);
      return;
    }
    if (activeCount <= 0) return;
    if (key === 'ArrowDown') {
      event.preventDefault?.();
      event.stopPropagation?.();
      setFocusedIndex((prev) => Math.min(activeCount - 1, prev + 1));
    } else if (key === 'ArrowUp') {
      event.preventDefault?.();
      event.stopPropagation?.();
      setFocusedIndex((prev) => Math.max(0, prev - 1));
    } else if (key === 'Enter' || key === ' ') {
      const activeEl = (globalThis as { document?: { activeElement?: unknown } }).document
        ?.activeElement;
      if (isInteractiveButtonTarget(event.target ?? activeEl)) return;
      const entry = isRecentTab
        ? recentEntriesRef.current[focusedIndex]
        : entriesCacheRef.current.get(focusedIndex);
      if (entry !== undefined) {
        event.preventDefault?.();
        event.stopPropagation?.();
        onSelectChannel(entry, isRecentTab ? undefined : focusedIndex);
      }
    }
  };

  const indices: number[] = [];
  for (let i = windowStart; i <= windowEnd; i++) indices.push(i);

  const content = (
    <View testID="player-channel-drawer-panel" style={styles.inner}>
      {isTv && navigationRef === undefined ? (
        <ChannelDrawerTvKeyFallback
          onMove={moveFocus}
          onSwitchTab={switchTab}
          onSelect={selectFocused}
          onClose={onClose}
        />
      ) : null}
      <View style={[styles.header, { borderBottomColor: theme.colors.surfaceBorder }]}>
        <Text
          numberOfLines={1}
          style={[theme.typography.h2, styles.flex1, { color: theme.colors.textPrimary }]}
        >
          {headerTitle}
        </Text>
        <IconButton
          testID="player-channel-drawer-close"
          icon="close"
          size={36}
          accessibilityLabel={i18n.t('player.closeTracks')}
          focusable={!isTv}
          onPress={onClose}
        />
      </View>

      {fetchRecentChannels !== undefined ? (
        <View
          testID="player-channel-drawer-tabs"
          accessibilityRole="tablist"
          style={[styles.filterTabs, { borderBottomColor: theme.colors.surfaceBorder }]}
        >
          {(['all', 'recent'] as const).map((tabKey) => {
            const active = filterTab === tabKey;
            const label =
              tabKey === 'all'
                ? i18n.t('player.channelDrawerAll')
                : i18n.t('player.channelDrawerRecent');
            return (
              <Pressable
                key={tabKey}
                testID={`player-channel-drawer-tab-${tabKey}`}
                accessibilityRole="tab"
                accessibilityLabel={label}
                accessibilityState={{ selected: active }}
                focusable={!isTv}
                onPress={() => {
                  setFilterTab(tabKey);
                  setFocusedIndex(tabKey === 'all' ? initialIndex : 0);
                }}
                style={[
                  styles.filterTab,
                  { borderBottomColor: active ? theme.colors.accent : 'transparent' },
                  !isTv ? webCursorPointer() : undefined,
                ]}
              >
                <Text
                  style={[
                    theme.typography.caption,
                    {
                      color: active ? theme.colors.textPrimary : theme.colors.textSecondary,
                      fontWeight: active ? '700' : '500',
                    },
                  ]}
                >
                  {label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      {activeCount === 0 ? (
        <View
          testID={
            isRecentTab ? 'player-channel-drawer-recent-empty' : 'player-channel-drawer-empty'
          }
          style={styles.emptyBox}
        >
          <Text style={[theme.typography.body, { color: theme.colors.textMuted }]}>
            {isRecentTab
              ? i18n.t('player.channelDrawerRecentEmpty')
              : i18n.t('player.channelListEmpty')}
          </Text>
        </View>
      ) : (
        <>
          <ScrollView
            ref={listScrollRef}
            testID="player-channel-drawer-list"
            style={styles.list}
            showsVerticalScrollIndicator={false}
          >
            {(isRecentTab ? recentEntries.map((_, idx) => idx) : indices).map((idx) => {
              const entry = isRecentTab ? recentEntries[idx] : entriesByIndex.get(idx);
              const isPlaying = entry !== undefined && entry.itemKey === currentItemKey;
              const isFocused = idx === focusedIndex;
              if (entry === undefined) {
                return (
                  <View key={`slot-${idx}`} style={[styles.row, { minHeight: channelRowPitch }]}>
                    <SkeletonBox width={32} height={32} borderRadius={theme.radius.button} />
                    <SkeletonBox width="70%" height={14} borderRadius={theme.radius.button} />
                  </View>
                );
              }
              const hoverProps = !isTv
                ? ({
                    onHoverIn: () => setFocusedIndex(idx),
                    onFocus: () => setFocusedIndex(idx),
                  } as Record<string, unknown>)
                : undefined;
              return (
                <Pressable
                  key={entry.itemKey}
                  testID={
                    isRecentTab ? `player-channel-recent-row-${idx}` : `player-channel-row-${idx}`
                  }
                  focusable={!isTv}
                  accessibilityRole="button"
                  accessibilityLabel={entry.title}
                  accessibilityState={{ selected: isPlaying }}
                  onPress={() => onSelectChannel(entry, isRecentTab ? undefined : idx)}
                  {...hoverProps}
                  style={({ pressed }) => [
                    styles.row,
                    {
                      minHeight: channelRowPitch,
                      backgroundColor: isPlaying
                        ? theme.colors.accentTint
                        : isFocused
                          ? theme.colors.focusFill
                          : 'transparent',
                      borderLeftWidth: isPlaying ? 3 : 0,
                      borderLeftColor: isPlaying ? theme.colors.accent : 'transparent',
                      borderWidth: isFocused ? theme.focus.ringWidth : 0,
                      borderColor: isFocused ? theme.colors.focusRingColor : 'transparent',
                      borderRadius: theme.radius.card,
                      opacity: pressed ? 0.84 : 1,
                    },
                    webTransition(theme, 'background-color, border-color, opacity'),
                    !isTv ? webCursorPointer() : undefined,
                  ]}
                >
                  <ArtworkImage
                    uri={entry.logo}
                    label={entry.title}
                    maxDecodePx={96}
                    resizeMode="contain"
                    logoBackdrop
                    borderRadius={theme.radius.button}
                    style={styles.logo}
                  />
                  <Text
                    numberOfLines={1}
                    style={[
                      theme.typography.caption,
                      TABULAR_NUMS_STYLE,
                      styles.channelNum,
                      { color: isPlaying ? theme.colors.textPrimary : theme.colors.textMuted },
                    ]}
                  >
                    {idx + 1}
                  </Text>
                  <Text
                    numberOfLines={1}
                    style={[
                      theme.typography.title,
                      styles.flex1,
                      { color: theme.colors.textPrimary },
                    ]}
                  >
                    {entry.title}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>

          {focusedEntry !== undefined ? (
            <ChannelDrawerScheduleBox schedule={focusedSchedule} i18n={i18n} />
          ) : null}
        </>
      )}
    </View>
  );

  if (formFactor === 'desktop') {
    const dockedMode = docked;
    const keyProps = {
      onKeyDown: handleKeyDown,
      ...(isWebDesktop ? { role: 'dialog', 'aria-modal': false, 'aria-label': headerTitle } : {}),
    } as Record<string, unknown>;
    if (!dockedMode) {
      const backdropWebProps = isWebDesktop
        ? ({ tabIndex: -1 } as Record<string, unknown>)
        : undefined;
      return (
        <View
          ref={desktopPanelRef}
          testID="player-channel-drawer-overlay"
          pointerEvents="box-none"
          style={styles.overlayRoot}
        >
          <Pressable
            testID="player-channel-drawer-backdrop"
            accessible={false}
            aria-hidden
            focusable={false}
            {...backdropWebProps}
            onPress={onClose}
            style={StyleSheet.absoluteFill}
          />
          <View
            testID="player-channel-drawer-desktop"
            {...keyProps}
            style={[
              styles.desktopFloating,
              {
                backgroundColor: theme.colors.glassBg,
                borderRightColor: theme.colors.glassBorder,
              },
              webBackdropBlur(20),
            ]}
          >
            {content}
          </View>
        </View>
      );
    }
    return (
      <View
        ref={desktopPanelRef}
        testID="player-channel-drawer-desktop"
        {...keyProps}
        style={[
          styles.desktopDocked,
          {
            backgroundColor: theme.colors.bgElevated,
            borderRightColor: theme.colors.glassBorder,
          },
        ]}
      >
        {content}
      </View>
    );
  }

  if (isPortraitOverlay) {
    return (
      <AdaptiveSheet visible={visible} onDismiss={onClose} testID="player-channel-drawer-sheet">
        {content}
      </AdaptiveSheet>
    );
  }

  return (
    <View testID="player-channel-drawer-overlay" style={styles.overlayRoot}>
      {!isTv ? (
        <Pressable
          testID="player-channel-drawer-backdrop"
          focusable={false}
          accessibilityRole="button"
          accessibilityLabel={i18n.t('ui.dismiss')}
          onPress={onClose}
          style={[StyleSheet.absoluteFill, { backgroundColor: theme.colors.overlayBackdrop }]}
        />
      ) : null}
      <View
        style={[
          styles.sidePanel,
          {
            width: isTv ? 360 : 320,
            backgroundColor: theme.colors.glassBg,
            borderRightColor: theme.colors.glassBorder,
            paddingTop: 12 + viewport.safeArea.top + viewport.overscan.y,
            paddingBottom: 12 + viewport.safeArea.bottom + viewport.overscan.y,
            paddingLeft: 10 + viewport.safeArea.left + viewport.overscan.x,
          },
          webBackdropBlur(20),
        ]}
      >
        {content}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  desktopDocked: {
    width: 320,
    borderRightWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    overflow: 'hidden',
  },
  desktopFloating: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    width: 320,
    borderRightWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    overflow: 'hidden',
    zIndex: 35,
  },
  overlayRoot: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: 35 },
  sidePanel: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    borderRightWidth: 1,
    paddingRight: 12,
    overflow: 'hidden',
  },
  inner: { flex: 1, gap: 8 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  filterTabs: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  filterTab: { paddingVertical: 6, borderBottomWidth: 2 },
  flex1: { flex: 1 },
  list: { flex: 1, maxHeight: 360 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 46,
    paddingHorizontal: 8,
    paddingVertical: 6,
    gap: 8,
  },
  logo: { width: 32, height: 32, flexShrink: 0 },
  channelNum: { minWidth: 26, fontWeight: '700' },
  emptyBox: { paddingVertical: 24, alignItems: 'center' },
});
