import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Platform, Pressable, Text, View } from 'react-native';
import type { RectLike } from '../safe-hover-geometry';
import {
  createSafeHoverController,
  type SafeHoverBridgeOptions,
  useSafeHoverBridge,
} from '../useSafeHoverBridge';

function BridgeHarness(props: { options?: SafeHoverBridgeOptions; panelRect?: RectLike | null }) {
  const bridge = useSafeHoverBridge(props.options);
  if (props.panelRect !== undefined) {
    (bridge.panelRef as { current: unknown }).current = props.panelRect
      ? { getBoundingClientRect: () => props.panelRect }
      : null;
  }

  return (
    <View>
      <View testID="trigger" {...bridge.triggerProps} />
      <Pressable testID="lock-btn" onPress={() => bridge.setLocked(true)} />
      <Pressable testID="unlock-btn" onPress={() => bridge.setLocked(false)} />
      {bridge.open ? (
        <View testID="panel" {...bridge.panelProps}>
          <Text>Panel Open</Text>
        </View>
      ) : null}
    </View>
  );
}

describe('createSafeHoverController & useSafeHoverBridge', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('keeps open while pointer moves inside aim triangle up to aimTimeoutMs, then closes if panel never entered', () => {
    const onOpenChange = jest.fn();
    const panelRect: RectLike = { left: 100, top: 100, width: 100, height: 100 };
    const ctrl = createSafeHoverController({
      closeDelayMs: 140,
      aimTimeoutMs: 300,
      marginPx: 12,
      getPanelRect: () => panelRect,
      onOpenChange,
    });

    ctrl.enterTrigger();
    expect(ctrl.isOpen()).toBe(true);
    expect(onOpenChange).toHaveBeenLastCalledWith(true);

    // Leave trigger above panel, moving diagonally toward panel inside aim triangle
    ctrl.leaveTrigger({ x: 150, y: 60 });
    jest.advanceTimersByTime(100);
    ctrl.handlePointerMove({ x: 135, y: 75 });
    jest.advanceTimersByTime(100);
    // Past closeDelayMs (200ms > 140ms) but still inside aim corridor and under aimTimeoutMs (300ms)
    expect(ctrl.isOpen()).toBe(true);

    ctrl.handlePointerMove({ x: 130, y: 85 });
    jest.advanceTimersByTime(110);
    // Past aimTimeoutMs (310ms >= 300ms) without entering panel -> closes
    expect(ctrl.isOpen()).toBe(false);
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    ctrl.dispose();
  });

  it('cancels close immediately when pointer enters panel from aim triangle', () => {
    const panelRect: RectLike = { left: 100, top: 100, width: 100, height: 100 };
    const ctrl = createSafeHoverController({
      closeDelayMs: 140,
      aimTimeoutMs: 300,
      getPanelRect: () => panelRect,
    });

    ctrl.enterTrigger();
    ctrl.leaveTrigger({ x: 150, y: 60 });
    jest.advanceTimersByTime(100);
    ctrl.handlePointerMove({ x: 140, y: 80 });
    jest.advanceTimersByTime(80);
    ctrl.enterPanel();

    jest.advanceTimersByTime(1000);
    expect(ctrl.isOpen()).toBe(true);
    ctrl.dispose();
  });

  it('closes after closeDelayMs when moving away from panel or staying idle', () => {
    const panelRect: RectLike = { left: 100, top: 100, width: 100, height: 100 };
    const ctrl = createSafeHoverController({
      closeDelayMs: 140,
      aimTimeoutMs: 300,
      getPanelRect: () => panelRect,
    });

    ctrl.enterTrigger();
    ctrl.leaveTrigger({ x: 150, y: 60 });
    // Move away (upward)
    jest.advanceTimersByTime(40);
    ctrl.handlePointerMove({ x: 150, y: 20 });
    jest.advanceTimersByTime(105);
    expect(ctrl.isOpen()).toBe(false);

    // Idle after leave also closes at closeDelayMs
    ctrl.enterTrigger();
    ctrl.leaveTrigger({ x: 150, y: 60 });
    jest.advanceTimersByTime(139);
    expect(ctrl.isOpen()).toBe(true);
    jest.advanceTimersByTime(2);
    expect(ctrl.isOpen()).toBe(false);
    ctrl.dispose();
  });

  it('prevents closing while locked (e.g. active slider drag) and closes after unlock if outside', () => {
    const ctrl = createSafeHoverController({ closeDelayMs: 140 });

    ctrl.enterTrigger();
    ctrl.enterPanel();
    ctrl.setLocked(true);
    ctrl.leaveTrigger({ x: 10, y: 10 });
    ctrl.leavePanel();

    jest.advanceTimersByTime(1000);
    expect(ctrl.isOpen()).toBe(true);

    ctrl.setLocked(false);
    jest.advanceTimersByTime(145);
    expect(ctrl.isOpen()).toBe(false);
    ctrl.dispose();
  });

  it('wires useSafeHoverBridge on web, tracks window pointermove, and cleans up on unmount', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    const listeners = new Map<string, Set<(e: unknown) => void>>();
    const addSpy = jest.fn((type: string, fn: (e: unknown) => void) => {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(fn);
    });
    const removeSpy = jest.fn((type: string, fn: (e: unknown) => void) => {
      listeners.get(type)?.delete(fn);
    });
    const origWindow = (globalThis as Record<string, unknown>).window;
    (globalThis as Record<string, unknown>).window = {
      addEventListener: addSpy,
      removeEventListener: removeSpy,
    };

    try {
      const panelRect: RectLike = { left: 100, top: 100, width: 100, height: 100 };
      const view = await render(
        <BridgeHarness
          panelRect={panelRect}
          options={{ closeDelayMs: 140, aimTimeoutMs: 300, marginPx: 12 }}
        />,
      );

      expect(screen.queryByTestId('panel')).toBeNull();
      await fireEvent(screen.getByTestId('trigger'), 'pointerEnter');
      expect(screen.getByTestId('panel')).toBeTruthy();

      await fireEvent(screen.getByTestId('trigger'), 'pointerLeave', { clientX: 150, clientY: 60 });
      expect(addSpy).toHaveBeenCalledWith('pointermove', expect.any(Function));

      // Lock prevents close
      await fireEvent.press(screen.getByTestId('lock-btn'));
      await act(async () => {
        jest.advanceTimersByTime(500);
      });
      expect(screen.getByTestId('panel')).toBeTruthy();

      await view.unmount();
      expect(listeners.get('pointermove')?.size ?? 0).toBe(0);
    } finally {
      if (origWindow === undefined) {
        delete (globalThis as Record<string, unknown>).window;
      } else {
        (globalThis as Record<string, unknown>).window = origWindow;
      }
    }
  });

  it('acts as a zero-overhead no-op on non-web platforms', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    await render(<BridgeHarness />);
    await fireEvent(screen.getByTestId('trigger'), 'pointerEnter');
    expect(screen.queryByTestId('panel')).toBeNull();
  });
});
