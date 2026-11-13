import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { APP_ORIGIN, CONTENT_SECURITY_POLICY } from './app-protocol.ts';
import { serveAppRequest } from './serve-app.ts';

const root = resolve('/srv/renderer');

function setup(options: { isFile?: boolean; fetchFails?: boolean } = {}) {
  const fetchFile = vi.fn(async (_path: string) => {
    if (options.fetchFails) throw new Error('ERR_FILE_NOT_FOUND');
    return new Response('body', { status: 200, headers: { 'content-type': 'text/html' } });
  });
  const isFile = vi.fn(async (_path: string) => options.isFile ?? true);
  return { fetchFile, isFile, deps: { isFile, fetchFile } };
}

describe('serveAppRequest', () => {
  it('serves an existing file with the CSP header', async () => {
    const { deps, fetchFile } = setup();
    const response = await serveAppRequest(root, `${APP_ORIGIN}/`, deps);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('body');
    expect(response.headers.get('content-type')).toBe('text/html');
    expect(response.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
    expect(fetchFile).toHaveBeenCalledWith(resolve(root, 'index.html'));
  });

  it('answers 404 with the CSP header for refused paths without touching the disk', async () => {
    const { deps, isFile, fetchFile } = setup();
    const response = await serveAppRequest(root, `${APP_ORIGIN}/%2e%2e/secret.txt`, deps);
    expect(response.status).toBe(404);
    expect(response.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
    expect(isFile).not.toHaveBeenCalled();
    expect(fetchFile).not.toHaveBeenCalled();
  });

  it.each(['/assets', '/assets/'])('answers 404 for the directory %s', async (path) => {
    const { deps, fetchFile } = setup({ isFile: false });
    const response = await serveAppRequest(root, `${APP_ORIGIN}${path}`, deps);
    expect(response.status).toBe(404);
    expect(response.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
    expect(fetchFile).not.toHaveBeenCalled();
  });

  it('answers 404 when the fetch rejects for a missing file', async () => {
    const { deps } = setup({ fetchFails: true });
    const response = await serveAppRequest(root, `${APP_ORIGIN}/missing.js`, deps);
    expect(response.status).toBe(404);
    expect(response.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
  });
});
