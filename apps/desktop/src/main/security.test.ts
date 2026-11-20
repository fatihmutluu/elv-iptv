import { describe, expect, it, vi } from 'vitest';
import { APP_ORIGIN } from './app-protocol.ts';
import {
  isAllowedAppNavigation,
  lockDownSession,
  lockDownWebContents,
  type NavigationEventLike,
  type SessionGuardTarget,
  type WebContentsGuardTarget,
} from './security.ts';

type NavigationListener = (details: NavigationEventLike, url: string) => void;

function createFakeWebContents() {
  const listeners = new Map<string, NavigationListener[]>();
  let windowOpenHandler: (() => { action: 'deny' | 'allow' }) | undefined;
  const contents: WebContentsGuardTarget = {
    setWindowOpenHandler(handler) {
      windowOpenHandler = handler;
    },
    on(
      event: 'will-navigate' | 'will-redirect' | 'will-frame-navigate',
      listener: (details: NavigationEventLike, url: string) => void,
    ) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return contents;
    },
  };
  return {
    contents,
    openWindow() {
      return windowOpenHandler?.();
    },
    emitNavigation(event: 'will-navigate' | 'will-redirect' | 'will-frame-navigate', url: string) {
      const preventDefault = vi.fn();
      const details: NavigationEventLike = { url, preventDefault };
      for (const listener of listeners.get(event) ?? []) {
        if (event === 'will-frame-navigate') {
          (listener as (details: NavigationEventLike) => void)(details);
        } else {
          listener(details, url);
        }
      }
      return preventDefault.mock.calls.length > 0;
    },
  };
}

describe('isAllowedAppNavigation', () => {
  it('allows canonical app://elv URLs', () => {
    expect(isAllowedAppNavigation(APP_ORIGIN)).toBe(true);
    expect(isAllowedAppNavigation(`${APP_ORIGIN}/`)).toBe(true);
    expect(isAllowedAppNavigation(`${APP_ORIGIN}/index.html?x=1#main`)).toBe(true);
    expect(isAllowedAppNavigation('APP://ELV/settings')).toBe(true);
  });

  it.each([
    'https://example.com/',
    'http://127.0.0.1:7878/',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,<h1>x</h1>',
    'app://other/index.html',
    'app://elv.evil.example/index.html',
    'app://user:pass@elv/index.html',
    'app://elv:8080/index.html',
    'not a url',
  ])('denies %s', (url) => {
    expect(isAllowedAppNavigation(url)).toBe(false);
  });
});

describe('lockDownWebContents', () => {
  it('denies window.open and blocks off-origin will-navigate, will-redirect, and will-frame-navigate', () => {
    const fake = createFakeWebContents();
    lockDownWebContents(fake.contents);

    expect(fake.openWindow()).toEqual({ action: 'deny' });

    for (const event of ['will-navigate', 'will-redirect', 'will-frame-navigate'] as const) {
      expect(fake.emitNavigation(event, `${APP_ORIGIN}/`)).toBe(false);
      expect(fake.emitNavigation(event, `${APP_ORIGIN}/player`)).toBe(false);
      expect(fake.emitNavigation(event, 'http://127.0.0.1:8081/')).toBe(true);
      expect(fake.emitNavigation(event, 'https://attacker.example/')).toBe(true);
      expect(fake.emitNavigation(event, 'file:///C:/Windows/win.ini')).toBe(true);
      expect(fake.emitNavigation(event, 'app://user@elv/index.html')).toBe(true);
      expect(fake.emitNavigation(event, 'app://elv:80/index.html')).toBe(true);
    }
  });

  it('allows same-origin dev navigation when devOrigin is set while denying other origins and window.open', () => {
    const fake = createFakeWebContents();
    lockDownWebContents(fake.contents, { devOrigin: 'http://127.0.0.1:8081' });

    expect(fake.openWindow()).toEqual({ action: 'deny' });

    for (const event of ['will-navigate', 'will-redirect', 'will-frame-navigate'] as const) {
      expect(fake.emitNavigation(event, `${APP_ORIGIN}/`)).toBe(false);
      expect(fake.emitNavigation(event, 'http://127.0.0.1:8081/')).toBe(false);
      expect(fake.emitNavigation(event, 'http://127.0.0.1:8081/workbench?tab=rail#top')).toBe(
        false,
      );
      expect(fake.emitNavigation(event, 'http://127.0.0.1:8082/')).toBe(true);
      expect(fake.emitNavigation(event, 'http://localhost:8081/')).toBe(true);
      expect(fake.emitNavigation(event, 'https://127.0.0.1:8081/')).toBe(true);
      expect(fake.emitNavigation(event, 'https://attacker.example/')).toBe(true);
      expect(fake.emitNavigation(event, 'file:///C:/Windows/win.ini')).toBe(true);
      expect(fake.emitNavigation(event, 'http://user:pass@127.0.0.1:8081/')).toBe(true);
    }
  });

  it('treats null or empty devOrigin identically to no devOrigin', () => {
    for (const devOrigin of [null, ''] as const) {
      const fake = createFakeWebContents();
      lockDownWebContents(fake.contents, { devOrigin });
      expect(fake.emitNavigation('will-navigate', `${APP_ORIGIN}/`)).toBe(false);
      expect(fake.emitNavigation('will-navigate', 'http://127.0.0.1:8081/')).toBe(true);
    }
  });
});

describe('lockDownSession', () => {
  it('denies all permission checks and permission requests by default', () => {
    const captured: {
      request?: Parameters<SessionGuardTarget['setPermissionRequestHandler']>[0];
      check?: Parameters<SessionGuardTarget['setPermissionCheckHandler']>[0];
    } = {};

    lockDownSession({
      setPermissionRequestHandler(handler) {
        captured.request = handler;
      },
      setPermissionCheckHandler(handler) {
        captured.check = handler;
      },
    });

    expect(captured.check).toBeDefined();
    expect(captured.check?.(null, 'media', `${APP_ORIGIN}/`)).toBe(false);
    expect(captured.check?.(null, 'notifications', 'https://example.com')).toBe(false);

    const granted = vi.fn();
    captured.request?.(null, 'geolocation', granted);
    expect(granted).toHaveBeenCalledWith(false);
  });
});
