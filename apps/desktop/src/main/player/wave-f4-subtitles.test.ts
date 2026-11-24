import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import {
  createServer,
  type IncomingHttpHeaders,
  type RequestListener,
  type Server,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SUBTITLE_STYLE, type SubtitleStyleConfig } from '@elv/domain';
import type { EngineEvent, ExternalSubtitleTrack, MediaTracks } from '@elv/playback';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPlayerBridge, type IpcRendererLike } from '../../preload/player-bridge.ts';
import {
  DESKTOP_CAPABILITIES,
  isPlayerCommandMessage,
  PLAYER_CHANNELS,
} from '../../shared/player-ipc.ts';
import { createMpvEngine, type MpvEngine, type MpvEngineDeps } from './engine.ts';
import { type IpcMainLike, registerPlayerIpc, type WebContentsLike } from './ipc.ts';
import type { MpvClient } from './mpv/client.ts';
import { createFakeMpv, type FakeMpv, type FakeMpvScript } from './mpv/fake-mpv.ts';
import { LAUNCH_OPTIONS, loadfileCommand } from './mpv/options.ts';
import { subtitleStyleCommands, subtitleStyleLoadOptions } from './mpv/subtitle-style.ts';
import { inspectMpvTracks } from './mpv/track-snapshot.ts';
import type { VideoPresenter } from './presenter/types.ts';
import {
  ALLOWED_SUBTITLE_EXTENSIONS,
  createSubtitleFetchSession,
  createSubtitleFilePicker,
  validateLocalSubtitlePath,
} from './subtitle-fetch.ts';

const URL_STREAM = 'http://sim.test/movie/demo/demo/1001.mkv';
const URL_NEXT = 'http://sim.test/movie/demo/demo/1002.mkv';

const DUAL_SUB_SCRIPT: FakeMpvScript = [
  { afterMs: 0, event: 'start-file' },
  {
    afterMs: 2,
    property: 'track-list',
    value: [
      { id: 1, type: 'video', codec: 'h264', selected: true },
      { id: 1, type: 'audio', lang: 'eng', title: 'English', codec: 'aac', selected: true },
      { id: 1, type: 'sub', lang: 'eng', title: 'English', codec: 'subrip', selected: true },
      { id: 2, type: 'sub', lang: 'tur', title: 'Turkish', codec: 'subrip', selected: false },
      {
        id: 3,
        type: 'sub',
        lang: 'deu',
        title: 'German Ext',
        codec: 'subrip',
        external: true,
        selected: false,
      },
    ],
  },
  { afterMs: 2, property: 'aid', value: 1 },
  { afterMs: 2, property: 'sid', value: 1 },
  { afterMs: 2, property: 'secondary-sid', value: 'no' },
  { afterMs: 4, event: 'file-loaded' },
  { afterMs: 5, property: 'video-params', value: { w: 1280, h: 720 } },
  { afterMs: 8, property: 'time-pos', value: 1.0 },
  { afterMs: 8, event: 'playback-restart' },
];

const timers: MpvEngineDeps['timers'] = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

