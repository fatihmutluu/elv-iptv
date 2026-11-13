import { CONTENT_SECURITY_POLICY, resolveAppFile } from './app-protocol.ts';

/** File access injected by the caller so the decision logic runs without Electron. */
export interface ServeDeps {
  /** True only for an existing regular file. */
  isFile(path: string): Promise<boolean>;
  /** Loads the file as a response; may reject. */
  fetchFile(path: string): Promise<Response>;
}

function withCsp(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  return new Response(response.body, { status: response.status, headers });
}

function notFound(): Response {
  return withCsp(new Response('Not found', { status: 404 }));
}

/**
 * Answers an app request: the file's response, or a 404 for refused paths, missing files,
 * directories and failed loads. Every response carries the Content-Security-Policy header.
 */
export async function serveAppRequest(
  rootDir: string,
  requestUrl: string,
  deps: ServeDeps,
): Promise<Response> {
  const file = resolveAppFile(rootDir, requestUrl);
  if (file === null) return notFound();
  try {
    if (!(await deps.isFile(file))) return notFound();
    return withCsp(await deps.fetchFile(file));
  } catch {
    return notFound();
  }
}
