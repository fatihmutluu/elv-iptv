import { describe, expect, it } from 'vitest';
import { createSyncApp, type SyncAppConfig } from './app.ts';
import type { TelemetryDigestReport } from './digest.ts';
import { createMemoryStorage } from './storage-memory.ts';

const TEST_JWT_SECRET = 'jwt-p9-telemetry-secret-0123456789abcdef';
const TEST_ADMIN_TOKEN = 'admin-p9-telemetry-token-0123456789abcdef';

function makeApp(overrides: Partial<SyncAppConfig> = {}) {
  const currentMs = Date.parse('2026-11-27T12:00:00.000Z');
  const storage = overrides.storage ?? createMemoryStorage();
  const app = createSyncApp({
    storage,
    jwtSecret: TEST_JWT_SECRET,
    adminToken: TEST_ADMIN_TOKEN,
    verifierHashIterations: 1_000,
    now: () => currentMs,
    ...overrides,
  });
  return { app, storage };
}

function jsonReq(
  path: string,
  method: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Request {
  const init: RequestInit = {
    method,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
  };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  return new Request(`https://sync.example.test${path}`, init);
}

describe('Wave P9: Expanded Telemetry Ingestion & Admin Digest', () => {
  it('validates new event kinds, deviceProfile fields, and PII/email bans', async () => {
    const { app } = makeApp();

    const invalidBatches = [
      // Disallowed deviceProfile key
      {
        sessionId: 'sess-bad-profile',
        appVersion: '1.4.0',
        platform: 'windows',
        deviceProfile: { arch: 'x64', hostname: 'forbidden-field' },
        events: [{ kind: 'startup', durationMs: 200 }],
      },
      // Non-object deviceProfile
      {
        sessionId: 'sess-bad-profile-type',
        appVersion: '1.4.0',
        platform: 'windows',
        deviceProfile: 'windows-x64',
        events: [{ kind: 'startup', durationMs: 200 }],
      },
      // Email address PII in stackSig
      {
        sessionId: 'sess-bad-email',
        appVersion: '1.4.0',
        platform: 'windows',
        events: [
          {
            kind: 'unhandled_error',
            errorName: 'TypeError',
            stackSig: 'alice@example.com failed',
          },
        ],
      },
      // Missing required errorName on app_crash
      {
        sessionId: 'sess-missing-err',
        appVersion: '1.4.0',
        platform: 'windows',
        events: [{ kind: 'app_crash', stackSig: 'sig_1', fatal: true }],
      },
      // Missing required sourceKind on catalog_import
      {
        sessionId: 'sess-missing-src',
        appVersion: '1.4.0',
        platform: 'windows',
        events: [{ kind: 'catalog_import', stage: 'parse', durationMs: 120, success: true }],
      },
    ];

    for (const batch of invalidBatches) {
      const res = await app.fetch(jsonReq('/v1/telemetry', 'POST', batch));
      expect(res.status).toBe(400);
    }
  });

  it('ingests app_crash, unhandled_error, catalog_import, and deviceProfile and aggregates them in admin digest', async () => {
    const { app } = makeApp();

    const b1 = await app.fetch(
      jsonReq('/v1/telemetry', 'POST', {
        sessionId: 'sess-p9-1',
        appVersion: '1.4.0',
        platform: 'windows',
        osVersion: '11.0',
        formFactor: 'desktop',
        deviceProfile: {
          arch: 'x64',
          ramBucket: '16gb',
          gpu: 'NVIDIA RTX 4070',
          resolution: '2560x1440',
          locale: 'en-US',
        },
        events: [
          {
            kind: 'app_crash',
            errorName: 'SIGSEGV',
            stackSig: 'libmpv_render_0x1a',
            screen: 'player',
            fatal: true,
            uptimeMs: 45_000,
          },
          {
            kind: 'unhandled_error',
            errorName: 'TypeError',
            stackSig: 'epgGrid_render_112',
            screen: 'epg-grid',
            source: 'unhandledrejection',
          },
          {
            kind: 'catalog_import',
            sourceKind: 'xtream',
            stage: 'sync_live',
            durationMs: 1200,
            itemCount: 15_000,
            success: true,
          },
          {
            kind: 'catalog_import',
            sourceKind: 'xtream',
            stage: 'sync_epg',
            durationMs: 3400,
            itemCount: 0,
            success: false,
            errorCode: 'TIMEOUT',
          },
        ],
      }),
    );
    expect(b1.status).toBe(200);
    expect(await b1.json()).toEqual({ accepted: 4, disabled: false });

    const b2 = await app.fetch(
      jsonReq('/v1/telemetry', 'POST', {
        sessionId: 'sess-p9-2',
        appVersion: '1.4.0',
        platform: 'android-tv',
        deviceProfile: {
          formFactor: 'tv',
          osVersion: '14',
          arch: 'arm64',
          ramBucket: '2gb',
          gpu: 'Mali-G57',
          resolution: '1920x1080',
          locale: 'tr-TR',
        },
        events: [
          {
            kind: 'app_crash',
            errorName: 'SIGSEGV',
            stackSig: 'libmpv_render_0x1a',
            screen: 'player',
            fatal: true,
            uptimeMs: 12_000,
          },
          {
            kind: 'catalog_import',
            sourceKind: 'm3u',
            stage: 'parse',
            durationMs: 650,
            itemCount: 5_000,
            success: true,
          },
        ],
      }),
    );
    expect(b2.status).toBe(200);

    const digestRes = await app.fetch(
      new Request('https://sync.example.test/v1/admin/digest', {
        headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      }),
    );
    expect(digestRes.status).toBe(200);
    const report = (await digestRes.json()) as TelemetryDigestReport;

    expect(report.crashesAndErrors).toEqual([
      {
        kind: 'app_crash',
        errorName: 'SIGSEGV',
        stackSig: 'libmpv_render_0x1a',
        screen: 'player',
        fatalCount: 2,
        count: 2,
        affectedSessions: 2,
      },
      {
        kind: 'unhandled_error',
        errorName: 'TypeError',
        stackSig: 'epgGrid_render_112',
        screen: 'epg-grid',
        fatalCount: 0,
        count: 1,
        affectedSessions: 1,
      },
    ]);

    expect(report.catalogImports).toEqual([
      {
        sourceKind: 'xtream',
        count: 2,
        failureCount: 1,
        failureRate: 0.5,
        p50Ms: 1200,
        p95Ms: 3400,
        maxMs: 3400,
      },
      {
        sourceKind: 'm3u',
        count: 1,
        failureCount: 0,
        failureRate: 0,
        p50Ms: 650,
        p95Ms: 650,
        maxMs: 650,
      },
    ]);

    expect(report.deviceProfiles).toEqual([
      {
        platform: 'windows',
        formFactor: 'desktop',
        arch: 'x64',
        ramBucket: '16gb',
        resolution: '2560x1440',
        gpu: 'NVIDIA RTX 4070',
        locale: 'en-US',
        sessions: 1,
        events: 4,
      },
      {
        platform: 'android-tv',
        formFactor: 'tv',
        arch: 'arm64',
        ramBucket: '2gb',
        resolution: '1920x1080',
        gpu: 'Mali-G57',
        locale: 'tr-TR',
        sessions: 1,
        events: 2,
      },
    ]);
  });

  it('P1-6 & P2-2: allows 365-day uptimeMs, 4-part OS versions, and >/:/;/. stackSig while keeping strict latency and IPv4 caps', async () => {
    const { app } = makeApp();

    // Valid: uptimeMs up to 31_536_000_000 (365 days), 4-part OS version, stackSig with >/:/;/.
    const validRes = await app.fetch(
      jsonReq('/v1/telemetry', 'POST', {
        sessionId: 'sess-p9-caps',
        appVersion: '1.4.0',
        platform: 'windows',
        osVersion: '10.0.190.45',
        deviceProfile: {
          osVersion: '6.8.0.45',
          arch: 'x64',
          formFactor: 'desktop',
        },
        events: [
          {
            kind: 'app_crash',
            errorName: 'storage.schema-corrupt',
            stackSig: 'App>PlayerScreen.tsx:142;renderFrame:55',
            screen: 'player',
            fatal: true,
            uptimeMs: 31_536_000_000,
          },
          {
            kind: 'unhandled_error',
            errorName: 'TypeError',
            stackSig: 'Root>CatalogGrid.tsx:88;useCatalog:14',
            deviceProfile: { osVersion: '14.2.1.0' },
          },
        ],
      }),
    );
    expect(validRes.status).toBe(200);
    expect(await validRes.json()).toEqual({ accepted: 2, disabled: false });

    // Reject uptimeMs > 365 days or negative
    for (const badUptime of [31_536_000_001, -1]) {
      const res = await app.fetch(
        jsonReq('/v1/telemetry', 'POST', {
          sessionId: 'sess-bad-uptime',
          appVersion: '1.4.0',
          platform: 'windows',
          events: [
            {
              kind: 'app_crash',
              errorName: 'Error',
              stackSig: 'App>Main:1',
              uptimeMs: badUptime,
            },
          ],
        }),
      );
      expect(res.status).toBe(400);
    }

    // Latency fields keep strict 10_000_000 cap
    const badLatency = await app.fetch(
      jsonReq('/v1/telemetry', 'POST', {
        sessionId: 'sess-bad-lat',
        appVersion: '1.4.0',
        platform: 'windows',
        events: [{ kind: 'startup', durationMs: 10_000_001, coldStart: true }],
      }),
    );
    expect(badLatency.status).toBe(400);

    // IPv4 embedded in non-osVersion fields or non-quad osVersion STILL rejected
    for (const badBatch of [
      {
        sessionId: 'sess-bad-ip-sig',
        appVersion: '1.4.0',
        platform: 'windows',
        events: [{ kind: 'unhandled_error', errorName: 'Error', stackSig: '192.168.1.10' }],
      },
      {
        sessionId: 'sess-bad-ip-gpu',
        appVersion: '1.4.0',
        platform: 'windows',
        deviceProfile: { gpu: '10.0.0.1' },
        events: [{ kind: 'startup', durationMs: 100, coldStart: true }],
      },
      {
        sessionId: 'sess-bad-osver-text',
        appVersion: '1.4.0',
        platform: 'windows',
        deviceProfile: { osVersion: 'host 192.168.1.1' },
        events: [{ kind: 'startup', durationMs: 100, coldStart: true }],
      },
    ]) {
      expect((await app.fetch(jsonReq('/v1/telemetry', 'POST', badBatch))).status).toBe(400);
    }
  });
});
