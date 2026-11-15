import { createFocusStore, findList, type Intent, type KeyEvent } from '@elv/focus-core';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { useRef } from 'react';
import { BackHandler, Platform, View } from 'react-native';
import type { AndroidKeyEvent, AndroidKeySource } from '../android-keys';
import {
  RemoteKeysProvider,
  TextEntryBoundary,
  TvTextInput,
  type TvTextInputInstance,
  useKeyInterpreter,
  useTextEntrySuspension,
} from '../index';

function fakeAndroidSource() {
  let listener: ((e: AndroidKeyEvent) => void) | undefined;
  const source: AndroidKeySource = {
    addListener: (l) => {
      listener = l;
      return {
        remove: () => {
          listener = undefined;
        },
      };
    },
  };
  return {
    source,
    emit: (e: AndroidKeyEvent) => listener?.(e),
    key: (action: 'down' | 'up', keyCode: number, ageMs = 0) =>
      listener?.({ action, keyCode, canceled: false, ageMs }),
  };
}

function Harness({
  store,
  intents,
  events,
  onInputBlur,
}: {
  store: ReturnType<typeof createFocusStore>;
  intents: Intent[];
  events?: KeyEvent[];
  onInputBlur?: () => void;
}) {
  const inputRef = useRef<TvTextInputInstance>(null);
  useKeyInterpreter((event) => {
    events?.push(event);
    intents.push(...store.dispatch(event));
  });
  return (
    <View>
      <TvTextInput ref={inputRef} testID="search-input" onBlur={onInputBlur} />
    </View>
  );
}

function Probe({ onEvent }: { onEvent: (e: KeyEvent) => void }) {
  useKeyInterpreter(onEvent);
  const { enter } = useTextEntrySuspension(false);
  void enter;
  return <View />;
}

async function advanceFrames(ms: number, step = 16): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    await act(async () => {
      jest.advanceTimersByTime(step);
    });
  }
}

describe('TextEntryBoundary, TvTextInput and useKeyInterpreter (#48)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
    jest.spyOn(BackHandler, 'addEventListener').mockImplementation(() => ({ remove: () => {} }));
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('cancels held non-back keys on focus, suppresses non-back keys while focused, blurs on short back without popping, allows backLong, and drops orphan up after mid-hold exit', async () => {
    const raw = fakeAndroidSource();
    const store = createFocusStore({
      id: 'root',
      lists: [{ id: 'list', count: 50, index: 0, orientation: 'vertical', pageSize: 10 }],
      active: 'list',
    });
    store.pushScope(
      'search',
      [{ id: 'results', count: 20, index: 0, orientation: 'vertical', pageSize: 5 }],
      'results',
    );
    const intents: Intent[] = [];
    const events: KeyEvent[] = [];
    const blurred = jest.fn();

    await render(
      <RemoteKeysProvider android={raw.source}>
        <TextEntryBoundary>
          <Harness store={store} intents={intents} events={events} onInputBlur={blurred} />
        </TextEntryBoundary>
      </RemoteKeysProvider>,
    );

    const input = screen.getByTestId('search-input');
    const resultsIndex = () => findList(store.getState().scopes, 'results')?.list.index;

    // 1. Start holding Down (20) -> steps once to index 1, then focus TvTextInput -> cancels held Down (zero stuck repeats!)
    await act(async () => raw.key('down', 20));
    expect(resultsIndex()).toBe(1);
    await act(async () => fireEvent(input, 'focus'));
    await advanceFrames(1000);
    expect(resultsIndex()).toBe(1);

    // 2. While focused, D-pad, Select and digits do not reach FocusStore
    await act(async () => {
      raw.key('down', 20);
      raw.key('up', 20);
      raw.key('down', 21);
      raw.key('up', 21);
      raw.key('down', 23);
      raw.key('up', 23);
      raw.key('down', 7);
      raw.key('up', 7);
    });
    expect(resultsIndex()).toBe(1);
    expect(intents).toEqual([]);

    // 3. Long Back (>= 500ms) while focused still dispatches backLong without popping the scope
    await act(async () => raw.key('down', 4));
    await advanceFrames(560);
    await act(async () => raw.key('up', 4));
    expect(intents).toEqual([{ kind: 'backLong' }]);
    expect(store.getState().scopes).toHaveLength(2);

    // 4. Short Back (< 500ms) blurs/exits text entry without popping the 'search' scope!
    intents.length = 0;
    await act(async () => raw.key('down', 4));
    await advanceFrames(80);
    await act(async () => raw.key('up', 4));
    // Simulate RN TextInput firing onBlur when native blur() is called
    await act(async () => fireEvent(input, 'blur'));
    expect(intents).toEqual([]);
    expect(store.getState().scopes).toHaveLength(2);

    // Next short Back (after leaving text-entry) pops 'search' scope normally
    await act(async () => raw.key('down', 4));
    await advanceFrames(80);
    await act(async () => raw.key('up', 4));
    expect(store.getState().scopes).toHaveLength(1);

    // 5. Leaving text-entry mid-hold of Select (23) does not synthesize a bogus press on orphan up
    intents.length = 0;
    await act(async () => fireEvent(input, 'focus'));
    await act(async () => raw.key('down', 23));
    await act(async () => fireEvent(input, 'blur'));
    await act(async () => raw.key('up', 23));
    expect(intents).toEqual([]);
  });

  it('acknowledges edge/non-moving repeats and simultaneous holds via rAF without deadlocking, and guards 1 turn on >100ms stalls', async () => {
    const raw = fakeAndroidSource();
    const events: KeyEvent[] = [];

    const view = await render(
      <RemoteKeysProvider android={raw.source}>
        <Probe onEvent={(e) => events.push(e)} />
      </RemoteKeysProvider>,
    );

    // Hold both Rewind (89) and FastForward (90) simultaneously with no TvList/onFrameCommitted
    await act(async () => {
      raw.key('down', 89);
      raw.key('down', 90);
    });
    await advanceFrames(1000);
    await act(async () => {
      raw.key('up', 89);
      raw.key('up', 90);
    });

    const rwRepeats = events.filter((e) => e.key === 'rewind' && e.kind === 'repeat');
    const ffRepeats = events.filter((e) => e.key === 'fastForward' && e.kind === 'repeat');
    expect(rwRepeats.length).toBeGreaterThanOrEqual(3);
    expect(ffRepeats.length).toBeGreaterThanOrEqual(3);

    // 1-turn stall guard: simulate a 550ms wall-clock jump before the interval fires, followed by an 80ms Back up
    events.length = 0;
    let fakeNow = 2000;
    jest.spyOn(performance, 'now').mockImplementation(() => fakeNow);
    await act(async () => raw.key('down', 4, 0));
    fakeNow = 2550;
    // One overdue interval fires at fakeNow=2550 (delta 550 > 100 -> skipped!), then queued 80ms up arrives
    await act(async () => {
      jest.advanceTimersByTime(16);
      raw.key('up', 4, 470);
    });
    expect(events).toEqual([{ key: 'back', kind: 'press', time: 2080 }]);

    await view.unmount();
  });
});
