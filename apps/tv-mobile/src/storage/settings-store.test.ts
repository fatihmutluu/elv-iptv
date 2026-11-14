import { beforeEach, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
  get: vi.fn((key: string): unknown => settings.values[key]),
  set: vi.fn((values: Record<string, unknown>) => {
    Object.assign(settings.values, values);
  }),
}));
vi.mock('react-native', () => ({ Settings: { get: settings.get, set: settings.set } }));

import { createSettingsStore } from './settings-store';

beforeEach(() => {
  settings.values = {};
  settings.get.mockClear();
  settings.set.mockClear();
});

describe('createSettingsStore', () => {
  it('writes and reads one string under its key', () => {
    const store = createSettingsStore('elv.test');
    expect(store.read()).toBeUndefined();
    store.write('{"v":1}');
    expect(settings.set).toHaveBeenCalledWith({ 'elv.test': '{"v":1}' });
    expect(store.read()).toBe('{"v":1}');
  });

  it('reads a value of another type as nothing', () => {
    settings.values['elv.test'] = 42;
    expect(createSettingsStore('elv.test').read()).toBeUndefined();
  });

  it('swallows failures of the settings module', () => {
    settings.get.mockImplementationOnce(() => {
      throw new Error('no module');
    });
    settings.set.mockImplementationOnce(() => {
      throw new Error('no module');
    });
    const store = createSettingsStore('elv.test');
    expect(store.read()).toBeUndefined();
    expect(() => store.write('x')).not.toThrow();
  });
});
