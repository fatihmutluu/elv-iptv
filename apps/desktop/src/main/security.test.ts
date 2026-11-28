import { describe, expect, it, vi } from 'vitest';
import { APP_ORIGIN } from './app-protocol.ts';
import {
  isAllowedAppNavigation,
  isAllowedTrailerEmbedUrl,
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
    emitNavigation(
      event: 'will-navigate' | 'will-redirect' | 'will-frame-navigate',
      url: string,
      isMainFrame?: boolean,
    ) {
      const preventDefault = vi.fn();
      const details: NavigationEventLike =
        isMainFrame === undefined ? { url, preventDefault } : { url, isMainFrame, preventDefault };
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

  it('allows canonical youtube-nocookie trailer embeds ONLY on subframe will-frame-navigate while keeping top-level navigation locked down', () => {
    const fake = createFakeWebContents();
    lockDownWebContents(fake.contents, { devOrigin: 'http://127.0.0.1:8081' });

    const embedUrl =
      'https://www.youtube-nocookie.com/embed/8g18jFHCLXk?autoplay=1&mute=1&enablejsapi=1';

    // Top-level navigation and redirects remain strictly locked to app://elv (+ devOrigin)
    expect(fake.emitNavigation('will-navigate', embedUrl)).toBe(true);
    expect(fake.emitNavigation('will-redirect', embedUrl)).toBe(true);
    expect(fake.emitNavigation('will-frame-navigate', embedUrl, true)).toBe(true);

    // Subframe navigation to canonical youtube-nocookie embed is allowed ONLY when isMainFrame === false (fail-closed)
    expect(fake.emitNavigation('will-frame-navigate', embedUrl, false)).toBe(false);
    expect(fake.emitNavigation('will-frame-navigate', embedUrl)).toBe(true);

    // All other external subframe navigations stay blocked
    for (const blocked of [
      'https://www.youtube.com/embed/8g18jFHCLXk',
      'https://youtube-nocookie.com/embed/8g18jFHCLXk',
      'https://www.youtube-nocookie.com/watch?v=8g18jFHCLXk',
      'https://www.youtube-nocookie.com/embed/short',
      'http://www.youtube-nocookie.com/embed/8g18jFHCLXk',
      'https://user:pass@www.youtube-nocookie.com/embed/8g18jFHCLXk',
      'https://www.youtube-nocookie.com:8443/embed/8g18jFHCLXk',
      'https://www.youtube-nocookie.com:443/embed/8g18jFHCLXk',
      'https://attacker.example/embed/8g18jFHCLXk',
      'file:///etc/passwd',
    ]) {
      expect(fake.emitNavigation('will-frame-navigate', blocked, false)).toBe(true);
    }
  });
});

describe('isAllowedTrailerEmbedUrl', () => {
  it('accepts canonical HTTPS www.youtube-nocookie.com/embed/<11-char-id> URLs', () => {
    expect(isAllowedTrailerEmbedUrl('https://www.youtube-nocookie.com/embed/8g18jFHCLXk')).toBe(
      true,
    );
    expect(
      isAllowedTrailerEmbedUrl(
        'https://www.youtube-nocookie.com/embed/abc_123-XYZ?autoplay=1&mute=1&controls=0&rel=0&playsinline=1&modestbranding=1&iv_load_policy=3&disablekb=1&fs=0&loop=1&playlist=abc_123-XYZ&enablejsapi=1',
      ),
    ).toBe(true);
    expect(isAllowedTrailerEmbedUrl('HTTPS://WWW.YOUTUBE-NOCOOKIE.COM/embed/8g18jFHCLXk#t=5')).toBe(
      true,
    );
  });

  it.each([
    '',
    'not a url',
    'http://www.youtube-nocookie.com/embed/8g18jFHCLXk',
    'https://youtube-nocookie.com/embed/8g18jFHCLXk',
    'https://www.youtube.com/embed/8g18jFHCLXk',
    'https://www.youtube-nocookie.com.evil.example/embed/8g18jFHCLXk',
    'https://www.youtube-nocookie.com/watch?v=8g18jFHCLXk',
    'https://www.youtube-nocookie.com/EMBED/8g18jFHCLXk',
    'https://www.youtube-nocookie.com/embed/short',
    'https://www.youtube-nocookie.com/embed/toolong12345',
    'https://www.youtube-nocookie.com/embed/8g18jFHCLXk/',
    'https://www.youtube-nocookie.com/embed/8g18jFHCLXk/extra',
    'https://www.youtube-nocookie.com/watch/../embed/8g18jFHCLXk',
    'https://user:pass@www.youtube-nocookie.com/embed/8g18jFHCLXk',
    'https://user@www.youtube-nocookie.com/embed/8g18jFHCLXk',
    'https://www.youtube-nocookie.com:443/embed/8g18jFHCLXk',
    'https://www.youtube-nocookie.com:8443/embed/8g18jFHCLXk',
    ' https://www.youtube-nocookie.com/embed/8g18jFHCLXk',
    'https://www.youtube-nocookie.com/embed/8g18jFHCLXk\n',
    'file:///etc/passwd',
    'javascript:alert(1)',
  ])('rejects %s', (url) => {
    expect(isAllowedTrailerEmbedUrl(url)).toBe(false);
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
