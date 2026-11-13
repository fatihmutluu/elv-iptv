import {
  createFocusStore,
  createKeyInterpreter,
  findList,
  type Intent,
  type KeyInput,
} from '@elv/focus-core';
import { renderHook } from '@testing-library/react-native';
import { BackHandler, Platform, TVEventHandler } from 'react-native';
import { useTvKeySource } from '../key-source';

type RemoteEvent = { eventType: string; eventKeyAction?: number };

/**
 * The event sequences react-native-tvos 0.88 delivers to `TVEventHandler` on Android TV, recorded on the API 36
 * emulator with a focused root view (`adb shell input keyevent [--duration ms] 20|23`): a tap arrives only at the
 * release as one `eventKeyAction: 1` event; a hold arrives as `long<Key>` with action 0 at the long-press timeout and
 * `long<Key>` with action 1 at the release, with no events in between.
 */
const ANDROID = {
  tapDown: [{ eventType: 'down', eventKeyAction: 1 }],
  holdDown: [
    { eventType: 'longDown', eventKeyAction: 0 },
    { eventType: 'longDown', eventKeyAction: 1 },
  ],
  tapSelect: [{ eventType: 'select', eventKeyAction: 1 }],
  holdSelect: [
    { eventType: 'longSelect', eventKeyAction: 0 },
    { eventType: 'longSelect', eventKeyAction: 1 },
  ],
} satisfies Record<string, RemoteEvent[]>;

/** Wires the key source to an interpreter and a 100,000-item list store, as a TV screen does. */
async function androidScreen() {
  jest.replaceProperty(Platform, 'OS', 'android');
  jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
  let remote: ((event: RemoteEvent) => void) | undefined;
  jest.spyOn(TVEventHandler, 'addListener').mockImplementation((listener) => {
    remote = listener as (event: RemoteEvent) => void;
    return { remove: () => {} };
  });
  jest.spyOn(BackHandler, 'addEventListener').mockImplementation(() => ({ remove: () => {} }));
  const store = createFocusStore({
    id: 'root',
    lists: [{ id: 'list', count: 100_000, index: 0, orientation: 'vertical', pageSize: 10 }],
    active: 'list',
  });
  const interpreter = createKeyInterpreter();
  const intents: Intent[] = [];
  const inputs: KeyInput[] = [];
  await renderHook(() =>
    useTvKeySource((k) => {
      inputs.push(k);
      for (const e of interpreter.input(k)) intents.push(...store.dispatch(e));
    }),
  );
  const send = (events: RemoteEvent[]) => {
    for (const event of events) remote?.(event);
  };
  const index = () => findList(store.getState().scopes, 'list')?.list.index;
  return { send, index, intents, inputs };
}

describe('Android TV remote, end to end (key source -> interpreter -> store)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('moves one row per D-pad tap, on the release the runtime delivers', async () => {
    const screen = await androidScreen();
    screen.send(ANDROID.tapDown);
    expect(screen.index()).toBe(1);
    for (let i = 0; i < 4; i++) screen.send(ANDROID.tapDown);
    expect(screen.index()).toBe(5);
    expect(screen.inputs.every((k) => k.action === 'up')).toBe(true);
  });

  it('jumps one page for a D-pad hold, with no extra step on release', async () => {
    const screen = await androidScreen();
    screen.send(ANDROID.holdDown);
    expect(screen.index()).toBe(10);
    screen.send(ANDROID.tapDown);
    expect(screen.index()).toBe(11);
  });

  it('selects once per tap and long-selects once per hold', async () => {
    const screen = await androidScreen();
    screen.send(ANDROID.tapSelect);
    screen.send(ANDROID.holdSelect);
    expect(screen.intents.map((i) => i.kind)).toEqual(['select', 'long']);
    expect(screen.index()).toBe(0);
  });
});
