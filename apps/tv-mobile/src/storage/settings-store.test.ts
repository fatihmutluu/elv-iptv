import { DEFAULT_USER_DATA_MAX_BYTES } from '@elv/data';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
  get: vi.fn((key: string): unknown => settings.values[key]),
  set: vi.fn((values: Record<string, unknown>) => {
    Object.assign(settings.values, values);
  }),
}));
const nativeKv = vi.hoisted(() => ({
  budget: null as number | null,
  readValue: null as string | null,
  writeResult: true,
  writeLocalResult: true,
  getApplePersistentBudgetBytes: vi.fn(() => nativeKv.budget),
  readApplePersistentValue: vi.fn((_key: string) => nativeKv.readValue),
  writeApplePersistentValue: vi.fn((_key: string, _value: string) => nativeKv.writeResult),
  writeAppleLocalPersistentValue: vi.fn(
    (_key: string, _value: string) => nativeKv.writeLocalResult,
  ),
}));
vi.mock('react-native', () => ({ Settings: { get: settings.get, set: settings.set } }));
vi.mock('@elv/engine-aether', () => ({
  getApplePersistentBudgetBytes: nativeKv.getApplePersistentBudgetBytes,
  readApplePersistentValue: nativeKv.readApplePersistentValue,
  writeApplePersistentValue: nativeKv.writeApplePersistentValue,
  writeAppleLocalPersistentValue: nativeKv.writeAppleLocalPersistentValue,
}));

import { createAppleUserDataStore, createSettingsStore } from './settings-store';

beforeEach(() => {
  settings.values = {};
  settings.get.mockClear();
  settings.set.mockClear();
  nativeKv.budget = null;
  nativeKv.readValue = null;
  nativeKv.writeResult = true;
  nativeKv.writeLocalResult = true;
  nativeKv.getApplePersistentBudgetBytes.mockClear();
  nativeKv.readApplePersistentValue.mockClear();
  nativeKv.writeApplePersistentValue.mockClear();
  nativeKv.writeAppleLocalPersistentValue.mockClear();
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

describe('createAppleUserDataStore (#79)', () => {
  it('falls back to React Native Settings with a strict 384 KB UTF-8 guard when native KV is absent', () => {
    const store = createAppleUserDataStore('elv.catalog.userstate.v1');
    expect(store.maxBytes).toBe(DEFAULT_USER_DATA_MAX_BYTES);
    store.write('{"v":1,"favorites":[],"progress":[]}');
    expect(settings.set).toHaveBeenCalledWith({
      'elv.catalog.userstate.v1': '{"v":1,"favorites":[],"progress":[]}',
    });
    expect(store.read()).toBe('{"v":1,"favorites":[],"progress":[]}');
    expect(nativeKv.writeApplePersistentValue).not.toHaveBeenCalled();

    // Oversized payload (> 384 KB) must never hit NSUserDefaults via Settings.set.
    settings.set.mockClear();
    store.write('x'.repeat(DEFAULT_USER_DATA_MAX_BYTES + 1));
    expect(settings.set).not.toHaveBeenCalled();
  });

  it('reads dynamic budget from native KV bridge, never bypasses native size rejections, and routes writeLocalFallback', () => {
    nativeKv.budget = 921_600;
    nativeKv.readValue = '{"v":1,"favorites":[{"id":"f1"}],"progress":[]}';
    const store = createAppleUserDataStore('elv.catalog.userstate.v1');
    expect(store.maxBytes).toBe(921_600);
    expect(store.read()).toBe(nativeKv.readValue);

    // Dynamic budget update when iCloud availability changes at runtime.
    nativeKv.budget = 393_216;
    expect(store.maxBytes).toBe(393_216);

    // Even when native write rejects (e.g. oversized payload), never fall through to unguarded Settings.set.
    nativeKv.writeResult = false;
    store.write('x'.repeat(450_000));
    expect(nativeKv.writeApplePersistentValue).toHaveBeenCalledTimes(1);
    expect(settings.set).not.toHaveBeenCalled();

    // writeLocalFallback writes strictly <= 384 KB through native local bridge.
    store.writeLocalFallback?.('{"v":1,"favorites":[],"progress":[]}');
    expect(nativeKv.writeAppleLocalPersistentValue).toHaveBeenCalledWith(
      'elv.catalog.userstate.v1',
      '{"v":1,"favorites":[],"progress":[]}',
    );
    nativeKv.writeAppleLocalPersistentValue.mockClear();
    store.writeLocalFallback?.('x'.repeat(DEFAULT_USER_DATA_MAX_BYTES + 1));
    expect(nativeKv.writeAppleLocalPersistentValue).not.toHaveBeenCalled();
  });

  it('falls back to Settings on read when native persistent read returns null', () => {
    nativeKv.budget = 393_216;
    nativeKv.readValue = null;
    settings.values['elv.catalog.userstate.v1'] = '{"v":1,"from":"local"}';
    const store = createAppleUserDataStore('elv.catalog.userstate.v1');
    expect(store.read()).toBe('{"v":1,"from":"local"}');
  });
});
