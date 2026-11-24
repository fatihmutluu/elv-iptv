import {
  type Key,
  type KeyEvent,
  type KeyInput,
  type KeyTrigger,
  REMAPPABLE_ACTIONS,
  type RemapActionMeta,
  type RemapContext,
  type RemappableActionId,
  resolveKeyTrigger,
  validateKeyBinding,
} from '@elv/focus-core';
import type { MessageId } from '@elv/i18n';
import {
  CtaButton,
  FilterChip,
  MicroPill,
  Surface,
  TvFocusAnchor,
  useI18n,
  useKeyInterpreter,
  useTheme,
  useTvKeyInterceptor,
  useTvKeySource,
  useViewport,
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
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { formatRemoteKeyLabel, mapWebKeyToRemoteKey, useKeymap, useRouteActive } from '../shared';

const CONTEXTS: readonly RemapContext[] = ['player', 'live', 'global'];
const CAPTURE_LONG_PRESS_MS = 500;
const NOOP_TV_SUBSCRIBER = (): boolean => false;

const CONTEXT_LABEL_KEYS: Readonly<Record<RemapContext, MessageId>> = {
  player: 'remote.contextPlayer',
  live: 'remote.contextLive',
  global: 'remote.contextGlobal',
};

const ACTION_LABEL_KEYS: Readonly<Record<RemappableActionId, MessageId>> = {
  'player.togglePlayPause': 'remote.action.togglePlayPause',
  'player.seekBack': 'remote.action.seekBack',
  'player.seekForward': 'remote.action.seekForward',
  'player.channelUp': 'remote.action.channelUp',
  'player.channelDown': 'remote.action.channelDown',
  'player.lastChannel': 'remote.action.lastChannel',
  'player.openChannelDrawer': 'remote.action.openChannelDrawer',
  'player.openSettings': 'remote.action.openSettings',
  'player.cycleAudioTrack': 'remote.action.cycleAudioTrack',
  'player.cycleSubtitleTrack': 'remote.action.cycleSubtitleTrack',
  'player.toggleMute': 'remote.action.toggleMute',
  'player.openInfo': 'remote.action.openInfo',
  'player.toggleGuide': 'remote.action.toggleGuide',
  'live.lastChannel': 'remote.action.lastChannel',
  'live.toggleGuide': 'remote.action.toggleGuide',
  'live.openSearch': 'remote.action.openSearch',
  'live.toggleFavorite': 'remote.action.toggleFavorite',
  'global.openSearch': 'remote.action.openSearch',
  'global.openGuide': 'remote.action.toggleGuide',
  'global.openHome': 'remote.action.openHome',
};

function RemotePanelTvKeyBridge({
  onEvent,
}: {
  readonly onEvent: (event: KeyEvent) => boolean;
}): ReactElement {
  const routeActive = useRouteActive();
  useKeyInterpreter(onEvent);
  return <TvFocusAnchor testID="remote-keys-tv-focus-anchor" hasTVPreferredFocus={routeActive} />;
}

function CaptureTvKeyInterceptor({
  onTrigger,
}: {
  readonly onTrigger: (trigger: KeyTrigger) => void;
}): ReactElement {
  const onTriggerRef = useRef(onTrigger);
  onTriggerRef.current = onTrigger;
  const activeKeyRef = useRef<Key | null>(null);
  const longFiredRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPending = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    activeKeyRef.current = null;
    longFiredRef.current = false;
  }, []);

  useEffect(() => clearPending, [clearPending]);

  useTvKeySource(NOOP_TV_SUBSCRIBER);
  useTvKeyInterceptor((input: KeyInput) => {
    if (input.action === 'press') {
      clearPending();
      onTriggerRef.current({ key: input.key, kind: 'press' });
      return true;
    }
    if (input.action === 'long') {
      clearPending();
      onTriggerRef.current({ key: input.key, kind: 'long' });
      return true;
    }
    if (input.action === 'down') {
      if (activeKeyRef.current === input.key) return true;
      clearPending();
      activeKeyRef.current = input.key;
      longFiredRef.current = false;
      const pressedKey = input.key;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        if (activeKeyRef.current === pressedKey) {
          longFiredRef.current = true;
          onTriggerRef.current({ key: pressedKey, kind: 'long' });
        }
      }, CAPTURE_LONG_PRESS_MS);
      return true;
    }
    if (input.action === 'up') {
      if (activeKeyRef.current !== input.key) return true;
      const firedLong = longFiredRef.current;
      const key = activeKeyRef.current;
      clearPending();
      if (!firedLong) {
        onTriggerRef.current({ key, kind: 'press' });
      }
      return true;
    }
    if (input.action === 'cancel') {
      clearPending();
      return true;
    }
    return true;
  });

  return <TvFocusAnchor testID="remote-capture-tv-focus-anchor" hasTVPreferredFocus />;
}

