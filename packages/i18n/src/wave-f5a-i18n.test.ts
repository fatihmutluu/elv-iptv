import { describe, expect, it } from 'vitest';
import enPo from '../locales/en/messages.po?raw';
import trPo from '../locales/tr/messages.po?raw';
import { createAppI18n, type MessageId } from './index';
import { enFailoverNetworkMessages } from './locales/en-failover-network';
import { trFailoverNetworkMessages } from './locales/tr-failover-network';

const EXPECTED_PAIRS: ReadonlyArray<readonly [MessageId, string, string]> = [
  // #157 Multi-Source Failover Channel Groups
  ['channels.manage.tab.failover', 'Failover', 'Yedekleme'],
  ['channels.failover.title', 'Failover Groups', 'Yedekleme Grupları'],
  [
    'channels.failover.subtitle',
    'Group matching channels across sources in priority order for automatic backup switching.',
    'Otomatik yedek geçiş için birden fazla kaynaktaki aynı kanalları öncelik sırasıyla gruplayın.',
  ],
  ['channels.failover.autoMatch', 'Auto-match channels', 'Kanalları otomatik eşleştir'],
  [
    'channels.failover.applySuggestions',
    'Apply {count} suggested groups',
    '{count} önerilen grubu uygula',
  ],
  [
    'channels.failover.noSuggestions',
    'No new cross-source matches found.',
    'Kaynaklar arası yeni eşleşme bulunamadı.',
  ],
  ['channels.failover.createPlaceholder', 'New failover group name', 'Yeni yedekleme grubu adı'],
  ['channels.failover.create', 'Create group', 'Grup oluştur'],
  [
    'channels.failover.empty',
    'No failover groups yet. Add multiple sources or create a group manually.',
    'Henüz yedekleme grubu yok. Birden fazla kaynak ekleyin veya elle grup oluşturun.',
  ],
  ['channels.failover.memberCount', '{count} sources', '{count} kaynak'],
  ['channels.failover.priorityBadge', '#{rank}', '#{rank}'],
  ['channels.failover.primaryBadge', 'Primary', 'Birincil'],
  ['channels.failover.moveUp', 'Move up', 'Yukarı taşı'],
  ['channels.failover.moveDown', 'Move down', 'Aşağı taşı'],
  ['channels.failover.addChannel', 'Add channel', 'Kanal ekle'],
  ['channels.failover.removeMember', 'Remove', 'Kaldır'],
  ['channels.failover.deleteGroup', 'Delete group', 'Grubu sil'],
  [
    'channels.failover.selectChannelHint',
    'Choose a live channel to add to this failover group.',
    'Bu yedekleme grubuna eklenecek canlı kanalı seçin.',
  ],

  // #167 Passive Stream Health Badges
  ['live.health.flaky', 'Unstable', 'Kararsız'],
  ['live.health.dead', 'Offline', 'Çevrimdışı'],
  ['live.health.healthy', 'Healthy', 'Sağlıklı'],

  // #172 Per-Source Advanced Network Settings
  ['sources.network.title', 'Network', 'Ağ'],
  ['sources.network.dnsFamilyLabel', 'DNS IP preference', 'DNS IP tercihi'],
  ['sources.network.dnsFamily.system', 'System', 'Sistem'],
  ['sources.network.dnsFamily.ipv4', 'IPv4 only', 'Yalnızca IPv4'],
  ['sources.network.dnsFamily.ipv6', 'IPv6 only', 'Yalnızca IPv6'],
  [
    'sources.network.hostOverrideLabel',
    'Host IP override (optional)',
    'Sunucu IP geçersiz kılma (isteğe bağlı)',
  ],
  [
    'sources.network.hostOverridePlaceholder',
    'e.g. 203.0.113.10 or 2001:db8::1',
    'örn. 203.0.113.10 veya 2001:db8::1',
  ],
  [
    'sources.network.hostOverrideHint',
    'Connects directly to this IP while keeping original TLS certificate verification.',
    'Orijinal TLS sertifika doğrulamasını koruyarak doğrudan bu IP adresine bağlanır.',
  ],
  [
    'sources.network.invalidHostOverride',
    'Enter a valid IPv4 or IPv6 address without ports or schemes.',
    'Port veya protokol olmadan geçerli bir IPv4 veya IPv6 adresi girin.',
  ],
  [
    'sources.network.backupServersLabel',
    'Backup server URLs (optional)',
    "Yedek sunucu URL'leri (isteğe bağlı)",
  ],
  ['sources.network.backupServersPlaceholder', 'One URL per line', 'Her satıra bir URL'],
  ['sources.network.save', 'Save network settings', 'Ağ ayarlarını kaydet'],
  ['sources.network.saved', 'Network settings saved', 'Ağ ayarları kaydedildi'],
];

