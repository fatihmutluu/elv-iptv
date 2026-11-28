import { createAppI18n } from '@elv/i18n';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_PICKED_PLAYLIST_BYTES } from '../../src/shared/sources-ipc.ts';

const state = vi.hoisted(() => ({
  locale: 'en' as 'en' | 'tr',
  preset: 'obsidianCrimson' as 'obsidianCrimson' | 'highContrast',
}));

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Platform: {
    OS: 'web',
    isTV: false,
    select: (map: Record<string, unknown>) => map.web ?? map.default,
  },
  StyleSheet: {
    create: <T,>(styles: T): T => styles,
    flatten: (style: unknown) => style,
    hairlineWidth: 1,
  },
}));

vi.mock('@elv/ui-kit', async () => {
  const { buildTheme } = await import('../../../../packages/ui-kit/src/theme/tokens.ts');
  return {
    useTheme: () => buildTheme({ preset: state.preset }),
    useI18n: () => createAppI18n(state.locale),
    webBackdropBlur: (px: number) => ({ backdropFilter: `blur(${px}px)` }),
  };
});

import {
  attachDesktopM3uDropListeners,
  DesktopM3uDropOverlay,
  findFirstSupportedPlaylistFile,
  hasExternalFileDrag,
  resolveDroppedPlaylistFile,
} from './DesktopM3uDropZone.tsx';

function collectText(node: unknown): string[] {
  if (typeof node === 'string') return [node];
  if (typeof node === 'number') return [String(node)];
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(collectText);
  const el = node as ReactElement<Record<string, unknown>>;
  return collectText(el.props?.children);
}

