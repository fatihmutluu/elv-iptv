import { type ChildProcess, spawn } from 'node:child_process';
import { join } from 'node:path';
import type { EngineEvent, MediaTracks } from '@elv/playback';
import { _electron as electron, expect, test } from '@playwright/test';
import { mpvRuntimePaths } from '../src/main/player/runtime-path.ts';
import { SIM_URL, simulatorAnswers } from '../src/main/player/testing/sim-streams.ts';
import type { PlayerBridge } from '../src/shared/player-ipc.ts';

const DESKTOP_ROOT = join(__dirname, '..');
const SIM_BIN = join(DESKTOP_ROOT, '..', '..', 'tools', 'bin', 'sim.ts');

function spawnEphemeralSim(): Promise<{ child: ChildProcess; url: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SIM_BIN, '--port', '0', '--host', '127.0.0.1'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Timed out starting local simulator.\n${out}`));
    }, 15_000);
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
      const match = /sim:\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(out);
      if (match?.[1]) {
        clearTimeout(timer);
        resolve({ child, url: match[1] });
      }
    });
  });
}

test('gate route with one live channel reaches firstFrame', async () => {
  const runtime = mpvRuntimePaths({
    isPackaged: false,
    resourcesPath: '',
    appPath: DESKTOP_ROOT,
    platform: process.platform,
    arch: process.arch,
  });
  if (!runtime) {
    test.skip(true, 'mpv runtime is not installed for this platform');
    return;
  }
  if (!(await simulatorAnswers())) {
    test.skip(true, `Stream simulator is not reachable at ${SIM_URL}`);
    return;
  }

  const query = `elv-gate=player&base=${SIM_URL}&account=demo&channels=1001&zaps=1&rate=0.5`;
  const app = await electron.launch({
    args: [DESKTOP_ROOT, `--elv-gate=${query}`],
  });

  try {
    const proc = app.process();
    const gateLine = await new Promise<string>((resolvePromise, rejectPromise) => {
      let buffer = '';
      const timer = setTimeout(() => {
        rejectPromise(new Error(`Timed out waiting for ELV_GATE_PLAYER line.\n${buffer}`));
      }, 30_000);
      proc.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const found = buffer.split(/\r?\n/).find((line) => line.startsWith('ELV_GATE_PLAYER {'));
        if (found) {
          clearTimeout(timer);
          resolvePromise(found);
        }
      });
      proc.once('exit', (code) => {
        clearTimeout(timer);
        const found = buffer.split(/\r?\n/).find((line) => line.startsWith('ELV_GATE_PLAYER {'));
        if (found) resolvePromise(found);
        else
          rejectPromise(
            new Error(
              `Electron exited (${String(code)}) before printing ELV_GATE_PLAYER.\n${buffer}`,
            ),
          );
      });
    });

    const payload = JSON.parse(gateLine.slice('ELV_GATE_PLAYER '.length)) as {
      ttffColdMs: number | null;
      failures: number;
      mpvSpawns: number;
    };
    expect(typeof payload.ttffColdMs).toBe('number');
    expect(payload.ttffColdMs as number).toBeGreaterThan(0);
    expect(payload.failures).toBe(0);
    expect(payload.mpvSpawns).toBe(1);
  } finally {
    await app.close().catch(() => {});
  }
});

test('enumerates multi-audio and SRT subtitle tracks and switches aid/sid over player IPC without resetting VOD position', async () => {
  const runtime = mpvRuntimePaths({
    isPackaged: false,
    resourcesPath: '',
    appPath: DESKTOP_ROOT,
    platform: process.platform,
    arch: process.arch,
  });
  if (!runtime) {
    test.skip(true, 'mpv runtime is not installed for this platform');
    return;
  }

  const sim = await spawnEphemeralSim();
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    const playlistRes = await fetch(`${sim.url}/playlists/corpus.m3u`, {
      signal: AbortSignal.timeout(15_000),
    });
    expect(playlistRes.ok).toBe(true);
    const playlistText = await playlistRes.text();
    const vodUrl = playlistText.split(/\r?\n/).find((line) => line.endsWith('/200011.mkv'));
    if (!vodUrl) {
      throw new Error('Expected 200011.mkv in simulator corpus playlist');
    }
    const warm = await fetch(vodUrl, {
      headers: { Range: 'bytes=0-4095' },
      signal: AbortSignal.timeout(60_000),
    });
    if (warm.status === 503) {
      test.skip(true, 'FFmpeg is not available to synthesize simulator media');
      return;
    }
    expect(warm.ok || warm.status === 206).toBe(true);

    app = await electron.launch({ args: [DESKTOP_ROOT] });
    const page = await app.firstWindow();

    const result = await page.evaluate(async (streamUrl: string) => {
      const w = window as unknown as { elv: { player: PlayerBridge } };
      const player = w.elv.player;
      const events: EngineEvent[] = [];
      let targetEngineId = '';
      const off = player.onEvent((msg) => {
        if (msg.engineId === targetEngineId) events.push(msg.event);
      });

      const waitUntil = async <T>(pick: () => T | undefined, label: string): Promise<T> => {
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          const err = events.find((e) => e.type === 'error');
          if (err && err.type === 'error') {
            throw new Error(
              `Engine error while waiting for ${label}: ${JSON.stringify(err.error)}`,
            );
          }
          const found = pick();
          if (found !== undefined) return found;
          await new Promise((r) => setTimeout(r, 50));
        }
        throw new Error(`Timed out waiting for ${label}`);
      };

      const { engineId } = await player.open();
      targetEngineId = engineId;
      try {
        player.send({
          engineId,
          command: {
            name: 'load',
            cmd: { attempt: 1, url: streamUrl, headers: {}, kind: 'vod', startMs: 3_000 },
          },
        });

        await waitUntil(
          () => events.find((e) => e.type === 'state' && e.state === 'playing'),
          'playing state',
        );
        const initialTracks = await waitUntil((): MediaTracks | undefined => {
          for (let i = events.length - 1; i >= 0; i -= 1) {
            const ev = events[i];
            if (
              ev?.type === 'tracks' &&
              ev.tracks.audio.length >= 2 &&
              ev.tracks.subtitles.length >= 2
            ) {
              return ev.tracks;
            }
          }
          return undefined;
        }, 'initial 2 audio + 2 subtitle tracks');

        player.send({
          engineId,
          command: { name: 'selectAudioTrack', attempt: 2, id: 'a:2' },
        });
        await waitUntil(
          () =>
            events.find(
              (e) => e.type === 'tracks' && e.attempt === 2 && e.tracks.selectedAudioId === 'a:2',
            ),
          'selectedAudioId === a:2',
        );
        const clockAfterAudioSwitch = await waitUntil(() => {
          const ev = events.find((e) => e.type === 'clock' && e.attempt >= 2);
          return ev?.type === 'clock' ? ev.anchor.positionMs : undefined;
        }, 'post-switch VOD clock');

        player.send({
          engineId,
          command: { name: 'selectSubtitleTrack', attempt: 3, id: 's:2' },
        });
        await waitUntil(
          () =>
            events.find(
              (e) =>
                e.type === 'tracks' && e.attempt === 3 && e.tracks.selectedSubtitleId === 's:2',
            ),
          'selectedSubtitleId === s:2',
        );

        player.send({
          engineId,
          command: { name: 'selectSubtitleTrack', attempt: 4, id: null },
        });
        const afterOff = await waitUntil(() => {
          const ev = events.find(
            (e) => e.type === 'tracks' && e.attempt === 4 && e.tracks.selectedSubtitleId === null,
          );
          return ev?.type === 'tracks' ? ev.tracks : undefined;
        }, 'selectedSubtitleId === null');

        return {
          audioLangs: initialTracks.audio.map((t) => t.language),
          subLangs: initialTracks.subtitles.map((t) => t.language),
          clockAfterAudioSwitch,
          selectedAudioAfterOff: afterOff.selectedAudioId,
          selectedSubAfterOff: afterOff.selectedSubtitleId,
        };
      } finally {
        off();
        await player.close(engineId).catch(() => {});
      }
    }, vodUrl);

    expect(result.audioLangs).toEqual(['tur', 'eng']);
    expect(result.subLangs).toEqual(['tur', 'eng']);
    expect(result.clockAfterAudioSwitch).toBeGreaterThanOrEqual(2_500);
    expect(result.selectedAudioAfterOff).toBe('a:2');
    expect(result.selectedSubAfterOff).toBeNull();
  } finally {
    await app?.close().catch(() => {});
    sim.child.kill();
  }
});
