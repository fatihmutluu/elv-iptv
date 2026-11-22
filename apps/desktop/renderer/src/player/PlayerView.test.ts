import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlayerUiEvent } from '../../../src/shared/player-ipc.ts';
import type { DesktopEngine } from './desktop-engine.ts';

interface EffectRecord {
  deps: readonly unknown[] | undefined;
  cleanup: (() => void) | undefined;
}

const hookState = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as unknown[],
  effects: [] as Array<EffectRecord | undefined>,
  pendingEffects: [] as Array<{ index: number; create: () => (() => void) | undefined }>,
  reset() {
    this.cursor = 0;
    this.slots = [];
    this.effects = [];
    this.pendingEffects = [];
  },
  beginRender() {
    this.cursor = 0;
    this.pendingEffects = [];
  },
  flushEffects() {
    const queue = this.pendingEffects.splice(0);
    for (const item of queue) {
      const prev = this.effects[item.index];
      prev?.cleanup?.();
      const cleanup = item.create();
      const record = this.effects[item.index];
      if (record) {
        record.cleanup = cleanup;
      }
    }
  },
  unmount() {
    for (const rec of this.effects) rec?.cleanup?.();
    this.reset();
  },
}));

function depsChanged(
  prev: readonly unknown[] | undefined,
  next: readonly unknown[] | undefined,
): boolean {
  if (!prev || !next || prev.length !== next.length) return true;
  for (let i = 0; i < prev.length; i += 1) {
    if (!Object.is(prev[i], next[i])) return true;
  }
  return false;
}

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useRef<T>(initial: T) {
      const idx = hookState.cursor;
      hookState.cursor += 1;
      if (!hookState.slots[idx]) hookState.slots[idx] = { current: initial };
      return hookState.slots[idx] as { current: T };
    },
    useState<T>(initial: T | (() => T)) {
      const idx = hookState.cursor;
      hookState.cursor += 1;
      if (!(idx in hookState.slots)) {
        hookState.slots[idx] = typeof initial === 'function' ? (initial as () => T)() : initial;
      }
      const setState = (next: T | ((prev: T) => T)) => {
        hookState.slots[idx] =
          typeof next === 'function' ? (next as (prev: T) => T)(hookState.slots[idx] as T) : next;
      };
      return [hookState.slots[idx] as T, setState] as const;
    },
    useMemo<T>(factory: () => T, deps: readonly unknown[]) {
      const idx = hookState.cursor;
      hookState.cursor += 1;
      const prev = hookState.slots[idx] as { deps: readonly unknown[]; value: T } | undefined;
      if (!prev || depsChanged(prev.deps, deps)) {
        const value = factory();
        hookState.slots[idx] = { deps, value };
        return value;
      }
      return prev.value;
    },
    useCallback<T extends (...args: never[]) => unknown>(fn: T, deps: readonly unknown[]) {
      const idx = hookState.cursor;
      hookState.cursor += 1;
      const prev = hookState.slots[idx] as { deps: readonly unknown[]; value: T } | undefined;
      if (!prev || depsChanged(prev.deps, deps)) {
        hookState.slots[idx] = { deps, value: fn };
        return fn;
      }
      return prev.value;
    },
    useEffect(create: () => (() => void) | undefined, deps?: readonly unknown[]) {
      const idx = hookState.cursor;
      hookState.cursor += 1;
      const prev = hookState.effects[idx];
      if (!prev || depsChanged(prev.deps, deps)) {
        hookState.effects[idx] = { deps, cleanup: prev?.cleanup };
        hookState.pendingEffects.push({ index: idx, create });
      }
    },
  };
});

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  StyleSheet: {
    create: <T>(styles: T): T => styles,
  },
}));

import { PlayerCanvas } from './PlayerCanvas.tsx';
import { PlayerView, type PlayerViewProps } from './PlayerView.tsx';

function findByTestId(node: unknown, testID: string): ReactElement<Record<string, unknown>> | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findByTestId(child, testID);
      if (hit) return hit;
    }
    return null;
  }
  const el = node as ReactElement<Record<string, unknown>>;
  if (el.props?.testID === testID) return el;
  return findByTestId(el.props?.children, testID);
}

