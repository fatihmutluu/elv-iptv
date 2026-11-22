import { describe, expect, it } from 'vitest';
import { choosePresenter, parsePresenterOverride, WINDOWS_DEFAULT_PRESENTER } from './choose.ts';

describe('choosePresenter', () => {
  it('defaults win32 to canvas', () => {
    expect(WINDOWS_DEFAULT_PRESENTER).toBe('canvas');
    expect(choosePresenter('win32')).toBe('canvas');
  });

  it('darwin is own-window', () => {
    expect(choosePresenter('darwin')).toBe('own-window');
  });

  it('other platforms use own-window', () => {
    expect(choosePresenter('linux')).toBe('own-window');
  });

  it('an override wins', () => {
    expect(choosePresenter('darwin', 'child-window')).toBe('child-window');
    expect(choosePresenter('win32', 'own-window')).toBe('own-window');
    expect(choosePresenter('win32', 'child-window')).toBe('child-window');
    expect(choosePresenter('linux', 'canvas')).toBe('canvas');
  });
});

describe('parsePresenterOverride', () => {
  it('accepts canvas, child-window, and own-window (ignoring surrounding whitespace)', () => {
    expect(parsePresenterOverride('canvas')).toBe('canvas');
    expect(parsePresenterOverride(' child-window ')).toBe('child-window');
    expect(parsePresenterOverride('own-window')).toBe('own-window');
  });

  it('returns undefined for absent, empty, or unknown values', () => {
    expect(parsePresenterOverride(undefined)).toBeUndefined();
    expect(parsePresenterOverride('')).toBeUndefined();
    expect(parsePresenterOverride('   ')).toBeUndefined();
    expect(parsePresenterOverride('CANVAS')).toBeUndefined();
    expect(parsePresenterOverride('gpu')).toBeUndefined();
  });
});
