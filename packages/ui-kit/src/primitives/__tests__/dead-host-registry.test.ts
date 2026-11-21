import {
  classifyImageError,
  createDeadHostRegistry,
  extractArtworkHost,
  extractNativeImageError,
} from '../dead-host-registry';

describe('classifyImageError (#202)', () => {
  it('classifies HTTP 4xx status codes and messages as http-4xx', () => {
    expect(classifyImageError({ statusCode: 400 })).toBe('http-4xx');
    expect(classifyImageError({ statusCode: 404 })).toBe('http-4xx');
    expect(classifyImageError({ statusCode: 403 })).toBe('http-4xx');
    expect(classifyImageError({ statusCode: 499 })).toBe('http-4xx');
    expect(classifyImageError({ message: 'HTTP 404 Not Found' })).toBe('http-4xx');
    expect(classifyImageError({ message: 'Server returned 400 Bad Request' })).toBe('http-4xx');
    expect(classifyImageError({ message: 'Access Forbidden for poster' })).toBe('http-4xx');
    expect(classifyImageError({ message: 'Unauthorized image request' })).toBe('http-4xx');
    expect(classifyImageError({ message: 'HTTP 410 Gone' })).toBe('http-4xx');
    expect(classifyImageError({ message: 'Status 401' })).toBe('http-4xx');
    expect(classifyImageError({ message: 'Error 403' })).toBe('http-4xx');
    expect(classifyImageError({ message: 'Code 410' })).toBe('http-4xx');
    expect(classifyImageError({ message: 'Rate limited 429' })).toBe('http-4xx');
  });

  it('extractNativeImageError parses string, Error-like object, and statusCode safely', () => {
    expect(extractNativeImageError(undefined)).toBeUndefined();
    expect(extractNativeImageError({})).toBeUndefined();
    expect(extractNativeImageError({ nativeEvent: { error: 'ENOTFOUND' } })).toEqual({
      message: 'ENOTFOUND',
    });
    expect(
      extractNativeImageError({
        nativeEvent: { error: { message: 'timed out' }, statusCode: 404 },
      }),
    ).toEqual({ message: 'timed out', statusCode: 404 });
    expect(extractNativeImageError({ nativeEvent: { statusCode: 403 } })).toEqual({
      statusCode: 403,
    });
  });

  it('classifies DNS and NXDOMAIN failures as dns', () => {
    expect(classifyImageError({ message: 'getaddrinfo ENOTFOUND dead.cdn.test' })).toBe('dns');
    expect(
      classifyImageError({
        message: 'java.net.UnknownHostException: Unable to resolve host "dead.cdn.test"',
      }),
    ).toBe('dns');
    expect(classifyImageError({ message: 'EAI_NONAME lookup failed' })).toBe('dns');
    expect(classifyImageError({ message: 'net::ERR_NAME_NOT_RESOLVED' })).toBe('dns');
    expect(classifyImageError({ message: 'NSURLErrorCannotFindHost (-1003)' })).toBe('dns');
    expect(classifyImageError({ message: 'Cannot find host logo.example' })).toBe('dns');
    expect(classifyImageError({ message: 'DNS lookup failed: NXDOMAIN' })).toBe('dns');
  });

  it('classifies connection refused, unreachable, and timeout failures as network', () => {
    expect(classifyImageError({ message: 'connect ECONNREFUSED 127.0.0.1:80' })).toBe('network');
    expect(classifyImageError({ message: 'ENETUNREACH' })).toBe('network');
    expect(classifyImageError({ message: 'EHOSTUNREACH' })).toBe('network');
    expect(classifyImageError({ message: 'ETIMEDOUT' })).toBe('network');
    expect(classifyImageError({ message: 'net::ERR_CONNECTION_REFUSED' })).toBe('network');
    expect(classifyImageError({ message: 'net::ERR_CONNECTION_TIMED_OUT' })).toBe('network');
    expect(classifyImageError({ message: 'net::ERR_INTERNET_DISCONNECTED' })).toBe('network');
    expect(classifyImageError({ message: 'java.net.ConnectException: failed' })).toBe('network');
    expect(classifyImageError({ message: 'java.net.SocketTimeoutException' })).toBe('network');
    expect(classifyImageError({ message: 'Could not connect: cannot connect to host' })).toBe(
      'network',
    );
    expect(classifyImageError({ message: 'The network connection was lost.' })).toBe('network');
    expect(classifyImageError({ message: 'The request timed out.' })).toBe('network');
  });

  it('classifies missing or unrecognized errors as unknown', () => {
    expect(classifyImageError()).toBe('unknown');
    expect(classifyImageError({})).toBe('unknown');
    expect(classifyImageError({ statusCode: 500, message: 'Internal server error' })).toBe(
      'unknown',
    );
    expect(classifyImageError({ message: 'Image decode failed' })).toBe('unknown');
  });
});