function createFakeEngine(initialPresenter?: Extract<PlayerUiEvent, { type: 'presenter' }>) {
  const listeners = new Set<(event: PlayerUiEvent) => void>();
  const setArea = vi.fn();
  const engine = {
    engineId: 'e1',
    setArea,
    onUi: vi.fn((listener: (event: PlayerUiEvent) => void) => {
      listeners.add(listener);
      if (initialPresenter) listener(initialPresenter);
      return () => {
        listeners.delete(listener);
      };
    }),
    onFrame: vi.fn(() => () => undefined),
  } as unknown as DesktopEngine;
  return {
    engine,
    setArea,
    emitUi(event: PlayerUiEvent) {
      for (const l of listeners) l(event);
    },
  };
}

function renderPlayerView(props: PlayerViewProps): ReactElement<Record<string, unknown>> {
  hookState.beginRender();
  const tree = PlayerView(props) as ReactElement<Record<string, unknown>>;
  hookState.flushEffects();
  return tree;
}

function areaChildren(
  tree: ReactElement<Record<string, unknown>>,
): ReactElement<Record<string, unknown>>[] {
  const area = findByTestId(tree, 'player-area');
  if (!area) throw new Error('expected player-area');
  const raw = Array.isArray(area.props.children) ? area.props.children : [area.props.children];
  return raw.filter(Boolean) as ReactElement<Record<string, unknown>>[];
}

describe('PlayerView', () => {
  beforeEach(() => {
    hookState.reset();
    (globalThis as unknown as { window: unknown }).window = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
  });

  it('mounts PlayerCanvas behind status inside player-area when presenterKind is canvas', () => {
    const { engine } = createFakeEngine({
      type: 'presenter',
      kind: 'canvas',
      coversArea: false,
    });

    // Initial render subscribes to engine.onUi (which synchronously replays presenter), second render reflects state.
    renderPlayerView({ engine, status: 'Live 1080p', failed: false, resizeMode: 'fill' });
    const tree = renderPlayerView({
      engine,
      status: 'Live 1080p',
      failed: false,
      resizeMode: 'fill',
    });

    const children = areaChildren(tree);
    expect(children).toHaveLength(2);
    expect(children[0]?.type).toBe(PlayerCanvas);
    expect(children[0]?.props).toEqual({
      engine,
      resizeMode: 'fill',
      visible: true,
    });
    expect(children[1]?.props.testID).toBe('player-status');

    // When failed=true, PlayerCanvas receives visible=false.
    const failedTree = renderPlayerView({
      engine,
      status: 'Failed',
      failed: true,
      resizeMode: 'fit',
    });
    const failedChildren = areaChildren(failedTree);
    expect(failedChildren[0]?.type).toBe(PlayerCanvas);
    expect(failedChildren[0]?.props).toEqual({
      engine,
      resizeMode: 'fit',
      visible: false,
    });

    hookState.unmount();
  });

  it('does not mount PlayerCanvas for child-window or own-window presenters', () => {
    const child = createFakeEngine({
      type: 'presenter',
      kind: 'child-window',
      coversArea: true,
    });
    renderPlayerView({ engine: child.engine, status: 'Live', failed: false });
    const childTree = renderPlayerView({ engine: child.engine, status: 'Live', failed: false });
    expect(areaChildren(childTree)).toEqual([]);
    // Status goes below the area when coversArea is true.
    expect(findByTestId(childTree, 'player-status')).not.toBeNull();
    hookState.unmount();

    const own = createFakeEngine({
      type: 'presenter',
      kind: 'own-window',
      coversArea: false,
    });
    renderPlayerView({ engine: own.engine, status: 'Live', failed: false });
    const ownTree = renderPlayerView({ engine: own.engine, status: 'Live', failed: false });
    const ownChildren = areaChildren(ownTree);
    expect(ownChildren).toHaveLength(1);
    expect(ownChildren[0]?.type).not.toBe(PlayerCanvas);
    expect(ownChildren[0]?.props.testID).toBe('player-status');
    hookState.unmount();
  });
});
