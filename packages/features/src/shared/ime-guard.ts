interface ImeEventLike {
  readonly isComposing?: unknown;
  readonly keyCode?: unknown;
  readonly key?: unknown;
  readonly nativeEvent?: {
    readonly isComposing?: unknown;
    readonly keyCode?: unknown;
    readonly key?: unknown;
  };
}

/**
 * Reports whether a keyboard or submit event originated from an active IME composition session
 * (`isComposing === true`, `keyCode === 229`, or `key === 'Process'`).
 */
export function isImeComposingEvent(event: unknown): boolean {
  if (typeof event !== 'object' || event === null) return false;
  const e = event as ImeEventLike;
  const ne = e.nativeEvent;
  return (
    e.isComposing === true ||
    e.keyCode === 229 ||
    e.key === 'Process' ||
    ne?.isComposing === true ||
    ne?.keyCode === 229 ||
    ne?.key === 'Process'
  );
}

function isImeCommitKeyEvent(event: unknown): boolean {
  if (!isImeComposingEvent(event)) return false;
  const e = event as ImeEventLike;
  const ne = e.nativeEvent;
  const key = ne?.key ?? e.key;
  const keyCode = ne?.keyCode ?? e.keyCode;
  return key === 'Enter' || key === 'Process' || keyCode === 229;
}

/** Stateful per-input IME Enter guard shared by `onKeyPress`, `onSubmitEditing`, and `onBlur`. */
export interface ImeSubmitGuard {
  onKeyPress(event: unknown): void;
  shouldAllowSubmit(event?: unknown): boolean;
  reset(): void;
}

/** Creates an {@link ImeSubmitGuard} preventing IME composition commits from prematurely submitting forms. */
export function createImeSubmitGuard(): ImeSubmitGuard {
  let suppressNextSubmit = false;
  return {
    onKeyPress(event: unknown): void {
      if (isImeCommitKeyEvent(event)) {
        suppressNextSubmit = true;
        return;
      }
      if (!isImeComposingEvent(event)) {
        suppressNextSubmit = false;
      }
    },
    shouldAllowSubmit(event?: unknown): boolean {
      const e = event as ImeEventLike | undefined;
      const explicitFalse = e?.isComposing === false || e?.nativeEvent?.isComposing === false;
      const blocked = isImeComposingEvent(event) || (suppressNextSubmit && !explicitFalse);
      suppressNextSubmit = false;
      return !blocked;
    },
    reset(): void {
      suppressNextSubmit = false;
    },
  };
}
