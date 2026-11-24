/** Payload handed to an optional host OS notification adapter when a reminder fires (`#35`). */
export interface ReminderNotificationPayload {
  readonly channelKey: string;
  readonly channelName: string;
  readonly programmeTitle: string;
  readonly programmeStart: number;
  readonly startsInMinutes: number;
}

/**
 * Optional host port allowing Desktop (Electron `Notification`) or future native platforms
 * to surface an OS-level alert when a programme reminder triggers while the window is unfocused (`#35`).
 */
export interface ReminderHostPort {
  notifyReminder(payload: ReminderNotificationPayload): void;
}
