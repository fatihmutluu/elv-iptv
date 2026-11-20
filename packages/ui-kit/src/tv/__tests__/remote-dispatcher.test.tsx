import type { KeyInput } from '@elv/focus-core';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { BackHandler, Platform, TVEventControl, TVEventHandler, View } from 'react-native';
import type { AndroidKeyEvent, AndroidKeySource } from '../android-keys';
import {
  createTvRemoteDispatcher,
  RemoteKeysProvider,
  TextEntryBoundary,
  TvRemoteProvider,
  TvTextInput,
  useTvKeySource,
} from '../index';

type RemoteEvent = { eventType: string; eventKeyAction?: number };

function mockTvApis(os: 'android' | 'ios', isTV = true) {
  jest.replaceProperty(Platform, 'OS', os);
  jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(isTV);
  const remoteSet = new Set<(event: RemoteEvent) => void>();
  const backSet = new Set<() => boolean | null | undefined>();
  const addRemote = jest.spyOn(TVEventHandler, 'addListener').mockImplementation((listener) => {
    const fn = listener as (event: RemoteEvent) => void;
    remoteSet.add(fn);
    return {
      remove: jest.fn(() => {
        remoteSet.delete(fn);
      }),
    };
  });
  const addBack = jest
    .spyOn(BackHandler, 'addEventListener')
    .mockImplementation((_name, listener) => {
      const fn = listener as () => boolean | null | undefined;
      backSet.add(fn);
      return {
        remove: jest.fn(() => {
          backSet.delete(fn);
        }),
      };
    });
  // Accessing BackHandler on iOS lazily initializes BackHandler.ios.js, which registers one internal TVEventHandler listener.
  remoteSet.clear();
  addRemote.mockClear();
  const enableMenu = jest.spyOn(TVEventControl, 'enableTVMenuKey').mockImplementation(() => {});
  const disableMenu = jest.spyOn(TVEventControl, 'disableTVMenuKey').mockImplementation(() => {});
  return {
    addRemote,
    addBack,
    enableMenu,
    disableMenu,
    activeRemoteListeners: () => remoteSet.size,
    activeBackListeners: () => backSet.size,
    emitRemote: (event: RemoteEvent) => {
      for (const fn of remoteSet) fn(event);
    },
    emitBack: () => {
      for (const fn of backSet) fn();
    },
  };
}

function fakeAndroidSource() {
  const listeners = new Set<(event: AndroidKeyEvent) => void>();
  const addListener = jest.fn((listener: (event: AndroidKeyEvent) => void) => {
    listeners.add(listener);
    return {
      remove: jest.fn(() => {
        listeners.delete(listener);
      }),
    };
  });
  const source: AndroidKeySource = { addListener };
  return {
    source,
    addListener,
    activeCount: () => listeners.size,
    emit: (event: AndroidKeyEvent) => {
      for (const listener of listeners) listener(event);
    },
  };
}

function setupFakeWebWindow() {
  const handlers = new Map<string, Set<(event: unknown) => void>>();
  const win = {
    document: { activeElement: null as unknown },
    addEventListener: jest.fn((type: string, fn: (event: unknown) => void) => {
      let set = handlers.get(type);
      if (!set) {
        set = new Set();
        handlers.set(type, set);
      }
      set.add(fn);
    }),
    removeEventListener: jest.fn((type: string, fn: (event: unknown) => void) => {
      handlers.get(type)?.delete(fn);
    }),
  };
  const emit = (type: string, event?: unknown) => {
    for (const fn of handlers.get(type) ?? []) fn(event);
  };
  const count = (type: string) => handlers.get(type)?.size ?? 0;
  return { win, emit, count };
}

function Consumer({ onInput }: { onInput: (k: KeyInput) => void }) {
  useTvKeySource(onInput);
  return <View />;
}

describe('createTvRemoteDispatcher', () => {
  it('broadcasts events to all subscribers, tracks counts, and isolates throwing subscribers', () => {
    const dispatcher = createTvRemoteDispatcher();
    const first = jest.fn();
    const second = jest.fn();
    const throwing = jest.fn(() => {
      throw new Error('boom');
    });

    const offFirst = dispatcher.subscribe(first);
    const offThrowing = dispatcher.subscribe(throwing);
    const offSecond = dispatcher.subscribe(second);
    expect(dispatcher.subscriberCount()).toBe(3);

    const input: KeyInput = { key: 'down', action: 'press', time: 100 };
    expect(() => dispatcher.dispatch(input, false)).not.toThrow();
    expect(first).toHaveBeenCalledWith({ input, requirePriorDown: false });
    expect(throwing).toHaveBeenCalledWith({ input, requirePriorDown: false });
    expect(second).toHaveBeenCalledWith({ input, requirePriorDown: false });

    offThrowing();
    offThrowing();
    expect(dispatcher.subscriberCount()).toBe(2);

    offFirst();
    offSecond();
    expect(dispatcher.subscriberCount()).toBe(0);
  });

  it('ref-counts registered text-entry controllers cleanly', () => {
    const dispatcher = createTvRemoteDispatcher();
    let active = false;
    const ctrl = {
      isActive: () => active,
      enter: () => () => {},
      exit: () => false,
      onEnter: () => () => {},
    };

    const offA = dispatcher.registerTextEntry(ctrl);
    const offB = dispatcher.registerTextEntry(ctrl);
    expect(dispatcher.isTextEntryActive()).toBe(false);

    active = true;
    expect(dispatcher.isTextEntryActive()).toBe(true);

    offA();
    offA();
    expect(dispatcher.isTextEntryActive()).toBe(true);

    offB();
    expect(dispatcher.isTextEntryActive()).toBe(false);
  });
});

