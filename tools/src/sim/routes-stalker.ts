import { baseUrlOf, type RouteHandler } from './context.ts';
import { parseFaults } from './faults.ts';
import { requestFaults } from './request-faults.ts';
import { sendText } from './routes-data.ts';
import {
  parseMacCookie,
  resolveStalkerAccount,
  StalkerSessionStore,
  stalkerApi,
} from './stalker.ts';

const STALKER_PATHS = new Set([
  '/portal.php',
  '/stalker_portal/server/load.php',
  '/server/load.php',
]);

function headerText(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.join('; ') : value;
}

/** Synthetic Stalker / Ministra portal routes (`/portal.php`, `/stalker_portal/server/load.php`). */
export const stalkerRoute: RouteHandler = async (req, res, ctx, meta) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const url = new URL(req.url ?? '/', 'http://sim');
  if (!STALKER_PATHS.has(url.pathname)) return false;

  const cookie = headerText(req.headers.cookie);
  const authorization = headerText(req.headers.authorization);
  const cookieMac = parseMacCookie(cookie);
  const account = resolveStalkerAccount(cookieMac);
  if (account) meta.account = account.username;

  const action = (url.searchParams.get('action') ?? '').toLowerCase();
  if (action !== 'handshake') {
    const faultAccount = account?.username ?? 'demo';
    const rule = ctx.faultRules.take(faultAccount, 0);
    if (rule) {
      meta.faultRule = rule.id;
      meta.fault = rule.spec;
      if (await requestFaults(req, res, parseFaults(rule.spec))) return true;
    }
  }

  ctx.stalker ??= new StalkerSessionStore();
  const result = stalkerApi(
    url.searchParams,
    { cookie, authorization },
    { baseUrl: baseUrlOf(req, ctx), now: ctx.now(), seed: ctx.seed },
    ctx.stalker,
  );
  sendText(res, result.status, 'application/json', JSON.stringify(result.body));
  return true;
};
