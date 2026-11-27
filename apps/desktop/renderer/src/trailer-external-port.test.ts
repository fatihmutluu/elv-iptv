import { describe, expect, it, vi } from 'vitest';
import {
  createDesktopTrailerExternalPort,
  isAllowedDesktopTrailerUrl,
} from './trailer-external-port.ts';

describe('createDesktopTrailerExternalPort (#512)', () => {
  it('allows strict https YouTube URLs only', () => {
    expect(isAllowedDesktopTrailerUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true);
    expect(isAllowedDesktopTrailerUrl('https://youtu.be/dQw4w9WgXcQ')).toBe(true);
    expect(isAllowedDesktopTrailerUrl('https://m.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true);
    expect(isAllowedDesktopTrailerUrl('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ')).toBe(
      true,
    );
    expect(isAllowedDesktopTrailerUrl('http://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(false);
    expect(isAllowedDesktopTrailerUrl('https://evil.example.com/watch?v=dQw4w9WgXcQ')).toBe(false);
    expect(isAllowedDesktopTrailerUrl('https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ')).toBe(
      false,
    );
    expect(isAllowedDesktopTrailerUrl('javascript:alert(1)')).toBe(false);
    expect(
      isAllowedDesktopTrailerUrl('https://user:pass@www.youtube.com/watch?v=dQw4w9WgXcQ'),
    ).toBe(false);
    expect(isAllowedDesktopTrailerUrl('https://www.youtube.com:8443/watch?v=dQw4w9WgXcQ')).toBe(
      false,
    );
  });

  it('delegates valid URLs to window bridge and rejects disallowed URLs before IPC', async () => {
    const openExternalUrl = vi.fn(async () => true);
    const port = createDesktopTrailerExternalPort({ openExternalUrl });

    expect(await port.openExternalUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true);
    expect(openExternalUrl).toHaveBeenCalledWith('https://www.youtube.com/watch?v=dQw4w9WgXcQ');

    expect(await port.openExternalUrl('https://evil.example.com/phish')).toBe(false);
    expect(openExternalUrl).toHaveBeenCalledTimes(1);
  });

  it('returns false gracefully when bridge is unavailable or throws', async () => {
    const noBridgePort = createDesktopTrailerExternalPort(undefined);
    expect(await noBridgePort.openExternalUrl('https://youtu.be/dQw4w9WgXcQ')).toBe(false);

    const failingPort = createDesktopTrailerExternalPort({
      openExternalUrl: vi.fn(async () => {
        throw new Error('ipc failed');
      }),
    });
    expect(await failingPort.openExternalUrl('https://youtu.be/dQw4w9WgXcQ')).toBe(false);
  });
});
