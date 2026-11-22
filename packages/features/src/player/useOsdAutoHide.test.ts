import { describe, expect, it } from 'vitest';
import { initialOsdAutoHideState, osdAutoHideReducer } from './useOsdAutoHide';

describe('osdAutoHideReducer (#277)', () => {
  it('starts armed at restartCounter 0 and atomically increments on arm/restart without self-cancelling', () => {
    const s0 = initialOsdAutoHideState();
    expect(s0).toEqual({ armed: true, restartCounter: 0 });

    const s1 = osdAutoHideReducer(s0, { type: 'restart' });
    expect(s1).toEqual({ armed: true, restartCounter: 1 });

    const s2 = osdAutoHideReducer(s1, { type: 'disarm' });
    expect(s2).toEqual({ armed: false, restartCounter: 1 });

    // Idempotent disarm keeps same state object
    expect(osdAutoHideReducer(s2, { type: 'disarm' })).toBe(s2);

    // Re-arming after disarm sets armed: true AND increments restartCounter in one transition
    const s3 = osdAutoHideReducer(s2, { type: 'arm' });
    expect(s3).toEqual({ armed: true, restartCounter: 2 });
  });
});