function stubPresenter(onAttach?: (client: MpvClient) => void): VideoPresenter {
  return {
    kind: 'canvas',
    coversArea: false,
    prepare: async () => [],
    attach: (c) => onAttach?.(c),
    setArea: () => undefined,
    toggleFullscreen: () => undefined,
    onEvent: () => () => undefined,
    dispose: () => undefined,
  };
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startHttpServer(
  handler: RequestListener,
): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

function makeTempDir(prefix: string): string {
  const dir = join(
    realpathSync(tmpdir()),
    `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const latestTracks = (events: readonly EngineEvent[]): MediaTracks | undefined => {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i];
    if (ev?.type === 'tracks') return ev.tracks;
  }
  return undefined;
};

async function setupEngine(
  scripts: Record<string, FakeMpvScript> = { [URL_STREAM]: DUAL_SUB_SCRIPT },
) {
  const fake: FakeMpv = createFakeMpv({ scripts, transport: 'socket' });
  let client: MpvClient | undefined;
  const engine = createMpvEngine({
    spawn: (args, signal) => fake.spawn(args, signal),
    presenter: stubPresenter((c) => {
      client = c;
    }),
    baseArgs: LAUNCH_OPTIONS,
    loadMode: 'replace',
    now: () => Date.now(),
    timers,
    onUi: () => undefined,
  });
  const events: EngineEvent[] = [];
  engine.subscribe((e) => events.push(e));
  cleanups.push(async () => {
    engine.release();
    await fake.dispose();
  });
  await vi.waitFor(() => {
    expect(fake.sent).toContainEqual(['request_log_messages', 'v']);
    expect(client).toBeDefined();
  });
  return { fake, engine, events, getClient: () => client };
}

describe('#308 Isolated external subtitle fetcher & local file validation', () => {
  it('fetches HTTP subtitles via isolated client without stream credentials, strips auth/cookie on cross-origin redirect, caps at 4 MiB, and cleans up temp dirs', async () => {
    const targetHeaders: IncomingHttpHeaders[] = [];
    const target = await startHttpServer((req, res) => {
      targetHeaders.push({ ...req.headers });
      res.writeHead(200, { 'Content-Type': 'application/x-subrip' });
      res.end('1\n00:00:01,000 --> 00:00:03,000\nHello isolated world\n');
    });

    const originHeaders: IncomingHttpHeaders[] = [];
    const origin = await startHttpServer((req, res) => {
      originHeaders.push({ ...req.headers });
      if (req.url === '/redirect.srt') {
        res.writeHead(302, { Location: `${target.baseUrl}/final.srt` });
        res.end();
        return;
      }
      if (req.url === '/oversize.srt') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(Buffer.alloc(4 * 1024 * 1024 + 64, 0x41));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/vtt' });
      res.end('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nDirect\n');
    });

    const tempRoot = makeTempDir('elv-sub-fetch-test');
    const session = createSubtitleFetchSession({ tempRoot });
    cleanups.push(() => session.cleanup());

    // 1. Direct fetch carries ONLY declared subtitle headers (no ambient/stream headers)
    const directPath = await session.resolveTrack({
      id: 'sub-1',
      uri: `${origin.baseUrl}/direct.vtt`,
      headers: { 'X-Sub-Token': 'sub-only' },
    });
    expect(directPath.startsWith(tempRoot)).toBe(true);
    expect(directPath.endsWith('.vtt')).toBe(true);
    expect(existsSync(directPath)).toBe(true);
    expect(originHeaders[0]?.['x-sub-token']).toBe('sub-only');
    expect(originHeaders[0]?.authorization).toBeUndefined();
    expect(originHeaders[0]?.cookie).toBeUndefined();

    // 2. Cross-origin redirect strips Authorization, Cookie, X-Api-Key, X-Auth-Token while preserving non-auth headers
    const redirectedPath = await session.resolveTrack({
      id: 'sub-2',
      uri: `${origin.baseUrl}/redirect.srt`,
      headers: {
        Authorization: 'Bearer sub-secret',
        Cookie: 'sub_sid=abc',
        'X-Api-Key': 'api-secret',
        'X-Auth-Token': 'auth-secret',
        'X-Sub-Trace': 'keep-me',
      },
    });
    expect(existsSync(redirectedPath)).toBe(true);
    expect(originHeaders[1]?.authorization).toBe('Bearer sub-secret');
    expect(originHeaders[1]?.cookie).toBe('sub_sid=abc');
    expect(originHeaders[1]?.['x-api-key']).toBe('api-secret');
    expect(originHeaders[1]?.['x-auth-token']).toBe('auth-secret');
    expect(targetHeaders[0]?.authorization).toBeUndefined();
    expect(targetHeaders[0]?.cookie).toBeUndefined();
    expect(targetHeaders[0]?.['x-api-key']).toBeUndefined();
    expect(targetHeaders[0]?.['x-auth-token']).toBeUndefined();
    expect(targetHeaders[0]?.['x-sub-trace']).toBe('keep-me');

    // 3. Responses exceeding 4 MiB are rejected
    await expect(
      session.resolveTrack({
        id: 'sub-big',
        uri: `${origin.baseUrl}/oversize.srt`,
      }),
    ).rejects.toThrow(/size|limit|large/i);

    // 4. cleanup() synchronously removes the session temp directory
    session.cleanup();
    expect(existsSync(directPath)).toBe(false);
    expect(existsSync(redirectedPath)).toBe(false);
  });

  it('validates local file:// subtitles against extension allowlist, regular file stat, and 16 MiB cap without deleting user files on cleanup', async () => {
    const dir = makeTempDir('elv-local-sub-test');
    const validSrt = join(dir, 'movie.srt');
    writeFileSync(validSrt, '1\n00:00:00,000 --> 00:00:02,000\nLocal cue\n');
    const badExt = join(dir, 'notes.txt');
    writeFileSync(badExt, 'not a subtitle');
    const subDir = join(dir, 'folder.srt');
    mkdirSync(subDir);

    const session = createSubtitleFetchSession();
    const resolved = await session.resolveTrack({
      id: 'local-1',
      uri: pathToFileURL(validSrt).href,
    });
    expect(resolved).toBe(validSrt);

    await expect(validateLocalSubtitlePath(pathToFileURL(badExt).href)).rejects.toThrow(
      /extension/i,
    );
    await expect(validateLocalSubtitlePath(pathToFileURL(subDir).href)).rejects.toThrow(/file/i);
    await expect(validateLocalSubtitlePath('ftp://example.test/a.srt')).rejects.toThrow(/scheme/i);
    await expect(validateLocalSubtitlePath(pathToFileURL(validSrt).href, 8)).rejects.toThrow(
      /size|limit/i,
    );
    // Reject symlinks whose realpath target violates the subtitle extension allowlist (#308)
    await expect(
      validateLocalSubtitlePath(pathToFileURL(validSrt).href, undefined, {
        realpath: async () => badExt,
        lstat: async () => ({ isFile: () => true, size: 16 }),
      }),
    ).rejects.toThrow(/extension/i);
    const evilLink = join(dir, 'evil-link.srt');
    let symlinkCreated = false;
    try {
      symlinkSync(badExt, evilLink, 'file');
      symlinkCreated = true;
    } catch {
      // OS lacks unprivileged symlink permission (e.g. Windows without Developer Mode)
    }
    if (symlinkCreated) {
      await expect(validateLocalSubtitlePath(pathToFileURL(evilLink).href)).rejects.toThrow(
        /extension/i,
      );
    }

    // cleanup() MUST NEVER delete user's own local subtitle file
    session.cleanup();
    expect(existsSync(validSrt)).toBe(true);
  });

  it('never leaks primary stream Authorization/Cookie to external subtitle fetches and cleans up temp files on stop() and release()', async () => {
    const seenSubHeaders: IncomingHttpHeaders[] = [];
    const subServer = await startHttpServer((req, res) => {
      seenSubHeaders.push({ ...req.headers });
      res.writeHead(200, { 'Content-Type': 'application/x-subrip' });
      res.end('1\n00:00:01,000 --> 00:00:02,000\nHi\n');
    });

    const { fake, engine, events } = await setupEngine({
      [URL_STREAM]: DUAL_SUB_SCRIPT,
      [URL_NEXT]: DUAL_SUB_SCRIPT,
    });

    engine.load({
      attempt: 1,
      url: URL_STREAM,
      headers: {
        Authorization: 'Bearer stream-secret-token',
        Cookie: 'session=topsecret',
        'X-Stream-Only': 'do-not-leak',
      },
      kind: 'vod',
    });

    await vi.waitFor(() =>
      expect(
        events.some((e) => e.attempt === 1 && e.type === 'state' && e.state === 'playing'),
      ).toBe(true),
    );

    engine.addExternalSubtitle?.(1, {
      id: 'ext-1',
      uri: `${subServer.baseUrl}/en.srt`,
      label: 'English External',
      language: 'en',
    });

    let addedLocalPath = '';
    await vi.waitFor(() => {
      const subAdd = fake.sent.find((cmd) => cmd[0] === 'sub-add');
      expect(subAdd).toBeDefined();
      addedLocalPath = String(subAdd?.[1] ?? '');
      expect(addedLocalPath).not.toMatch(/^https?:/i);
      expect(subAdd).toEqual(['sub-add', addedLocalPath, 'select', 'English External', 'en']);
    });

    // Primary stream credentials NEVER appeared on the external subtitle request
    expect(seenSubHeaders).toHaveLength(1);
    expect(seenSubHeaders[0]?.authorization).toBeUndefined();
    expect(seenSubHeaders[0]?.cookie).toBeUndefined();
    expect(seenSubHeaders[0]?.['x-stream-only']).toBeUndefined();
    expect(existsSync(addedLocalPath)).toBe(true);

    // Stale attempt is ignored
    const subAddCountBeforeStale = fake.sent.filter((c) => c[0] === 'sub-add').length;
    engine.load({ attempt: 5, url: URL_NEXT, headers: {}, kind: 'vod' });
    await vi.waitFor(() =>
      expect(
        events.some((e) => e.attempt === 5 && e.type === 'state' && e.state === 'playing'),
      ).toBe(true),
    );
    // Previous media's temp file was cleaned up on load()
    expect(existsSync(addedLocalPath)).toBe(false);

    engine.addExternalSubtitle?.(4, {
      id: 'stale-sub',
      uri: `${subServer.baseUrl}/stale.srt`,
      label: 'Stale',
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(fake.sent.filter((c) => c[0] === 'sub-add').length).toBe(subAddCountBeforeStale);

    // Add another external subtitle and verify stop() cleans up its temp file
    engine.addExternalSubtitle?.(5, {
      id: 'ext-2',
      uri: `${subServer.baseUrl}/tr.srt`,
      label: 'Turkish External',
      language: 'tr',
    });
    let secondTempPath = '';
    await vi.waitFor(() => {
      const subAdds = fake.sent.filter((cmd) => cmd[0] === 'sub-add');
      expect(subAdds.length).toBeGreaterThan(subAddCountBeforeStale);
      secondTempPath = String(subAdds.at(-1)?.[1] ?? '');
    });
    expect(existsSync(secondTempPath)).toBe(true);
    engine.stop(6);
    expect(existsSync(secondTempPath)).toBe(false);
  });
});

describe('#32 Live subtitle styling & sandboxed native file picker', () => {
  it('maps SubtitleStyleConfig to exact mpv loadfile options and live set_property commands', () => {
    const custom: SubtitleStyleConfig = {
      fontSize: 'extraLarge',
      textColor: 'yellow',
      backgroundColor: 'opaque',
      edgeStyle: 'dropShadow',
      verticalPosition: 'top',
    };
    expect(subtitleStyleLoadOptions(custom)).toEqual({
      'sub-scale': '1.55',
      'sub-color': '#FFFFE066',
      'sub-back-color': '#F2000000',
      'sub-border-size': '1',
      'sub-shadow-offset': '2.5',
      'sub-pos': '12',
    });
    expect(subtitleStyleCommands(custom)).toEqual([
      ['set_property', 'sub-scale', 1.55],
      ['set_property', 'sub-color', '#FFFFE066'],
      ['set_property', 'sub-back-color', '#F2000000'],
      ['set_property', 'sub-border-size', 1],
      ['set_property', 'sub-shadow-offset', 2.5],
      ['set_property', 'sub-pos', 12],
    ]);

    expect(subtitleStyleLoadOptions(DEFAULT_SUBTITLE_STYLE)).toEqual({
      'sub-scale': '1',
      'sub-color': '#FFFFFFFF',
      'sub-back-color': '#B8000000',
      'sub-border-size': '2.5',
      'sub-shadow-offset': '0',
      'sub-pos': '96',
    });
  });

  it('applies subtitleStyle on loadfile AND updates live via set_property without restarting playback', async () => {
    const { fake, engine, events } = await setupEngine();
    const initialStyle: SubtitleStyleConfig = {
      fontSize: 'large',
      textColor: 'cyan',
      backgroundColor: 'none',
      edgeStyle: 'none',
      verticalPosition: 'raised',
    };
    engine.load({
      attempt: 1,
      url: URL_STREAM,
      headers: {},
      kind: 'vod',
      options: { subtitleStyle: initialStyle },
    });

    await vi.waitFor(() =>
      expect(
        events.some((e) => e.attempt === 1 && e.type === 'state' && e.state === 'playing'),
      ).toBe(true),
    );

    const loadCmd = fake.sent.find((c) => c[0] === 'loadfile');
    expect(loadCmd?.[4]).toMatchObject({
      'secondary-sub-pos': '10',
      'sub-scale': '1.25',
      'sub-color': '#FF66F0FF',
      'sub-back-color': '#00000000',
      'sub-border-size': '0',
      'sub-shadow-offset': '0',
      'sub-pos': '84',
    });

    const loadCountBefore = fake.sent.filter((c) => c[0] === 'loadfile').length;
    const liveStyle: SubtitleStyleConfig = {
      fontSize: 'small',
      textColor: 'green',
      backgroundColor: 'opaque',
      edgeStyle: 'outline',
      verticalPosition: 'bottom',
    };
    engine.setSubtitleStyle?.(liveStyle);

    await vi.waitFor(() => {
      expect(fake.sent).toContainEqual(['set_property', 'sub-scale', 0.78]);
      expect(fake.sent).toContainEqual(['set_property', 'sub-color', '#FF80FF99']);
      expect(fake.sent).toContainEqual(['set_property', 'sub-back-color', '#F2000000']);
      expect(fake.sent).toContainEqual(['set_property', 'sub-border-size', 2.5]);
      expect(fake.sent).toContainEqual(['set_property', 'sub-shadow-offset', 0]);
      expect(fake.sent).toContainEqual(['set_property', 'sub-pos', 96]);
    });
    // Zero playback restart on live style update
    expect(fake.sent.filter((c) => c[0] === 'loadfile').length).toBe(loadCountBefore);
  });

  it('validates addExternalSubtitle and setSubtitleStyle IPC guards strictly with hasOnlyKeys and exposes pickSubtitleFile over preload/IPC', async () => {
    const validTrack: ExternalSubtitleTrack = {
      id: 'ext-1',
      uri: 'https://subs.example.test/en.vtt',
      label: 'English',
      language: 'en',
      mimeType: 'text/vtt',
      headers: { 'X-Sub': '1' },
    };
    const msg = (command: unknown) => ({ engineId: 'e1', command });
    const addExt = (track: unknown, extra?: object) =>
      msg({ name: 'addExternalSubtitle', attempt: 1, track, ...extra });
    const styleCmd = (style: unknown, extra?: object) =>
      msg({ name: 'setSubtitleStyle', style, ...extra });
    expect(isPlayerCommandMessage(addExt(validTrack))).toBe(true);
    expect(isPlayerCommandMessage(styleCmd(DEFAULT_SUBTITLE_STYLE))).toBe(true);

    // Reject extra keys, bad schemes, control chars, invalid style values
    const invalidMessages: unknown[] = [
      addExt(validTrack, { extra: true }),
      addExt({ ...validTrack, unexpected: 'x' }),
      addExt({ ...validTrack, uri: 'javascript:alert(1)' }),
      addExt({ ...validTrack, label: 'Bad\nLabel' }),
      styleCmd({ ...DEFAULT_SUBTITLE_STYLE, extra: 1 }),
      styleCmd({ ...DEFAULT_SUBTITLE_STYLE, fontSize: 'huge' }),
      styleCmd(DEFAULT_SUBTITLE_STYLE, { extra: 'nope' }),
    ];
    for (const bad of invalidMessages) expect(isPlayerCommandMessage(bad)).toBe(false);

    // Sandboxed dialog picker test
    const dir = makeTempDir('elv-picker-test');
    const subFile = join(dir, 'episode.ass');
    writeFileSync(subFile, '[Script Info]\nTitle: Test\n');
    const showOpenDialog = vi.fn(async () => ({ canceled: false, filePaths: [subFile] }));
    const pick = createSubtitleFilePicker({
      getWindowFromSender: () => 'win-1',
      showOpenDialog,
    });

    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const listeners = new Map<string, (...args: unknown[]) => unknown>();
    const ipcMain: IpcMainLike = {
      handle: (ch, fn) => void handlers.set(ch, fn as (...args: unknown[]) => unknown),
      on: (ch, fn) => void listeners.set(ch, fn as (...args: unknown[]) => unknown),
      removeHandler: (ch) => void handlers.delete(ch),
      removeListener: (ch) => void listeners.delete(ch),
    };
    const owner: WebContentsLike = {
      id: 1,
      isDestroyed: () => false,
      send: () => undefined,
      once: () => undefined,
      on: () => undefined,
    };
    const calls: unknown[][] = [];
    const stubEngine = {
      start: () => undefined,
      release: () => undefined,
      subscribe: () => () => undefined,
      addExternalSubtitle: (a: number, t: ExternalSubtitleTrack) =>
        calls.push(['addExternalSubtitle', a, t]),
      setSubtitleStyle: (s: SubtitleStyleConfig) => calls.push(['setSubtitleStyle', s]),
    } as unknown as MpvEngine;

    const dispose = registerPlayerIpc({
      ipcMain,
      createEngine: async () => stubEngine,
      now: () => 0,
      log: () => undefined,
      pickSubtitleFile: pick,
    });
    cleanups.push(dispose);

    const openFn = handlers.get(PLAYER_CHANNELS.open);
    if (!openFn) throw new Error('expected open handler');
    const { engineId } = (await openFn({ sender: owner })) as { engineId: string };
    const cmdFn = listeners.get(PLAYER_CHANNELS.command);
    cmdFn?.(
      { sender: owner },
      { engineId, command: { name: 'addExternalSubtitle', attempt: 1, track: validTrack } },
    );
    cmdFn?.(
      { sender: owner },
      { engineId, command: { name: 'setSubtitleStyle', style: DEFAULT_SUBTITLE_STYLE } },
    );
    expect(calls).toEqual([
      ['addExternalSubtitle', 1, validTrack],
      ['setSubtitleStyle', DEFAULT_SUBTITLE_STYLE],
    ]);

    const pickHandler = handlers.get(PLAYER_CHANNELS.pickSubtitleFile);
    expect(pickHandler).toBeDefined();
    const picked = (await pickHandler?.({ sender: owner })) as ExternalSubtitleTrack | null;
    expect(picked).not.toBeNull();
    expect(picked?.uri).toBe(pathToFileURL(subFile).href);
    expect(picked?.label).toBe('episode.ass');
    expect(picked?.mimeType).toBe('text/x-ssa');
    expect(showOpenDialog).toHaveBeenCalledWith('win-1', {
      properties: ['openFile'],
      filters: [{ name: 'Subtitles', extensions: [...ALLOWED_SUBTITLE_EXTENSIONS] }],
    });

    // Preload bridge invokes player:pick-subtitle-file and validates return payload
    const fakeRendererIpc: IpcRendererLike = {
      invoke: vi.fn(async () => picked),
      send: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
    };
    const bridge = createPlayerBridge(fakeRendererIpc);
    const viaBridge = await bridge.pickSubtitleFile?.();
    expect(fakeRendererIpc.invoke).toHaveBeenCalledWith(PLAYER_CHANNELS.pickSubtitleFile);
    expect(viaBridge).toEqual(picked);
  });
});

describe('#402 Simultaneous dual subtitles polish', () => {
  it('enables desktop capabilities, sets secondary-sub-pos=10, resets secondary-sub-pos, marks external tracks, and prevents primary/secondary collision', async () => {
    expect(DESKTOP_CAPABILITIES.dualSubtitles).toBe(true);
    expect(DESKTOP_CAPABILITIES.externalSubtitles).toBe(true);
    expect(DESKTOP_CAPABILITIES.subtitleStyling).toBe(true);

    const resetArg = LAUNCH_OPTIONS.find((arg) => arg.startsWith('--reset-on-next-file='));
    const resetProps = new Set(resetArg?.slice('--reset-on-next-file='.length).split(','));
    expect(resetProps.has('secondary-sid')).toBe(true);
    expect(resetProps.has('secondary-sub-pos')).toBe(true);

    expect(loadfileCommand({ url: URL_STREAM, headers: {}, kind: 'live' })[4]).toMatchObject({
      'secondary-sub-pos': '10',
    });
    expect(loadfileCommand({ url: URL_STREAM, headers: {}, kind: 'vod' })[4]).toMatchObject({
      'secondary-sub-pos': '10',
    });

    // inspectMpvTracks marks external: true on external sub tracks & enforces secondary !== primary
    const snap = inspectMpvTracks(
      [
        { id: 1, type: 'sub', lang: 'eng', title: 'Embedded' },
        { id: 2, type: 'sub', lang: 'tur', title: 'Sidecar', external: true },
      ],
      'auto',
      1,
      2,
    );
    expect(snap.subtitles).toEqual([
      { id: 's:1', language: 'eng', label: 'Embedded' },
      { id: 's:2', language: 'tur', label: 'Sidecar', external: true },
    ]);
    expect(snap.selectedSubtitleId).toBe('s:1');
    expect(snap.selectedSecondarySubtitleId).toBe('s:2');

    // MpvEngine clears secondary-sid='no' when primary switches onto active secondary track
    const { fake, engine, events } = await setupEngine();
    engine.load({ attempt: 1, url: URL_STREAM, headers: {}, kind: 'vod' });
    await vi.waitFor(() => expect(latestTracks(events)?.selectedSubtitleId).toBe('s:1'));

    // Secondary rejects active primary 's:1'
    engine.selectSecondarySubtitleTrack?.(2, 's:1');
    // Secondary accepts 's:2'
    engine.selectSecondarySubtitleTrack?.(2, 's:2');
    await vi.waitFor(() => {
      expect(fake.sent).toContainEqual(['set_property', 'secondary-sid', 2]);
      expect(latestTracks(events)?.selectedSecondarySubtitleId).toBe('s:2');
    });
    expect(fake.sent).not.toContainEqual(['set_property', 'secondary-sid', 1]);

    // Now switch primary to 's:2' -> MUST clear secondary-sid='no' so they never collide!
    const beforeCollision = fake.sent.length;
    engine.selectSubtitleTrack?.(3, 's:2');
    await vi.waitFor(() => {
      const after = fake.sent.slice(beforeCollision);
      expect(after).toContainEqual(['set_property', 'secondary-sid', 'no']);
      expect(after).toContainEqual(['set_property', 'sid', 2]);
      expect(latestTracks(events)?.selectedSubtitleId).toBe('s:2');
      expect(latestTracks(events)?.selectedSecondarySubtitleId).toBeUndefined();
    });
  });

  it('handles load.options.externalSubtitles, release() temp cleanup, HTTP error/redirect-scheme guards, and canceled/invalid picker replies', async () => {
    const subServer = await startHttpServer((req, res) => {
      if (req.url === '/not-found.srt') {
        res.writeHead(404);
        res.end('missing');
        return;
      }
      if (req.url === '/bad-redirect.srt') {
        res.writeHead(302, { Location: 'file:///etc/passwd' });
        res.end();
        return;
      }
      if (req.url === '/declared-huge.srt') {
        res.writeHead(200, { 'Content-Length': String(8 * 1024 * 1024) });
        res.end('tiny');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/vtt' });
      res.end('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nAttached on load\n');
    });

    const session = createSubtitleFetchSession();
    cleanups.push(() => session.cleanup());
    await expect(
      session.resolveTrack({ id: 'e1', uri: `${subServer.baseUrl}/not-found.srt` }),
    ).rejects.toThrow(/404/);
    await expect(
      session.resolveTrack({ id: 'e2', uri: `${subServer.baseUrl}/bad-redirect.srt` }),
    ).rejects.toThrow(/scheme/i);
    await expect(
      session.resolveTrack({ id: 'e3', uri: `${subServer.baseUrl}/declared-huge.srt` }),
    ).rejects.toThrow(/limit|size/i);

    const { fake, engine, events } = await setupEngine();
    engine.load({
      attempt: 1,
      url: URL_STREAM,
      headers: { Authorization: 'Bearer never-leaked' },
      kind: 'vod',
      options: {
        secondarySubtitleTrackId: 's:2',
        externalSubtitles: [
          {
            id: 'load-ext-1',
            uri: `${subServer.baseUrl}/preloaded.vtt`,
            label: 'Preloaded',
            language: 'en',
          },
        ],
      },
    });
    await vi.waitFor(() =>
      expect(
        events.some((e) => e.attempt === 1 && e.type === 'state' && e.state === 'playing'),
      ).toBe(true),
    );
    let preloadedPath = '';
    await vi.waitFor(() => {
      const subAdd = fake.sent.find((cmd) => cmd[0] === 'sub-add');
      expect(subAdd).toBeDefined();
      preloadedPath = String(subAdd?.[1] ?? '');
      expect(subAdd).toEqual(['sub-add', preloadedPath, 'auto', 'Preloaded', 'en']);
      expect(fake.sent).toContainEqual(['set_property', 'secondary-sid', 2]);
    });
    expect(existsSync(preloadedPath)).toBe(true);
    engine.release();
    expect(existsSync(preloadedPath)).toBe(false);

    // Picker returns null when canceled; preload rejects malformed reply
    const canceledPicker = createSubtitleFilePicker({
      getWindowFromSender: () => null,
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    });
    await expect(canceledPicker({})).resolves.toBeNull();

    const badIpc: IpcRendererLike = {
      invoke: vi.fn(async () => ({ id: 'x', uri: 'javascript:alert(1)' })),
      send: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
    };
    const bridge = createPlayerBridge(badIpc);
    await expect(bridge.pickSubtitleFile?.()).rejects.toThrow(/reply/i);
  });

  it('separates primary sub-pos from secondary-sub-pos when verticalPosition is top and retains mid-playback external tracks across retry()', async () => {
    const topStyle: SubtitleStyleConfig = { ...DEFAULT_SUBTITLE_STYLE, verticalPosition: 'top' };
    expect(subtitleStyleLoadOptions(topStyle, true)['sub-pos']).toBe('24');
    expect(subtitleStyleCommands(topStyle, true)).toContainEqual(['set_property', 'sub-pos', 24]);
    expect(subtitleStyleCommands(topStyle, true)).toContainEqual([
      'set_property',
      'secondary-sub-pos',
      10,
    ]);

    const subServer = await startHttpServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/x-subrip' });
      res.end('1\n00:00:01,000 --> 00:00:02,000\nRetry cue\n');
    });
    const { fake, engine, events } = await setupEngine();
    engine.load({
      attempt: 1,
      url: URL_STREAM,
      headers: {},
      kind: 'vod',
      options: { subtitleStyle: topStyle },
    });
    await vi.waitFor(() => expect(latestTracks(events)?.selectedSubtitleId).toBe('s:1'));
    expect(fake.sent.find((c) => c[0] === 'loadfile')?.[4]).toMatchObject({ 'sub-pos': '12' });

    // Enabling secondary subtitle while primary is 'top' separates sub-pos (24) from secondary-sub-pos (10)
    const beforeDual = fake.sent.length;
    engine.selectSecondarySubtitleTrack?.(2, 's:2');
    await vi.waitFor(() => {
      const after = fake.sent.slice(beforeDual);
      expect(after).toContainEqual(['set_property', 'secondary-sid', 2]);
      expect(after).toContainEqual(['set_property', 'secondary-sub-pos', 10]);
      expect(after).toContainEqual(['set_property', 'sub-pos', 24]);
    });

    // Toggling setSubtitleStyle to 'top' while secondary is active preserves separation (24 vs 10)
    engine.setSubtitleStyle?.({ ...DEFAULT_SUBTITLE_STYLE, verticalPosition: 'bottom' });
    const beforeReTop = fake.sent.length;
    engine.setSubtitleStyle?.(topStyle);
    await vi.waitFor(() => {
      const after = fake.sent.slice(beforeReTop);
      expect(after).toContainEqual(['set_property', 'sub-pos', 24]);
      expect(after).toContainEqual(['set_property', 'secondary-sub-pos', 10]);
    });

    // Clearing secondary subtitle restores primary sub-pos to 12
    const beforeClear = fake.sent.length;
    engine.selectSecondarySubtitleTrack?.(3, null);
    await vi.waitFor(() => {
      expect(fake.sent.slice(beforeClear)).toContainEqual(['set_property', 'sub-pos', 12]);
    });

    // Mid-playback addExternalSubtitle is re-attached after retry()
    engine.addExternalSubtitle?.(3, {
      id: 'ext-retry',
      uri: `${subServer.baseUrl}/retry.srt`,
      label: 'Retry Ext',
      language: 'en',
    });
    await vi.waitFor(() => {
      expect(fake.sent.filter((c) => c[0] === 'sub-add')).toHaveLength(1);
    });
    engine.retry(4);
    await vi.waitFor(() => {
      expect(fake.sent.filter((c) => c[0] === 'sub-add')).toHaveLength(2);
    });
  });
});