/** Props of {@link RemoteKeysSettingsPanel}. */
export interface RemoteKeysSettingsPanelProps {
  /** Whether this panel currently owns 10-ft TV D-pad focus. */
  readonly isActiveScope?: boolean;
  /** Returns TV focus back to the Settings sidebar. */
  readonly onBack?: () => void;
  /** Routes TV focus directly to the top navigation bar. */
  readonly onFocusTopNav?: () => void;
}

type RowButtonCol = 0 | 1 | 2;

/**
 * Cinema Quietude v2 Remote Key Remapping panel (`#33`) under Settings -> Remote keys.
 * Supports context filtering (`Player` | `Live TV` | `Global`), live in-tree capture overlay
 * via `useTvKeyInterceptor` (zero RN `<Modal>`), immutable nav key protection, Clear, Reset,
 * and Reset all defaults.
 */
export function RemoteKeysSettingsPanel({
  isActiveScope = true,
  onBack,
  onFocusTopNav,
}: RemoteKeysSettingsPanelProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const viewport = useViewport();
  const isTv = viewport.formFactor === 'tv';
  const keymap = useKeymap();

  const [context, setContext] = useState<RemapContext>('player');
  const [capturingAction, setCapturingAction] = useState<RemapActionMeta | null>(null);
  const [captureWarning, setCaptureWarning] = useState<string | null>(null);

  const actions = useMemo(
    () => REMAPPABLE_ACTIONS.filter((meta) => meta.context === context),
    [context],
  );

  // TV focus coordinates: row 0 = context chips, rows 1..actions.length = action rows (cols 0..2), last row = Reset all
  const [focusRow, setFocusRow] = useState(0);
  const [focusCol, setFocusCol] = useState(0);
  const focusRef = useRef({ row: 0, col: 0 });
  focusRef.current = { row: focusRow, col: focusCol };
  const scrollViewRef = useRef<ComponentRef<typeof ScrollView> | null>(null);
  const listCardYRef = useRef(0);
  const rowYRef = useRef<Record<number, number>>({});
  const footerYRef = useRef<number | null>(null);

  useEffect(() => {
    rowYRef.current = {};
    footerYRef.current = null;
    const maxRow = actions.length + 1;
    if (focusRef.current.row > maxRow) {
      setFocusRow(0);
      setFocusCol(CONTEXTS.indexOf(context));
    }
  }, [actions.length, context]);

  useEffect(() => {
    if (!isTv || !isActiveScope) return;
    const animated = !theme.reduceMotion;
    if (focusRow === 0) {
      scrollViewRef.current?.scrollTo({ y: 0, animated });
      return;
    }
    const resetRow = actions.length + 1;
    if (focusRow === resetRow) {
      const targetY = footerYRef.current ?? actions.length * 68 + 80;
      scrollViewRef.current?.scrollTo({ y: Math.max(0, targetY - 48), animated });
      return;
    }
    const measuredRowY = rowYRef.current[focusRow];
    const targetY =
      measuredRowY !== undefined ? listCardYRef.current + measuredRowY : (focusRow - 1) * 68 + 64;
    scrollViewRef.current?.scrollTo({ y: Math.max(0, targetY - 48), animated });
  }, [actions.length, focusRow, isActiveScope, isTv, theme.reduceMotion]);

  const startCapture = useCallback((meta: RemapActionMeta) => {
    setCaptureWarning(null);
    setCapturingAction(meta);
  }, []);

  const cancelCapture = useCallback(() => {
    setCapturingAction(null);
    setCaptureWarning(null);
  }, []);

  const handleCapturedTrigger = useCallback(
    (trigger: KeyTrigger) => {
      if (capturingAction === null) return;
      if (trigger.key === 'back' && trigger.kind === 'press') {
        cancelCapture();
        return;
      }
      const validation = validateKeyBinding(capturingAction.id, trigger);
      if (!validation.ok) {
        if (validation.reason === 'immutable-nav-key') {
          setCaptureWarning(i18n.t('remote.immutableWarning'));
        }
        return;
      }
      void keymap.rebindAction(capturingAction.id, trigger);
      cancelCapture();
    },
    [cancelCapture, capturingAction, i18n, keymap],
  );

  useEffect(() => {
    if (capturingAction === null || (Platform.OS as string) !== 'web') return;
    interface WebCaptureKeyEvent {
      readonly key?: string;
      readonly repeat?: boolean;
      readonly shiftKey?: boolean;
      readonly preventDefault?: () => void;
      readonly stopImmediatePropagation?: () => void;
    }
    const win = globalThis as {
      addEventListener?: (
        type: string,
        fn: (e: WebCaptureKeyEvent) => void,
        capture?: boolean,
      ) => void;
      removeEventListener?: (
        type: string,
        fn: (e: WebCaptureKeyEvent) => void,
        capture?: boolean,
      ) => void;
    };
    const onKeyDown = (e: WebCaptureKeyEvent) => {
      if (!e.key) return;
      if (e.repeat) {
        e.preventDefault?.();
        e.stopImmediatePropagation?.();
        return;
      }
      const mapped = mapWebKeyToRemoteKey(e.key);
      if (mapped === null) return;
      e.preventDefault?.();
      e.stopImmediatePropagation?.();
      handleCapturedTrigger({ key: mapped, kind: e.shiftKey ? 'long' : 'press' });
    };
    const onKeyUp = (e: WebCaptureKeyEvent) => {
      if (!e.key) return;
      if (mapWebKeyToRemoteKey(e.key) === null) return;
      e.preventDefault?.();
      e.stopImmediatePropagation?.();
    };
    win.addEventListener?.('keydown', onKeyDown, true);
    win.addEventListener?.('keyup', onKeyUp, true);
    return () => {
      win.removeEventListener?.('keydown', onKeyDown, true);
      win.removeEventListener?.('keyup', onKeyUp, true);
    };
  }, [capturingAction, handleCapturedTrigger]);

  const handleTvKey = useCallback(
    (event: KeyEvent): boolean => {
      if (event.kind !== 'press' && event.kind !== 'repeat') return false;
      const { row, col } = focusRef.current;
      const resetRow = actions.length + 1;

      if (event.key === 'back' && event.kind === 'press') {
        onBack?.();
        return true;
      }
      if (event.key === 'up') {
        if (row === 0) {
          onFocusTopNav?.();
          return true;
        }
        const nextRow = row - 1;
        setFocusRow(nextRow);
        if (nextRow === 0) setFocusCol(Math.min(col, CONTEXTS.length - 1));
        return true;
      }
      if (event.key === 'down') {
        const nextRow = Math.min(resetRow, row + 1);
        setFocusRow(nextRow);
        if (nextRow === resetRow) setFocusCol(0);
        else if (row === 0) setFocusCol(0);
        return true;
      }
      if (event.key === 'left') {
        if (col === 0) {
          onBack?.();
          return true;
        }
        setFocusCol(col - 1);
        return true;
      }
      if (event.key === 'right') {
        const maxCol = row === 0 ? CONTEXTS.length - 1 : row === resetRow ? 0 : 2;
        setFocusCol(Math.min(maxCol, col + 1));
        return true;
      }
      if (event.key === 'select' && event.kind === 'press') {
        if (row === 0) {
          const nextCtx = CONTEXTS[col];
          if (nextCtx) setContext(nextCtx);
          return true;
        }
        if (row === resetRow) {
          void keymap.resetAll();
          return true;
        }
        const meta = actions[row - 1];
        if (!meta) return true;
        const btnCol = col as RowButtonCol;
        if (btnCol === 0) startCapture(meta);
        else if (btnCol === 1) void keymap.clearAction(meta.id);
        else void keymap.resetAction(meta.id);
        return true;
      }
      return false;
    },
    [actions, keymap, onBack, onFocusTopNav, startCapture],
  );

  const cursor = webCursorPointer();
  const transition = webTransition(theme, 'background-color, border-color, opacity');
  const activeTv = isTv && isActiveScope && capturingAction === null;
  const resetRowIdx = actions.length + 1;

  return (
    <View testID="settings-panel-remote" style={styles.root}>
      {activeTv ? <RemotePanelTvKeyBridge onEvent={handleTvKey} /> : null}

      <ScrollView
        ref={scrollViewRef}
        testID="remote-keys-scroll"
        {...(isTv ? { focusable: false } : {})}
        style={styles.scroll}
        contentContainerStyle={[styles.content, { gap: theme.spacing.md }]}
      >
        <View style={styles.headerBlock}>
          <Text style={[theme.typography.h2, { color: theme.colors.textPrimary }]}>
            {i18n.t('remote.title')}
          </Text>
          <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
            {i18n.t('remote.subtitle')}
          </Text>
        </View>

        <View testID="remote-context-chips" style={styles.contextRow}>
          {CONTEXTS.map((ctx, idx) => (
            <FilterChip
              key={ctx}
              testID={`remote-context-${ctx}`}
              label={i18n.t(CONTEXT_LABEL_KEYS[ctx])}
              selected={context === ctx}
              focusable={!isTv}
              focused={activeTv && focusRow === 0 && focusCol === idx}
              onPress={() => setContext(ctx)}
            />
          ))}
        </View>

        <Surface
          tone="surface"
          bordered
          rounded="modal"
          style={styles.listCard}
          onLayout={(e) => {
            listCardYRef.current = e.nativeEvent.layout.y;
          }}
        >
          {actions.map((meta, idx) => {
            const trigger = resolveKeyTrigger(keymap.overrides, meta.id);
            const hasOverride = Object.hasOwn(keymap.overrides, meta.id);
            const rowIdx = idx + 1;
            const label = i18n.t(ACTION_LABEL_KEYS[meta.id]);

            return (
              <View
                key={meta.id}
                testID={`remote-action-row-${meta.id}`}
                onLayout={(e) => {
                  rowYRef.current[rowIdx] = e.nativeEvent.layout.y;
                }}
                style={[
                  styles.actionRow,
                  idx > 0
                    ? {
                        borderTopWidth: StyleSheet.hairlineWidth,
                        borderTopColor: theme.colors.surfaceBorder,
                      }
                    : null,
                ]}
              >
                <View style={styles.actionMeta}>
                  <Text
                    numberOfLines={1}
                    style={[theme.typography.body, { color: theme.colors.textPrimary }]}
                  >
                    {label}
                  </Text>
                  <View style={styles.badgeRow}>
                    <MicroPill
                      testID={`remote-binding-${meta.id}`}
                      label={
                        trigger !== null
                          ? formatRemoteKeyLabel(trigger.key)
                          : i18n.t('remote.unbound')
                      }
                      tone={trigger !== null ? (hasOverride ? 'accent' : 'neutral') : 'neutral'}
                    />
                    {trigger?.kind === 'long' ? (
                      <MicroPill
                        testID={`remote-long-badge-${meta.id}`}
                        label={i18n.t('remote.longPressBadge')}
                        tone="accent"
                      />
                    ) : null}
                  </View>
                </View>

                <View style={styles.actionButtons}>
                  <SmallActionBtn
                    testID={`remote-rebind-${meta.id}`}
                    label={i18n.t('remote.rebind')}
                    isTv={isTv}
                    focused={activeTv && focusRow === rowIdx && focusCol === 0}
                    onPress={() => startCapture(meta)}
                  />
                  <SmallActionBtn
                    testID={`remote-clear-${meta.id}`}
                    label={i18n.t('remote.clear')}
                    isTv={isTv}
                    focused={activeTv && focusRow === rowIdx && focusCol === 1}
                    onPress={() => void keymap.clearAction(meta.id)}
                  />
                  <SmallActionBtn
                    testID={`remote-reset-${meta.id}`}
                    label={i18n.t('remote.resetAction')}
                    isTv={isTv}
                    focused={activeTv && focusRow === rowIdx && focusCol === 2}
                    onPress={() => void keymap.resetAction(meta.id)}
                  />
                </View>
              </View>
            );
          })}
        </Surface>

        <View
          style={styles.footerRow}
          onLayout={(e) => {
            footerYRef.current = e.nativeEvent.layout.y;
          }}
        >
          <CtaButton
            testID="remote-reset-all"
            label={i18n.t('remote.resetAll')}
            variant="secondary"
            focusable={!isTv}
            focused={activeTv && focusRow === resetRowIdx}
            onPress={() => void keymap.resetAll()}
          />
        </View>
      </ScrollView>

      {capturingAction !== null ? (
        <View testID="remote-capture-overlay" style={styles.captureRoot}>
          {(Platform.OS as string) !== 'web' ? (
            <CaptureTvKeyInterceptor onTrigger={handleCapturedTrigger} />
          ) : null}
          <Pressable
            testID="remote-capture-backdrop"
            focusable={false}
            accessibilityRole="button"
            accessibilityLabel={i18n.t('remote.captureCancel')}
            onPress={cancelCapture}
            style={[StyleSheet.absoluteFill, { backgroundColor: theme.colors.overlayBackdrop }]}
          />
          <View
            style={[
              styles.captureSheet,
              {
                backgroundColor: theme.colors.bgElevated,
                borderColor: theme.colors.glassBorder,
                borderRadius: theme.radius.modal,
              },
              webBackdropBlur(20),
            ]}
          >
            <Text style={[theme.typography.h2, { color: theme.colors.textPrimary }]}>
              {i18n.t(ACTION_LABEL_KEYS[capturingAction.id])}
            </Text>
            <Text
              testID="remote-capture-prompt"
              style={[theme.typography.body, { color: theme.colors.textSecondary }]}
            >
              {i18n.t('remote.capturePrompt')}
            </Text>
            {captureWarning !== null ? (
              <Text
                testID="remote-immutable-warning"
                style={[theme.typography.caption, { color: theme.colors.liveColor }]}
              >
                {captureWarning}
              </Text>
            ) : null}
            <View style={styles.captureFooter}>
              <Text style={[theme.typography.caption, { color: theme.colors.textMuted }]}>
                {i18n.t('remote.captureCancel')}
              </Text>
              <Pressable
                testID="remote-capture-cancel-btn"
                focusable={!isTv}
                accessibilityRole="button"
                accessibilityLabel={i18n.t('remote.captureCancel')}
                onPress={cancelCapture}
                style={[
                  styles.smallBtn,
                  cursor,
                  transition,
                  {
                    backgroundColor: theme.colors.bgCard,
                    borderColor: theme.colors.surfaceBorder,
                    borderRadius: theme.radius.button,
                  },
                ]}
              >
                <Text style={[theme.typography.caption, { color: theme.colors.textPrimary }]}>
                  {i18n.t('channels.manage.cancel')}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      ) : null}
    </View>
  );
}

