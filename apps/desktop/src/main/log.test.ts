import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDesktopLogger, DEFAULT_MAX_TOTAL_BYTES, type DesktopLogFs } from './log.ts';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'elv-desktop-log-'));
  tempDirs.push(dir);
  return dir;
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('createDesktopLogger', () => {
  it('defaults to a 10 MB total cap and redacts URLs, headers, and credentials before writing anywhere', () => {
    expect(DEFAULT_MAX_TOTAL_BYTES).toBe(10 * 1024 * 1024);
    const dir = makeTempDir();
    const logPath = join(dir, 'logs', 'elv-desktop.log');
    const stderrChunks: string[] = [];
    const logger = createDesktopLogger({
      logPath,
      mirrorStderr: true,
      writeStderr: (chunk) => stderrChunks.push(chunk),
    });

    logger.log(
      'failed https://user:pass@iptv.example.com:8080/live/demo/pass/42.m3u8?token=xyz Authorization: Bearer topsecret123 password=example',
    );

    const onDisk = readFileSync(logPath, 'utf8');
    expect(onDisk).toBe(stderrChunks.join(''));
    expect(onDisk).toContain('https://iptv.example.com:8080/***/***/***/***.m3u8');
    expect(onDisk).not.toContain('user:pass');
    expect(onDisk).not.toContain('/live/demo/pass/');
    expect(onDisk).not.toContain('token=xyz');
    expect(onDisk).not.toContain('topsecret123');
    expect(onDisk).not.toContain('password=example');
  });

  it('rotates at maxTotalBytes / 2 and enforces a strict total byte ceiling across many rotations', () => {
    const dir = makeTempDir();
    const logPath = join(dir, 'elv-desktop.log');
    const maxTotalBytes = 512;
    const logger = createDesktopLogger({ logPath, maxTotalBytes });

    const payload = 'x'.repeat(80);
    for (let i = 0; i < 40; i += 1) {
      logger.log(`line-${String(i).padStart(2, '0')} ${payload}`);
      const activeBytes = fileSize(logger.logPath);
      const backupBytes = fileSize(logger.backupPath);
      expect(activeBytes).toBeLessThanOrEqual(maxTotalBytes / 2);
      expect(backupBytes).toBeLessThanOrEqual(maxTotalBytes / 2);
      expect(activeBytes + backupBytes).toBeLessThanOrEqual(maxTotalBytes);
    }

    expect(fileSize(logger.backupPath)).toBeGreaterThan(0);
    expect(readFileSync(logger.logPath, 'utf8')).toContain('line-39');
  });

  it('truncates single oversized lines cleanly on UTF-8 boundaries without exceeding the cap', () => {
    const dir = makeTempDir();
    const logPath = join(dir, 'elv-desktop.log');
    const maxTotalBytes = 128;
    const logger = createDesktopLogger({ logPath, maxTotalBytes });

    logger.log(`prefix-${'😀'.repeat(50)}-suffix`);
    logger.log(`second-${'b'.repeat(200)}`);

    const activeBytes = fileSize(logger.logPath);
    const backupBytes = fileSize(logger.backupPath);
    expect(activeBytes).toBeLessThanOrEqual(maxTotalBytes / 2);
    expect(backupBytes).toBeLessThanOrEqual(maxTotalBytes / 2);
    expect(activeBytes + backupBytes).toBeLessThanOrEqual(maxTotalBytes);

    const activeContent = readFileSync(logger.logPath, 'utf8');
    const backupContent = readFileSync(logger.backupPath, 'utf8');
    expect(activeContent.endsWith('\n')).toBe(true);
    expect(backupContent.endsWith('\n')).toBe(true);
    expect(backupContent).not.toContain('\uFFFD');
  });

  it('bounds pre-existing oversized active and backup files so disk usage never exceeds maxTotalBytes', () => {
    const dir = makeTempDir();
    const logPath = join(dir, 'elv-desktop.log');
    const backupPath = `${logPath}.1`;
    writeFileSync(logPath, 'a'.repeat(400), 'utf8');
    writeFileSync(backupPath, 'b'.repeat(400), 'utf8');

    const logger = createDesktopLogger({ logPath, maxTotalBytes: 200 });
    logger.log('fresh line');

    expect(fileSize(logPath)).toBeLessThanOrEqual(100);
    expect(fileSize(backupPath)).toBeLessThanOrEqual(100);
    expect(fileSize(logPath) + fileSize(backupPath)).toBeLessThanOrEqual(200);
    expect(readFileSync(logPath, 'utf8')).toContain('fresh line');
  });

  it('handles Windows EBUSY/EACCES rename locks and ENOENT directory removal without throwing', () => {
    const files = new Map<string, string>();
    let renameErrors = 0;
    let enoentOnce = true;

    const fakeFs: DesktopLogFs = {
      mkdirSync: () => undefined,
      statSync: (path) => {
        const content = files.get(path);
        if (content === undefined) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        return { size: Buffer.byteLength(content, 'utf8') };
      },
      appendFileSync: (path, data) => {
        if (enoentOnce) {
          enoentOnce = false;
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        files.set(path, (files.get(path) ?? '') + data);
      },
      writeFileSync: (path, data) => {
        files.set(path, data);
      },
      renameSync: () => {
        renameErrors += 1;
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      },
      rmSync: () => {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      },
    };

    const logger = createDesktopLogger({
      logPath: 'C:\\logs\\elv-desktop.log',
      maxTotalBytes: 120,
      fs: fakeFs,
    });

    // First write recovers from ENOENT by recreating dir and retrying
    expect(() => logger.log('a'.repeat(40))).not.toThrow();
    expect(files.get(logger.logPath)).toBe(`${'a'.repeat(40)}\n`);

    // Second write triggers rotation -> renameSync throws EBUSY -> falls back to truncating active file
    expect(() => logger.log('b'.repeat(40))).not.toThrow();
    expect(renameErrors).toBe(1);
    expect(files.get(logger.logPath)).toBe(`${'b'.repeat(40)}\n`);
  });

  it('falls back to stderr without throwing when all disk writes fail with EBUSY', () => {
    const stderrChunks: string[] = [];
    const brokenFs: DesktopLogFs = {
      mkdirSync: () => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      },
      statSync: () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
      appendFileSync: () => {
        throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      },
      writeFileSync: () => {
        throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      },
      renameSync: () => {
        throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      },
      rmSync: () => {
        throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      },
    };

    const logger = createDesktopLogger({
      logPath: 'C:\\locked\\elv-desktop.log',
      fs: brokenFs,
      mirrorStderr: false,
      writeStderr: (chunk) => stderrChunks.push(chunk),
    });

    expect(() => logger.log('secret https://u:p@host.test/secret/1.ts')).not.toThrow();
    expect(stderrChunks.join('')).toContain('https://host.test/***/***.ts');
    expect(stderrChunks.join('')).not.toContain('u:p');
  });
});
