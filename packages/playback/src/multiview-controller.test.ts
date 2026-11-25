import { describe, expect, it, vi } from 'vitest';
import { createConnectionTracker } from './connection-tracker';
import { createMultiViewController, type MultiViewTile } from './multiview-controller';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('multiview-controller (#34, #221, #232)', () => {
  it('admits tiles across distinct accounts, enforces single active audio, and rejects duplicates', () => {
    const tracker = createConnectionTracker();
    const ctrl = createMultiViewController({
      capabilities: { platform: 'desktop' },
      tracker,
    });

    const first = ctrl.addTile({
      itemKey: 'ch-1',
      title: 'News 1',
      sourceId: 'src-a',
      accountKey: 'acct-a',
      maxConnections: 1,
      channelNumber: 1,
      logo: 'https://img.example.test/1.png',
    });
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.tile.muted).toBe(false);
      expect(first.tile.status).toBe('loading');
    }

    const dup = ctrl.addTile({
      itemKey: 'ch-1',
      title: 'News 1',
      sourceId: 'src-a',
      accountKey: 'acct-b',
      maxConnections: 2,
    });
    expect(dup).toEqual({ ok: false, reason: 'duplicate-item' });

    const second = ctrl.addTile({
      itemKey: 'ch-2',
      title: 'Sports 2',
      sourceId: 'src-b',
      accountKey: 'acct-b',
      maxConnections: 1,
    });
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.tile.muted).toBe(true);
    }

    expect(tracker.activeCount('acct-a')).toBe(1);
    expect(tracker.activeCount('acct-b')).toBe(1);

    const state = ctrl.getState();
    expect(state.tiles).toHaveLength(2);
    expect(state.activeAudioTileId).toBe(first.ok ? first.tile.tileId : null);
    expect(state.canAddTile).toBe(true);

    // Swap active audio tile -> strictly 1 unmuted tile at a time
    if (second.ok) {
      expect(ctrl.setActiveAudioTile(second.tile.tileId)).toBe(true);
      const nextState = ctrl.getState();
      expect(nextState.activeAudioTileId).toBe(second.tile.tileId);
      expect(nextState.tiles.filter((t) => !t.muted)).toHaveLength(1);
      expect(nextState.tiles.find((t) => t.tileId === second.tile.tileId)?.muted).toBe(false);
    }
    expect(ctrl.setActiveAudioTile('missing-tile')).toBe(false);
  });

  it('rejects same-account tiles when maxConnections is reached (#221)', () => {
    const tracker = createConnectionTracker();
    const ctrl = createMultiViewController({
      capabilities: { platform: 'desktop' },
      tracker,
    });

    const first = ctrl.addTile({
      itemKey: 'ch-1',
      title: 'Channel 1',
      sourceId: 'src-a',
      accountKey: 'acct-a',
      maxConnections: 1,
    });
    expect(first.ok).toBe(true);

    const second = ctrl.addTile({
      itemKey: 'ch-2',
      title: 'Channel 2',
      sourceId: 'src-a',
      accountKey: 'acct-a',
      maxConnections: 1,
    });
    expect(second).toEqual({
      ok: false,
      reason: 'connection-limit',
      activeCount: 1,
      maxConnections: 1,
    });
    expect(ctrl.getState().tiles).toHaveLength(1);
  });

  it('enforces low-ram, unsupported, device-tile-cap, and thermal admission blocks', () => {
    const lowRamCtrl = createMultiViewController({
      capabilities: { platform: 'android', isLowRamDevice: true },
      tracker: createConnectionTracker(),
    });
    expect(
      lowRamCtrl.addTile({
        itemKey: 'ch-1',
        title: 'Ch 1',
        sourceId: 's',
        accountKey: 'a',
        maxConnections: 4,
      }),
    ).toEqual({ ok: false, reason: 'low-ram', hardwareMaxTiles: 1 });

    const unsupportedCtrl = createMultiViewController({
      capabilities: { platform: 'desktop', supported: false },
      tracker: createConnectionTracker(),
    });
    expect(
      unsupportedCtrl.addTile({
        itemKey: 'ch-1',
        title: 'Ch 1',
        sourceId: 's',
        accountKey: 'a',
        maxConnections: 4,
      }),
    ).toEqual({ ok: false, reason: 'unsupported', hardwareMaxTiles: 1 });

    const twoTileCtrl = createMultiViewController({
      capabilities: { platform: 'tvos', deviceModel: 'AppleTV6,2' },
      tracker: createConnectionTracker(),
    });
    expect(
      twoTileCtrl.addTile({
        itemKey: 'ch-1',
        title: 'Ch 1',
        sourceId: 's',
        accountKey: 'a',
        maxConnections: 4,
      }).ok,
    ).toBe(true);
    expect(
      twoTileCtrl.addTile({
        itemKey: 'ch-2',
        title: 'Ch 2',
        sourceId: 's',
        accountKey: 'a',
        maxConnections: 4,
      }).ok,
    ).toBe(true);
    expect(
      twoTileCtrl.addTile({
        itemKey: 'ch-3',
        title: 'Ch 3',
        sourceId: 's',
        accountKey: 'a',
        maxConnections: 4,
      }),
    ).toEqual({ ok: false, reason: 'device-tile-cap', hardwareMaxTiles: 2 });

    const seriousCtrl = createMultiViewController({
      capabilities: { platform: 'desktop' },
      tracker: createConnectionTracker(),
      initialThermalState: 'serious',
    });
    expect(
      seriousCtrl.addTile({
        itemKey: 'ch-1',
        title: 'Ch 1',
        sourceId: 's',
        accountKey: 'a',
        maxConnections: 4,
      }),
    ).toEqual({ ok: false, reason: 'thermal-serious', hardwareMaxTiles: 4 });
  });

  it('strictly awaits socket close BEFORE releasing tracker slot on removeTile and promotes remaining tile audio', async () => {
    const tracker = createConnectionTracker();
    const ctrl = createMultiViewController({
      capabilities: { platform: 'desktop' },
      tracker,
    });

    const t1 = ctrl.addTile({
      itemKey: 'ch-1',
      title: 'Ch 1',
      sourceId: 's1',
      accountKey: 'acct-1',
      maxConnections: 1,
    });
    const t2 = ctrl.addTile({
      itemKey: 'ch-2',
      title: 'Ch 2',
      sourceId: 's2',
      accountKey: 'acct-2',
      maxConnections: 1,
    });
    expect(t1.ok && t2.ok).toBe(true);
    if (!t1.ok || !t2.ok) return;

    const gate = deferred();
    const removePromise = ctrl.removeTile(t1.tile.tileId, () => gate.promise);

    // While close is still pending, tracker slot MUST still be held!
    expect(tracker.activeCount('acct-1')).toBe(1);
    // Double remove while closing returns false
    expect(await ctrl.removeTile(t1.tile.tileId, () => undefined)).toBe(false);

    gate.resolve();
    expect(await removePromise).toBe(true);
    expect(tracker.activeCount('acct-1')).toBe(0);

    const state = ctrl.getState();
    expect(state.tiles).toHaveLength(1);
    expect(state.activeAudioTileId).toBe(t2.tile.tileId);
    expect(state.tiles[0]?.muted).toBe(false);
  });

  it('replaceTile awaits close of old tile BEFORE releasing old slot and acquiring new slot on same max_connections=1 account', async () => {
    const tracker = createConnectionTracker();
    const ctrl = createMultiViewController({
      capabilities: { platform: 'desktop' },
      tracker,
    });

    const t1 = ctrl.addTile({
      itemKey: 'ch-1',
      title: 'Ch 1',
      sourceId: 's1',
      accountKey: 'acct-1',
      maxConnections: 1,
    });
    expect(t1.ok).toBe(true);
    if (!t1.ok) return;

    const gate = deferred();
    const replacePromise = ctrl.replaceTile(
      t1.tile.tileId,
      {
        itemKey: 'ch-2',
        title: 'Ch 2',
        sourceId: 's1',
        accountKey: 'acct-1',
        maxConnections: 1,
      },
      () => gate.promise,
    );

    // Old stream slot must remain held until awaitClose settles
    expect(tracker.activeStreamIds('acct-1')).toEqual([t1.tile.streamId]);

    gate.resolve();
    const replaced = await replacePromise;
    expect(replaced.ok).toBe(true);
    if (replaced.ok) {
      expect(replaced.tile.tileId).toBe(t1.tile.tileId);
      expect(replaced.tile.itemKey).toBe('ch-2');
      expect(replaced.tile.streamId).not.toBe(t1.tile.streamId);
      expect(replaced.tile.muted).toBe(false);
      expect(tracker.activeStreamIds('acct-1')).toEqual([replaced.tile.streamId]);
    }
  });

  it('applyThermalState sheds non-primary tiles on critical after awaiting close and releases their slots', async () => {
    const tracker = createConnectionTracker();
    const ctrl = createMultiViewController({
      capabilities: { platform: 'desktop' },
      tracker,
    });

    const t1 = ctrl.addTile({
      itemKey: 'ch-1',
      title: 'Ch 1',
      sourceId: 's1',
      accountKey: 'acct-1',
      maxConnections: 4,
    });
    const t2 = ctrl.addTile({
      itemKey: 'ch-2',
      title: 'Ch 2',
      sourceId: 's1',
      accountKey: 'acct-1',
      maxConnections: 4,
    });
    const t3 = ctrl.addTile({
      itemKey: 'ch-3',
      title: 'Ch 3',
      sourceId: 's1',
      accountKey: 'acct-1',
      maxConnections: 4,
    });
    expect(t1.ok && t2.ok && t3.ok).toBe(true);
    if (!t1.ok || !t2.ok || !t3.ok) return;

    ctrl.setActiveAudioTile(t2.tile.tileId);

    const closedOrder: string[] = [];
    const shedIds = await ctrl.applyThermalState('critical', async (tile: MultiViewTile) => {
      expect(tracker.activeStreamIds('acct-1')).toContain(tile.streamId);
      closedOrder.push(tile.tileId);
    });

    expect(shedIds).toEqual([t1.tile.tileId, t3.tile.tileId]);
    expect(closedOrder).toEqual([t1.tile.tileId, t3.tile.tileId]);
    expect(tracker.activeCount('acct-1')).toBe(1);
    expect(tracker.activeStreamIds('acct-1')).toEqual([t2.tile.streamId]);

    const state = ctrl.getState();
    expect(state.tiles).toHaveLength(1);
    expect(state.tiles[0]?.tileId).toBe(t2.tile.tileId);
    expect(state.tiles[0]?.muted).toBe(false);
    expect(state.thermalState).toBe('critical');
    expect(state.canAddTile).toBe(false);

    // Adding while critical is rejected
    expect(
      ctrl.addTile({
        itemKey: 'ch-4',
        title: 'Ch 4',
        sourceId: 's1',
        accountKey: 'acct-1',
        maxConnections: 4,
      }),
    ).toEqual({ ok: false, reason: 'thermal-critical', hardwareMaxTiles: 4 });
  });

  it('updates tile status, notifies subscribers, and clearAll awaits close and releases every slot', async () => {
    const tracker = createConnectionTracker();
    const ctrl = createMultiViewController({
      capabilities: { platform: 'desktop' },
      tracker,
    });
    const listener = vi.fn();
    const unsub = ctrl.subscribe(listener);

    const t1 = ctrl.addTile({
      itemKey: 'ch-1',
      title: 'Ch 1',
      sourceId: 's1',
      accountKey: 'acct-1',
      maxConnections: 2,
    });
    const t2 = ctrl.addTile({
      itemKey: 'ch-2',
      title: 'Ch 2',
      sourceId: 's1',
      accountKey: 'acct-1',
      maxConnections: 2,
    });
    expect(t1.ok && t2.ok).toBe(true);
    if (!t1.ok || !t2.ok) return;

    expect(ctrl.updateTileStatus(t1.tile.tileId, 'playing')).toBe(true);
    expect(ctrl.getState().tiles[0]?.status).toBe('playing');
    expect(ctrl.updateTileStatus('unknown', 'error')).toBe(false);

    const closed: string[] = [];
    await ctrl.clearAll(async (tile) => {
      closed.push(tile.tileId);
    });
    expect(closed).toEqual([t1.tile.tileId, t2.tile.tileId]);
    expect(tracker.activeCount('acct-1')).toBe(0);
    expect(ctrl.getState().tiles).toHaveLength(0);
    expect(ctrl.getState().activeAudioTileId).toBeNull();
    expect(listener).toHaveBeenCalled();
    unsub();
  });

  it('handles replaceTile edge cases, non-critical thermal updates, and closing guards', async () => {
    const tracker = createConnectionTracker();
    const ctrl = createMultiViewController({
      capabilities: { platform: 'desktop' },
      tracker,
    });

    const t1 = ctrl.addTile({
      itemKey: 'ch-1',
      title: 'Ch 1',
      sourceId: 's1',
      accountKey: 'acct-1',
      maxConnections: 1,
    });
    const t2 = ctrl.addTile({
      itemKey: 'ch-2',
      title: 'Ch 2',
      sourceId: 's2',
      accountKey: 'acct-2',
      maxConnections: 1,
    });
    expect(t1.ok && t2.ok).toBe(true);
    if (!t1.ok || !t2.ok) return;

    // Missing tileId -> closing
    expect(
      await ctrl.replaceTile(
        'missing',
        { itemKey: 'ch-3', title: 'Ch 3', sourceId: 's1', accountKey: 'acct-1', maxConnections: 1 },
        () => undefined,
      ),
    ).toEqual({ ok: false, reason: 'closing' });

    // Duplicate itemKey on another tile -> duplicate-item
    expect(
      await ctrl.replaceTile(
        t1.tile.tileId,
        { itemKey: 'ch-2', title: 'Ch 2', sourceId: 's2', accountKey: 'acct-2', maxConnections: 1 },
        () => undefined,
      ),
    ).toEqual({ ok: false, reason: 'duplicate-item' });

    // Replacing onto a saturated different account -> connection-limit
    expect(
      await ctrl.replaceTile(
        t1.tile.tileId,
        { itemKey: 'ch-3', title: 'Ch 3', sourceId: 's2', accountKey: 'acct-2', maxConnections: 1 },
        () => undefined,
      ),
    ).toEqual({ ok: false, reason: 'connection-limit', activeCount: 1, maxConnections: 1 });

    // Non-critical thermal state update returns []
    expect(await ctrl.applyThermalState('fair', () => undefined)).toEqual([]);
    expect(ctrl.getState().thermalState).toBe('fair');

    // Serious thermal blocks replaceTile
    expect(await ctrl.applyThermalState('serious', () => undefined)).toEqual([]);
    expect(
      await ctrl.replaceTile(
        t1.tile.tileId,
        { itemKey: 'ch-3', title: 'Ch 3', sourceId: 's1', accountKey: 'acct-1', maxConnections: 1 },
        () => undefined,
      ),
    ).toEqual({ ok: false, reason: 'thermal-serious', hardwareMaxTiles: 4 });

    // Back to nominal; thermal turning serious mid-replace rejects after awaitClose
    await ctrl.applyThermalState('nominal', () => undefined);
    const gate = deferred();
    const pendingReplace = ctrl.replaceTile(
      t1.tile.tileId,
      { itemKey: 'ch-3', title: 'Ch 3', sourceId: 's1', accountKey: 'acct-1', maxConnections: 1 },
      () => gate.promise,
    );
    await ctrl.applyThermalState('serious', () => undefined);
    gate.resolve();
    expect(await pendingReplace).toEqual({
      ok: false,
      reason: 'thermal-serious',
      hardwareMaxTiles: 4,
    });

    // clearAll blocks addTile while closing
    await ctrl.applyThermalState('nominal', () => undefined);
    const clearGate = deferred();
    const clearPromise = ctrl.clearAll(() => clearGate.promise);
    expect(
      ctrl.addTile({
        itemKey: 'ch-9',
        title: 'Ch 9',
        sourceId: 's1',
        accountKey: 'acct-1',
        maxConnections: 1,
      }),
    ).toEqual({ ok: false, reason: 'closing' });
    clearGate.resolve();
    await clearPromise;
  });

  it('removes oldTile, promotes remaining tile audio, notifies subscribers, and releases tracker slot if awaitClose rejects in replaceTile', async () => {
    const tracker = createConnectionTracker();
    const ctrl = createMultiViewController({
      capabilities: { platform: 'desktop' },
      tracker,
    });

    const t1 = ctrl.addTile({
      itemKey: 'ch-1',
      title: 'Ch 1',
      sourceId: 's1',
      accountKey: 'acct-1',
      maxConnections: 1,
    });
    const t2 = ctrl.addTile({
      itemKey: 'ch-2',
      title: 'Ch 2',
      sourceId: 's2',
      accountKey: 'acct-2',
      maxConnections: 1,
    });
    expect(t1.ok && t2.ok).toBe(true);
    if (!t1.ok || !t2.ok) return;

    const observedInNotify: { tileIds: string[]; acct1Count: number }[] = [];
    ctrl.subscribe((state) => {
      observedInNotify.push({
        tileIds: state.tiles.map((t) => t.tileId),
        acct1Count: tracker.activeCount('acct-1'),
      });
    });

    await expect(
      ctrl.replaceTile(
        t1.tile.tileId,
        {
          itemKey: 'ch-3',
          title: 'Ch 3',
          sourceId: 's1',
          accountKey: 'acct-1',
          maxConnections: 1,
        },
        async () => {
          throw new Error('close failed');
        },
      ),
    ).rejects.toThrow('close failed');

    expect(tracker.activeCount('acct-1')).toBe(0);
    expect(tracker.activeCount('acct-2')).toBe(1);
    const state = ctrl.getState();
    expect(state.tiles).toHaveLength(1);
    expect(state.tiles[0]?.tileId).toBe(t2.tile.tileId);
    expect(state.tiles[0]?.muted).toBe(false);
    expect(state.activeAudioTileId).toBe(t2.tile.tileId);
    expect(observedInNotify).toEqual([{ tileIds: [t2.tile.tileId], acct1Count: 0 }]);
  });
});
