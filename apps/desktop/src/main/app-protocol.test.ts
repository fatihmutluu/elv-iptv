import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_ORIGIN, resolveAppFile } from './app-protocol.ts';

const root = resolve('/srv/renderer');

describe('resolveAppFile', () => {
  it('serves index.html for the root path', () => {
    expect(resolveAppFile(root, `${APP_ORIGIN}/`)).toBe(resolve(root, 'index.html'));
  });

  it('resolves nested assets inside the root', () => {
    expect(resolveAppFile(root, `${APP_ORIGIN}/_expo/static/js/web/app.js`)).toBe(
      resolve(root, '_expo/static/js/web/app.js'),
    );
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
    '/a%00.js',
    '//etc/passwd',
  ])('refuses %s', (path) => {
    expect(resolveAppFile(root, `${APP_ORIGIN}${path}`)).toBeNull();
  });

  it('refuses other hosts and schemes', () => {
    expect(resolveAppFile(root, 'app://other/index.html')).toBeNull();
    expect(resolveAppFile(root, 'https://elv/index.html')).toBeNull();
  });

  it('refuses malformed URLs and bad escapes', () => {
    expect(resolveAppFile(root, 'not a url')).toBeNull();
    expect(resolveAppFile(root, `${APP_ORIGIN}/%E0%A4%A`)).toBeNull();
  });
});
