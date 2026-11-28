import { describe, expect, it } from 'vitest';
import { sanitizeAddSourceInput } from './catalog-worker-sanitize.ts';

describe('sanitizeAddSourceInput Xtream /panel_api.php parity', () => {
  it('accepts primary and backup Xtream servers ending with /panel_api.php', () => {
    const res = sanitizeAddSourceInput({
      kind: 'xtream',
      name: 'Panel API Source',
      server: '  https://panel.example.test:8443/panel_api.php?foo=1  ',
      backupServers: [
        'mirror.example.test:8080/panel_api.php',
        'https://m2.example.test/player_api.php',
      ],
      username: 'u',
      password: 'p',
      transport: {
        userAgent: 'FeedAgent/1.0',
        streamUserAgent: 'PlayerAgent/2.0',
      },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toMatchObject({
      kind: 'xtream',
      server: 'https://panel.example.test:8443/panel_api.php?foo=1',
      backupServers: [
        'mirror.example.test:8080/panel_api.php',
        'https://m2.example.test/player_api.php',
      ],
      transport: {
        userAgent: 'FeedAgent/1.0',
        streamUserAgent: 'PlayerAgent/2.0',
      },
    });
  });

  it('rejects hostless /panel_api.php URLs after stripping the Xtream endpoint tail', () => {
    const res = sanitizeAddSourceInput({
      kind: 'xtream',
      name: 'Hostless Panel API',
      server: 'http:///panel_api.php',
      username: 'u',
      password: 'p',
    });
    expect(res.ok).toBe(false);
  });
});
