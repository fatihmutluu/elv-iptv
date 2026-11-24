import type { FailoverNetworkMessageId } from './en-failover-network';

/** Turkish (`tr`) messages for Wave F5A Failover, Health & Network Settings (`#157`, `#167`, `#172`). */
export const trFailoverNetworkMessages: Readonly<Record<FailoverNetworkMessageId, string>> = {
  // #157 Multi-Source Failover Channel Groups
  'channels.manage.tab.failover': 'Yedekleme',
  'channels.failover.title': 'Yedekleme Grupları',
  'channels.failover.subtitle':
    'Otomatik yedek geçiş için birden fazla kaynaktaki aynı kanalları öncelik sırasıyla gruplayın.',
  'channels.failover.autoMatch': 'Kanalları otomatik eşleştir',
  'channels.failover.applySuggestions': '{count} önerilen grubu uygula',
  'channels.failover.noSuggestions': 'Kaynaklar arası yeni eşleşme bulunamadı.',
  'channels.failover.createPlaceholder': 'Yeni yedekleme grubu adı',
  'channels.failover.create': 'Grup oluştur',
  'channels.failover.empty':
    'Henüz yedekleme grubu yok. Birden fazla kaynak ekleyin veya elle grup oluşturun.',
  'channels.failover.memberCount': '{count} kaynak',
  'channels.failover.priorityBadge': '#{rank}',
  'channels.failover.primaryBadge': 'Birincil',
  'channels.failover.moveUp': 'Yukarı taşı',
  'channels.failover.moveDown': 'Aşağı taşı',
  'channels.failover.addChannel': 'Kanal ekle',
  'channels.failover.removeMember': 'Kaldır',
  'channels.failover.deleteGroup': 'Grubu sil',
  'channels.failover.selectChannelHint': 'Bu yedekleme grubuna eklenecek canlı kanalı seçin.',

  // #167 Passive Stream Health Badges
  'live.health.flaky': 'Kararsız',
  'live.health.dead': 'Çevrimdışı',
  'live.health.healthy': 'Sağlıklı',

  // #172 Per-Source Advanced Network Settings
  'sources.network.title': 'Ağ',
  'sources.network.dnsFamilyLabel': 'DNS IP tercihi',
  'sources.network.dnsFamily.system': 'Sistem',
  'sources.network.dnsFamily.ipv4': 'Yalnızca IPv4',
  'sources.network.dnsFamily.ipv6': 'Yalnızca IPv6',
  'sources.network.hostOverrideLabel': 'Sunucu IP geçersiz kılma (isteğe bağlı)',
  'sources.network.hostOverridePlaceholder': 'örn. 203.0.113.10 veya 2001:db8::1',
  'sources.network.hostOverrideHint':
    'Orijinal TLS sertifika doğrulamasını koruyarak doğrudan bu IP adresine bağlanır.',
  'sources.network.invalidHostOverride':
    'Port veya protokol olmadan geçerli bir IPv4 veya IPv6 adresi girin.',
  'sources.network.backupServersLabel': "Yedek sunucu URL'leri (isteğe bağlı)",
  'sources.network.backupServersPlaceholder': 'Her satıra bir URL',
  'sources.network.save': 'Ağ ayarlarını kaydet',
  'sources.network.saved': 'Ağ ayarları kaydedildi',
};
