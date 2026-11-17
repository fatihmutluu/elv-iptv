import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createReadStream, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DESKTOP_ROOT = join(__dirname, '..');
const SIM_BIN = join(DESKTOP_ROOT, '..', '..', 'tools', 'bin', 'sim.ts');

export interface BrowseTestEnv {
  readonly frontUrl: string;
  readonly hasMedia: boolean;
  close(): Promise<void>;
}

function spawnEphemeralSim(): Promise<{ child: ChildProcess; url: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [SIM_BIN, '--port', '0', '--host', '127.0.0.1', '--clock', '2026-06-15T12:00:00Z'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
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

function generateTestClips(
  dir: string,
): { liveTs: string; vodMp4: string; vodMultiMkv: string } | null {
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  const probe = spawnSync(ffmpeg, ['-version'], { windowsHide: true, stdio: 'ignore' });
  if (probe.status !== 0) return null;

  const baseArgs = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=320x180:rate=25',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000',
    '-t',
    '12',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-preset',
    'ultrafast',
    '-c:a',
    'aac',
  ];
  const liveTs = join(dir, 'live.ts');
  const vodMp4 = join(dir, 'vod.mp4');
  const vodMultiMkv = join(dir, 'vod-multi.mkv');
  const turSrt = join(dir, 'tur.srt');
  const engSrt = join(dir, 'eng.srt');
  writeFileSync(turSrt, '1\n00:00:00,000 --> 00:00:25,000\nTUR SUB\n', 'utf8');
  writeFileSync(engSrt, '1\n00:00:00,000 --> 00:00:25,000\nENG SUB\n', 'utf8');

  const tsOut = spawnSync(ffmpeg, [...baseArgs, '-f', 'mpegts', liveTs], {
    windowsHide: true,
    stdio: 'ignore',
  });
  if (tsOut.status !== 0) return null;

  const mp4Out = spawnSync(ffmpeg, [...baseArgs, '-movflags', '+faststart', '-f', 'mp4', vodMp4], {
    windowsHide: true,
    stdio: 'ignore',
  });
  if (mp4Out.status !== 0) return null;

  const mkvOut = spawnSync(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=320x180:rate=25',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=660:sample_rate=48000',
      '-i',
      turSrt,
      '-i',
      engSrt,
      '-t',
      '25',
      '-map',
      '0:v',
      '-map',
      '1:a',
      '-map',
      '2:a',
      '-map',
      '3:s',
      '-map',
      '4:s',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-preset',
      'ultrafast',
      '-c:a',
      'aac',
      '-c:s',
      'srt',
      '-metadata:s:a:0',
      'language=tur',
      '-metadata:s:a:1',
      'language=eng',
      '-metadata:s:s:0',
      'language=tur',
      '-metadata:s:s:1',
      'language=eng',
      '-f',
      'matroska',
      vodMultiMkv,
    ],
    { windowsHide: true, stdio: 'ignore' },
  );
  if (mkvOut.status !== 0) return null;

  return { liveTs, vodMp4, vodMultiMkv };
}

function serveStaticClip(req: IncomingMessage, res: ServerResponse, file: string, mime: string) {
  const size = statSync(file).size;
  const range = req.headers.range;
  const match = typeof range === 'string' ? /^bytes=(\d+)-(\d*)$/.exec(range) : null;
  if (match) {
    const start = Math.min(Number(match[1]), Math.max(0, size - 1));
    const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    res.writeHead(206, {
      'content-type': mime,
      'accept-ranges': 'bytes',
      'content-range': `bytes ${start}-${end}/${size}`,
      'content-length': String(end - start + 1),
      'cache-control': 'no-store',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = createReadStream(file, { start, end });
    res.once('close', () => stream.destroy());
    stream.pipe(res);
    return;
  }
  res.writeHead(200, {
    'content-type': mime,
    'accept-ranges': 'bytes',
    'content-length': String(size),
    'cache-control': 'no-store',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = createReadStream(file);
  res.once('close', () => stream.destroy());
  stream.pipe(res);
}

async function proxyToSim(
  simBaseUrl: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const upstream = await fetch(`${simBaseUrl}${req.url ?? '/'}`, {
      method: req.method ?? 'GET',
    });
    const headers: Record<string, string> = {};
    upstream.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, headers);
    res.end(buf);
  } catch {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  }
}

export async function startBrowseTestEnv(): Promise<BrowseTestEnv> {
  const started = await spawnEphemeralSim();
  const ownedSim = started.child;
  const simBaseUrl = started.url;

  const mediaDir = mkdtempSync(join(tmpdir(), 'elv-e2e-browse-media-'));
  const clips = generateTestClips(mediaDir);

  const frontServer: Server = createServer((req, res) => {
    const path = req.url ?? '/';
    if (clips && path.startsWith('/live/')) {
      serveStaticClip(req, res, clips.liveTs, 'video/mp2t');
      return;
    }
    if (clips && path.startsWith('/movie/corpus/') && path.endsWith('.mkv')) {
      serveStaticClip(req, res, clips.vodMultiMkv, 'video/x-matroska');
      return;
    }
    if (clips && (path.startsWith('/movie/') || path.startsWith('/series/'))) {
      serveStaticClip(req, res, clips.vodMp4, 'video/mp4');
      return;
    }
    void proxyToSim(simBaseUrl, req, res);
  });
  await new Promise<void>((resolve) => frontServer.listen(0, '127.0.0.1', resolve));
  const addr = frontServer.address();
  const frontUrl =
    typeof addr === 'object' && addr !== null ? `http://127.0.0.1:${addr.port}` : simBaseUrl;

  return {
    frontUrl,
    hasMedia: clips !== null,
    async close() {
      await new Promise<void>((resolve) => frontServer.close(() => resolve()));
      if (ownedSim.exitCode === null) {
        const exited = new Promise<void>((resolve) => ownedSim.once('exit', () => resolve()));
        ownedSim.kill();
        await Promise.race([exited, new Promise<void>((r) => setTimeout(r, 3_000))]);
      }
      rmSync(mediaDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}