function SmallActionBtn({
  testID,
  label,
  isTv,
  focused,
  onPress,
}: {
  readonly testID: string;
  readonly label: string;
  readonly isTv: boolean;
  readonly focused: boolean;
  readonly onPress: () => void;
}): ReactElement {
  const theme = useTheme();
  const cursor = webCursorPointer();
  const transition = webTransition(theme, 'background-color, border-color, opacity');
  return (
    <Pressable
      testID={testID}
      focusable={!isTv}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.smallBtn,
        cursor,
        transition,
        {
          borderRadius: theme.radius.button,
          backgroundColor: focused
            ? theme.colors.focusFill
            : pressed
              ? theme.colors.subtleHighlight
              : theme.colors.bgCard,
          borderWidth: focused ? theme.focus.ringWidth : 1,
          borderColor: focused ? theme.colors.focusRingColor : theme.colors.surfaceBorder,
        },
      ]}
    >
      <Text
        numberOfLines={1}
        style={[
          theme.typography.caption,
          { color: theme.colors.textPrimary, fontWeight: focused ? '700' : '500' },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0, position: 'relative' },
  scroll: { flex: 1, minHeight: 0 },
  content: { paddingBottom: 24 },
  headerBlock: { gap: 4 },
  contextRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  listCard: { paddingHorizontal: 16, paddingVertical: 8 },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 10,
    paddingVertical: 10,
  },
  actionMeta: { flex: 1, minWidth: 160, gap: 4 },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  actionButtons: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  smallBtn: {
    minHeight: 34,
    paddingHorizontal: 10,
    paddingVertical: 6,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  footerRow: { flexDirection: 'row', alignItems: 'center' },
  captureRoot: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 60,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  captureSheet: {
    width: '100%',
    maxWidth: 420,
    borderWidth: 1,
    padding: 20,
    gap: 12,
  },
  captureFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginTop: 4,
  },
});
