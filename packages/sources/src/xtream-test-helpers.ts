import {
  type ElvError,
  err,
  type HttpClient,
  type HttpResponse,
  ok,
  type Result,
} from '@elv/domain';
import { expect } from 'vitest';
import { createXtreamClient, type XtreamClientOptions } from './xtream';

export type Reply =
  | { json: unknown; status?: number }
  | { text: string; status?: number }
  | { throws: true }
  | { fail: ElvError };

interface Recorded {
  url: string;
  headers: Record<string, string> | undefined;
}

export const USER = 'u1';
export const PASS = 'p@ss/word';

function fakeHttp(route: (url: string) => Reply) {
  const requests: Recorded[] = [];
  const http: HttpClient = {
    async get(url, options): Promise<Result<HttpResponse>> {
      requests.push({ url, headers: options?.headers ? { ...options.headers } : undefined });
      const reply = route(url);
      if ('throws' in reply) throw new Error(`boom ${url}`);
      if ('fail' in reply) return err(reply.fail);
      const text = 'json' in reply ? JSON.stringify(reply.json) : reply.text;
      const bytes = new TextEncoder().encode(text);
      async function* body() {
        yield bytes.slice(0, 3);
        yield bytes.slice(3);
      }
      return ok({ status: reply.status ?? 200, headers: {}, body: body() });
    },
  };
  return { http, requests };
}

export function client(route: (url: string) => Reply, extra: Partial<XtreamClientOptions> = {}) {
  const { http, requests } = fakeHttp(route);
  const c = createXtreamClient({
    http,
    server: 'http://h.example:8080/',
    username: USER,
    password: PASS,
    ...extra,
  });
  return { c, requests };
}

export const action = (url: string) => new URL(url).searchParams.get('action');

export function expectErr<T>(r: Result<T>, category: string, code: string): ElvError {
  if (r.ok) throw new Error('expected an error');
  expect(r.error.category).toBe(category);
  expect(r.error.code).toBe(code);
  return r.error;
}

export function value<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`unexpected error ${JSON.stringify(r.error)}`);
  return r.value;
}
