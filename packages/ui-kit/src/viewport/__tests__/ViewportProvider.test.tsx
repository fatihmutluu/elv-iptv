import { act, render, screen } from '@testing-library/react-native';
import { Platform, Text } from 'react-native';
import { useViewport, ViewportProvider } from '../index';

interface FakeProbeNode {
  style: Record<string, string>;
  removed: boolean;
  remove(): void;
}

function installFakeDom(initialPadding: {
  paddingTop: string;
  paddingRight: string;
  paddingBottom: string;
  paddingLeft: string;
}) {
  const prevDoc = (globalThis as Record<string, unknown>)['document'];
  const prevWin = (globalThis as Record<string, unknown>)['window'];
  const created: FakeProbeNode[] = [];
  const attached: FakeProbeNode[] = [];
  const docListeners = new Map<string, Set<() => void>>();
  const winListeners = new Map<string, Set<() => void>>();
  const padding = { ...initialPadding };

  const fakeDoc = {
    body: {
      appendChild(node: FakeProbeNode) {
        attached.push(node);
      },
      removeChild(node: FakeProbeNode) {
        const idx = attached.indexOf(node);
        if (idx >= 0) attached.splice(idx, 1);
      },
    },
    createElement(tag: string) {
      expect(tag).toBe('div');
      const node: FakeProbeNode = {
        style: {},
        removed: false,
        remove() {
          this.removed = true;
          const idx = attached.indexOf(this);
          if (idx >= 0) attached.splice(idx, 1);
        },
      };
      created.push(node);
      return node;
    },
    addEventListener(type: string, listener: () => void) {
      const set = docListeners.get(type) ?? new Set<() => void>();
      set.add(listener);
      docListeners.set(type, set);
    },
    removeEventListener(type: string, listener: () => void) {
      docListeners.get(type)?.delete(listener);
    },
  };

  const fakeWin = {
    getComputedStyle: jest.fn(() => ({ ...padding })),
    addEventListener(type: string, listener: () => void) {
      const set = winListeners.get(type) ?? new Set<() => void>();
      set.add(listener);
      winListeners.set(type, set);
    },
    removeEventListener(type: string, listener: () => void) {
      winListeners.get(type)?.delete(listener);
    },
  };

  (globalThis as Record<string, unknown>)['document'] = fakeDoc;
  (globalThis as Record<string, unknown>)['window'] = fakeWin;

  return {
    created,
    attached,
    padding,
    getComputedStyle: fakeWin.getComputedStyle,
    docListenerCount: () => [...docListeners.values()].reduce((n, s) => n + s.size, 0),
    winListenerCount: () => [...winListeners.values()].reduce((n, s) => n + s.size, 0),
    emitDoc(type: string) {
      for (const l of [...(docListeners.get(type) ?? [])]) l();
    },
    emitWin(type: string) {
      for (const l of [...(winListeners.get(type) ?? [])]) l();
    },
    restore() {
      if (prevDoc === undefined) delete (globalThis as Record<string, unknown>)['document'];
      else (globalThis as Record<string, unknown>)['document'] = prevDoc;
      if (prevWin === undefined) delete (globalThis as Record<string, unknown>)['window'];
      else (globalThis as Record<string, unknown>)['window'] = prevWin;
    },
  };
}

function SafeAreaReadout() {
  const { safeArea } = useViewport();
  return (
    <Text testID="safe-area">
      {`${safeArea.top},${safeArea.right},${safeArea.bottom},${safeArea.left}`}
    </Text>
  );
}

function OverscanReadout() {
  const { overscan } = useViewport();
  return <Text testID="overscan">{`${overscan.x},${overscan.y}`}</Text>;
}

