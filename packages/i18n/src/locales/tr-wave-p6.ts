import type { WaveP6MessageId } from './en-wave-p6';

/** Turkish (`tr`) messages for Wave P6 Library hub, Like/Dislike ratings & grouped series downloads. */
export const trWaveP6Messages: Readonly<Record<WaveP6MessageId, string>> = {
  'nav.library': 'Kitaplık',
  'library.title': 'Kitaplık',
  'library.tabFollowing': 'Takip Edilenler',
  'library.tabLikes': 'Beğeniler',
  'library.tabWatched': 'İzlenenler',
  'library.tabDownloads': 'İndirilenler',
  'library.railLive': 'Canlı Yayınlar',
  'library.railSeries': 'Diziler',
  'library.railMovies': 'Filmler',
  'library.railCollections': 'Koleksiyonlar',
  'library.railLiked': 'Beğendiklerim',
  'library.railDisliked': 'Beğenmediklerim',
  'library.railWatchedMovies': 'İzlenen filmler',
  'library.railWatchedSeries': 'İzlenen diziler',
  'library.railDownloadedMovies': 'İndirilen filmler',
  'library.railDownloadedSeries': 'İndirilen diziler',
  'library.episodesDownloaded': '{downloaded} / {total} bölüm indirildi',
  'library.episodesDownloadedUnknownTotal': '{downloaded} bölüm indirildi',
  'library.seeAll': 'Tümünü gör',
  'library.backToTab': 'Geri',
  'library.emptyFollowingTitle': 'Henüz takip edilen içerik yok',
  'library.emptyFollowingBody':
    'Canlı kanalları, dizileri veya filmleri yıldızlayarak burada toplayabilirsiniz.',
  'library.emptyLikesTitle': 'Henüz beğeni veya beğenmeme yok',
  'library.emptyLikesBody':
    'Film ve dizileri detay sayfasından veya sağ tık menüsünden değerlendirebilirsiniz.',
  'library.emptyWatchedTitle': 'Henüz izlenen içerik yok',
  'library.emptyWatchedBody': 'İzlemeyi tamamladığınız film ve diziler burada görünür.',
  'rating.like': 'Beğendim',
  'rating.liked': 'Beğenildi',
  'rating.dislike': 'Beğenmedim',
  'rating.disliked': 'Beğenilmedi',
  'rating.clearLike': 'Beğeniyi kaldır',
  'rating.clearDislike': 'Beğenmemeyi kaldır',
};
