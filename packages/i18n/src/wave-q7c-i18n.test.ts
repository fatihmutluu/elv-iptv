import { describe, expect, it } from 'vitest';
import { createAppI18n } from './index';

describe('Wave Q7-C i18n strings (store-gated desktop auto-updater)', () => {
  it('formats EN and TR updater labels and interpolated placeholders cleanly', () => {
    const en = createAppI18n('en');
    const tr = createAppI18n('tr');

    expect(en.t('settings.updates.title')).toBe('Software updates');
    expect(tr.t('settings.updates.title')).toBe('Yazılım güncellemeleri');

    expect(en.t('settings.updates.currentVersion', { version: '1.2.0' })).toBe('Version 1.2.0');
    expect(tr.t('settings.updates.currentVersion', { version: '1.2.0' })).toBe('Sürüm 1.2.0');

    expect(en.t('settings.updates.check')).toBe('Check for updates');
    expect(tr.t('settings.updates.check')).toBe('Güncellemeleri denetle');

    expect(en.t('settings.updates.checking')).toContain('Checking');
    expect(tr.t('settings.updates.checking')).toContain('denetleniyor');

    expect(en.t('settings.updates.upToDate')).toBe('Up to date');
    expect(tr.t('settings.updates.upToDate')).toBe('Güncel');

    expect(en.t('settings.updates.available', { version: '1.3.0' })).toContain('1.3.0');
    expect(tr.t('settings.updates.available', { version: '1.3.0' })).toContain('1.3.0');

    expect(en.t('settings.updates.download')).toBe('Download update');
    expect(tr.t('settings.updates.download')).toBe('Güncellemeyi indir');

    expect(en.t('settings.updates.downloading', { percent: 42 })).toContain('42%');
    expect(tr.t('settings.updates.downloading', { percent: 42 })).toContain('%42');

    expect(en.t('settings.updates.downloaded', { version: '1.3.0' })).toContain('1.3.0');
    expect(tr.t('settings.updates.downloaded', { version: '1.3.0' })).toContain('1.3.0');

    expect(en.t('settings.updates.restartInstall')).toBe('Restart & install');
    expect(tr.t('settings.updates.restartInstall')).toBe('Yeniden başlat ve kur');

    expect(en.t('settings.updates.openReleasePage')).toBe('Open release page');
    expect(tr.t('settings.updates.openReleasePage')).toBe('Sürüm sayfasını aç');

    expect(en.t('settings.updates.releaseNotes')).toBe('What’s new');
    expect(tr.t('settings.updates.releaseNotes')).toBe('Yenilikler');

    expect(en.t('settings.updates.error')).toContain('update');
    expect(tr.t('settings.updates.error')).toContain('Güncellemeler');

    expect(en.t('settings.updates.errorChecksum')).toContain('verification');
    expect(tr.t('settings.updates.errorChecksum')).toContain('doğrulaması');

    expect(en.t('settings.updates.installing')).toContain('Preparing');
    expect(tr.t('settings.updates.installing')).toContain('hazırlanıyor');
  });
});
