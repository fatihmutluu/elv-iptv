import type { Key, KeyEvent, KeyInput } from '@elv/focus-core';
import { render } from '@testing-library/react-native';
import { useKeyInterpreter } from '../use-key-interpreter';

type KeyInputCallback = ((input: KeyInput) => boolean | undefined) | ((input: KeyInput) => void);

interface HarnessProps {
  longKeys?: readonly Key[];
  onEvent: (event: KeyEvent) => void;
  onCaptureInput: (cb: KeyInputCallback) => void;
  now: () => number;
}

function Harness({ longKeys, onEvent, onCaptureInput, now }: HarnessProps): null {
  useKeyInterpreter(onEvent, {
    longKeys,
    now,
    keySource: (cb) => {
      onCaptureInput(cb);
    },
  });
  return null;
}

describe('useKeyInterpreter longKeys reactivity', () => {
  it('updates longKeys dynamically without changing the keySource callback identity', async () => {
    const events: KeyEvent[] = [];
    const capturedCallbacks: KeyInputCallback[] = [];
    let clock = 0;

    const { rerender } = await render(
      <Harness
        longKeys={['select', 'back']}
        onEvent={(e) => events.push(e)}
        onCaptureInput={(cb) => capturedCallbacks.push(cb)}
        now={() => clock}
      />,
    );

    const firstCb = capturedCallbacks[0];
    expect(firstCb).toBeDefined();

    // Before adding 'menu' to longKeys, holding 'menu' past 500ms emits press on up.
    clock = 0;
    firstCb?.({ key: 'menu', action: 'down', time: 0 });
    clock = 600;
    firstCb?.({ key: 'menu', action: 'up', time: 600 });
    expect(events).toEqual([{ key: 'menu', kind: 'press', time: 600 }]);
    events.length = 0;

    // Update longKeys to include 'menu' without dropping key subscription (callback identity stays stable).
    await rerender(
      <Harness
        longKeys={['select', 'back', 'menu']}
        onEvent={(e) => events.push(e)}
        onCaptureInput={(cb) => capturedCallbacks.push(cb)}
        now={() => clock}
      />,
    );

    expect(capturedCallbacks[capturedCallbacks.length - 1]).toBe(firstCb);

    clock = 1000;
    firstCb?.({ key: 'menu', action: 'down', time: 1000 });
    clock = 1600;
    firstCb?.({ key: 'menu', action: 'up', time: 1600 });
    expect(events).toEqual([{ key: 'menu', kind: 'long', time: 1500 }]);
  });
});
