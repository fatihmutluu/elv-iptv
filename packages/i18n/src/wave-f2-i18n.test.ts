import { describe, expect, it } from 'vitest';
import { createAppI18n, type MessageId } from './index';
import { enErgonomicsMessages } from './locales/en-ergonomics';
import { trErgonomicsMessages } from './locales/tr-ergonomics';

const EXPECTED_WAVE_F2_KEYS: readonly MessageId[] = [
  // #60 Channel Management & Custom Groups
  'channels.manage.title',
  'channels.manage.subtitle',
  'channels.manage.openButton',
  'channels.manage.rename',
  'channels.manage.renamePlaceholder',
  'channels.manage.resetName',
  'channels.manage.hide',
  'channels.manage.unhide',
  'channels.manage.hiddenBadge',
  'channels.manage.showHidden',
  'channels.manage.moveUp',
  'channels.manage.moveDown',
  'channels.manage.resetOrder',
  'channels.manage.empty',
  'channels.manage.groupsTab',
  'channels.manage.channelsTab',
  'channels.manage.addGroup',
  'channels.manage.groupNamePlaceholder',
  'channels.manage.editGroup',
  'channels.manage.deleteGroup',
  'channels.manage.addToGroup',
  'channels.manage.removeFromGroup',
  'channels.manage.groupEmpty',
  'channels.manage.save',
  'channels.manage.cancel',
  // #50 QR LAN Pairing
  'sources.qr.button',
  'sources.qr.title',
  'sources.qr.subtitle',
  'sources.qr.scanHint',
  'sources.qr.orVisit',
  'sources.qr.expiresIn',
  'sources.qr.expired',
  'sources.qr.regenerate',
  'sources.qr.waiting',
  'sources.qr.received',
  'sources.qr.unavailable',
  'sources.qr.close',
  'sources.qr.lanOnlyNote',
  // #33 Remote Key Remapping
  'settings.section.remote',
  'remote.title',
  'remote.subtitle',
  'remote.contextPlayer',
  'remote.contextLive',
  'remote.contextGlobal',
  'remote.capturePrompt',
  'remote.captureCancel',
  'remote.immutableWarning',
  'remote.unbound',
  'remote.longPressBadge',
  'remote.rebind',
  'remote.clear',
  'remote.resetAction',
  'remote.resetAll',
  'remote.action.togglePlayPause',
  'remote.action.seekBack',
  'remote.action.seekForward',
  'remote.action.channelUp',
  'remote.action.channelDown',
  'remote.action.lastChannel',
  'remote.action.openChannelDrawer',
  'remote.action.openSettings',
  'remote.action.cycleAudioTrack',
  'remote.action.cycleSubtitleTrack',
  'remote.action.toggleMute',
  'remote.action.openInfo',
  'remote.action.toggleGuide',
  'remote.action.openSearch',
  'remote.action.toggleFavorite',
  'remote.action.openHome',
  // #273 Android TV Home Channels
  'tvHomeChannels.continueWatching',
  'tvHomeChannels.favorites',
  'tvHomeChannels.syncToggle',
  'tvHomeChannels.syncHint',
];

describe('Wave F2 Living-Room Ergonomics i18n (#60, #50, #33, #273)', () => {
  it('defines all 73 EN and TR keys with non-empty translations and clean copy', () => {
    expect(Object.keys(enErgonomicsMessages).sort()).toEqual([...EXPECTED_WAVE_F2_KEYS].sort());
    expect(Object.keys(trErgonomicsMessages).sort()).toEqual([...EXPECTED_WAVE_F2_KEYS].sort());

    const en = createAppI18n('en');
    const tr = createAppI18n('tr');

    const forbidden = /\b(dvr|recording|tivimate|smarters|kodi|plex|jellyfin|vlc)\b/i;

    for (const key of EXPECTED_WAVE_F2_KEYS) {
      const enVal = en.t(key, { time: '04:30' });
      const trVal = tr.t(key, { time: '04:30' });
      expect(enVal.trim().length, `empty EN for ${key}`).toBeGreaterThan(0);
      expect(trVal.trim().length, `empty TR for ${key}`).toBeGreaterThan(0);
      expect(enVal, `forbidden word in EN ${key}`).not.toMatch(forbidden);
      expect(trVal, `forbidden word in TR ${key}`).not.toMatch(forbidden);
    }

    expect(en.t('sources.qr.expiresIn', { time: '04:59' })).toBe('Expires in 04:59');
    expect(tr.t('sources.qr.expiresIn', { time: '04:59' })).toBe('04:59 içinde süresi dolar');
  });
});