const WAVE_F5A_KEYS: readonly MessageId[] = EXPECTED_PAIRS.map(([id]) => id);

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

describe('Wave F5A Failover, Health & Network Settings i18n (#157, #167, #172)', () => {
  it('defines all 34 EN and TR keys with strict parity, .po sync, clean copy, and placeholder formatting', () => {
    expect(WAVE_F5A_KEYS).toHaveLength(34);
    expect(Object.keys(enFailoverNetworkMessages).sort()).toEqual([...WAVE_F5A_KEYS].sort());
    expect(Object.keys(trFailoverNetworkMessages).sort()).toEqual([...WAVE_F5A_KEYS].sort());

    const en = createAppI18n('en');
    const tr = createAppI18n('tr');
    const enPoMap = parsePoEntries(enPo);
    const trPoMap = parsePoEntries(trPo);

    const forbidden = new RegExp(
      `\\b(${['d' + 'vr', 'record' + 'ing', 'tivi' + 'mate', 'smar' + 'ters', 'v' + 'lc', 'ko' + 'di', 'pl' + 'ex', 'em' + 'by', 'jelly' + 'fin'].join('|')})\\b`,
      'i',
    );

    for (const [key, expectedEn, expectedTr] of EXPECTED_PAIRS) {
      const enRaw = enFailoverNetworkMessages[key as keyof typeof enFailoverNetworkMessages];
      const trRaw = trFailoverNetworkMessages[key as keyof typeof trFailoverNetworkMessages];
      expect(enRaw).toBe(expectedEn);
      expect(trRaw).toBe(expectedTr);
      expect(enRaw.trim().length, `empty EN for ${key}`).toBeGreaterThan(0);
      expect(trRaw.trim().length, `empty TR for ${key}`).toBeGreaterThan(0);
      expect(enRaw, `forbidden word in EN ${key}`).not.toMatch(forbidden);
      expect(trRaw, `forbidden word in TR ${key}`).not.toMatch(forbidden);
      expect(enPoMap[key], `missing/mismatched EN .po for ${key}`).toBe(enRaw);
      expect(trPoMap[key], `missing/mismatched TR .po for ${key}`).toBe(trRaw);
    }

    expect(en.t('channels.failover.applySuggestions', { count: 3 })).toBe(
      'Apply 3 suggested groups',
    );
    expect(tr.t('channels.failover.applySuggestions', { count: 3 })).toBe(
      '3 önerilen grubu uygula',
    );
    expect(en.t('channels.failover.memberCount', { count: 2 })).toBe('2 sources');
    expect(tr.t('channels.failover.memberCount', { count: 2 })).toBe('2 kaynak');
    expect(en.t('channels.failover.priorityBadge', { rank: 1 })).toBe('#1');
    expect(tr.t('channels.failover.priorityBadge', { rank: 1 })).toBe('#1');
    expect(en.t('channels.manage.tab.failover')).toBe('Failover');
    expect(tr.t('channels.manage.tab.failover')).toBe('Yedekleme');
    expect(en.t('live.health.flaky')).toBe('Unstable');
    expect(tr.t('live.health.flaky')).toBe('Kararsız');
    expect(en.t('sources.network.hostOverridePlaceholder')).toBe(
      'e.g. 203.0.113.10 or 2001:db8::1',
    );
    expect(tr.t('sources.network.hostOverridePlaceholder')).toBe(
      'örn. 203.0.113.10 veya 2001:db8::1',
    );
    expect(en.t('sources.network.saved')).toBe('Network settings saved');
    expect(tr.t('sources.network.saved')).toBe('Ağ ayarları kaydedildi');
  });
});
