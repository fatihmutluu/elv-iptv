import type { KeyInput } from '@elv/focus-core';
import { renderHook } from '@testing-library/react-native';
import { BackHandler, Platform, TVEventControl, TVEventHandler } from 'react-native';
import type { AndroidKeyEvent, AndroidKeySource } from '../android-keys';
import { useTvKeySource } from '../key-source';
import { RemoteKeysProvider } from '../RemoteKeysProvider';

type RemoteEvent = { eventType: string; eventKeyAction?: number };

/** Replaces the react-native-tvos APIs the hook touches and hands back their listeners. */
function mockTvApis(os: 'android' | 'ios', isTV = true) {
  jest.replaceProperty(Platform, 'OS', os);
  jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(isTV);
  const listeners: {
    remote?: (event: RemoteEvent) => void;
    back?: (...args: never[]) => boolean | null | undefined;
  } = {};
  const removeRemote = jest.fn();
  const removeBack = jest.fn();
  const addRemote = jest.spyOn(TVEventHandler, 'addListener').mockImplementation((listener) => {
    listeners.remote = listener as (event: RemoteEvent) => void;
    return { remove: removeRemote };
  });
  const addBack = jest
    .spyOn(BackHandler, 'addEventListener')
    .mockImplementation((_name, listener) => {
      listeners.back = listener;
      return { remove: removeBack };
    });
  const enableMenu = jest.spyOn(TVEventControl, 'enableTVMenuKey').mockImplementation(() => {});
  const disableMenu = jest.spyOn(TVEventControl, 'disableTVMenuKey').mockImplementation(() => {});
  return { listeners, addRemote, addBack, removeRemote, removeBack, enableMenu, disableMenu };
}

