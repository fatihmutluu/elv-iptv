import type { ElvCastMember } from '@elv/data';
import type { KeyEvent } from '@elv/focus-core';
import type { AppI18n } from '@elv/i18n';
import {
  ArtworkImage,
  HorizontalRailScroll,
  Icon,
  MicroPill,
  TvFocusAnchor,
  useKeyInterpreter,
  useTheme,
  useViewport,
  webBackdropBlur,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import {
  type ComponentRef,
  memo,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Pressable, type ScrollView, StyleSheet, Text, View } from 'react-native';
import type { PersonLibraryModalPerson } from '../shared';
import { splitDirectorNames } from '../shared/PersonLibraryModal';

/** Props of {@link PlayerXRayStrip}. */
export interface PlayerXRayStripProps {
  readonly visible: boolean;
  readonly docked: boolean;
  readonly isTv: boolean;
  readonly title: string;
  readonly subtitle?: string | null;
  readonly director: string | null;
  readonly cast: readonly ElvCastMember[];
  readonly i18n: AppI18n;
  readonly onSelectPerson: (person: PersonLibraryModalPerson) => void;
  readonly onTogglePlayPause?: () => void;
  readonly onClose: () => void;
}

const CAST_CHIP_ESTIMATE_WIDTH = 176;

function XRayTvKeyBridge({
  onEvent,
}: {
  readonly onEvent: (event: KeyEvent) => boolean;
}): ReactElement {
  useKeyInterpreter(onEvent);
  return <TvFocusAnchor testID="player-xray-tv-anchor" hasTVPreferredFocus />;
}

/**
 * Quiet Cinema Quietude In-Player X-Ray strip (`#352`):
 * - Docked Desktop mode (`docked: true`): flex-flow surface outside the native child HWND bounds.
 * - Floating mode (`docked: false`): translucent glass overlay anchored bottom-left above the
 *   seekbar without covering center video playback.
 * - 10-ft TV D-pad mode (`isTv: true`): Left/Right traverses director pill(s), cast chips, and
 *   close button; Select activates the focused item; Back dismisses X-Ray without exiting playback.
 */
export const PlayerXRayStrip = memo(function PlayerXRayStripInner({
  visible,
  docked,
  isTv,
  title,
  subtitle,
  director,
  cast,
  i18n,
  onSelectPerson,
  onTogglePlayPause,
  onClose,
}: PlayerXRayStripProps): ReactElement | null {
  const theme = useTheme();
  const viewport = useViewport();

  const directors = useMemo(() => splitDirectorNames(director), [director]);
  const visibleCast = useMemo(() => cast.slice(0, 12), [cast]);
  const totalTvItems = directors.length + visibleCast.length + 1;
  const closeTvIndex = directors.length + visibleCast.length;

  const [tvFocusIndex, setTvFocusIndex] = useState(0);
  const castScrollRef = useRef<ComponentRef<typeof ScrollView> | null>(null);
  const tvFocusRef = useRef(tvFocusIndex);
  tvFocusRef.current = tvFocusIndex;
  const directorsRef = useRef(directors);
  directorsRef.current = directors;
  const visibleCastRef = useRef(visibleCast);
  visibleCastRef.current = visibleCast;
  const onSelectPersonRef = useRef(onSelectPerson);
  onSelectPersonRef.current = onSelectPerson;
  const onTogglePlayPauseRef = useRef(onTogglePlayPause);
  onTogglePlayPauseRef.current = onTogglePlayPause;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (visible) {
      setTvFocusIndex(0);
    }
  }, [visible]);

  useEffect(() => {
    if (tvFocusIndex >= totalTvItems) {
      setTvFocusIndex(Math.max(0, totalTvItems - 1));
    }
  }, [totalTvItems, tvFocusIndex]);

  useEffect(() => {
    if (!visible || !isTv) return;
    const castIdx = tvFocusIndex - directors.length;
    if (castIdx >= 0 && castIdx < visibleCast.length) {
      const x = Math.max(0, castIdx * CAST_CHIP_ESTIMATE_WIDTH - 48);
      castScrollRef.current?.scrollTo({ x, animated: !theme.reduceMotion });
    }
  }, [directors.length, isTv, theme.reduceMotion, tvFocusIndex, visible, visibleCast.length]);

  const handleTvKey = useCallback((event: KeyEvent): boolean => {
    if (event.kind !== 'press' && event.kind !== 'repeat') return false;
    if (event.key === 'back') {
      if (event.kind === 'press') onCloseRef.current();
      return true;
    }
    if (event.kind === 'press' && event.key === 'playPause') {
      onTogglePlayPauseRef.current?.();
      return true;
    }
    const dirs = directorsRef.current;
    const castList = visibleCastRef.current;
    const maxIdx = dirs.length + castList.length;
    if (event.key === 'right') {
      setTvFocusIndex((idx) => Math.min(maxIdx, idx + 1));
      return true;
    }
    if (event.key === 'left') {
      setTvFocusIndex((idx) => Math.max(0, idx - 1));
      return true;
    }
    if (event.kind === 'press' && event.key === 'select') {
      const cur = tvFocusRef.current;
      if (cur < dirs.length) {
        const dirName = dirs[cur];
        if (dirName) onSelectPersonRef.current({ name: dirName });
      } else if (cur < dirs.length + castList.length) {
        const member = castList[cur - dirs.length];
        if (member) {
          onSelectPersonRef.current({
            ...(member.personId ? { personId: member.personId } : {}),
            name: member.name,
            ...(member.portraitUrl ? { portraitUrl: member.portraitUrl } : {}),
          });
        }
      } else {
        onCloseRef.current();
      }
      return true;
    }
    return true;
  }, []);

  if (!visible) return null;

  const cursor = webCursorPointer();
  const transition = webTransition(theme, 'background-color, opacity, transform');
  const hasDirector = directors.length > 0;
  const hasCast = visibleCast.length > 0;
  const episodeDisplay = subtitle?.trim() ? `${title} · ${subtitle.trim()}` : title;
  const viewLibraryHint = i18n.t('player.xray.viewLibrary');
  const closeFocused = isTv && tvFocusIndex === closeTvIndex;

  const content = (
    <View
      testID="player-xray-strip"
      style={[
        docked ? styles.dockedStrip : styles.floatingStrip,
        !docked && webBackdropBlur(16),
        {
          backgroundColor: docked ? theme.colors.bgElevated : theme.colors.glassBg,
          borderColor: docked ? theme.colors.surfaceBorder : theme.colors.glassBorder,
          borderRadius: docked ? 0 : theme.radius.card,
          ...(docked ? { borderTopWidth: 1 } : { borderWidth: 1 }),
        },
      ]}
    >
      {isTv ? <XRayTvKeyBridge onEvent={handleTvKey} /> : null}
      <View style={styles.headerRow}>
        <View style={styles.headerLeft}>
          <MicroPill label={i18n.t('player.xray.title')} tone="accent" />
          <Text
            testID="player-xray-episode"
            numberOfLines={1}
            style={[theme.typography.caption, { color: theme.colors.textSecondary, flexShrink: 1 }]}
          >
            {`${i18n.t('player.xray.episode')}: ${episodeDisplay}`}
          </Text>
        </View>

        <View style={styles.headerRight}>
          {directors.map((dirName, dirIdx) => {
            const focused = isTv && tvFocusIndex === dirIdx;
            const testId = dirIdx === 0 ? 'player-xray-director' : `player-xray-director-${dirIdx}`;
            return (
              <Pressable
                key={dirName}
                testID={testId}
                accessibilityRole="button"
                accessibilityLabel={`${i18n.t('player.xray.director')}: ${dirName}`}
                accessibilityHint={viewLibraryHint}
                focusable={!isTv}
                onPress={() => onSelectPerson({ name: dirName })}
                style={({ pressed }) => [
                  styles.directorChip,
                  cursor,
                  transition,
                  {
                    borderRadius: theme.radius.pill,
                    backgroundColor: focused ? theme.colors.focusFill : theme.colors.actionGlassBg,
                    borderColor: focused
                      ? theme.colors.focusRingColor
                      : theme.colors.actionGlassBorder,
                    borderWidth: focused ? theme.focus.ringWidth : 1,
                    opacity: pressed ? 0.8 : 1,
                  },
                ]}
              >
                <Text
                  numberOfLines={1}
                  style={[theme.typography.caption, { color: theme.colors.textMuted }]}
                >
                  {`${i18n.t('player.xray.director')}: `}
                  <Text style={{ color: theme.colors.textPrimary, fontWeight: '600' }}>
                    {dirName}
                  </Text>
                </Text>
              </Pressable>
            );
          })}

          <Pressable
            testID="player-xray-close"
            accessibilityRole="button"
            accessibilityLabel={i18n.t('person.close')}
            focusable={!isTv}
            onPress={onClose}
            style={({ pressed }) => [
              styles.closeBtn,
              cursor,
              transition,
              {
                borderRadius: theme.radius.pill,
                backgroundColor: closeFocused ? theme.colors.focusFill : theme.colors.actionGlassBg,
                borderColor: closeFocused ? theme.colors.focusRingColor : 'transparent',
                borderWidth: closeFocused ? theme.focus.ringWidth : 0,
                opacity: pressed ? 0.78 : 1,
              },
            ]}
          >
            <Icon name="close" size={14} color={theme.colors.textPrimary} />
          </Pressable>
        </View>
      </View>

      {hasCast ? (
        <View style={styles.castSection}>
          <Text style={[theme.typography.micro, { color: theme.colors.textMuted }]}>
            {`${i18n.t('player.xray.cast')} · ${viewLibraryHint}`}
          </Text>
          <HorizontalRailScroll
            scrollRef={castScrollRef}
            testID="player-xray-cast-scroll"
            isTv={isTv}
            showArrows={!isTv}
            contentContainerStyle={styles.castStrip}
          >
            {visibleCast.map((member, idx) => {
              const focused = isTv && tvFocusIndex === directors.length + idx;
              return (
                <Pressable
                  key={member.personId ?? `${member.name}:${member.character ?? ''}`}
                  testID={`player-xray-cast-${idx}`}
                  accessibilityRole="button"
                  accessibilityLabel={member.name}
                  accessibilityHint={viewLibraryHint}
                  focusable={!isTv}
                  onPress={() =>
                    onSelectPerson({
                      ...(member.personId ? { personId: member.personId } : {}),
                      name: member.name,
                      ...(member.portraitUrl ? { portraitUrl: member.portraitUrl } : {}),
                    })
                  }
                  style={({ pressed }) => [
                    styles.castChip,
                    cursor,
                    transition,
                    {
                      borderRadius: theme.radius.pill,
                      backgroundColor: focused
                        ? theme.colors.focusFill
                        : theme.colors.actionGlassBg,
                      borderColor: focused
                        ? theme.colors.focusRingColor
                        : theme.colors.actionGlassBorder,
                      borderWidth: focused ? theme.focus.ringWidth : 1,
                      opacity: pressed ? 0.8 : 1,
                    },
                  ]}
                >
                  <ArtworkImage
                    uri={member.portraitUrl ?? null}
                    label={member.name}
                    aspectRatio={1}
                    maxDecodePx={80}
                    borderRadius={theme.radius.pill}
                    style={styles.castAvatar}
                  />
                  <View style={styles.castText}>
                    <Text
                      numberOfLines={1}
                      style={[
                        theme.typography.caption,
                        { color: theme.colors.textPrimary, fontWeight: '600' },
                      ]}
                    >
                      {member.name}
                    </Text>
                    {member.character ? (
                      <Text
                        numberOfLines={1}
                        style={[theme.typography.micro, { color: theme.colors.textMuted }]}
                      >
                        {member.character}
                      </Text>
                    ) : null}
                  </View>
                </Pressable>
              );
            })}
          </HorizontalRailScroll>
        </View>
      ) : !hasDirector ? (
        <Text
          testID="player-xray-empty"
          style={[theme.typography.caption, { color: theme.colors.textMuted }]}
        >
          {i18n.t('player.xray.empty')}
        </Text>
      ) : null}
    </View>
  );

  if (docked) {
    return (
      <View testID="player-xray-strip-docked" style={styles.dockedWrap}>
        {content}
      </View>
    );
  }

  const leftPad = (isTv ? 48 : 24) + viewport.safeArea.left + viewport.overscan.x;
  const rightPad = (isTv ? 48 : 24) + viewport.safeArea.right + viewport.overscan.x;
  const bottomOffset = (isTv ? 148 : 128) + viewport.safeArea.bottom + viewport.overscan.y;

  return (
    <View
      testID="player-xray-strip-floating"
      pointerEvents="box-none"
      style={[styles.floatingWrap, { left: leftPad, right: rightPad, bottom: bottomOffset }]}
    >
      {content}
    </View>
  );
});

PlayerXRayStrip.displayName = 'PlayerXRayStrip';

const styles = StyleSheet.create({
  dockedWrap: {
    width: '100%',
    flexShrink: 0,
  },
  dockedStrip: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    gap: 8,
  },
  floatingWrap: {
    position: 'absolute',
    zIndex: 18,
    alignItems: 'flex-start',
  },
  floatingStrip: {
    maxWidth: 760,
    width: '100%',
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 8,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    flexWrap: 'wrap',
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
    minWidth: 0,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexShrink: 0,
  },
  directorChip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderWidth: 1,
    maxWidth: 240,
  },
  closeBtn: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  castSection: {
    gap: 4,
  },
  castStrip: {
    alignItems: 'center',
    gap: 8,
    paddingVertical: 2,
  },
  castChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 4,
    paddingRight: 12,
    paddingVertical: 4,
    borderWidth: 1,
    maxWidth: 210,
  },
  castAvatar: {
    width: 30,
    height: 30,
    flexShrink: 0,
  },
  castText: {
    minWidth: 0,
    flexShrink: 1,
  },
});
