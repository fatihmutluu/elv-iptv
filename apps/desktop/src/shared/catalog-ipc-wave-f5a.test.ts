import { describe, expect, it } from 'vitest';
import { isCatalogClientMessage } from './catalog-ipc.ts';

const call = (c: unknown) => ({ type: 'call', reqId: 1, call: c });

describe('Wave F5A catalog IPC guards (#157, #317, #172)', () => {
  it('validates transport dnsFamily & hostOverride on addSource and updateSourceSettings (#172)', () => {
    const validCalls: unknown[] = [
      {
        method: 'addSource',
        input: {
          kind: 'm3u',
          name: 'V4 Source',
          playlistUrl: 'https://provider.example.test/list.m3u',
          transport: { dnsFamily: 'ipv4', hostOverride: '203.0.113.10' },
        },
      },
      {
        method: 'addSource',
        input: {
          kind: 'xtream',
          name: 'V6 Xtream',
          server: 'https://primary.example.test',
          backupServers: [
            'https://mirror1.example.test:8443',
            'http://mirror2.example.test',
            'mirror3.example.test:8080',
          ],
          username: 'demo',
          password: 'secret',
          transport: { dnsFamily: 'ipv6', hostOverride: '[2001:db8::10]' },
        },
      },
      {
        method: 'updateSourceSettings',
        sourceId: 's1',
        patch: {
          transport: { dnsFamily: 'ipv4', hostOverride: '198.51.100.42' },
        },
      },
      {
        method: 'updateSourceSettings',
        sourceId: 's1',
        patch: {
          // Empty string clears an existing hostOverride via mergeSourceSettings
          transport: { dnsFamily: 'system', hostOverride: '' },
        },
      },
    ];
    for (const c of validCalls) {
      expect(isCatalogClientMessage(call(c))).toBe(true);
    }

    const invalidCalls: unknown[] = [
      {
        method: 'updateSourceSettings',
        sourceId: 's1',
        patch: { transport: { dnsFamily: 'ipv5' } },
      },
      {
        method: 'updateSourceSettings',
        sourceId: 's1',
        patch: { transport: { dnsFamily: 'IPV4' } },
      },
      {
        method: 'updateSourceSettings',
        sourceId: 's1',
        patch: { transport: { dnsFamily: 4 } },
      },
      {
        method: 'updateSourceSettings',
        sourceId: 's1',
        patch: { transport: { hostOverride: 'evil.example' } },
      },
      {
        method: 'updateSourceSettings',
        sourceId: 's1',
        patch: { transport: { hostOverride: '203.0.113.10:8080' } },
      },
      {
        method: 'updateSourceSettings',
        sourceId: 's1',
        patch: { transport: { hostOverride: 'http://203.0.113.10' } },
      },
      {
        method: 'updateSourceSettings',
        sourceId: 's1',
        patch: { transport: { hostOverride: 'fe80::1%eth0' } },
      },
      {
        method: 'updateSourceSettings',
        sourceId: 's1',
        patch: { transport: { hostOverride: '203.0.113.10\n' } },
      },
      {
        method: 'updateSourceSettings',
        sourceId: 's1',
        patch: { transport: { hostOverride: 123 } },
      },
      {
        method: 'updateSourceSettings',
        sourceId: 's1',
        patch: { transport: { hostOverride: null } },
      },
      {
        method: 'addSource',
        input: {
          kind: 'm3u',
          name: 'Bad Host',
          playlistUrl: 'https://provider.example.test/list.m3u',
          transport: { hostOverride: 'not-an-ip.example' },
        },
      },
      {
        method: 'addSource',
        input: {
          kind: 'xtream',
          name: 'Too Many Backups',
          server: 'https://primary.example.test',
          backupServers: Array.from({ length: 17 }, (_, i) => `https://m${i}.example.test`),
          username: 'u',
          password: 'p',
        },
      },
      {
        method: 'addSource',
        input: {
          kind: 'xtream',
          name: 'Empty Backup',
          server: 'https://primary.example.test',
          backupServers: ['   '],
          username: 'u',
          password: 'p',
        },
      },
      {
        method: 'addSource',
        input: {
          kind: 'xtream',
          name: 'Bad Scheme Backup',
          server: 'https://primary.example.test',
          backupServers: ['file:///etc/passwd'],
          username: 'u',
          password: 'p',
        },
      },
      {
        method: 'addSource',
        input: {
          kind: 'xtream',
          name: 'Javascript Scheme Backup',
          server: 'https://primary.example.test',
          backupServers: ['javascript:alert(1)'],
          username: 'u',
          password: 'p',
        },
      },
      {
        method: 'addSource',
        input: {
          kind: 'xtream',
          name: 'Control Char Backup',
          server: 'https://primary.example.test',
          backupServers: ['https://mirror.example.test\r\n'],
          username: 'u',
          password: 'p',
        },
      },
      {
        method: 'addSource',
        input: {
          kind: 'xtream',
          name: 'Oversized Backup',
          server: 'https://primary.example.test',
          backupServers: [`https://mirror.example.test/${'a'.repeat(2_049)}`],
          username: 'u',
          password: 'p',
        },
      },
      {
        method: 'addSource',
        input: {
          kind: 'xtream',
          name: 'Non-Array Backup',
          server: 'https://primary.example.test',
          backupServers: 'https://mirror.example.test',
          username: 'u',
          password: 'p',
        },
      },
    ];
    for (const c of invalidCalls) {
      expect(isCatalogClientMessage(call(c))).toBe(false);
    }
  });

  it('validates all 11 failover group and stream outcome RPC calls (#157, #317)', () => {
    const validCalls: unknown[] = [
      { method: 'listFailoverGroups' },
      { method: 'getFailoverGroupByChannel', channelKey: 'x:s1:live:101' },
      {
        method: 'createFailoverGroup',
        input: {
          id: 'fg_news_1',
          name: 'News One',
          autoMatched: false,
          channelKeys: ['x:s1:live:101', 'm:s2:ch1'],
          nowMs: 1_700_000_000_000,
        },
      },
      { method: 'createFailoverGroup', input: { name: 'Sports HD' } },
      { method: 'renameFailoverGroup', groupId: 'fg_news_1', name: 'News 24' },
      { method: 'deleteFailoverGroup', groupId: 'fg_news_1' },
      { method: 'addFailoverGroupMember', groupId: 'fg_news_1', channelKey: 'm:s3:ch9' },
      { method: 'removeFailoverGroupMember', groupId: 'fg_news_1', channelKey: 'm:s3:ch9' },
      {
        method: 'reorderFailoverGroupMembers',
        groupId: 'fg_news_1',
        orderedChannelKeys: ['m:s2:ch1', 'x:s1:live:101'],
      },
      { method: 'suggestFailoverGroups' },
      {
        method: 'applySuggestedFailoverGroups',
        clusters: [
          {
            normalizedKey: 'guide:news.one',
            suggestedName: 'News One',
            matchReason: 'guide-id',
            members: [
              {
                sourceId: 's1',
                channelKey: 'x:s1:live:101',
                channelName: 'News One HD',
                sourceName: 'Provider A',
              },
              {
                sourceId: 's2',
                channelKey: 'm:s2:ch1',
                channelName: '[TR] News One 4K',
                sourceName: 'Provider B',
              },
            ],
          },
        ],
      },
      {
        method: 'reportStreamOutcome',
        sourceId: 's1',
        serverUrl: 'https://stream1.example.test:8443/live/u/p/1.ts',
        succeeded: false,
      },
      {
        method: 'reportStreamOutcome',
        sourceId: 's1',
        serverUrl: 'http://stream2.example.test',
        succeeded: true,
      },
    ];
    for (const c of validCalls) {
      expect(isCatalogClientMessage(call(c))).toBe(true);
    }
  });

  it('rejects invalid failover group and reportStreamOutcome payloads and prototype pollution', () => {
    const invalidCalls: unknown[] = [
      { method: 'listFailoverGroups', extra: 1 },
      { method: 'getFailoverGroupByChannel', channelKey: '' },
      { method: 'getFailoverGroupByChannel', channelKey: 'http://evil.test/ch' },
      { method: 'getFailoverGroupByChannel', channelKey: 'x:s1:live:1', extra: true },
      { method: 'createFailoverGroup', input: null },
      { method: 'createFailoverGroup', input: { name: '   ' } },
      { method: 'createFailoverGroup', input: { name: 'a'.repeat(101) } },
      { method: 'createFailoverGroup', input: { name: 'Bad\nName' } },
      { method: 'createFailoverGroup', input: { id: '../bad', name: 'Ok' } },
      { method: 'createFailoverGroup', input: { name: 'Ok', autoMatched: 'yes' } },
      { method: 'createFailoverGroup', input: { name: 'Ok', channelKeys: ['http://evil.test/1'] } },
      {
        method: 'createFailoverGroup',
        input: { name: 'Ok', channelKeys: Array.from({ length: 129 }, (_, i) => `m:s1:ch${i}`) },
      },
      { method: 'createFailoverGroup', input: { name: 'Ok', nowMs: -1 } },
      { method: 'createFailoverGroup', input: { name: 'Ok', extra: 1 } },
      { method: 'renameFailoverGroup', groupId: '../bad', name: 'Ok' },
      { method: 'renameFailoverGroup', groupId: 'fg_1', name: '' },
      { method: 'renameFailoverGroup', groupId: 'fg_1', name: 'Bad\rName' },
      { method: 'deleteFailoverGroup', groupId: '' },
      { method: 'deleteFailoverGroup', groupId: '../bad' },
      { method: 'addFailoverGroupMember', groupId: '../bad', channelKey: 'm:s1:ch1' },
      { method: 'addFailoverGroupMember', groupId: 'fg_1', channelKey: 'http://evil.test/ch' },
      { method: 'removeFailoverGroupMember', groupId: 'fg_1', channelKey: 'bad\nkey' },
      {
        method: 'reorderFailoverGroupMembers',
        groupId: 'fg_1',
        orderedChannelKeys: 'not-array',
      },
      {
        method: 'reorderFailoverGroupMembers',
        groupId: 'fg_1',
        orderedChannelKeys: Array.from({ length: 129 }, (_, i) => `m:s1:ch${i}`),
      },
      { method: 'suggestFailoverGroups', extra: 1 },
      { method: 'applySuggestedFailoverGroups', clusters: 'nope' },
      {
        method: 'applySuggestedFailoverGroups',
        clusters: [
          {
            normalizedKey: 'name:news',
            suggestedName: 'News',
            matchReason: 'bogus',
            members: [],
          },
        ],
      },
      {
        method: 'applySuggestedFailoverGroups',
        clusters: [
          {
            normalizedKey: 'name:news',
            suggestedName: 'News\nInjected',
            matchReason: 'name',
            members: [],
          },
        ],
      },
      {
        method: 'applySuggestedFailoverGroups',
        clusters: [
          {
            normalizedKey: 'name:news',
            suggestedName: 'News',
            matchReason: 'name',
            members: [
              {
                sourceId: '../bad',
                channelKey: 'm:s1:ch1',
                channelName: 'News',
                sourceName: 'A',
              },
            ],
          },
        ],
      },
      {
        method: 'reportStreamOutcome',
        sourceId: '../bad',
        serverUrl: 'https://stream.example.test',
        succeeded: true,
      },
      {
        method: 'reportStreamOutcome',
        sourceId: 's1',
        serverUrl: 'file:///etc/passwd',
        succeeded: true,
      },
      {
        method: 'reportStreamOutcome',
        sourceId: 's1',
        serverUrl: 'https://stream.example.test\n',
        succeeded: false,
      },
      {
        method: 'reportStreamOutcome',
        sourceId: 's1',
        serverUrl: 'https://stream.example.test',
        succeeded: 'yes',
      },
      {
        method: 'reportStreamOutcome',
        sourceId: 's1',
        serverUrl: 'https://stream.example.test',
        succeeded: true,
        extra: 1,
      },
    ];
    for (const c of invalidCalls) {
      expect(isCatalogClientMessage(call(c))).toBe(false);
    }

    const protoInjected = JSON.parse(
      '{"type":"call","reqId":1,"call":{"method":"createFailoverGroup","input":{"name":"Ok","__proto__":{"polluted":true}}}}',
    );
    expect(isCatalogClientMessage(protoInjected)).toBe(false);
  });
});
