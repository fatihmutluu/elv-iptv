import type { LiveChannel } from './catalog.ts';

/** Position (modulo) of live channels that keep a guide id on the `quirks` account; the rest report none. */
const GUIDE_KEPT_EVERY = 10;
const CREATED_LIVE_EVERY = 10;
const CREATED_LIVE_OFFSET = 5;
const ARCHIVE_EVERY = 5;
const ARCHIVE_DAYS = 3;

/** Whether the live channel at `index` still reports its guide id on the `quirks` account. */
export const quirkKeepsGuideId = (index: number): boolean => index % GUIDE_KEPT_EVERY === 0;

/** Whether the live channel at `index` is a `created_live` stream on the `quirks` account. */
export const quirkIsCreatedLive = (index: number): boolean =>
  index % CREATED_LIVE_EVERY === CREATED_LIVE_OFFSET;

/** Archive days of a live channel on the `quirks` account: every fifth channel offers a 3-day archive. */
export const quirkArchiveDays = (index: number, ch: LiveChannel): number =>
  index % ARCHIVE_EVERY === 0 ? ARCHIVE_DAYS : ch.archiveDays;
