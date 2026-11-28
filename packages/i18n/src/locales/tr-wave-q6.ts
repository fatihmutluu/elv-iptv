import type { enWaveQ6Messages } from './en-wave-q6';

/** Turkish (`tr`) strings for Wave Q6 stream User-Agent and source card account health captions. */
export const trWaveQ6Messages: Readonly<Record<keyof typeof enWaveQ6Messages, string>> = {
  'sources.field.streamUserAgent': 'Yayın User-Agent (isteğe bağlı)',
  'sources.placeholder.streamUserAgent': 'Varsayılan olarak yukarıdaki User-Agent kullanılır',
  'sources.hint.streamUserAgent':
    'Sağlayıcınız farklı bir oynatıcı User-Agent beklediğinde yalnızca yayın oynatma ve indirmelerde kullanılır.',
  'sources.account.expiresOn': 'Bitiş {date}',
  'sources.account.connectionsActive': '{active}/{max} bağlantı',
  'sources.account.connectionsMax': '{max} bağlantı',
};
