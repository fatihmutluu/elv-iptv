import { describe, expect, it } from 'vitest';
import enPo from '../locales/en/messages.po?raw';
import trPo from '../locales/tr/messages.po?raw';
import { createAppI18n, type MessageId } from './index';
import { enWaveE3Messages } from './locales/en-wave-e3';
import { trWaveE3Messages } from './locales/tr-wave-e3';

const EXPECTED_KEYS: readonly MessageId[] = [
  // Shared Interactive ELV Mode Preview (18)
  'elv.preview.badgeClean',
  'elv.preview.badgeRaw',
  'elv.preview.captionAllOn',
  'elv.preview.captionChaos',
  'elv.preview.genre.scifi',
  'elv.preview.genre.drama',
  'elv.preview.genre.thriller',
  'elv.preview.genre.mystery',
  'elv.preview.rawCat1',
  'elv.preview.rawCat2',
  'elv.preview.rawCat3',
  'elv.preview.film1.title',
  'elv.preview.film2.title',
  'elv.preview.film3.title',
  'elv.preview.film4.title',
  'elv.preview.rawNoPoster',
  'elv.preview.rawNoRating',
  'elv.preview.duplicateTag',
  // Onboarding Screen 1 — Smart Welcome & Auth (14)
  'onboarding.welcome.title',
  'onboarding.welcome.subtitle',
  'onboarding.welcome.emailOption',
  'onboarding.welcome.emailContinue',
  'onboarding.welcome.checkingEmail',
  'onboarding.welcome.existingAccountHint',
  'onboarding.welcome.notFoundPrompt',
  'onboarding.welcome.createWithEmailAction',
  'onboarding.welcome.backToEmail',
  'onboarding.welcome.guestAction',
  'onboarding.welcome.transferAction',
  'onboarding.welcome.privacyStripPrefix',
  'onboarding.welcome.privacyPolicyLink',
  'onboarding.welcome.diagnosticsLabel',
  // Privacy Policy Modal (9)
  'onboarding.privacy.title',
  'onboarding.privacy.summary',
  'onboarding.privacy.sectionDataTitle',
  'onboarding.privacy.sectionDataBody',
  'onboarding.privacy.sectionDiagnosticsTitle',
  'onboarding.privacy.sectionDiagnosticsBody',
  'onboarding.privacy.sectionRightsTitle',
  'onboarding.privacy.sectionRightsBody',
  'onboarding.privacy.close',
  // Onboarding Syncing Step (2)
  'onboarding.syncing.title',
  'onboarding.syncing.subtitle',
  // Onboarding Screen 2 — Add First Source (5)
  'onboarding.source.title',
  'onboarding.source.subtitle',
  'onboarding.source.continueAction',
  'onboarding.source.browseWithoutSource',
  'onboarding.source.pairPhoneAction',
  // Onboarding Screen 3 — ELV Mode (6)
  'onboarding.elv.title',
  'onboarding.elv.subtitle',
  'onboarding.elv.masterToggle',
  'onboarding.elv.mergeToggle',
  'onboarding.elv.postersToggle',
  'onboarding.elv.categoriesToggle',
  // Onboarding Top Import Bar & Dynamic CTA (9)
  'onboarding.import.loading',
  'onboarding.import.ready',
  'onboarding.import.failed',
  'onboarding.import.providerWaitHint',
  'onboarding.import.continueAction',
  'onboarding.import.enterAppAction',
  'onboarding.import.continueCustomizing',
  'onboarding.import.retryAction',
  'onboarding.import.editSourceAction',
  // Onboarding Personalization Cards 1–4 (18)
  'onboarding.personalize.stepCounter',
  'onboarding.personalize.profileTitle',
  'onboarding.personalize.profileSubtitle',
  'onboarding.personalize.profileNameLabel',
  'onboarding.personalize.avatarLabel',
  'onboarding.personalize.themeTitle',
  'onboarding.personalize.themeSubtitle',
  'onboarding.personalize.layoutTitle',
  'onboarding.personalize.layoutSubtitle',
  'onboarding.personalize.layoutPreviewLabel',
  'onboarding.personalize.tipsTitle',
  'onboarding.personalize.tipsSubtitle',
  'onboarding.personalize.tipDesktop1',
  'onboarding.personalize.tipDesktop2',
  'onboarding.personalize.tipMobile1',
  'onboarding.personalize.tipMobile2',
  'onboarding.personalize.tipTv1',
  'onboarding.personalize.tipTv2',
  // Onboarding Waiting Stage & Returning-User Startup Refresh (6)
  'onboarding.waiting.title',
  'onboarding.waiting.subtitle',
  'startup.refresh.title',
  'startup.refresh.subtitle',
  'startup.refresh.cancelContinue',
  'startup.refresh.backgroundNote',
  // Original Evening & Cinema Quotes (6)
  'onboarding.quote.1',
  'onboarding.quote.2',
  'onboarding.quote.3',
  'onboarding.quote.4',
  'onboarding.quote.5',
  'onboarding.quote.6',
];

