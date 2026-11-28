import { describe, expect, it } from 'vitest';
import { isCatalogClientMessage } from './catalog-ipc.ts';

const call = (c: unknown) => ({ type: 'call', reqId: 1, call: c });

describe('Wave Q6 catalog IPC transport.streamUserAgent validation', () => {
  it('accepts transport.streamUserAgent across addSource, addSourceFromLink, addLocalM3uSource, and updateSourceSettings', () => {
    const validCalls = [
      {
        method: 'addSource',
        input: {
          kind: 'm3u',
          name: 'Split UA M3U',
          playlistUrl: 'https://cdn.example.test/list.m3u',
          transport: {
            userAgent: 'FeedAgent/1.0',
            streamUserAgent: 'PlayerAgent/2.0',
          },
        },
      },
      {
        method: 'addSource',
        input: {
          kind: 'xtream',
          name: 'Split UA Xtream',
          server: 'https://xc.example.test/panel_api.php',
          username: 'u',
          password: 'p',
          transport: {
            streamUserAgent: 'PlayerAgent/2.0',
          },
        },
      },
      {
        method: 'addSourceFromLink',
        input: {
          name: 'Link Split UA',
          url: 'https://cdn.example.test/get.php?username=u&password=p',
          transport: {
            userAgent: 'FeedAgent/1.0',
            streamUserAgent: 'PlayerAgent/2.0',
          },
        },
      },
      {
        method: 'addLocalM3uSource',
        input: {
          name: 'Local Split UA',
          bytes: new Uint8Array([0x23, 0x45, 0x58, 0x54]),
          transport: {
            streamUserAgent: 'PlayerAgent/2.0',
          },
        },
      },
      {
        method: 'updateSourceSettings',
        sourceId: 'src-1',
        patch: {
          transport: {
            dnsFamily: 'ipv4',
            hostOverride: '',
            userAgent: 'FeedAgent/1.0',
            streamUserAgent: 'UpdatedPlayer/3.0',
          },
        },
      },
      {
        method: 'updateSourceSettings',
        sourceId: 'src-1',
        patch: {
          transport: {
            streamUserAgent: '',
          },
        },
      },
    ];

    for (const c of validCalls) {
      expect(isCatalogClientMessage(call(c))).toBe(true);
    }
  });

  it('rejects control characters, non-strings, and oversized values in transport.streamUserAgent', () => {
    const invalidValues: unknown[] = [
      'Player\r\nX-Inject: 1',
      'Player\nAgent',
      'Player\0Agent',
      'Player\x7fAgent',
      123,
      null,
      true,
      { ua: 'x' },
      'A'.repeat(9_000),
    ];

    for (const bad of invalidValues) {
      expect(
        isCatalogClientMessage(
          call({
            method: 'addSource',
            input: {
              kind: 'm3u',
              name: 'Bad UA',
              playlistUrl: 'https://cdn.example.test/list.m3u',
              transport: { streamUserAgent: bad },
            },
          }),
        ),
      ).toBe(false);
      expect(
        isCatalogClientMessage(
          call({
            method: 'updateSourceSettings',
            sourceId: 'src-1',
            patch: { transport: { streamUserAgent: bad } },
          }),
        ),
      ).toBe(false);
    }
  });
});
