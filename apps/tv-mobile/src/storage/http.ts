import { createFetchHttpClient, type FetchLike, type HttpClient } from '@elv/domain';
import { fetch as expoFetch } from 'expo/fetch';

type FetchResponse = Awaited<ReturnType<FetchLike>>;

interface ExpoResponse extends Omit<FetchResponse, 'body'> {
  body?: FetchResponse['body'];
  arrayBuffer?(): Promise<ArrayBuffer>;
}

/**
 * Rebuilds the response from its fields: a real response keeps `status` and `headers` as prototype accessors,
 * which object spread would drop. Where it has no stream, the whole body is delivered as one chunk.
 */
function withWholeBody(res: ExpoResponse): FetchResponse {
  const { status, headers } = res;
  if (res.body !== null && res.body !== undefined) return { status, headers, body: res.body };
  if (typeof res.arrayBuffer !== 'function') return { status, headers, body: null };
  const read = () => res.arrayBuffer?.() as Promise<ArrayBuffer>;
  return {
    status,
    headers,
    body: (async function* () {
      yield new Uint8Array(await read());
    })(),
  };
}

const deviceFetch: FetchLike = async (url, init) =>
  withWholeBody((await expoFetch(url, init)) as unknown as ExpoResponse);

/**
 * The domain fetch client over `expo/fetch`, whose response bodies stream. Where a platform returns no stream,
 * `arrayBuffer()` reads the whole body into memory as one chunk: `maxBodyBytes` rejects it only after that read and
 * cannot bound the memory it takes.
 */
export function createDeviceHttpClient(): HttpClient {
  return createFetchHttpClient(deviceFetch);
}