function parsePoEntries(raw: string): Record<string, string> {
  const entries: Record<string, string> = {};
  let currentKey: 'msgid' | 'msgstr' | null = null;
  let msgid = '';
  let msgstr = '';

  const flush = () => {
    if (msgid !== '') entries[msgid] = msgstr;
    msgid = '';
    msgstr = '';
    currentKey = null;
  };

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      if (line === '') flush();
      continue;
    }
    if (line.startsWith('msgid ')) {
      flush();
      currentKey = 'msgid';
      msgid += JSON.parse(line.slice('msgid '.length).trim()) as string;
    } else if (line.startsWith('msgstr ')) {
      currentKey = 'msgstr';
      msgstr += JSON.parse(line.slice('msgstr '.length).trim()) as string;
    } else if (line.startsWith('"') && currentKey !== null) {
      if (currentKey === 'msgid') msgid += JSON.parse(line) as string;
      else msgstr += JSON.parse(line) as string;
    }
  }
  flush();
  return entries;
}

describe('Wave E3 Smart Onboarding & ELV Mode Preview i18n (#513)', () => {
  it('defines all 93 EN and TR keys with strict parity, .po sync, and clean copy', () => {
    expect(EXPECTED_KEYS).toHaveLength(93);
    expect(Object.keys(enWaveE3Messages).sort()).toEqual([...EXPECTED_KEYS].sort());
    expect(Object.keys(trWaveE3Messages).sort()).toEqual([...EXPECTED_KEYS].sort());

    const en = createAppI18n('en');
    const tr = createAppI18n('tr');
    const enPoMap = parsePoEntries(enPo);
    const trPoMap = parsePoEntries(trPo);

    const forbidden = new RegExp(
      `\\b(${['d' + 'vr', 'record' + 'ing', 'tivi' + 'mate', 'smar' + 'ters', 'v' + 'lc', 'ko' + 'di', 'pl' + 'ex', 'em' + 'by', 'jelly' + 'fin', 'inf' + 'use', 'net' + 'flix', 'dis' + 'ney', 'h' + 'bo'].join('|')})\\b`,
      'i',
    );

    for (const key of EXPECTED_KEYS) {
      const enRaw = enWaveE3Messages[key as keyof typeof enWaveE3Messages];
      const trRaw = trWaveE3Messages[key as keyof typeof trWaveE3Messages];
      expect(enRaw.trim().length, `empty EN for ${key}`).toBeGreaterThan(0);
      expect(trRaw.trim().length, `empty TR for ${key}`).toBeGreaterThan(0);
      expect(enRaw, `forbidden word in EN ${key}`).not.toMatch(forbidden);
      expect(trRaw, `forbidden word in TR ${key}`).not.toMatch(forbidden);
      expect(enPoMap[key], `missing/mismatched EN .po for ${key}`).toBe(enRaw);
      expect(trPoMap[key], `missing/mismatched TR .po for ${key}`).toBe(trRaw);
      if (!enRaw.includes('{')) {
        expect(en.t(key)).toBe(enRaw);
        expect(tr.t(key)).toBe(trRaw);
      }
    }

    expect(en.t('onboarding.personalize.stepCounter', { step: 2, total: 4 })).toBe('Step 2 of 4');
    expect(tr.t('onboarding.personalize.stepCounter', { step: 2, total: 4 })).toBe('Adım 2 / 4');
    expect(en.t('startup.refresh.cancelContinue')).toBe('Cancel / Continue with old data');
    expect(tr.t('startup.refresh.cancelContinue')).toBe('İptal et / Eski verilerle devam et');
    expect(en.t('elv.preview.badgeClean')).toBe('ELV Mode Active');
    expect(tr.t('elv.preview.badgeClean')).toBe('ELV Mode Aktif');
  });
});
