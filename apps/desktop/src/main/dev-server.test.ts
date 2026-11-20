import { describe, expect, it } from 'vitest';
import { isAllowedDevNavigation, parseDevServerUrl } from './dev-server.ts';

describe('parseDevServerUrl', () => {
  it('always returns null when the app is packaged', () => {
    expect(parseDevServerUrl('http://127.0.0.1:8081', { isPackaged: true })).toBeNull();
    expect(parseDevServerUrl('http://localhost:8081/', { isPackaged: true })).toBeNull();
    expect(parseDevServerUrl(undefined, { isPackaged: true })).toBeNull();
  });

  it('returns null when raw is undefined, empty, or whitespace', () => {
    expect(parseDevServerUrl(undefined, { isPackaged: false })).toBeNull();
    expect(parseDevServerUrl('', { isPackaged: false })).toBeNull();
    expect(parseDevServerUrl('   \t\n  ', { isPackaged: false })).toBeNull();
  });

  it('normalizes valid 127.0.0.1 and localhost origins without a trailing slash', () => {
    expect(parseDevServerUrl('http://127.0.0.1:8081', { isPackaged: false })).toBe(
      'http://127.0.0.1:8081',
    );
    expect(parseDevServerUrl('  http://127.0.0.1:8081/  ', { isPackaged: false })).toBe(
      'http://127.0.0.1:8081',
    );
    expect(parseDevServerUrl('http://localhost:8081', { isPackaged: false })).toBe(
      'http://localhost:8081',
    );
    expect(parseDevServerUrl('http://localhost:8081/', { isPackaged: false })).toBe(
      'http://localhost:8081',
    );
    expect(parseDevServerUrl('HTTP://LOCALHOST:19006/', { isPackaged: false })).toBe(
      'http://localhost:19006',
    );
    expect(parseDevServerUrl('http://127.0.0.1:1', { isPackaged: false })).toBe(
      'http://127.0.0.1:1',
    );
    expect(parseDevServerUrl('http://localhost:65535', { isPackaged: false })).toBe(
      'http://localhost:65535',
    );
  });

  it.each([
    'https://localhost:8081',
    'https://127.0.0.1:8081',
    'ws://127.0.0.1:8081',
    'app://elv:8081',
    'file:///tmp/index.html',
    'http://example.com:8081',
    'http://192.168.1.10:8081',
    'http://0.0.0.0:8081',
    'http://[::1]:8081',
    'http://sub.localhost:8081',
    'http://127.1:8081',
    'http://2130706433:8081',
    'http://127.0.0.1',
    'http://localhost/',
    'http://127.0.0.1:0',
    'http://127.0.0.1:65536',
    'http://127.0.0.1:99999',
    'http://127.0.0.1:abc',
    'http://user:pass@localhost:8081',
    'http://user@127.0.0.1:8081',
    'http://:pass@127.0.0.1:8081',
    'http://@localhost:8081',
    'http://localhost:8081/foo',
    'http://127.0.0.1:8081/index.html',
    'http://localhost:8081//',
    'http://localhost:8081?x=1',
    'http://localhost:8081/?x=1',
    'http://localhost:8081#main',
    'http://localhost:8081?',
    'http://localhost:8081#',
    'not a url',
    '://8081',
  ])('rejects %s', (candidate) => {
    expect(parseDevServerUrl(candidate, { isPackaged: false })).toBeNull();
  });
});

describe('isAllowedDevNavigation', () => {
  it('allows http navigations matching allowedOrigin without credentials', () => {
    expect(isAllowedDevNavigation('http://127.0.0.1:8081/', 'http://127.0.0.1:8081')).toBe(true);
    expect(
      isAllowedDevNavigation(
        'http://127.0.0.1:8081/index.bundle?platform=web&dev=true#hmr',
        'http://127.0.0.1:8081',
      ),
    ).toBe(true);
    expect(isAllowedDevNavigation('HTTP://LOCALHOST:8081/workbench', 'http://localhost:8081')).toBe(
      true,
    );
  });

  it.each([
    ['http://127.0.0.1:8082/', 'http://127.0.0.1:8081'],
    ['http://localhost:8081/', 'http://127.0.0.1:8081'],
    ['https://127.0.0.1:8081/', 'http://127.0.0.1:8081'],
    ['https://127.0.0.1:8081/', 'https://127.0.0.1:8081'],
    ['http://attacker.example:8081/', 'http://127.0.0.1:8081'],
    ['http://user:pass@127.0.0.1:8081/', 'http://127.0.0.1:8081'],
    ['http://user@127.0.0.1:8081/', 'http://127.0.0.1:8081'],
    ['http://:pass@127.0.0.1:8081/', 'http://127.0.0.1:8081'],
    ['file:///etc/passwd', 'http://127.0.0.1:8081'],
    ['javascript:alert(1)', 'http://127.0.0.1:8081'],
    ['http://127.0.0.1:8081/', ''],
    ['not a url', 'http://127.0.0.1:8081'],
  ])('denies %s when allowedOrigin is %s', (requestUrl, allowedOrigin) => {
    expect(isAllowedDevNavigation(requestUrl, allowedOrigin)).toBe(false);
  });
});
