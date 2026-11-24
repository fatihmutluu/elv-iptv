import type { ReminderNotificationPayload } from '@elv/features';
import { describe, expect, it, vi } from 'vitest';
import { createDesktopReminderHost, type DesktopNotificationCtor } from './adapter.ts';

const SAMPLE: ReminderNotificationPayload = {
  channelKey: 'm:s1:ch1',
  channelName: 'News One HD',
  programmeTitle: 'Evening Report',
  programmeStart: 1_700_003_600_000,
  startsInMinutes: 5,
};

function makeFakeNotification(permission: string, shouldThrow = false) {
  const calls: Array<{ title: string; options?: { body?: string; silent?: boolean } }> = [];
  const requestPermission = vi.fn();
  class FakeNotification {
    static readonly permission = permission;
    static readonly requestPermission = requestPermission;
    constructor(title: string, options?: { body?: string; silent?: boolean }) {
      calls.push({ title, ...(options === undefined ? {} : { options }) });
      if (shouldThrow) throw new Error('notification daemon unavailable');
    }
  }
  return {
    ctor: FakeNotification as unknown as DesktopNotificationCtor,
    calls,
    requestPermission,
  };
}

describe('createDesktopReminderHost (#35)', () => {
  it('fires an OS Notification when the window is hidden and permission is granted', () => {
    const fake = makeFakeNotification('granted');
    const host = createDesktopReminderHost({
      document: { visibilityState: 'hidden' },
      Notification: fake.ctor,
    });

    host.notifyReminder(SAMPLE);
    expect(fake.calls).toEqual([
      {
        title: 'Evening Report',
        options: { body: 'News One HD — Starts in 5 min', silent: false },
      },
    ]);
    expect(fake.requestPermission).not.toHaveBeenCalled();

    host.notifyReminder({ ...SAMPLE, startsInMinutes: 0 });
    expect(fake.calls[1]).toEqual({
      title: 'Evening Report',
      options: { body: 'News One HD — Starting now', silent: false },
    });
  });

  it('does not fire when the window is visible to avoid duplicating the in-app banner', () => {
    const fake = makeFakeNotification('granted');
    const host = createDesktopReminderHost({
      document: { visibilityState: 'visible' },
      Notification: fake.ctor,
    });

    host.notifyReminder(SAMPLE);
    expect(fake.calls).toHaveLength(0);
    expect(fake.requestPermission).not.toHaveBeenCalled();
  });

  it('does not fire or prompt when permission is default or denied', () => {
    for (const permission of ['default', 'denied']) {
      const fake = makeFakeNotification(permission);
      const host = createDesktopReminderHost({
        document: { visibilityState: 'hidden' },
        Notification: fake.ctor,
      });
      host.notifyReminder(SAMPLE);
      expect(fake.calls).toHaveLength(0);
      expect(fake.requestPermission).not.toHaveBeenCalled();
    }
  });

  it('is a safe no-op when document or Notification is unavailable or constructor throws', () => {
    const noDoc = createDesktopReminderHost({
      document: null,
      Notification: makeFakeNotification('granted').ctor,
    });
    expect(() => noDoc.notifyReminder(SAMPLE)).not.toThrow();

    const noApi = createDesktopReminderHost({
      document: { visibilityState: 'hidden' },
      Notification: null,
    });
    expect(() => noApi.notifyReminder(SAMPLE)).not.toThrow();

    const throwing = makeFakeNotification('granted', true);
    const throwingHost = createDesktopReminderHost({
      document: { visibilityState: 'hidden' },
      Notification: throwing.ctor,
    });
    expect(() => throwingHost.notifyReminder(SAMPLE)).not.toThrow();
    expect(throwing.calls).toHaveLength(1);
  });
});
