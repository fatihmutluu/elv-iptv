import { describe, expect, it } from 'vitest';
import { createAppI18n, type MessageId } from './index';
import { enCatchupEpgMessages } from './locales/en-catchup-epg';
import { trCatchupEpgMessages } from './locales/tr-catchup-epg';

const NEW_WAVE_F3_KEYS: readonly MessageId[] = [
  // #27 Catch-Up
  'epg.catchupBadge',
  'epg.watchCatchup',
  'epg.catchupUnavailable',
  'epg.catchupExpired',
  'player.catchupBadge',
  'player.backToLive',
  // #28 Live Time-Shift (player.jumpToLive already defined in base catalog)
  'player.livePaused',
  'player.behindLive',
  'player.timeShiftUnavailable',
  'player.liveEdge',
  // #30 Multi-Guide & Channel Mapper
  'sources.guides.button',
  'sources.guides.title',
  'sources.guides.subtitle',
  'sources.guides.guidesTab',
  'sources.guides.mapperTab',
  'sources.guides.addGuide',
  'sources.guides.namePlaceholder',
  'sources.guides.urlPlaceholder',
  'sources.guides.offsetLabel',
  'sources.guides.offsetHours',
  'sources.guides.priorityUp',
  'sources.guides.priorityDown',
  'sources.guides.remove',
  'sources.guides.empty',
  'sources.guides.filterAll',
  'sources.guides.filterUnmatched',
  'sources.guides.searchPlaceholder',
  'sources.guides.unmatchedBadge',
  'sources.guides.manualBadge',
  'sources.guides.assignGuide',
  'sources.guides.clearOverride',
  'sources.guides.channelOffsetLabel',
  'sources.guides.noGuideChannels',
  'sources.guides.save',
  'sources.guides.cancel',
  // #35 Programme Reminders
  'epg.remindMe',
  'epg.cancelReminder',
  'epg.reminderScheduled',
  'epg.reminderLeadLabel',
  'epg.reminderBannerTitle',
  'epg.reminderStartsIn',
  'epg.reminderStartingNow',
  'epg.reminderTuneNow',
  'epg.reminderDismiss',
];

const ALL_WAVE_F3_KEYS: readonly MessageId[] = [...NEW_WAVE_F3_KEYS, 'player.jumpToLive'];

describe('Wave F3 Catch-Up, Live Time-Shift, Multi-Guide & Reminders i18n (#27, #28, #30, #35)', () => {
  it('defines all EN and TR keys with non-empty translations, clean copy, and placeholder parity', () => {
    expect(Object.keys(enCatchupEpgMessages).sort()).toEqual([...NEW_WAVE_F3_KEYS].sort());
    expect(Object.keys(trCatchupEpgMessages).sort()).toEqual([...NEW_WAVE_F3_KEYS].sort());

    const en = createAppI18n('en');
    const tr = createAppI18n('tr');

    const forbidden = new RegExp(`\\b(${['d' + 'vr', 'record' + 'ing'].join('|')})\\b`, 'i');

    for (const key of ALL_WAVE_F3_KEYS) {
      const enVal = en.t(key, { offset: '-02:14', hours: '+2', minutes: 5 });
      const trVal = tr.t(key, { offset: '-02:14', hours: '+2', minutes: 5 });
      expect(enVal.trim().length, `empty EN for ${key}`).toBeGreaterThan(0);
      expect(trVal.trim().length, `empty TR for ${key}`).toBeGreaterThan(0);
      expect(enVal, `forbidden word in EN ${key}`).not.toMatch(forbidden);
      expect(trVal, `forbidden word in TR ${key}`).not.toMatch(forbidden);
    }

    expect(en.t('player.behindLive', { offset: '-02:14' })).toBe('-02:14 behind live');
    expect(tr.t('player.behindLive', { offset: '-02:14' })).toBe('Canlıdan -02:14 geride');
    expect(en.t('player.jumpToLive')).toBe('Jump to live');
    expect(tr.t('player.jumpToLive')).toBe('Canlı uca atla');
    expect(en.t('sources.guides.offsetHours', { hours: '+2' })).toBe('+2h');
    expect(tr.t('sources.guides.offsetHours', { hours: '+2' })).toBe('+2 sa');
    expect(en.t('epg.reminderStartsIn', { minutes: 5 })).toBe('Starts in 5 min');
    expect(tr.t('epg.reminderStartsIn', { minutes: 5 })).toBe('5 dk içinde başlıyor');
  });
});
