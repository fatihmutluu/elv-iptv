import { describe, expect, it } from 'vitest';
import { createConnectionTracker } from './connection-tracker';

describe('createConnectionTracker (#87)', () => {
  it('tracks acquire, release, activeCount, and activeStreamIds per account independently', () => {
    const tracker = createConnectionTracker();
    expect(tracker.activeCount('sourceA')).toBe(0);
    expect(tracker.activeStreamIds('sourceA')).toEqual([]);

    tracker.acquire('sourceA', 'stream-1');
    tracker.acquire('sourceB', 'stream-2');
    tracker.acquire('sourceB', 'stream-3');

    expect(tracker.activeCount('sourceA')).toBe(1);
    expect(tracker.activeStreamIds('sourceA')).toEqual(['stream-1']);
    expect(tracker.activeCount('sourceB')).toBe(2);
    expect(tracker.activeStreamIds('sourceB')).toEqual(['stream-2', 'stream-3']);

    // Idempotent re-acquire on same account does not double-count
    tracker.acquire('sourceA', 'stream-1');
    expect(tracker.activeCount('sourceA')).toBe(1);

    // Re-acquiring an existing streamId on another account moves it cleanly
    tracker.acquire('sourceB', 'stream-1');
    expect(tracker.activeCount('sourceA')).toBe(0);
    expect(tracker.activeCount('sourceB')).toBe(3);

    // Release removes only that stream and is idempotent
    tracker.release('stream-2');
    tracker.release('stream-2');
    tracker.release('unknown-stream');
    expect(tracker.activeCount('sourceB')).toBe(2);
    expect(tracker.activeStreamIds('sourceB')).toEqual(['stream-3', 'stream-1']);

    tracker.release('stream-1');
    tracker.release('stream-3');
    expect(tracker.activeCount('sourceB')).toBe(0);
    expect(tracker.activeStreamIds('sourceB')).toEqual([]);
  });

  it('ignores empty accountKey or streamId on acquire', () => {
    const tracker = createConnectionTracker();
    tracker.acquire('', 'stream-1');
    tracker.acquire('sourceA', '');
    expect(tracker.activeCount('')).toBe(0);
    expect(tracker.activeCount('sourceA')).toBe(0);
  });

  it('does not double-count when replacingStreamId is currently held on the same account (channel zap)', () => {
    const tracker = createConnectionTracker();
    tracker.acquire('sourceA', 'ch-1');

    // Zapping ch-1 -> ch-2 on a 1-connection account must never trigger a false limit
    const zapCheck = tracker.checkLimit({
      accountKey: 'sourceA',
      maxConnections: 1,
      replacingStreamId: 'ch-1',
    });
    expect(zapCheck).toEqual({
      exceeds: false,
      ownActiveCount: 1,
      maxConnections: 1,
      canStopOwnStream: false,
    });

    // Even when provider still reports active_cons=1 (close lag), replacing our own stream is allowed
    const zapWithProviderLag = tracker.checkLimit({
      accountKey: 'sourceA',
      maxConnections: 1,
      replacingStreamId: 'ch-1',
      providerActiveCons: 1,
    });
    expect(zapWithProviderLag).toEqual({
      exceeds: false,
      ownActiveCount: 1,
      maxConnections: 1,
      providerActiveCons: 1,
      canStopOwnStream: false,
    });
  });

  it('flags exceeds and offers stoppableStreamId when opening a second stream on a limit-1 account', () => {
    const tracker = createConnectionTracker();
    tracker.acquire('sourceA', 'ch-1');

    const secondStream = tracker.checkLimit({
      accountKey: 'sourceA',
      maxConnections: 1,
    });
    expect(secondStream).toEqual({
      exceeds: true,
      ownActiveCount: 1,
      maxConnections: 1,
      canStopOwnStream: true,
      stoppableStreamId: 'ch-1',
    });
  });

  it('enforces independent limits across multiple sources (sourceA limit 1, sourceB limit 3)', () => {
    const tracker = createConnectionTracker();
    tracker.acquire('sourceA', 'a-1');
    tracker.acquire('sourceB', 'b-1');
    tracker.acquire('sourceB', 'b-2');

    // sourceA is full (1/1) without replacing
    expect(
      tracker.checkLimit({
        accountKey: 'sourceA',
        maxConnections: 1,
      }),
    ).toMatchObject({
      exceeds: true,
      ownActiveCount: 1,
      maxConnections: 1,
      canStopOwnStream: true,
      stoppableStreamId: 'a-1',
    });

    // sourceB still has room (2/3)
    expect(
      tracker.checkLimit({
        accountKey: 'sourceB',
        maxConnections: 3,
      }),
    ).toMatchObject({
      exceeds: false,
      ownActiveCount: 2,
      maxConnections: 3,
      canStopOwnStream: true,
      stoppableStreamId: 'b-1',
    });

    // Cross-source zap: replacing b-1 does NOT free a slot on sourceA!
    expect(
      tracker.checkLimit({
        accountKey: 'sourceA',
        maxConnections: 1,
        replacingStreamId: 'b-1',
      }),
    ).toMatchObject({
      exceeds: true,
      ownActiveCount: 1,
      maxConnections: 1,
      canStopOwnStream: true,
      stoppableStreamId: 'a-1',
    });

    // Third stream on sourceB fills it to 3/3 -> 4th exceeds
    tracker.acquire('sourceB', 'b-3');
    expect(
      tracker.checkLimit({
        accountKey: 'sourceB',
        maxConnections: 3,
      }),
    ).toMatchObject({
      exceeds: true,
      ownActiveCount: 3,
      maxConnections: 3,
      canStopOwnStream: true,
      stoppableStreamId: 'b-1',
    });
  });

  it('detects provider-reported active connections when no local stream is active', () => {
    const tracker = createConnectionTracker();

    const otherDevice = tracker.checkLimit({
      accountKey: 'sourceA',
      maxConnections: 1,
      providerActiveCons: 1,
    });
    expect(otherDevice).toEqual({
      exceeds: true,
      ownActiveCount: 0,
      maxConnections: 1,
      providerActiveCons: 1,
      canStopOwnStream: false,
    });

    const belowLimit = tracker.checkLimit({
      accountKey: 'sourceA',
      maxConnections: 2,
      providerActiveCons: 1,
    });
    expect(belowLimit).toEqual({
      exceeds: false,
      ownActiveCount: 0,
      maxConnections: 2,
      providerActiveCons: 1,
      canStopOwnStream: false,
    });
  });

  it('normalizes invalid maxConnections (<= 0, NaN, float) to >= 1 and ignores invalid providerActiveCons', () => {
    const tracker = createConnectionTracker();
    tracker.acquire('sourceA', 's-1');

    expect(
      tracker.checkLimit({
        accountKey: 'sourceA',
        maxConnections: 0,
        providerActiveCons: Number.NaN,
      }),
    ).toEqual({
      exceeds: true,
      ownActiveCount: 1,
      maxConnections: 1,
      canStopOwnStream: true,
      stoppableStreamId: 's-1',
    });

    expect(
      tracker.checkLimit({
        accountKey: 'sourceA',
        maxConnections: -5,
        providerActiveCons: -1,
      }),
    ).toEqual({
      exceeds: true,
      ownActiveCount: 1,
      maxConnections: 1,
      canStopOwnStream: true,
      stoppableStreamId: 's-1',
    });

    expect(
      tracker.checkLimit({
        accountKey: 'sourceA',
        maxConnections: 2.9,
      }),
    ).toEqual({
      exceeds: false,
      ownActiveCount: 1,
      maxConnections: 2,
      canStopOwnStream: true,
      stoppableStreamId: 's-1',
    });
  });
});
