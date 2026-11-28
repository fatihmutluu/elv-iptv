import { describe, expect, it, vi } from 'vitest';
import {
  assertTrustedSenderFrame,
  isTrustedSenderFrame,
  type TrustedSenderEventLike,
} from './trusted-sender.ts';

function makeTopFrame(url: string): { url: string; top: unknown } {
  const frame: { url: string; top: unknown } = { url, top: undefined };
  frame.top = frame;
  return frame;
}

describe('trusted-sender', () => {
  it('accepts top-level app://elv frames and rejects subframes, missing frames, and untrusted origins', () => {
    const topApp = makeTopFrame('app://elv/index.html');
    const topAppNoProp = { url: 'app://elv/' };
    const subFrame = { url: 'app://elv/index.html', top: topApp };
    const detachedFrame = { url: 'app://elv/index.html', top: null };

    expect(isTrustedSenderFrame({ senderFrame: topApp })).toBe(true);
    expect(isTrustedSenderFrame({ senderFrame: topAppNoProp })).toBe(false);
    expect(isTrustedSenderFrame({ senderFrame: subFrame })).toBe(false);
    expect(isTrustedSenderFrame({ senderFrame: detachedFrame })).toBe(false);
    expect(isTrustedSenderFrame({ senderFrame: null })).toBe(false);
    expect(isTrustedSenderFrame({ senderFrame: undefined })).toBe(false);
    expect(isTrustedSenderFrame({})).toBe(false);
    expect(isTrustedSenderFrame(null)).toBe(false);
    expect(isTrustedSenderFrame(undefined)).toBe(false);
    expect(isTrustedSenderFrame({ senderFrame: makeTopFrame('') })).toBe(false);
    expect(isTrustedSenderFrame({ senderFrame: makeTopFrame('https://evil.example/') })).toBe(
      false,
    );
    expect(isTrustedSenderFrame({ senderFrame: makeTopFrame('app://elv:8080/') })).toBe(false);
    expect(isTrustedSenderFrame({ senderFrame: makeTopFrame('app://user:pw@elv/') })).toBe(false);
    expect(isTrustedSenderFrame({ senderFrame: makeTopFrame('file:///C:/index.html') })).toBe(
      false,
    );
  });

  it('never falls back to event.sender.getURL() when senderFrame is missing or null', () => {
    const spoofedEvent = {
      senderFrame: null,
      sender: { getURL: () => 'app://elv/index.html' },
    } as TrustedSenderEventLike;
    expect(isTrustedSenderFrame(spoofedEvent)).toBe(false);

    const missingFrameEvent = {
      sender: { getURL: () => 'app://elv/index.html' },
    } as TrustedSenderEventLike;
    expect(isTrustedSenderFrame(missingFrameEvent)).toBe(false);
  });

  it('allows matching top-level devOrigin only when explicitly configured', () => {
    const devTop = makeTopFrame('http://127.0.0.1:8081/index.html');
    const devSub = { url: 'http://127.0.0.1:8081/index.html', top: devTop };

    expect(isTrustedSenderFrame({ senderFrame: devTop }, null)).toBe(false);
    expect(isTrustedSenderFrame({ senderFrame: devTop }, undefined)).toBe(false);
    expect(isTrustedSenderFrame({ senderFrame: devTop }, '')).toBe(false);
    expect(isTrustedSenderFrame({ senderFrame: devTop }, 'http://127.0.0.1:8081')).toBe(true);
    expect(isTrustedSenderFrame({ senderFrame: devSub }, 'http://127.0.0.1:8081')).toBe(false);
    expect(
      isTrustedSenderFrame(
        { senderFrame: makeTopFrame('http://127.0.0.1:9999/') },
        'http://127.0.0.1:8081',
      ),
    ).toBe(false);
  });

  it('throws and logs channel name on assertTrustedSenderFrame failure without leaking URLs', () => {
    const log = vi.fn();
    expect(() =>
      assertTrustedSenderFrame(
        { senderFrame: makeTopFrame('app://elv/index.html') },
        'window:open-popout',
        null,
        log,
      ),
    ).not.toThrow();
    expect(log).not.toHaveBeenCalled();

    expect(() =>
      assertTrustedSenderFrame(
        { senderFrame: makeTopFrame('https://evil.example/secret-token-123') },
        'window:open-popout',
        null,
        log,
      ),
    ).toThrow(/untrusted sender.*window:open-popout/i);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain('window:open-popout');
    expect(log.mock.calls[0]?.[0]).not.toContain('secret-token-123');
    expect(log.mock.calls[0]?.[0]).not.toContain('evil.example');
  });
});
