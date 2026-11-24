import type { ItemRow, ProgrammeRow } from '@elv/data';
import { describe, expect, it } from 'vitest';
import type { PlayableEntry } from '../ports/play-target';
import {
  buildCatchupPlayTarget,
  buildReminderKey,
  CATCHUP_DAY_MS,
  findArchiveProgrammeMatch,
  indexReminderKeys,
  isPastCatchupEligible,
  resolveCatchupAvailability,
} from './catchup-reminder-model';

const NOW = 1_700_000_000_000;

const CHANNEL: ItemRow = {
  id: 1,
  key: 'x:s1:live:10',
  kind: 'live',
  sourceId: 's1',
  providerId: '10',
  name: 'Cinema One',
  logo: 'http://example.invalid/logo.png',
  rating: null,
  year: null,
  num: 10,
  catchupDays: 3,
};

const PAST_PROG: ProgrammeRow = {
  channelKey: CHANNEL.key,
  sourceId: 's1',
  guideId: 'cinema1',
  start: NOW - 2 * 3_600_000,
  stop: NOW - 3_600_000,
  title: 'Evening Classic',
  subTitle: null,
  description: 'A classic film.',
  episodeNum: null,
  icon: null,
  genre: 'movie',
  flags: 0,
};

describe('catchup-reminder-model', () => {
  it('resolves catch-up availability across valid, expired, archive-disabled, and non-past slots', () => {
    expect(resolveCatchupAvailability(CHANNEL, PAST_PROG, NOW)).toBe('available');
    expect(isPastCatchupEligible(CHANNEL, PAST_PROG, NOW)).toBe(true);

    // Explicit hasArchive === false from XMLTV or Xtream archive EPG disables catch-up
    expect(resolveCatchupAvailability(CHANNEL, { ...PAST_PROG, hasArchive: false }, NOW)).toBe(
      'unavailable',
    );
    expect(resolveCatchupAvailability(CHANNEL, PAST_PROG, NOW, false)).toBe('unavailable');

    // Older than catchupDays -> expired
    const expiredProg: ProgrammeRow = {
      ...PAST_PROG,
      start: NOW - 5 * CATCHUP_DAY_MS,
      stop: NOW - 4 * CATCHUP_DAY_MS,
    };
    expect(resolveCatchupAvailability(CHANNEL, expiredProg, NOW)).toBe('expired');
    expect(isPastCatchupEligible(CHANNEL, expiredProg, NOW)).toBe(false);

    // Channel without catchupDays -> unavailable
    expect(resolveCatchupAvailability({ ...CHANNEL, catchupDays: null }, PAST_PROG, NOW)).toBe(
      'unavailable',
    );
    expect(resolveCatchupAvailability({ ...CHANNEL, catchupDays: 0 }, PAST_PROG, NOW)).toBe(
      'unavailable',
    );

    // Currently airing or future programme -> unavailable
    expect(
      resolveCatchupAvailability(
        CHANNEL,
        { ...PAST_PROG, start: NOW - 60_000, stop: NOW + 60_000 },
        NOW,
      ),
    ).toBe('unavailable');
    expect(resolveCatchupAvailability(null, PAST_PROG, NOW)).toBe('unavailable');
  });

  it('matches Xtream archive entries by exact start or within +/- 5 min tolerance', () => {
    const entries: ProgrammeRow[] = [
      { ...PAST_PROG, start: PAST_PROG.start + 120_000, hasArchive: true },
      { ...PAST_PROG, start: PAST_PROG.start + 900_000, hasArchive: false },
    ];
    expect(findArchiveProgrammeMatch(entries, PAST_PROG)?.hasArchive).toBe(true);

    const exact: ProgrammeRow[] = [
      ...entries,
      { ...PAST_PROG, start: PAST_PROG.start, hasArchive: false },
    ];
    expect(findArchiveProgrammeMatch(exact, PAST_PROG)?.hasArchive).toBe(false);
    expect(
      findArchiveProgrammeMatch(
        [{ ...PAST_PROG, start: PAST_PROG.start + 20 * 60_000, hasArchive: true }],
        PAST_PROG,
      ),
    ).toBeUndefined();
  });

  it('builds a VOD catch-up PlayTarget preserving liveTarget and accountKey', () => {
    const liveTarget: PlayableEntry = {
      itemKey: CHANNEL.key,
      sourceId: CHANNEL.sourceId,
      accountKey: 'fp:abc',
      title: '10. Cinema One',
      kind: 'live',
      logo: CHANNEL.logo,
      itemKind: 'live',
    };
    const target = buildCatchupPlayTarget({
      channel: CHANNEL,
      programme: PAST_PROG,
      liveTarget,
      hasArchive: true,
    });
    expect(target.kind).toBe('vod');
    expect(target.accountKey).toBe('fp:abc');
    expect(target.title).toBe('Evening Classic');
    expect(target.subtitle).toBe('Cinema One');
    expect(target.startPositionMs).toBe(0);
    expect(target.catchup).toEqual({
      startMs: PAST_PROG.start,
      stopMs: PAST_PROG.stop,
      programmeTitle: 'Evening News'.replace('News', 'Classic'),
      hasArchive: true,
      liveTarget,
    });
  });

  it('indexes reminder keys cleanly by channelKey and programmeStart', () => {
    const set = indexReminderKeys([
      { channelKey: 'x:s1:live:1', programmeStart: 100_000 },
      { channelKey: 'x:s1:live:2', programmeStart: 200_000 },
    ]);
    expect(set.has(buildReminderKey('x:s1:live:1', 100_000))).toBe(true);
    expect(set.has(buildReminderKey('x:s1:live:2', 200_000))).toBe(true);
    expect(set.has(buildReminderKey('x:s1:live:1', 300_000))).toBe(false);
  });
});