describe('createDeadHostRegistry (#202)', () => {
  it('trips immediately on a single confirmed DNS failure (dnsThreshold = 1)', () => {
    const registry = createDeadHostRegistry();
    expect(
      registry.recordFailure('https://dead-dns.example/ch1.png', {
        message: 'java.net.UnknownHostException: Unable to resolve host',
      }),
    ).toBe(true);
    expect(registry.isDead('https://dead-dns.example/ch2.png')).toBe(true);
    expect(registry.isDead('https://healthy.example/ch1.png')).toBe(false);
  });

  it('trips fast on network errors (networkThreshold = 2)', () => {
    const registry = createDeadHostRegistry();
    expect(
      registry.recordFailure('https://down.example/ch1.png', {
        message: 'net::ERR_CONNECTION_REFUSED',
      }),
    ).toBe(false);
    expect(registry.isDead('https://down.example/ch2.png')).toBe(false);
    expect(
      registry.recordFailure('https://down.example/ch2.png', {
        message: 'The request timed out.',
      }),
    ).toBe(true);
    expect(registry.isDead('https://down.example/ch3.png')).toBe(true);
  });

  it('never blacklists a healthy host on HTTP 404/4xx single-object errors', () => {
    const registry = createDeadHostRegistry();
    for (let i = 0; i < 10; i++) {
      expect(
        registry.recordFailure(`https://cdn.example/missing-${i}.png`, { statusCode: 404 }),
      ).toBe(false);
      expect(
        registry.recordFailure(`https://cdn.example/forbidden-${i}.png`, {
          message: 'HTTP 403 Forbidden',
        }),
      ).toBe(false);
    }
    expect(registry.isDead('https://cdn.example/valid.png')).toBe(false);
  });

  it('preserves threshold = 3 for unknown errors', () => {
    const registry = createDeadHostRegistry();
    expect(registry.recordFailure('https://flaky.example/1.png')).toBe(false);
    expect(registry.recordFailure('https://flaky.example/2.png')).toBe(false);
    expect(registry.isDead('https://flaky.example/3.png')).toBe(false);
    expect(registry.recordFailure('https://flaky.example/3.png')).toBe(true);
    expect(registry.isDead('https://flaky.example/4.png')).toBe(true);
  });

  it('expires tripped hosts automatically after ttlMs and allows clean recovery', () => {
    let clock = 1_000;
    const registry = createDeadHostRegistry({ ttlMs: 60_000, now: () => clock });
    expect(
      registry.recordFailure('https://transient.example/a.png', { message: 'ENOTFOUND' }),
    ).toBe(true);
    expect(registry.isDead('https://transient.example/b.png')).toBe(true);

    clock += 59_999;
    expect(registry.isDead('https://transient.example/b.png')).toBe(true);

    clock += 1;
    expect(registry.isDead('https://transient.example/b.png')).toBe(false);

    // After TTL expiry, an unknown failure starts fresh instead of immediately re-tripping.
    expect(registry.recordFailure('https://transient.example/c.png')).toBe(false);
    expect(registry.isDead('https://transient.example/d.png')).toBe(false);
  });

  it('resets all entries on reset() and clears a host on recordSuccess()', () => {
    const registry = createDeadHostRegistry();
    registry.recordFailure('https://a.example/1.png', { message: 'ENOTFOUND' });
    registry.recordFailure('https://b.example/1.png', { message: 'ENOTFOUND' });
    expect(registry.isDead('https://a.example/2.png')).toBe(true);
    expect(registry.isDead('https://b.example/2.png')).toBe(true);

    registry.recordSuccess('https://a.example/2.png');
    expect(registry.isDead('https://a.example/3.png')).toBe(false);
    expect(registry.isDead('https://b.example/2.png')).toBe(true);

    registry.reset();
    expect(registry.isDead('https://b.example/3.png')).toBe(false);
  });

  it('evicts oldest entries beyond maxHosts and ignores non-HTTP URIs', () => {
    const registry = createDeadHostRegistry({ maxHosts: 16 });
    expect(extractArtworkHost('file:///tmp/a.png')).toBeNull();
    expect(registry.recordFailure('file:///tmp/a.png', { message: 'ENOTFOUND' })).toBe(false);

    for (let i = 0; i < 17; i++) {
      registry.recordFailure(`https://h${i}.example/logo.png`, { message: 'ENOTFOUND' });
    }
    expect(registry.isDead('https://h0.example/logo.png')).toBe(false);
    expect(registry.isDead('https://h16.example/logo.png')).toBe(true);
  });
});
