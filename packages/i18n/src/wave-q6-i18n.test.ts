import { describe, expect, it } from 'vitest';
import { createAppI18n } from './index';

describe('Wave Q6 i18n strings (streamUserAgent and source account health)', () => {
  it('formats EN and TR stream User-Agent and account health captions accurately', () => {
    const en = createAppI18n('en');
    const tr = createAppI18n('tr');

    expect(en.t('sources.field.streamUserAgent')).toBe('Stream User-Agent (optional)');
    expect(tr.t('sources.field.streamUserAgent')).toBe('Yayın User-Agent (isteğe bağlı)');
    expect(en.t('sources.placeholder.streamUserAgent')).toBe('Defaults to User-Agent above');
    expect(tr.t('sources.placeholder.streamUserAgent')).toContain('User-Agent');
    expect(en.t('sources.hint.streamUserAgent')).toContain('playback');
    expect(tr.t('sources.hint.streamUserAgent')).toContain('oynatma');

    expect(en.t('sources.account.expiresOn', { date: 'Jan 15, 2027' })).toBe(
      'Expires Jan 15, 2027',
    );
    expect(tr.t('sources.account.expiresOn', { date: '15 Oca 2027' })).toBe('Bitiş 15 Oca 2027');

    expect(en.t('sources.account.connectionsActive', { active: 1, max: 1 })).toBe('1/1 connection');
    expect(en.t('sources.account.connectionsActive', { active: 1, max: 3 })).toBe(
      '1/3 connections',
    );
    expect(tr.t('sources.account.connectionsActive', { active: 1, max: 3 })).toBe('1/3 bağlantı');

    expect(en.t('sources.account.connectionsMax', { max: 1 })).toBe('1 connection');
    expect(en.t('sources.account.connectionsMax', { max: 4 })).toBe('4 connections');
    expect(tr.t('sources.account.connectionsMax', { max: 4 })).toBe('4 bağlantı');
  });
});
