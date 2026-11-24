import type { ChannelGuideOverrideRecord, ItemRow } from '@elv/data';
import { describe, expect, it } from 'vitest';
import {
  clampOffsetHours,
  filterMapperChannels,
  formatSignedOffsetHours,
  offsetHoursToMs,
  offsetMsToHours,
  reorderGuideSourceIds,
  resolveChannelMappingStatus,
  validateGuideSourceDraft,
} from './guide-management-model';

const makeChannel = (key: string, name: string): ItemRow => ({
  id: 1,
  key,
  kind: 'live',
  sourceId: 's1',
  providerId: key,
  name,
  logo: null,
  rating: null,
  year: null,
  num: null,
});

describe('guide-management-model', () => {
  it('clamps and formats EPG time offsets within [-12h, +12h]', () => {
    expect(clampOffsetHours(-20)).toBe(-12);
    expect(clampOffsetHours(18)).toBe(12);
    expect(clampOffsetHours(Number.NaN)).toBe(0);
    expect(offsetHoursToMs(2)).toBe(7_200_000);
    expect(offsetMsToHours(-3_600_000)).toBe(-1);
    expect(offsetMsToHours(undefined)).toBe(0);
    expect(formatSignedOffsetHours(3)).toBe('+3');
    expect(formatSignedOffsetHours(-2)).toBe('-2');
    expect(formatSignedOffsetHours(0)).toBe('0');
  });

  it('reorders guide source IDs up and down and guards out-of-bounds moves', () => {
    const guides = [{ id: 'g1' }, { id: 'g2' }, { id: 'g3' }];
    expect(reorderGuideSourceIds(guides, 0, -1)).toBeNull();
    expect(reorderGuideSourceIds(guides, 2, 1)).toBeNull();
    expect(reorderGuideSourceIds(guides, 1, -1)).toEqual(['g2', 'g1', 'g3']);
    expect(reorderGuideSourceIds(guides, 0, 1)).toEqual(['g2', 'g1', 'g3']);
  });

  it('validates guide source drafts before saving', () => {
    expect(validateGuideSourceDraft('', 'http://example.invalid/epg.xml')).toBe('missing-name');
    expect(validateGuideSourceDraft('Backup', 'ftp://example.invalid/epg.xml')).toBe('invalid-url');
    expect(validateGuideSourceDraft('Backup', 'https://example.invalid/epg.xml.gz')).toBeNull();
  });

  it('resolves channel mapping status and filters by All/Unmatched and search query', () => {
    const ch1 = makeChannel('m:s1:live:1', 'News One');
    const ch2 = makeChannel('m:s1:live:2', 'Sports Arena');
    const ch3 = makeChannel('m:s1:live:3', 'Local Mystery');

    const overrides = new Map<string, ChannelGuideOverrideRecord>([
      [
        ch2.key,
        {
          sourceId: 's1',
          channelKey: ch2.key,
          guideSourceId: null,
          guideId: 'sports.eu',
          epgShiftMs: 3_600_000,
          isManual: true,
          updatedAt: 1,
        },
      ],
    ]);
    const matched = new Set<string>([ch1.key]);

    expect(resolveChannelMappingStatus(ch1.key, overrides, matched)).toBe('matched');
    expect(resolveChannelMappingStatus(ch2.key, overrides, matched)).toBe('manual');
    expect(resolveChannelMappingStatus(ch3.key, overrides, matched)).toBe('unmatched');

    expect(filterMapperChannels([ch1, ch2, ch3], overrides, matched, 'unmatched', '')).toEqual([
      ch3,
    ]);
    expect(filterMapperChannels([ch1, ch2, ch3], overrides, matched, 'all', 'sports.eu')).toEqual([
      ch2,
    ]);
    expect(filterMapperChannels([ch1, ch2, ch3], overrides, matched, 'all', 'news')).toEqual([ch1]);
  });
});
