import { createSyncApp } from './app.ts';
import { createSlidingWindowRateLimiter } from './rate-limit.ts';
import { createD1Storage, type D1Database } from './storage-d1.ts';

/** Cloudflare Workers environment bindings defined in `wrangler.toml` and secrets. */
export interface WorkerEnv {
  readonly DB: D1Database;
  readonly JWT_SECRET: string;
  readonly ADMIN_TOKEN?: string;
  readonly TELEMETRY_DISABLED?: string;
  readonly PUBLIC_ORIGIN?: string;
}

const isolateRateLimiter = createSlidingWindowRateLimiter();

/** Cloudflare Workers entry point delegating to the shared Web-Standard `SyncApp`. */
const worker = {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    if (!env.JWT_SECRET || env.JWT_SECRET.trim().length < 16) {
      return new Response(JSON.stringify({ error: 'server_misconfigured' }), {
        status: 503,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }

    const app = createSyncApp({
      storage: createD1Storage(env.DB),
      jwtSecret: env.JWT_SECRET,
      adminToken: env.ADMIN_TOKEN ?? '',
      telemetryDisabled: env.TELEMETRY_DISABLED === 'true',
      publicOrigin: env.PUBLIC_ORIGIN ?? '*',
      rateLimiter: isolateRateLimiter,
    });
    return app.fetch(request);
  },
};

export default worker;
