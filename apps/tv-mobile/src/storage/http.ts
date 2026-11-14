import { createFetchHttpClient, type FetchLike, type HttpClient } from '@elv/domain';
import { fetch as expoFetch } from 'expo/fetch';

type FetchResponse = Awaited<ReturnType<FetchLike>>;

interface ExpoResponse extends Omit<FetchResponse, 'body'> {
  body?: FetchResponse['body'];
  arrayBuffer?(): Promise<ArrayBuffer>;
}

/** Wraps a response that exposes no stream so its whole body is delivered as one chunk. */
function withWholeBody(res: ExpoResponse): FetchResponse {
  if (res.body !== null && res.body !== undefined) return res as FetchResponse;
  const { arrayBuffer } = res;
  if (arrayBuffer === undefined) return { ...res, body: null };
  const read = arrayBuffer.bind(res);
  return {
    ...res,
    body: (async function* () {
      yield new Uint8Array(await read());
    })(),
  };
}

const deviceFetch: FetchLike = async (url, init) =>
  withWholeBody((await expoFetch(url, init)) as unknown as ExpoResponse);

/**
 * The domain fetch client over `expo/fetch`, whose response bodies stream. Where a platform returns no stream
 * the whole body is read and delivered as one chunk; the importer bounds that with `maxBodyBytes`.
 */
export function createDeviceHttpClient(): HttpClient {
  return createFetchHttpClient(deviceFetch);
}