describe('DesktopM3uDropZone (Wave Q7)', () => {
  beforeEach(() => {
    state.locale = 'en';
    state.preset = 'obsidianCrimson';
  });

  it('activates only for external Files drags and ignores in-app HTML drag-and-drop payloads', () => {
    expect(hasExternalFileDrag({ types: ['Files'] })).toBe(true);
    expect(hasExternalFileDrag({ types: ['text/plain'] })).toBe(false);
    expect(hasExternalFileDrag({ types: ['application/x-elv-library-item'] })).toBe(false);
    expect(hasExternalFileDrag({ types: [] })).toBe(false);
    expect(hasExternalFileDrag(null)).toBe(false);
  });

  it('filters dropped files strictly to .m3u, .m3u8, and .m3u.gz', () => {
    const txt = { name: 'notes.txt', size: 10 } as File;
    const m3u8 = { name: 'Channels.M3U8', size: 50 } as File;
    const gz = { name: 'backup.m3u.gz', size: 80 } as File;

    expect(findFirstSupportedPlaylistFile([txt])).toBeNull();
    expect(findFirstSupportedPlaylistFile([txt, m3u8, gz])).toBe(m3u8);
    expect(findFirstSupportedPlaylistFile([gz])).toBe(gz);
  });

  it('prefers preload readDroppedPlaylistFile without falling back to arrayBuffer when bridge is present', async () => {
    const bytes = new Uint8Array([35, 69, 88, 84]);
    const arrayBuffer = vi.fn(async () => bytes.buffer);
    const file = { name: 'list.m3u', size: bytes.byteLength, arrayBuffer } as unknown as File;

    const readBridge = vi.fn(async () => ({ name: 'list.m3u', bytes }));
    expect(await resolveDroppedPlaylistFile(file, readBridge)).toEqual({
      name: 'list.m3u',
      bytes,
    });
    expect(readBridge).toHaveBeenCalledWith(file);
    expect(arrayBuffer).not.toHaveBeenCalled();

    // If preload bridge rejects/returns null (e.g. symlink blocked by main), never bypass with arrayBuffer!
    const rejectingBridge = vi.fn(async () => null);
    expect(await resolveDroppedPlaylistFile(file, rejectingBridge)).toBeNull();
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('falls back to bounded <= 64 MiB file.arrayBuffer() only when preload bridge is absent', async () => {
    const payload = new Uint8Array([35, 69, 88, 84, 77, 51, 85]);
    const file = {
      name: 'dev-list.m3u',
      size: payload.byteLength,
      arrayBuffer: async () => payload.buffer,
    } as unknown as File;

    const resolved = await resolveDroppedPlaylistFile(file, undefined);
    expect(resolved).not.toBeNull();
    expect(resolved?.name).toBe('dev-list.m3u');
    expect(Array.from(resolved?.bytes ?? [])).toEqual(Array.from(payload));

    const oversized = {
      name: 'huge.m3u',
      size: MAX_PICKED_PLAYLIST_BYTES + 1,
      arrayBuffer: vi.fn(),
    } as unknown as File;
    expect(await resolveDroppedPlaylistFile(oversized, undefined)).toBeNull();
    expect(oversized.arrayBuffer).not.toHaveBeenCalled();

    const empty = {
      name: 'empty.m3u',
      size: 0,
      arrayBuffer: vi.fn(),
    } as unknown as File;
    expect(await resolveDroppedPlaylistFile(empty, undefined)).toBeNull();
  });

  it('renders Cinema Quietude v2 drop overlay styled from theme tokens in EN and TR', () => {
    const enTree = DesktopM3uDropOverlay({ visible: true });
    expect(collectText(enTree)).toEqual([
      'Drop M3U playlist to import',
      'Release to open the playlist in Sources',
      'Supports .m3u, .m3u8, and .m3u.gz up to 64 MiB',
    ]);

    state.locale = 'tr';
    state.preset = 'highContrast';
    const trTree = DesktopM3uDropOverlay({ visible: true });
    expect(collectText(trTree)).toEqual([
      'İçe aktarmak için M3U listesini bırakın',
      'Kaynaklar ekranında açmak için bırakın',
      '64 MiB’a kadar .m3u, .m3u8 ve .m3u.gz dosyalarını destekler',
    ]);

    expect(DesktopM3uDropOverlay({ visible: false })).toBeNull();
  });

  it('tracks nested external dragenter/dragleave, ignores internal HTML drags, and delivers dropped playlists', async () => {
    const listeners = new Map<string, Set<(e: unknown) => void>>();
    const win = {
      addEventListener: (type: string, fn: (e: unknown) => void) => {
        const set = listeners.get(type) ?? new Set();
        set.add(fn);
        listeners.set(type, set);
      },
      removeEventListener: (type: string, fn: (e: unknown) => void) => {
        listeners.get(type)?.delete(fn);
      },
    };
    const emit = (type: string, event: unknown) => {
      for (const fn of [...(listeners.get(type) ?? [])]) fn(event);
    };

    const draggingStates: boolean[] = [];
    const received: unknown[] = [];
    const bytes = new Uint8Array([35, 69, 88, 84]);
    const bridgeReader = vi.fn(async () => ({ name: 'channels.m3u', bytes }));

    const dispose = attachDesktopM3uDropListeners(win, {
      onDraggingChange: (d) => draggingStates.push(d),
      onPlaylistFile: (f) => received.push(f),
      getBridgeReader: () => bridgeReader,
    });

    // In-app drag (text/plain) is never prevented and never opens overlay
    const internalPrevent = vi.fn();
    emit('dragenter', { dataTransfer: { types: ['text/plain'] }, preventDefault: internalPrevent });
    expect(internalPrevent).not.toHaveBeenCalled();
    expect(draggingStates).toEqual([]);

    // External Files drag enters nested elements cleanly
    const enter1 = vi.fn();
    emit('dragenter', { dataTransfer: { types: ['Files'] }, preventDefault: enter1 });
    emit('dragenter', { dataTransfer: { types: ['Files'] }, preventDefault: vi.fn() });
    expect(enter1).toHaveBeenCalledTimes(1);
    expect(draggingStates.at(-1)).toBe(true);

    // Leaving one child keeps overlay visible until depth reaches 0
    emit('dragleave', { dataTransfer: { types: ['Files'] } });
    expect(draggingStates.at(-1)).toBe(true);

    // Dropping a supported M3U file resolves via preload reader and closes overlay
    const dropPrevent = vi.fn();
    const dropStop = vi.fn();
    const droppedFile = { name: 'channels.m3u', size: 4 } as File;
    emit('drop', {
      dataTransfer: { types: ['Files'], files: [droppedFile] },
      preventDefault: dropPrevent,
      stopPropagation: dropStop,
    });
    expect(dropPrevent).toHaveBeenCalledTimes(1);
    expect(dropStop).toHaveBeenCalledTimes(1);
    expect(draggingStates.at(-1)).toBe(false);

    await Promise.resolve();
    await Promise.resolve();
    expect(bridgeReader).toHaveBeenCalledWith(droppedFile);
    expect(received).toEqual([{ name: 'channels.m3u', bytes }]);

    dispose();
    expect(listeners.get('drop')?.size ?? 0).toBe(0);
  });

  it('ignores late async dropped-file resolution after unmount/dispose (MINOR-16)', async () => {
    const listeners = new Map<string, Set<(e: unknown) => void>>();
    const win = {
      addEventListener: (type: string, fn: (e: unknown) => void) => {
        const set = listeners.get(type) ?? new Set();
        set.add(fn);
        listeners.set(type, set);
      },
      removeEventListener: (type: string, fn: (e: unknown) => void) => {
        listeners.get(type)?.delete(fn);
      },
    };

    let resolveRead: ((value: { name: string; bytes: Uint8Array } | null) => void) | undefined;
    const bridgeReader = vi.fn(
      () =>
        new Promise<{ name: string; bytes: Uint8Array } | null>((resolve) => {
          resolveRead = resolve;
        }),
    );
    const onPlaylistFile = vi.fn();
    const dispose = attachDesktopM3uDropListeners(win, {
      onDraggingChange: vi.fn(),
      onPlaylistFile,
      getBridgeReader: () => bridgeReader,
    });

    const droppedFile = { name: 'late.m3u', size: 4 } as File;
    for (const fn of [...(listeners.get('drop') ?? [])]) {
      fn({
        dataTransfer: { types: ['Files'], files: [droppedFile] },
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      });
    }

    // Unmount/dispose BEFORE async preload read resolves
    dispose();
    resolveRead?.({ name: 'late.m3u', bytes: new Uint8Array([35, 69, 88, 84]) });
    await Promise.resolve();
    await Promise.resolve();

    expect(onPlaylistFile).not.toHaveBeenCalled();
  });
});
