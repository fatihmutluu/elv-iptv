import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ElectronApplication, _electron as electron, expect, test } from '@playwright/test';
import type { Rect } from '../src/main/player/presenter/bounds.ts';
import { simulatorAnswers } from '../src/main/player/testing/sim-streams.ts';
import type { Probe } from './presenter-probe.ts';

// Opt-in go/no-go (opens windows, plays the simulator): ELV_MPV_SPIKE=1 on win32 with the runtime and `pnpm sim`.
const optedIn = process.env['ELV_MPV_SPIKE'] === '1';
const runtime = join(__dirname, '..', 'resources', 'mpv', 'win32-x64', 'elv-mpv.exe');
const probePath = join(__dirname, '..', 'dist', 'e2e', 'presenter-probe.js');
const evidenceDir =
  process.env['ELV_PRESENTER_EVIDENCE_DIR'] ?? join(__dirname, '..', 'test-results', 'presenter');

const VIDEO_BUCKETS = 16;
const VIDEO_WITHIN_MS = 5000;
const PING_BUDGET_MS = 200;
const AREA = { x: 40, y: 40, width: 800, height: 450, visible: true };

type Call = <K extends keyof Probe>(
  name: K,
  ...args: Parameters<Probe[K]>
) => Promise<Awaited<ReturnType<Probe[K]>>>;

function caller(app: ElectronApplication): Call {
  return (name, ...args) =>
    app.evaluate(
      (_electron, [n, a]) => {
        const g = globalThis as unknown as {
          elvProbe: Record<string, (...x: unknown[]) => unknown>;
        };
        return g.elvProbe[n]?.(...a);
      },
      [name, args] as [string, unknown[]],
    ) as never;
}

/** mpv's own window puts its title bar over the top of the area, so that presenter is judged below it. */
function judged(kind: string, area: Rect): Rect {
  if (kind !== 'own-window') return area;
  const skip = Math.round(area.height * 0.2);
  return { ...area, y: area.y + skip, height: area.height - skip };
}

async function waitForVideo(call: Call, rect: Rect): Promise<{ ms: number; distinct: number[] }> {
  const t0 = Date.now();
  const distinct: number[] = [];
  while (Date.now() - t0 < VIDEO_WITHIN_MS) {
    const d = await call('sample', rect);
    distinct.push(d);
    if (d >= VIDEO_BUCKETS) return { ms: Date.now() - t0, distinct };
    await new Promise((r) => setTimeout(r, 150));
  }
  return { ms: -1, distinct };
}

/** Electron reports DIP bounds of a window placed in physical pixels, so allow one DIP of rounding. */
function expectNear(actual: Rect | null, wanted: Rect, label: string): void {
  expect(actual, label).not.toBeNull();
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    const off = Math.abs((actual?.[key] ?? Number.NaN) - wanted[key]);
    expect(off, `${label} ${key}`).toBeLessThanOrEqual(1);
  }
}

/** mpv's OSD size is its window's client size in physical pixels. */
async function expectMpvPixels(call: Call, rect: Rect, scale: number, label: string) {
  const osd = await call('mpvGet', ['osd-width', 'osd-height']);
  const dw = Math.abs(Number(osd['osd-width']) - rect.width * scale);
  const dh = Math.abs(Number(osd['osd-height']) - rect.height * scale);
  expect(dw, `${label} osd-width`).toBeLessThanOrEqual(2);
  expect(dh, `${label} osd-height`).toBeLessThanOrEqual(2);
  return osd;
}

