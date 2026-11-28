import type { enWaveQ7cMessages } from './en-wave-q7c';

/** Wave Q7-C Turkish messages. */
export const trWaveQ7cMessages: Readonly<Record<keyof typeof enWaveQ7cMessages, string>> = {
  'settings.updates.title': 'Yazılım güncellemeleri',
  'settings.updates.currentVersion': 'Sürüm {version}',
  'settings.updates.check': 'Güncellemeleri denetle',
  'settings.updates.checking': 'Güncellemeler denetleniyor…',
  'settings.updates.upToDate': 'Güncel',
  'settings.updates.available': '{version} sürümü hazır',
  'settings.updates.download': 'Güncellemeyi indir',
  'settings.updates.downloading': 'Güncelleme indiriliyor (%{percent})',
  'settings.updates.downloaded': '{version} sürümü kuruluma hazır',
  'settings.updates.restartInstall': 'Yeniden başlat ve kur',
  'settings.updates.openReleasePage': 'Sürüm sayfasını aç',
  'settings.updates.releaseNotes': 'Yenilikler',
  'settings.updates.error': 'Güncellemeler denetlenemedi. Daha sonra tekrar deneyin.',
  'settings.updates.errorChecksum':
    'Güncelleme doğrulaması başarısız oldu. Sürüm sayfasından doğrudan indirin.',
  'settings.updates.installing': 'Güncelleme hazırlanıyor…',
};