describe('TvRemoteProvider (#277)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('attaches only ONE TVEventHandler/BackHandler/TVEventControl listener across multiple consumers and handler changes', async () => {
    const apis = mockTvApis('ios', true);
    const a1 = jest.fn<void, [KeyInput]>();
    const a2 = jest.fn<void, [KeyInput]>();
    const b1 = jest.fn<void, [KeyInput]>();

    const view = await render(
      <TvRemoteProvider>
        <Consumer onInput={a1} />
        <Consumer onInput={b1} />
      </TvRemoteProvider>,
    );

    expect(apis.addRemote).toHaveBeenCalledTimes(1);
    expect(apis.addBack).toHaveBeenCalledTimes(1);
    expect(apis.enableMenu).toHaveBeenCalledTimes(1);
    expect(apis.activeRemoteListeners()).toBe(1);

    await view.rerender(
      <TvRemoteProvider>
        <Consumer onInput={a2} />
        <Consumer onInput={b1} />
      </TvRemoteProvider>,
    );

    expect(apis.addRemote).toHaveBeenCalledTimes(1);
    expect(apis.addBack).toHaveBeenCalledTimes(1);
    expect(apis.enableMenu).toHaveBeenCalledTimes(1);

    apis.emitRemote({ eventType: 'down' });
    expect(a1).not.toHaveBeenCalled();
    expect(a2).toHaveBeenCalledTimes(1);
    expect(b1).toHaveBeenCalledTimes(1);

    await view.unmount();
    expect(apis.activeRemoteListeners()).toBe(0);
    expect(apis.activeBackListeners()).toBe(0);
    expect(apis.disableMenu).toHaveBeenCalledTimes(1);
  });

  it('does not tear down the shared Android raw listener when one consumer unmounts, and isolates throwing subscribers', async () => {
    const apis = mockTvApis('android', true);
    const raw = fakeAndroidSource();
    const survivor = jest.fn<void, [KeyInput]>();
    const leaving = jest.fn<void, [KeyInput]>();
    const broken = jest.fn<void, [KeyInput]>(() => {
      throw new Error('subscriber failure');
    });

    const view = await render(
      <RemoteKeysProvider android={raw.source}>
        <TvRemoteProvider>
          <Consumer key="broken" onInput={broken} />
          <Consumer key="leaving" onInput={leaving} />
          <Consumer key="survivor" onInput={survivor} />
        </TvRemoteProvider>
      </RemoteKeysProvider>,
    );

    expect(raw.addListener).toHaveBeenCalledTimes(1);
    expect(apis.addBack).toHaveBeenCalledTimes(1);
    expect(apis.addRemote).not.toHaveBeenCalled();

    raw.emit({ action: 'down', keyCode: 20, canceled: false, ageMs: 0 });
    expect(leaving).toHaveBeenCalledTimes(1);
    expect(survivor).toHaveBeenCalledTimes(1);

    await view.rerender(
      <RemoteKeysProvider android={raw.source}>
        <TvRemoteProvider>
          <Consumer key="broken" onInput={broken} />
          <Consumer key="survivor" onInput={survivor} />
        </TvRemoteProvider>
      </RemoteKeysProvider>,
    );

    expect(raw.addListener).toHaveBeenCalledTimes(1);
    expect(raw.activeCount()).toBe(1);
    expect(leaving).toHaveBeenLastCalledWith({
      key: 'down',
      action: 'cancel',
      time: expect.any(Number),
    });

    raw.emit({ action: 'up', keyCode: 20, canceled: false, ageMs: 0 });
    expect(survivor.mock.calls.map(([k]) => `${k.key}:${k.action}`)).toEqual([
      'down:down',
      'down:up',
    ]);

    await view.unmount();
    expect(raw.activeCount()).toBe(0);
  });

  it('suspends non-back keys when TextEntryBoundary is mounted INSIDE TvRemoteProvider (Android raw)', async () => {
    mockTvApis('android', true);
    const raw = fakeAndroidSource();
    const onInput = jest.fn<void, [KeyInput]>();

    await render(
      <RemoteKeysProvider android={raw.source}>
        <TvRemoteProvider>
          <TextEntryBoundary>
            <Consumer onInput={onInput} />
            <TvTextInput testID="inner-input" />
          </TextEntryBoundary>
        </TvRemoteProvider>
      </RemoteKeysProvider>,
    );

    const input = screen.getByTestId('inner-input');
    await act(async () => {
      raw.emit({ action: 'down', keyCode: 20, canceled: false, ageMs: 0 });
    });
    expect(onInput.mock.calls.map(([k]) => `${k.key}:${k.action}`)).toEqual(['down:down']);

    await act(async () => {
      fireEvent(input, 'focus');
    });
    expect(onInput.mock.calls.map(([k]) => `${k.key}:${k.action}`)).toEqual([
      'down:down',
      'down:cancel',
    ]);

    onInput.mockClear();
    await act(async () => {
      raw.emit({ action: 'down', keyCode: 21, canceled: false, ageMs: 0 });
      raw.emit({ action: 'up', keyCode: 21, canceled: false, ageMs: 0 });
    });
    expect(onInput).not.toHaveBeenCalled();

    await act(async () => {
      raw.emit({ action: 'down', keyCode: 4, canceled: false, ageMs: 0 });
      raw.emit({ action: 'up', keyCode: 4, canceled: false, ageMs: 0 });
    });
    expect(onInput.mock.calls.map(([k]) => `${k.key}:${k.action}`)).toEqual([
      'back:down',
      'back:cancel',
    ]);
  });

  it('shares ONE web listener across consumers and respects TextEntryBoundary both INSIDE and ABOVE TvRemoteProvider', async () => {
    jest.replaceProperty(Platform, 'OS', 'web' as typeof Platform.OS);
    const prevWindow = (globalThis as { window?: unknown }).window;
    const { win, emit, count } = setupFakeWebWindow();
    (globalThis as { window?: unknown }).window = win;

    try {
      const a = jest.fn<void, [KeyInput]>();
      const b = jest.fn<void, [KeyInput]>();
      const view = await render(
        <TvRemoteProvider>
          <TextEntryBoundary>
            <Consumer onInput={a} />
            <Consumer onInput={b} />
            <TvTextInput testID="web-inner-input" />
          </TextEntryBoundary>
        </TvRemoteProvider>,
      );

      expect(count('keydown')).toBe(1);
      expect(count('keyup')).toBe(1);
      expect(count('blur')).toBe(1);

      emit('keydown', { key: 'ArrowDown', repeat: false, preventDefault: jest.fn() });
      emit('keyup', { key: 'ArrowDown' });
      expect(a.mock.calls.map(([k]) => `${k.key}:${k.action}`)).toEqual(['down:down', 'down:up']);
      expect(b.mock.calls.map(([k]) => `${k.key}:${k.action}`)).toEqual(['down:down', 'down:up']);

      a.mockClear();
      b.mockClear();
      await act(async () => {
        fireEvent(screen.getByTestId('web-inner-input'), 'focus');
      });

      const preventSpace = jest.fn();
      emit('keydown', { key: ' ', repeat: false, preventDefault: preventSpace });
      expect(preventSpace).not.toHaveBeenCalled();
      expect(a).not.toHaveBeenCalled();
      expect(b).not.toHaveBeenCalled();

      const preventEsc = jest.fn();
      emit('keydown', { key: 'Escape', repeat: false, preventDefault: preventEsc });
      emit('keyup', { key: 'Escape' });
      expect(preventEsc).toHaveBeenCalledTimes(1);
      expect(a.mock.calls.map(([k]) => `${k.key}:${k.action}`)).toEqual([
        'back:down',
        'back:cancel',
      ]);

      await view.unmount();
      expect(count('keydown')).toBe(0);

      // TextEntryBoundary ABOVE TvRemoteProvider
      const aboveInput = jest.fn<void, [KeyInput]>();
      const wrapper = ({ children }: { children: ReactNode }) => (
        <TextEntryBoundary>
          <TvRemoteProvider>
            <TvTextInput testID="web-outer-input" />
            {children}
          </TvRemoteProvider>
        </TextEntryBoundary>
      );
      const hook = await renderHook(() => useTvKeySource(aboveInput), { wrapper });
      expect(count('keydown')).toBe(1);
      await act(async () => {
        fireEvent(screen.getByTestId('web-outer-input'), 'focus');
      });
      const preventArrow = jest.fn();
      emit('keydown', { key: 'ArrowLeft', repeat: false, preventDefault: preventArrow });
      expect(preventArrow).not.toHaveBeenCalled();
      expect(aboveInput).not.toHaveBeenCalled();
      await hook.unmount();
    } finally {
      (globalThis as { window?: unknown }).window = prevWindow;
    }
  });
});