for (const kind of ['child-window', 'own-window'] as const) {
  test(`${kind}: mpv video shows in the player area and the app stays responsive`, async () => {
    test.skip(
      !optedIn || process.platform !== 'win32' || !existsSync(runtime),
      'opt-in: ELV_MPV_SPIKE=1 on win32 with the mpv runtime',
    );
    test.skip(!(await simulatorAnswers()), 'needs `pnpm sim`');
    const app = await electron.launch({
      args: [probePath],
      env: { ...process.env, ELV_PRESENTER_EVIDENCE_DIR: evidenceDir },
    });
    const call = caller(app);
    const m: Record<string, unknown> = { kind };
    try {
      await app.firstWindow();
      await new Promise((r) => setTimeout(r, 500));
      const started = await call('start', kind);
      const scale = started.scaleFactor;
      Object.assign(m, { args: started.args, scaleFactor: scale, area: started.area });
      const judgedRect = judged(kind, started.area);
      m['beforeLoad'] = await call('sample', judgedRect);
      expect(m['beforeLoad'], 'idle mpv is not mistaken for video').toBeLessThan(VIDEO_BUCKETS);
      await call('load');
      const video = await waitForVideo(call, judgedRect);
      Object.assign(m, { videoMs: video.ms, distinct: video.distinct });
      expect(video.ms, `video within ${VIDEO_WITHIN_MS} ms`).toBeGreaterThanOrEqual(0);
      await new Promise((r) => setTimeout(r, 1000));
      await call('shot', `${kind}-playing`);
      m['mpv'] = await call('mpvGet', ['playback-time', 'current-vo', 'hwdec-current']);
      m['osd'] = await expectMpvPixels(call, started.area, scale, 'playing');
      m['pingsMs'] = await call('ping', 10);
      m['keysCounted'] = await call('pressKeys', 5);
      expect(Math.max(...(m['pingsMs'] as number[]))).toBeLessThanOrEqual(PING_BUDGET_MS);
      expect(m['keysCounted']).toBe(5);

      if (kind === 'child-window') {
        expectNear(await call('videoBounds'), started.area, 'start');

        await call('moveBy', 100, 0);
        const moved = await call('areaRect');
        const afterMove = {
          area: moved,
          video: await call('videoBounds'),
          distinct: await call('sample'),
        };
        m['afterMove'] = afterMove;
        await call('shot', `${kind}-moved`);
        expect(moved.x).toBe(started.area.x + 100);
        expectNear(afterMove.video, moved, 'after move');
        expect(afterMove.distinct).toBeGreaterThanOrEqual(VIDEO_BUCKETS);

        await call('resizeBy', -200, -100);
        const resized = await call('areaRect');
        const afterResize = {
          area: resized,
          video: await call('videoBounds'),
          distinct: await call('sample'),
          pingsMs: await call('ping', 5),
        };
        m['afterResize'] = afterResize;
        expectNear(afterResize.video, resized, 'after app resize');
        expect(afterResize.distinct).toBeGreaterThanOrEqual(VIDEO_BUCKETS);

        await call('setArea', { ...AREA, width: 640, height: 360 });
        const smaller = await call('areaRect');
        const afterArea = {
          area: smaller,
          video: await call('videoBounds'),
          distinct: await call('sample'),
        };
        m['afterAreaChange'] = afterArea;
        await call('shot', `${kind}-smaller-area`);
        expectNear(afterArea.video, smaller, 'after area change');
        m['osdAfterAreaChange'] = await expectMpvPixels(call, smaller, scale, 'after area change');
        expect(afterArea.distinct).toBeGreaterThanOrEqual(VIDEO_BUCKETS);

        await call('setArea', { ...AREA, width: 640, height: 360, visible: false });
        m['hiddenDistinct'] = await call('sample');
        expect(m['hiddenDistinct']).toBeLessThan(VIDEO_BUCKETS);
        await call('setArea', { ...AREA, width: 640, height: 360 });
        m['reshownDistinct'] = await call('sample');
        expect(m['reshownDistinct']).toBeGreaterThanOrEqual(VIDEO_BUCKETS);

        const fullscreen = await call('fullscreenFromMpv');
        const inFullscreen = {
          ...fullscreen,
          area: await call('areaRect'),
          video: await call('videoBounds'),
          distinct: await call('sample'),
        };
        m['fullscreenFromMpv'] = inFullscreen;
        await call('shot', `${kind}-fullscreen`);
        expect(inFullscreen.app, 'the app window owns fullscreen').toBe(true);
        expect(inFullscreen.mpv, 'mpv fullscreen is turned back').toBe(false);
        expectNear(inFullscreen.video, inFullscreen.area, 'in fullscreen');
        expect(inFullscreen.distinct).toBeGreaterThanOrEqual(VIDEO_BUCKETS);
        m['fullscreenAfterLeave'] = await call('leaveFullscreen');
        expect(m['fullscreenAfterLeave']).toBe(false);
      }
      await call('stop');
      m['events'] = await call('events');
      expect(m['events']).toEqual(['created', 'destroyed']);
    } finally {
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(join(evidenceDir, `${kind}.json`), `${JSON.stringify(m, null, 2)}\n`);
      await app.close();
    }
  });
}
