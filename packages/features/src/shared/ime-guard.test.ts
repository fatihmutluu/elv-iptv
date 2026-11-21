import { describe, expect, it, vi } from 'vitest';
import { createImeSubmitGuard, isImeComposingEvent } from './ime-guard';

describe('ime-guard', () => {
  it('detects composing events across DOM and React Native shapes', () => {
    expect(isImeComposingEvent(null)).toBe(false);
    expect(isImeComposingEvent(undefined)).toBe(false);
    expect(isImeComposingEvent({ key: 'Enter', isComposing: false })).toBe(false);
    expect(isImeComposingEvent({ isComposing: true })).toBe(true);
    expect(isImeComposingEvent({ keyCode: 229 })).toBe(true);
    expect(isImeComposingEvent({ key: 'Process' })).toBe(true);
    expect(isImeComposingEvent({ nativeEvent: { isComposing: true } })).toBe(true);
    expect(isImeComposingEvent({ nativeEvent: { keyCode: 229 } })).toBe(true);
    expect(isImeComposingEvent({ nativeEvent: { key: 'Process' } })).toBe(true);
  });

  it('suppresses premature submit after composing Enter without calling preventDefault, and clears on non-composing keys or blur', () => {
    const guard = createImeSubmitGuard();
    const preventDefault = vi.fn();

    // Regular composing character keystrokes must NEVER call preventDefault or arm submit suppression
    guard.onKeyPress({ nativeEvent: { key: 'a', isComposing: true }, preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(guard.shouldAllowSubmit({ nativeEvent: { text: 'あ' } })).toBe(true);

    // Composing Enter arms suppression without calling preventDefault
    guard.onKeyPress({ nativeEvent: { key: 'Enter', isComposing: true }, preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(guard.shouldAllowSubmit({ nativeEvent: { text: '東京' } })).toBe(false);

    // Subsequent normal submit is allowed
    expect(guard.shouldAllowSubmit({ nativeEvent: { text: '東京' } })).toBe(true);

    // Composing keyCode 229 followed by ANY non-composing keyPress clears suppression
    guard.onKeyPress({ nativeEvent: { key: 'Enter', keyCode: 229 }, preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    guard.onKeyPress({ nativeEvent: { key: 'a', isComposing: false } });
    expect(guard.shouldAllowSubmit({ nativeEvent: { text: '東京a' } })).toBe(true);

    // Blur clears any pending suppression
    guard.onKeyPress({ nativeEvent: { key: 'Enter', isComposing: true } });
    guard.reset();
    expect(guard.shouldAllowSubmit({ nativeEvent: { text: '東京' } })).toBe(true);
  });
});
