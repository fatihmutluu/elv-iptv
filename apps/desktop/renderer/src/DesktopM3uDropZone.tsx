import { useI18n, useTheme, webBackdropBlur } from '@elv/ui-kit';
import { type ReactElement, type ReactNode, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  MAX_PICKED_PLAYLIST_BYTES,
  type PickedPlaylistFile,
} from '../../src/shared/sources-ipc.ts';

const SUPPORTED_PLAYLIST_EXT_RE = /\.(?:m3u\.gz|m3u8?)$/i;

/** Minimal `DataTransfer` shape inspected to distinguish OS file drags from in-app HTML drags. */
export interface DragDataTransferLike {
  readonly types?: ArrayLike<string> | Iterable<string> | null;
  readonly files?: ArrayLike<File> | null;
}

/** Props of {@link DesktopM3uDropZone}. */
export interface DesktopM3uDropZoneProps {
  readonly children: ReactNode;
  readonly onPlaylistFile: (file: PickedPlaylistFile) => void;
  /** Optional override for preload's `window.elv.sources.readDroppedPlaylistFile`. */
  readonly readDroppedPlaylistFile?: (file: File) => Promise<PickedPlaylistFile | null>;
  /** Disables window drop interception while true (e.g. gate or popout mode). */
  readonly disabled?: boolean;
}

/**
 * Returns `true` strictly when `dataTransfer` carries external OS `'Files'` so in-app HTML
 * drag-and-drop (Library folders, channel reorder) is never intercepted.
 */
export function hasExternalFileDrag(
  dataTransfer: DragDataTransferLike | null | undefined,
): boolean {
  if (!dataTransfer?.types) return false;
  return Array.from(dataTransfer.types).includes('Files');
}

/** Returns the first dropped `.m3u`, `.m3u8`, or `.m3u.gz` file from a dropped `FileList`, or `null`. */
export function findFirstSupportedPlaylistFile(
  files: ArrayLike<File> | null | undefined,
): File | null {
  if (!files) return null;
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    if (file && typeof file.name === 'string' && SUPPORTED_PLAYLIST_EXT_RE.test(file.name.trim())) {
      return file;
    }
  }
  return null;
}

/**
 * Resolves a dropped playlist `File` via the sandboxed Electron preload bridge (`webUtils.getPathForFile`
 * + main-process `lstat`/`O_NOFOLLOW` validation). Falls back to bounded `<= 64 MiB` `file.arrayBuffer()`
 * ONLY when no preload bridge is present (plain browser dev mode).
 */
export async function resolveDroppedPlaylistFile(
  file: File,
  preloadReader: ((file: File) => Promise<PickedPlaylistFile | null>) | undefined,
): Promise<PickedPlaylistFile | null> {
  const name = typeof file.name === 'string' ? file.name.trim() : '';
  if (!SUPPORTED_PLAYLIST_EXT_RE.test(name)) return null;

  if (typeof preloadReader === 'function') {
    try {
      return await preloadReader(file);
    } catch {
      return null;
    }
  }

  if (typeof file.size !== 'number' || file.size <= 0 || file.size > MAX_PICKED_PLAYLIST_BYTES) {
    return null;
  }
  if (typeof file.arrayBuffer !== 'function') return null;

  try {
    const buffer = await file.arrayBuffer();
    if (buffer.byteLength <= 0 || buffer.byteLength > MAX_PICKED_PLAYLIST_BYTES) return null;
    return {
      name: name || 'playlist.m3u',
      bytes: new Uint8Array(buffer),
    };
  } catch {
    return null;
  }
}

/** Restrained Cinema Quietude v2 drop overlay styled strictly from active theme tokens. */
export function DesktopM3uDropOverlay({
  visible,
}: {
  readonly visible: boolean;
}): ReactElement | null {
  const theme = useTheme();
  const i18n = useI18n();
  if (!visible) return null;

  return (
    <View
      testID="desktop-m3u-drop-overlay"
      pointerEvents="none"
      accessibilityRole="alert"
      style={[styles.backdrop, { backgroundColor: theme.colors.overlayBackdrop }]}
    >
      <View
        testID="desktop-m3u-drop-card"
        style={[
          styles.card,
          {
            backgroundColor: theme.colors.bgElevated,
            borderColor: theme.colors.accent,
            borderRadius: theme.radius.modal,
            paddingHorizontal: theme.spacing.xl,
            paddingVertical: theme.spacing.lg,
            gap: theme.spacing.xs,
          },
          webBackdropBlur(20),
        ]}
      >
        <View style={[styles.accentRule, { backgroundColor: theme.colors.accent }]} />
        <Text
          testID="desktop-m3u-drop-title"
          style={[theme.typography.h2, styles.centered, { color: theme.colors.textPrimary }]}
        >
          {i18n.t('desktop.dropZone.title')}
        </Text>
        <Text
          testID="desktop-m3u-drop-subtitle"
          style={[theme.typography.body, styles.centered, { color: theme.colors.textSecondary }]}
        >
          {i18n.t('desktop.dropZone.subtitle')}
        </Text>
        <Text
          testID="desktop-m3u-drop-formats"
          style={[
            theme.typography.caption,
            styles.centered,
            {
              color: theme.colors.textMuted,
              marginTop: theme.spacing.xxs,
            },
          ]}
        >
          {i18n.t('desktop.dropZone.formats')}
        </Text>
      </View>
    </View>
  );
}