describe('useTvKeySource', () => {
  afterEach(() => jest.restoreAllMocks());

  it('consumes Android Back and sends it as one back press', async () => {
    const apis = mockTvApis('android');
    const onInput = jest.fn<void, [KeyInput]>();
    await renderHook(() => useTvKeySource(onInput));
    expect(apis.addBack).toHaveBeenCalledWith('hardwareBackPress', expect.any(Function));
    expect(apis.listeners.back?.()).toBe(true);
    expect(onInput.mock.calls).toEqual([
      [{ key: 'back', action: 'press', time: expect.any(Number) }],
    ]);
  });

  it('feeds remote events as key inputs and drops the ones the focus core does not use', async () => {
    const apis = mockTvApis('android');
    const onInput = jest.fn<void, [KeyInput]>();
    await renderHook(() => useTvKeySource(onInput));
    apis.listeners.remote?.({ eventType: 'down', eventKeyAction: 0 });
    apis.listeners.remote?.({ eventType: 'swipeUp' });
    apis.listeners.remote?.({ eventType: 'menu', eventKeyAction: 1 });
    expect(onInput.mock.calls).toEqual([
      [{ key: 'down', action: 'down', time: expect.any(Number) }],
      [{ key: 'menu', action: 'up', time: expect.any(Number) }],
    ]);
  });

  it('enables the tvOS menu key while mounted, maps Menu to back, and disables it on unmount', async () => {
    const apis = mockTvApis('ios');
    const onInput = jest.fn<void, [KeyInput]>();
    const hook = await renderHook(() => useTvKeySource(onInput));
    expect(apis.enableMenu).toHaveBeenCalledTimes(1);
    expect(apis.disableMenu).not.toHaveBeenCalled();
    apis.listeners.remote?.({ eventType: 'menu' });
    expect(onInput).toHaveBeenCalledWith({
      key: 'back',
      action: 'press',
      time: expect.any(Number),
    });
    await hook.unmount();
    expect(apis.disableMenu).toHaveBeenCalledTimes(1);
    expect(apis.enableMenu).toHaveBeenCalledTimes(1);
  });

  it('leaves the menu key alone on Android TV and on iOS phones', async () => {
    for (const [os, isTV] of [
      ['android', true],
      ['ios', false],
    ] as const) {
      const apis = mockTvApis(os, isTV);
      const hook = await renderHook(() => useTvKeySource(() => {}));
      await hook.unmount();
      expect(apis.enableMenu).not.toHaveBeenCalled();
      expect(apis.disableMenu).not.toHaveBeenCalled();
      jest.restoreAllMocks();
    }
  });

  it('removes the remote and Back listeners on unmount, once', async () => {
    const apis = mockTvApis('android');
    const hook = await renderHook(() => useTvKeySource(() => {}));
    expect(apis.removeRemote).not.toHaveBeenCalled();
    await hook.unmount();
    expect(apis.removeRemote).toHaveBeenCalledTimes(1);
    expect(apis.removeBack).toHaveBeenCalledTimes(1);
  });

  it('sends keys to the latest callback without subscribing again', async () => {
    const apis = mockTvApis('android');
    const first = jest.fn<void, [KeyInput]>();
    const second = jest.fn<void, [KeyInput]>();
    const hook = await renderHook(({ cb }: { cb: (k: KeyInput) => void }) => useTvKeySource(cb), {
      initialProps: { cb: first },
    });
    await hook.rerender({ cb: second });
    apis.listeners.remote?.({ eventType: 'select', eventKeyAction: 0 });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(apis.addRemote).toHaveBeenCalledTimes(1);
    expect(apis.addBack).toHaveBeenCalledTimes(1);
  });

  describe('raw Android key source', () => {
    function fakeSource() {
      let listener: ((event: AndroidKeyEvent) => void) | undefined;
      const remove = jest.fn(() => {
        listener = undefined;
      });
      const addListener = jest.fn((l: (event: AndroidKeyEvent) => void) => {
        listener = l;
        return { remove };
      });
      const source: AndroidKeySource = { addListener };
      return { source, addListener, remove, emit: (e: AndroidKeyEvent) => listener?.(e) };
    }
    const down: AndroidKeyEvent = { action: 'down', keyCode: 20, canceled: false, ageMs: 0 };

    it('feeds raw Android keys from the provider', async () => {
      mockTvApis('android');
      const fake = fakeSource();
      const onInput = jest.fn<void, [KeyInput]>();
      await renderHook(() => useTvKeySource(onInput), {
        wrapper: ({ children }) => (
          <RemoteKeysProvider android={fake.source}>{children}</RemoteKeysProvider>
        ),
      });
      fake.emit(down);
      expect(onInput.mock.calls).toEqual([
        [{ key: 'down', action: 'down', time: expect.any(Number) }],
      ]);
    });

    it('does not subscribe to TVEventHandler when a raw source is provided', async () => {
      const apis = mockTvApis('android');
      await renderHook(() => useTvKeySource(() => {}), {
        wrapper: ({ children }) => (
          <RemoteKeysProvider android={fakeSource().source}>{children}</RemoteKeysProvider>
        ),
      });
      expect(apis.addRemote).not.toHaveBeenCalled();
    });

    it('consumes Back without a second input on the raw path', async () => {
      const apis = mockTvApis('android');
      const onInput = jest.fn<void, [KeyInput]>();
      await renderHook(() => useTvKeySource(onInput), {
        wrapper: ({ children }) => (
          <RemoteKeysProvider android={fakeSource().source}>{children}</RemoteKeysProvider>
        ),
      });
      expect(apis.listeners.back?.()).toBe(true);
      expect(onInput).not.toHaveBeenCalled();
    });

    it('cancels the held key and unsubscribes on unmount mid-hold', async () => {
      mockTvApis('android');
      const fake = fakeSource();
      const onInput = jest.fn<void, [KeyInput]>();
      const hook = await renderHook(() => useTvKeySource(onInput), {
        wrapper: ({ children }) => (
          <RemoteKeysProvider android={fake.source}>{children}</RemoteKeysProvider>
        ),
      });
      fake.emit(down);
      await hook.unmount();
      fake.emit({ action: 'up', keyCode: 20, canceled: false, ageMs: 0 });
      expect(onInput.mock.calls).toEqual([
        [{ key: 'down', action: 'down', time: expect.any(Number) }],
        [{ key: 'down', action: 'cancel', time: expect.any(Number) }],
      ]);
      expect(fake.remove).toHaveBeenCalledTimes(1);
    });

    describe('provider value changes mid-hold', () => {
      /** Renders the hook under a provider whose value `swap` replaces. */
      async function swappable(first: AndroidKeySource | null) {
        let current = first;
        const onInput = jest.fn<void, [KeyInput]>();
        const hook = await renderHook(() => useTvKeySource(onInput), {
          wrapper: ({ children }) => (
            <RemoteKeysProvider android={current}>{children}</RemoteKeysProvider>
          ),
        });
        const swap = async (next: AndroidKeySource | null) => {
          current = next;
          await hook.rerender({});
        };
        return { onInput, swap };
      }

      it('cancels the held key and subscribes to the new source', async () => {
        mockTvApis('android');
        const a = fakeSource();
        const b = fakeSource();
        const { onInput, swap } = await swappable(a.source);
        a.emit(down);
        await swap(b.source);
        expect(onInput.mock.calls).toEqual([
          [{ key: 'down', action: 'down', time: expect.any(Number) }],
          [{ key: 'down', action: 'cancel', time: expect.any(Number) }],
        ]);
        expect(a.remove).toHaveBeenCalledTimes(1);
        expect(b.addListener).toHaveBeenCalledTimes(1);
        b.emit({ action: 'up', keyCode: 20, canceled: false, ageMs: 0 });
        expect(onInput).toHaveBeenCalledTimes(2);
        b.emit(down);
        expect(onInput).toHaveBeenLastCalledWith({
          key: 'down',
          action: 'down',
          time: expect.any(Number),
        });
      });

      it('cancels the held key and falls back to TVEventHandler when the source becomes null', async () => {
        const apis = mockTvApis('android');
        const a = fakeSource();
        const { onInput, swap } = await swappable(a.source);
        a.emit(down);
        await swap(null);
        expect(onInput.mock.calls).toEqual([
          [{ key: 'down', action: 'down', time: expect.any(Number) }],
          [{ key: 'down', action: 'cancel', time: expect.any(Number) }],
        ]);
        expect(a.remove).toHaveBeenCalledTimes(1);
        expect(apis.addRemote).toHaveBeenCalledTimes(1);
      });

      it('cancels nothing when no key is held', async () => {
        mockTvApis('android');
        const a = fakeSource();
        const { onInput, swap } = await swappable(a.source);
        await swap(fakeSource().source);
        expect(onInput).not.toHaveBeenCalled();
        expect(a.remove).toHaveBeenCalledTimes(1);
      });
    });

    it('uses TVEventHandler when the provider holds null', async () => {
      const apis = mockTvApis('android');
      await renderHook(() => useTvKeySource(() => {}), {
        wrapper: ({ children }) => (
          <RemoteKeysProvider android={null}>{children}</RemoteKeysProvider>
        ),
      });
      expect(apis.addRemote).toHaveBeenCalledTimes(1);
    });

    it('uses TVEventHandler on tvOS even with a source', async () => {
      const apis = mockTvApis('ios');
      const fake = fakeSource();
      await renderHook(() => useTvKeySource(() => {}), {
        wrapper: ({ children }) => (
          <RemoteKeysProvider android={fake.source}>{children}</RemoteKeysProvider>
        ),
      });
      expect(apis.addRemote).toHaveBeenCalledTimes(1);
      expect(fake.addListener).not.toHaveBeenCalled();
    });
  });
});
