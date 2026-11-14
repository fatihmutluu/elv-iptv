import { describe, expect, it } from 'vitest';
import { choosePresenter, WINDOWS_DEFAULT_PRESENTER } from './choose.ts';

describe('choosePresenter', () => {
  it('darwin is own-window', () => {
    expect(choosePresenter('darwin')).toBe('own-window');
  });

  it('win32 uses the Windows default', () => {
    expect(choosePresenter('win32')).toBe(WINDOWS_DEFAULT_PRESENTER);
  });

  it('other platforms use own-window', () => {
    expect(choosePresenter('linux')).toBe('own-window');
  });

  it('an override wins', () => {
    expect(choosePresenter('darwin', 'child-window')).toBe('child-window');
    expect(choosePresenter('win32', 'own-window')).toBe('own-window');
  });
});
