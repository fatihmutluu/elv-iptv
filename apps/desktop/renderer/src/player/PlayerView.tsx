import {
  type ElementRef,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { PresenterKind } from '../../../src/shared/player-ipc.ts';
import { createAreaSender, statusPlacement } from './area.ts';
import type { DesktopEngine } from './desktop-engine.ts';
import { PlayerCanvas } from './PlayerCanvas.tsx';

/** Props of {@link PlayerView}. */
export interface PlayerViewProps {
  engine: DesktopEngine;
  /** One line of status text, shown below the video when the presenter covers the area, else inside it. */
  status: string;
  /** True while the service status is `failed`: the video is hidden so the Retry card shows in the player area. */
  failed?: boolean;
  /** Picture scaling mode (`fit` letterboxed, `fill` cropped to cover, `stretch` fills bounds ignoring aspect). */
  resizeMode?: 'fit' | 'fill' | 'stretch';
}

/**
 * The player area: it paints black (the video window is transparent, so the page shows through whenever mpv's window
 * is absent), mounts `<PlayerCanvas>` when main selects `'canvas'` presentation, reports its layout rect to main by
 * `onLayout` and on window resize, and places the status line.
 */
export function PlayerView({
  engine,
  status,
  failed = false,
  resizeMode,
}: PlayerViewProps): ReactElement {
  const areaRef = useRef<ElementRef<typeof View>>(null);
  const failedRef = useRef(failed);
  failedRef.current = failed;
  const sender = useMemo(() => createAreaSender((area) => engine.setArea(area)), [engine]);
  const [coversArea, setCoversArea] = useState<boolean | undefined>(undefined);
  const [presenterKind, setPresenterKind] = useState<PresenterKind | undefined>(undefined);

  useEffect(
    () =>
      engine.onUi((event) => {
        if (event.type === 'presenter') {
          setCoversArea(event.coversArea);
          setPresenterKind(event.kind);
        }
      }),
    [engine],
  );

  const resizeModeRef = useRef<'fit' | 'fill' | 'stretch'>(resizeMode ?? 'fit');
  resizeModeRef.current = resizeMode ?? 'fit';

  useEffect(() => {
    if (presenterKind !== undefined && presenterKind !== 'canvas') {
      engine.setResizeMode?.(resizeMode ?? 'fit');
    }
  }, [engine, presenterKind, resizeMode]);

  useEffect(() => {
    if (
      presenterKind === undefined ||
      presenterKind === 'canvas' ||
      typeof engine.subscribe !== 'function'
    ) {
      return;
    }
    return engine.subscribe((event) => {
      if (event.type === 'state' && (event.state === 'ready' || event.state === 'playing')) {
        engine.setResizeMode?.(resizeModeRef.current);
      }
    });
  }, [engine, presenterKind]);

  const measure = useCallback((): void => {
    areaRef.current?.measureInWindow((x, y, width, height) => {
      sender.update({ x, y, width, height }, failedRef.current);
    });
  }, [sender]);

  useEffect(() => {
    sender.update(undefined, failed);
  }, [sender, failed]);

  useEffect(() => {
    return () => {
      sender.update(undefined, true);
    };
  }, [sender]);

  useEffect(() => {
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure]);

  const below = statusPlacement(coversArea) === 'below';
  const hasStatus = status.length > 0;
  return (
    <View style={styles.root}>
      <View ref={areaRef} onLayout={measure} style={styles.area} testID="player-area">
        {presenterKind === 'canvas' ? (
          <PlayerCanvas engine={engine} resizeMode={resizeMode} visible={!failed} />
        ) : null}
        {!hasStatus || below ? null : (
          <Text style={[styles.status, styles.inside]} testID="player-status">
            {status}
          </Text>
        )}
      </View>
      {hasStatus && below ? (
        <View style={styles.strip}>
          <Text style={styles.status} testID="player-status">
            {status}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000000' },
  area: { flex: 1, backgroundColor: '#000000', overflow: 'hidden' },
  strip: { paddingHorizontal: 16, paddingVertical: 8, backgroundColor: '#000000' },
  inside: { position: 'absolute', left: 16, bottom: 12 },
  status: { color: '#9aa4b2', fontSize: 16 },
});