describe('ViewportProvider web CSS env(safe-area-inset-*) probe (#269)', () => {
  const originalOs = Platform.OS;

  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { value: originalOs, configurable: true });
  });

  it('probes CSS env(safe-area-inset-*) on mount, fullscreenchange, and resize, and cleans up on unmount', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
    const dom = installFakeDom({
      paddingTop: '37px',
      paddingRight: '0px',
      paddingBottom: '12px',
      paddingLeft: '4px',
    });

    try {
      const view = await render(
        <ViewportProvider>
          <SafeAreaReadout />
        </ViewportProvider>,
      );

      expect(dom.created).toHaveLength(1);
      expect(dom.attached).toHaveLength(1);
      expect(dom.created[0]?.style).toMatchObject({
        position: 'fixed',
        visibility: 'hidden',
        pointerEvents: 'none',
        paddingTop: 'env(safe-area-inset-top, 0px)',
        paddingRight: 'env(safe-area-inset-right, 0px)',
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        paddingLeft: 'env(safe-area-inset-left, 0px)',
      });
      expect(screen.getByTestId('safe-area').props.children).toBe('37,0,12,4');

      // Entering or leaving fullscreen updates probed safeArea via fullscreenchange
      dom.padding.paddingTop = '0px';
      dom.padding.paddingBottom = '0px';
      dom.padding.paddingLeft = '0px';
      await act(async () => {
        dom.emitDoc('fullscreenchange');
      });
      expect(screen.getByTestId('safe-area').props.children).toBe('0,0,0,0');

      // Resize also re-probes insets
      dom.padding.paddingTop = '32px';
      dom.padding.paddingRight = '8px';
      await act(async () => {
        dom.emitWin('resize');
      });
      expect(screen.getByTestId('safe-area').props.children).toBe('32,8,0,0');

      // Unmount removes probe node and all DOM listeners
      await view.unmount();
      expect(dom.attached).toHaveLength(0);
      expect(dom.created[0]?.removed).toBe(true);
      expect(dom.docListenerCount()).toBe(0);
      expect(dom.winListenerCount()).toBe(0);
    } finally {
      dom.restore();
    }
  });

  it('merges explicit value.safeArea overrides on top of probed web insets', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
    const dom = installFakeDom({
      paddingTop: '37px',
      paddingRight: '16px',
      paddingBottom: '20px',
      paddingLeft: '16px',
    });

    try {
      await render(
        <ViewportProvider value={{ safeArea: { top: 0, bottom: 8 } }}>
          <SafeAreaReadout />
        </ViewportProvider>,
      );

      expect(screen.getByTestId('safe-area').props.children).toBe('0,16,8,16');
    } finally {
      dom.restore();
    }
  });

  it('performs zero DOM work on native platforms', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
    const dom = installFakeDom({
      paddingTop: '44px',
      paddingRight: '0px',
      paddingBottom: '34px',
      paddingLeft: '0px',
    });

    try {
      await render(
        <ViewportProvider>
          <SafeAreaReadout />
        </ViewportProvider>,
      );

      expect(dom.created).toHaveLength(0);
      expect(dom.getComputedStyle).not.toHaveBeenCalled();
      expect(dom.docListenerCount()).toBe(0);
      expect(dom.winListenerCount()).toBe(0);
      expect(screen.getByTestId('safe-area').props.children).toBe('0,0,0,0');
    } finally {
      dom.restore();
    }
  });
});

describe('ViewportProvider configurable overscanX / overscanY (#133)', () => {
  it('updates TV viewport.overscan live across 0, 0.03, 0.08, and clamped out-of-range values without restart', async () => {
    const view = await render(
      <ViewportProvider value={{ formFactor: 'tv', width: 1920, height: 1080 }}>
        <OverscanReadout />
      </ViewportProvider>,
    );
    expect(screen.getByTestId('overscan').props.children).toBe('96,54');

    await view.rerender(
      <ViewportProvider
        value={{ formFactor: 'tv', width: 1920, height: 1080 }}
        overscanX={0}
        overscanY={0}
      >
        <OverscanReadout />
      </ViewportProvider>,
    );
    expect(screen.getByTestId('overscan').props.children).toBe('0,0');

    await view.rerender(
      <ViewportProvider
        value={{ formFactor: 'tv', width: 1920, height: 1080 }}
        overscanX={0.03}
        overscanY={0.08}
      >
        <OverscanReadout />
      </ViewportProvider>,
    );
    expect(screen.getByTestId('overscan').props.children).toBe('58,86');

    await view.rerender(
      <ViewportProvider
        value={{ formFactor: 'tv', width: 1920, height: 1080 }}
        overscanX={-0.1}
        overscanY={0.25}
      >
        <OverscanReadout />
      </ViewportProvider>,
    );
    expect(screen.getByTestId('overscan').props.children).toBe('0,108');

    // Non-TV form factor ignores overscan ratios and stays 0,0.
    await view.rerender(
      <ViewportProvider
        value={{ formFactor: 'desktop', width: 1920, height: 1080 }}
        overscanX={0.08}
        overscanY={0.08}
      >
        <OverscanReadout />
      </ViewportProvider>,
    );
    expect(screen.getByTestId('overscan').props.children).toBe('0,0');

    await view.unmount();
  });
});
