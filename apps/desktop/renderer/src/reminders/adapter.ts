import type { ReminderHostPort, ReminderNotificationPayload } from '@elv/features';

/** Minimal `Notification` constructor surface used by {@link createDesktopReminderHost} (`#35`). */
export interface DesktopNotificationCtor {
  readonly permission: string;
  new (title: string, options?: { readonly body?: string; readonly silent?: boolean }): unknown;
}

/** Injectable browser/Electron globals for testing {@link createDesktopReminderHost} cleanly. */
export interface DesktopReminderHostEnv {
  readonly document?: { readonly visibilityState?: string } | null;
  readonly Notification?: DesktopNotificationCtor | null;
}

function cleanText(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    out += code < 0x20 || code === 0x7f ? ' ' : raw[i];
  }
  return out.trim();
}

function formatReminderBody(channelName: string, timingText?: string): string {
  const timing = timingText === undefined ? '' : cleanText(timingText);
  if (timing.length > 0) {
    return channelName.length > 0 ? `${channelName} — ${timing}` : timing;
  }
  return channelName;
}

/**
 * Creates a Desktop {@link ReminderHostPort} that dispatches a native OS `Notification` only when
 * the Electron window is unfocused/hidden (`visibilityState === 'hidden'`) and notification
 * permission is already `'granted'` — never prompting unexpectedly or duplicating the in-app
 * Cinema Quietude banner (`#35`).
 */
export function createDesktopReminderHost(env?: DesktopReminderHostEnv): ReminderHostPort {
  const getDoc = () =>
    env && 'document' in env ? env.document : typeof document !== 'undefined' ? document : null;
  const getNotificationCtor = (): DesktopNotificationCtor | null => {
    if (env && 'Notification' in env) return env.Notification ?? null;
    if (typeof Notification !== 'undefined') {
      return Notification as unknown as DesktopNotificationCtor;
    }
    return null;
  };

  return {
    notifyReminder(payload: ReminderNotificationPayload): void {
      const doc = getDoc();
      if (doc?.visibilityState !== 'hidden') return;
      const NotificationCtor = getNotificationCtor();
      if (NotificationCtor?.permission !== 'granted') return;

      const programmeTitle = cleanText(payload.programmeTitle);
      const channelName = cleanText(payload.channelName);
      const title = programmeTitle || channelName || 'ELV IPTV';
      const body = formatReminderBody(channelName, payload.timingText);
      try {
        // Construct native OS notification only while hidden; errors on headless Linux/CI are isolated.
        void new NotificationCtor(title, { body, silent: false });
      } catch {
        // Isolate unavailable OS notification daemon errors
      }
    },
  };
}
