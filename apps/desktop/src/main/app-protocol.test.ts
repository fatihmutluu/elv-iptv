import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { APP_ORIGIN, CONTENT_SECURITY_POLICY, resolveAppFile } from './app-protocol.ts';

const root = resolve('/srv/renderer');

describe('CONTENT_SECURITY_POLICY', () => {
  it('locks down frames, workers, and form submissions while allowing elv-art cached images', () => {
    const directives = CONTENT_SECURITY_POLICY.split('; ');
    expect(directives).toContain("frame-src 'none'");
    expect(directives).toContain("worker-src 'self'");
    expect(directives).toContain("form-action 'none'");
    expect(directives).toContain("img-src 'self' data: blob: elv-art: https: http:");
  });
});

describe('resolveAppFile', () => {
  it('serves index.html for the root path and bare origin', () => {
    expect(resolveAppFile(root, `${APP_ORIGIN}/`)).toBe(resolve(root, 'index.html'));
    expect(resolveAppFile(root, APP_ORIGIN)).toBe(resolve(root, 'index.html'));
  });

  it('resolves nested assets inside the root including uppercase scheme and host', () => {
    expect(resolveAppFile(root, `${APP_ORIGIN}/_expo/static/js/web/app.js`)).toBe(
      resolve(root, '_expo/static/js/web/app.js'),
    );
    expect(resolveAppFile(root, 'APP://ELV/a.js')).toBe(resolve(root, 'a.js'));
    expect(resolveAppFile(root, 'APP://ELV')).toBe(resolve(root, 'index.html'));
  });

  it('ignores query strings and fragments', () => {
    expect(resolveAppFile(root, `${APP_ORIGIN}/a.js?v=1#x`)).toBe(resolve(root, 'a.js'));
  });

  it.each([
    '/../secret.txt',
    '/a/../../secret.txt',
    '/%2e%2e/secret.txt',
    '/%2E%2E%2Fsecret.txt',
    '/a/%2e%2e/%2e%2e/secret.txt',
    '/..%5Csecret.txt',
    '/a%5C..%5C..%5Csecret.txt',
    '/%5CWindows/system.ini',
    '/C:/Windows/system.ini',
    '/%43%3A/Windows/system.ini',
    '/index.html:$DATA',
    '/index.html%3A$DATA',
    '/sub/file:stream.js',
    '/a%00.js',
    '//etc/passwd',
  ])('refuses %s', (path) => {
    expect(resolveAppFile(root, `${APP_ORIGIN}${path}`)).toBeNull();
  });

  it.each([
    'app://other/index.html',
    'https://elv/index.html',
    'app://user:pass@elv/index.html',
    'app://elv/../secret@elv/index.html',
    'app://user@elv/index.html',
    'app://elv:80/index.html',
    'APP://ELV:8080/index.html',
  ])('refuses non-canonical origin %s', (url) => {
    expect(resolveAppFile(root, url)).toBeNull();
  });

  it('refuses malformed URLs and bad escapes', () => {
    expect(resolveAppFile(root, 'not a url')).toBeNull();
    expect(resolveAppFile(root, `${APP_ORIGIN}/%E0%A4%A`)).toBeNull();
  });
});

describe('resolveAppFile trailing slashes', () => {
  it('maps a trailing-slash path to the directory path inside the root', () => {
    expect(resolveAppFile(root, `${APP_ORIGIN}/assets/`)).toBe(resolve(root, 'assets'));
  });
});

describe('resolveAppFile symlink containment', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects symlinks inside root that escape outside rootDir while allowing in-root files and symlinks', () => {
    const base = mkdtempSync(join(tmpdir(), 'elv-app-proto-'));
    tempDirs.push(base);
    const appRoot = join(base, 'renderer');
    const outsideDir = join(base, 'outside');
    mkdirSync(appRoot, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(appRoot, 'index.html'), '<html>ok</html>');
    writeFileSync(join(outsideDir, 'secret.txt'), 'secret');

    // Directory symlink (junction on Windows, dir symlink on POSIX) pointing outside appRoot
    const escapeDirLink = join(appRoot, 'escape-dir');
    symlinkSync(outsideDir, escapeDirLink, process.platform === 'win32' ? 'junction' : 'dir');

    // In-root directory symlink stays allowed
    const subDir = join(appRoot, 'sub');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, 'app.js'), 'console.log(1);');
    const safeDirLink = join(appRoot, 'safe-dir');
    symlinkSync(subDir, safeDirLink, process.platform === 'win32' ? 'junction' : 'dir');

    expect(resolveAppFile(appRoot, `${APP_ORIGIN}/index.html`)).toBe(
      resolve(appRoot, 'index.html'),
    );
    expect(resolveAppFile(appRoot, `${APP_ORIGIN}/safe-dir/app.js`)).toBe(
      resolve(appRoot, 'safe-dir/app.js'),
    );
    expect(resolveAppFile(appRoot, `${APP_ORIGIN}/missing-in-root.js`)).toBe(
      resolve(appRoot, 'missing-in-root.js'),
    );
    expect(resolveAppFile(appRoot, `${APP_ORIGIN}/escape-dir/secret.txt`)).toBeNull();
    expect(resolveAppFile(appRoot, `${APP_ORIGIN}/escape-dir/nonexistent.txt`)).toBeNull();

    // Also test a direct file symlink when permitted by OS privileges
    const fileLink = join(appRoot, 'escape-file.txt');
    let createdFileLink = false;
    try {
      symlinkSync(join(outsideDir, 'secret.txt'), fileLink, 'file');
      createdFileLink = true;
    } catch {
      // Unprivileged Windows without Developer Mode cannot create file symlinks; junction above covers realpath containment.
    }
    if (createdFileLink) {
      expect(resolveAppFile(appRoot, `${APP_ORIGIN}/escape-file.txt`)).toBeNull();
    }

    // Dangling symlink pointing to a non-existent outside target must fail closed (null)
    const danglingTarget = join(base, 'does-not-exist-outside');
    const danglingLink = join(appRoot, 'dangling-link');
    symlinkSync(danglingTarget, danglingLink, process.platform === 'win32' ? 'junction' : 'dir');
    expect(resolveAppFile(appRoot, `${APP_ORIGIN}/dangling-link`)).toBeNull();
    expect(resolveAppFile(appRoot, `${APP_ORIGIN}/dangling-link/secret.txt`)).toBeNull();
  });
});
