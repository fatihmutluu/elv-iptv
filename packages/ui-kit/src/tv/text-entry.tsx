import {
  type ComponentPropsWithRef,
  type ComponentRef,
  createContext,
  type ReactElement,
  type ReactNode,
  type Ref,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from 'react';
import { TextInput } from 'react-native';
import { TvRemoteContext } from './remote-context';

/** Coordinates active text-entry sessions with `useTvKeySource` and `useKeyInterpreter`. */
export interface TextEntryController {
  isActive(): boolean;
  enter(onExit?: () => void): () => void;
  exit(): boolean;
  onEnter(listener: () => void): () => void;
}

/** Creates an isolated text-entry suspension controller. */
function createTextEntryController(): TextEntryController {
  let nextId = 1;
  const sessions = new Map<number, (() => void) | undefined>();
  const enterListeners = new Set<() => void>();

  return {
    isActive: () => sessions.size > 0,
    enter(onExit) {
      const wasActive = sessions.size > 0;
      const id = nextId++;
      sessions.set(id, onExit);
      if (!wasActive) {
        for (const listener of [...enterListeners]) listener();
      }
      return () => {
        sessions.delete(id);
      };
    },
    exit() {
      const entries = [...sessions.entries()];
      const last = entries.at(-1);
      if (!last) return false;
      sessions.delete(last[0]);
      last[1]?.();
      return true;
    },
    onEnter(listener) {
      enterListeners.add(listener);
      return () => {
        enterListeners.delete(listener);
      };
    },
  };
}

/** Internal context shared by `TextEntryBoundary`, `TvTextInput`, `useTvKeySource`, and `useKeyInterpreter`. */
export const TextEntryContext = createContext<TextEntryController>(createTextEntryController());

/** Isolates TV text-entry key suspension within a component subtree. */
export function TextEntryBoundary({ children }: { children: ReactNode }): ReactElement {
  const controller = useMemo(() => createTextEntryController(), []);
  const dispatcher = useContext(TvRemoteContext);
  useEffect(() => dispatcher?.registerTextEntry(controller), [dispatcher, controller]);
  return <TextEntryContext.Provider value={controller}>{children}</TextEntryContext.Provider>;
}

/** Handle returned by {@link useTextEntrySuspension}. */
export interface TextEntrySuspension {
  isActive(): boolean;
  /** Enters text-entry mode synchronously and returns an idempotent cleanup function. */
  enter(onExit?: () => void): () => void;
}

/**
 * Suspends non-`back` remote keys while a TV text input or custom keyboard is active.
 * Pass `active` to bind declaratively to component state, or call `enter(onExit)` imperatively on focus/blur.
 */
export function useTextEntrySuspension(active = false, onExit?: () => void): TextEntrySuspension {
  const controller = useContext(TextEntryContext);
  const exitRef = useRef(onExit);
  exitRef.current = onExit;

  useEffect(() => {
    if (!active) return;
    return controller.enter(() => exitRef.current?.());
  }, [active, controller]);

  const enter = useCallback((cb?: () => void) => controller.enter(cb), [controller]);
  const isActive = useCallback(() => controller.isActive(), [controller]);
  return useMemo(() => ({ isActive, enter }), [isActive, enter]);
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === 'function') ref(value);
  else if (ref !== undefined && ref !== null) {
    (ref as { current: T | null }).current = value;
  }
}

/** Instance handle type of {@link TvTextInput}. */
export type TvTextInputInstance = ComponentRef<typeof TextInput>;

/** Props of {@link TvTextInput}. */
export type TvTextInputProps = ComponentPropsWithRef<typeof TextInput>;

/**
 * `TextInput` integrated with TV remote key suspension (#48): focusing cancels held non-`back` keys and suppresses
 * non-`back` remote keys while focused; a short `back` press blurs the input without popping the screen, whereas a
 * long `back` hold still dispatches `backLong`.
 */
export function TvTextInput({ ref, onFocus, onBlur, ...rest }: TvTextInputProps): ReactElement {
  const controller = useContext(TextEntryContext);
  const inputRef = useRef<TvTextInputInstance | null>(null);
  const leaveRef = useRef<(() => void) | undefined>(undefined);

  const setRef = useCallback(
    (node: TvTextInputInstance | null) => {
      inputRef.current = node;
      assignRef(ref, node);
    },
    [ref],
  );

  useEffect(
    () => () => {
      leaveRef.current?.();
      leaveRef.current = undefined;
    },
    [],
  );

  return (
    <TextInput
      {...rest}
      ref={setRef}
      onFocus={(e) => {
        leaveRef.current?.();
        leaveRef.current = controller.enter(() => inputRef.current?.blur());
        onFocus?.(e);
      }}
      onBlur={(e) => {
        leaveRef.current?.();
        leaveRef.current = undefined;
        onBlur?.(e);
      }}
    />
  );
}
