import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_ORIGIN, CONTENT_SECURITY_POLICY, resolveAppFile } from './app-protocol.ts';

const root = resolve('/srv/renderer');

describe('CONTENT_SECURITY_POLICY', () => {
  it('locks down frames, workers, and form submissions', () => {
    const directives = CONTENT_SECURITY_POLICY.split('; ');
    expect(directives).toContain("frame-src 'none'");
    expect(directives).toContain("worker-src 'self'");
    expect(directives).toContain("form-action 'none'");
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