/** Minimal window event surface required by {@link attachDesktopM3uDropListeners}. */
export interface DesktopDropWindowLike {
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
}

/**
 * Attaches OS-file-only `dragenter`/`dragover`/`dragleave`/`drop`/`blur` listeners to `win` so
 * in-app HTML drag-and-drop interactions are untouched while dropped `.m3u`/`.m3u8`/`.m3u.gz`
 * files resolve cleanly through preload. Returns an idempotent teardown function.
 */
export function attachDesktopM3uDropListeners(
  win: DesktopDropWindowLike,
  handlers: {
    readonly onDraggingChange: (dragging: boolean) => void;
    readonly onPlaylistFile: (file: PickedPlaylistFile) => void;
    readonly getBridgeReader: () =>
      | ((file: File) => Promise<PickedPlaylistFile | null>)
      | undefined;
  },
): () => void {
  let dragDepth = 0;
  let disposed = false;

  const resetDrag = (): void => {
    dragDepth = 0;
    handlers.onDraggingChange(false);
  };

  const onDragEnter = (raw: unknown): void => {
    const e = raw as { dataTransfer?: DragDataTransferLike | null; preventDefault?: () => void };
    if (!hasExternalFileDrag(e?.dataTransfer)) return;
    e.preventDefault?.();
    dragDepth += 1;
    handlers.onDraggingChange(true);
  };

  const onDragOver = (raw: unknown): void => {
    const e = raw as {
      dataTransfer?: (DragDataTransferLike & { dropEffect?: string }) | null;
      preventDefault?: () => void;
    };
    if (!hasExternalFileDrag(e?.dataTransfer)) return;
    e.preventDefault?.();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  };

  const onDragLeave = (raw: unknown): void => {
    const e = raw as { dataTransfer?: DragDataTransferLike | null };
    if (!hasExternalFileDrag(e?.dataTransfer)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      handlers.onDraggingChange(false);
    }
  };

  const onDrop = (raw: unknown): void => {
    const e = raw as {
      dataTransfer?: DragDataTransferLike | null;
      preventDefault?: () => void;
      stopPropagation?: () => void;
    };
    if (!hasExternalFileDrag(e?.dataTransfer)) return;
    e.preventDefault?.();
    e.stopPropagation?.();
    resetDrag();

    const candidate = findFirstSupportedPlaylistFile(e.dataTransfer?.files);
    if (!candidate) return;

    void resolveDroppedPlaylistFile(candidate, handlers.getBridgeReader()).then((picked) => {
      if (!disposed && picked !== null) handlers.onPlaylistFile(picked);
    });
  };

  win.addEventListener('dragenter', onDragEnter);
  win.addEventListener('dragover', onDragOver);
  win.addEventListener('dragleave', onDragLeave);
  win.addEventListener('drop', onDrop);
  win.addEventListener('blur', resetDrag);

  return () => {
    disposed = true;
    resetDrag();
    win.removeEventListener('dragenter', onDragEnter);
    win.removeEventListener('dragover', onDragOver);
    win.removeEventListener('dragleave', onDragLeave);
    win.removeEventListener('drop', onDrop);
    win.removeEventListener('blur', resetDrag);
  };
}

/**
 * Full-window desktop drag-and-drop wrapper accepting OS-dropped `.m3u`, `.m3u8`, and `.m3u.gz`
 * playlists without interfering with in-app HTML drag-and-drop interactions.
 */
export function DesktopM3uDropZone({
  children,
  onPlaylistFile,
  readDroppedPlaylistFile,
  disabled = false,
}: DesktopM3uDropZoneProps): ReactElement {
  const [draggingFiles, setDraggingFiles] = useState(false);
  const onPlaylistFileRef = useRef(onPlaylistFile);
  onPlaylistFileRef.current = onPlaylistFile;
  const readerRef = useRef(readDroppedPlaylistFile);
  readerRef.current = readDroppedPlaylistFile;

  useEffect(() => {
    if (disabled || typeof window === 'undefined') {
      setDraggingFiles(false);
      return;
    }
    return attachDesktopM3uDropListeners(window, {
      onDraggingChange: setDraggingFiles,
      onPlaylistFile: (file) => onPlaylistFileRef.current(file),
      getBridgeReader: () => readerRef.current ?? window.elv?.sources?.readDroppedPlaylistFile,
    });
  }, [disabled]);

  return (
    <View style={styles.root}>
      {children}
      <DesktopM3uDropOverlay visible={draggingFiles} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, position: 'relative' },
  backdrop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 95,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    alignItems: 'center',
  },
  accentRule: {
    width: 32,
    height: 3,
    borderRadius: 2,
    marginBottom: 8,
  },
  centered: {
    textAlign: 'center',
  },
});
