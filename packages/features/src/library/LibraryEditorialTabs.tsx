import { type ContextMenuAnchor, Icon, useI18n, useTheme } from '@elv/ui-kit';
import type { ReactElement } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { LibraryRailSection } from './LibraryRailSection';
import type {
  LibraryCardItem,
  LibrarySeeAllState,
  PartitionedLibraryFavorites,
  PartitionedLibraryRatings,
} from './library-model';

/** One hydrated custom collection rail entry. */
interface LibraryCollectionRail {
  readonly railId: string;
  readonly title: string;
  readonly items: readonly LibraryCardItem[];
}

/** Props of {@link LibraryEditorialTabs}. */
export interface LibraryEditorialTabsProps {
  readonly activeTab: 'following' | 'likes' | 'watched';
  readonly favPartition: PartitionedLibraryFavorites;
  readonly collectionRails: readonly LibraryCollectionRail[];
  readonly ratingPartition: PartitionedLibraryRatings;
  readonly watchedMovieCards: readonly LibraryCardItem[];
  readonly watchedSeriesCards: readonly LibraryCardItem[];
  readonly posterWidth: number;
  readonly wideWidth: number;
  readonly padX: number;
  readonly isTv: boolean;
  readonly focusedColFor: (railId: string) => number | null;
  readonly onPressCard: (item: LibraryCardItem) => void;
  readonly onContextMenuLive: (item: LibraryCardItem, anchor?: ContextMenuAnchor) => void;
  readonly onContextMenuVod: (item: LibraryCardItem, anchor?: ContextMenuAnchor) => void;
  readonly onSeeAll: (state: LibrarySeeAllState) => void;
}

/** Renders the `Following`, `Likes`, and `Watched` editorial sub-tabs inside {@link LibraryScreen}. */
export function LibraryEditorialTabs({
  activeTab,
  favPartition,
  collectionRails,
  ratingPartition,
  watchedMovieCards,
  watchedSeriesCards,
  posterWidth,
  wideWidth,
  padX,
  isTv,
  focusedColFor,
  onPressCard,
  onContextMenuLive,
  onContextMenuVod,
  onSeeAll,
}: LibraryEditorialTabsProps): ReactElement {
  const i18n = useI18n();

  if (activeTab === 'following') {
    const hasFollowing =
      favPartition.live.length > 0 ||
      favPartition.series.length > 0 ||
      favPartition.movies.length > 0 ||
      collectionRails.length > 0;
    if (!hasFollowing) {
      return (
        <LibraryEmptyNotice
          testID="library-empty-following"
          icon="star"
          title={i18n.t('library.emptyFollowingTitle')}
          body={i18n.t('library.emptyFollowingBody')}
          padX={padX}
        />
      );
    }
    return (
      <View testID="library-following-content" style={styles.railsStack}>
        <LibraryRailSection
          railId="live"
          title={i18n.t('library.railLive')}
          items={favPartition.live}
          variant="live"
          cardWidth={wideWidth}
          padX={padX}
          isTv={isTv}
          focusedCardIndex={focusedColFor('live')}
          onPressItem={onPressCard}
          onContextMenuItem={onContextMenuLive}
          onSeeAll={() =>
            onSeeAll({ railId: 'live', title: i18n.t('library.railLive'), kind: 'live' })
          }
        />
        <LibraryRailSection
          railId="series"
          title={i18n.t('library.railSeries')}
          items={favPartition.series}
          variant="poster"
          cardWidth={posterWidth}
          padX={padX}
          isTv={isTv}
          focusedCardIndex={focusedColFor('series')}
          onPressItem={onPressCard}
          onContextMenuItem={onContextMenuVod}
          onSeeAll={() =>
            onSeeAll({ railId: 'series', title: i18n.t('library.railSeries'), kind: 'poster' })
          }
        />
        <LibraryRailSection
          railId="movies"
          title={i18n.t('library.railMovies')}
          items={favPartition.movies}
          variant="poster"
          cardWidth={posterWidth}
          padX={padX}
          isTv={isTv}
          focusedCardIndex={focusedColFor('movies')}
          onPressItem={onPressCard}
          onContextMenuItem={onContextMenuVod}
          onSeeAll={() =>
            onSeeAll({ railId: 'movies', title: i18n.t('library.railMovies'), kind: 'poster' })
          }
        />
        {collectionRails.map((col) => (
          <LibraryRailSection
            key={col.railId}
            railId={col.railId}
            title={col.title}
            items={col.items}
            variant="poster"
            cardWidth={posterWidth}
            padX={padX}
            isTv={isTv}
            focusedCardIndex={focusedColFor(col.railId)}
            onPressItem={onPressCard}
            onContextMenuItem={onContextMenuVod}
            onSeeAll={() => onSeeAll({ railId: col.railId, title: col.title, kind: 'poster' })}
          />
        ))}
      </View>
    );
  }

  if (activeTab === 'likes') {
    const hasLikes = ratingPartition.liked.length > 0 || ratingPartition.disliked.length > 0;
    if (!hasLikes) {
      return (
        <LibraryEmptyNotice
          testID="library-empty-likes"
          icon="like"
          title={i18n.t('library.emptyLikesTitle')}
          body={i18n.t('library.emptyLikesBody')}
          padX={padX}
        />
      );
    }
    return (
      <View testID="library-likes-content" style={styles.railsStack}>
        <LibraryRailSection
          railId="liked"
          title={i18n.t('library.railLiked')}
          items={ratingPartition.liked}
          variant="poster"
          cardWidth={posterWidth}
          padX={padX}
          isTv={isTv}
          focusedCardIndex={focusedColFor('liked')}
          onPressItem={onPressCard}
          onContextMenuItem={onContextMenuVod}
          onSeeAll={() =>
            onSeeAll({ railId: 'liked', title: i18n.t('library.railLiked'), kind: 'poster' })
          }
        />
        <LibraryRailSection
          railId="disliked"
          title={i18n.t('library.railDisliked')}
          items={ratingPartition.disliked}
          variant="poster"
          cardWidth={posterWidth}
          padX={padX}
          isTv={isTv}
          focusedCardIndex={focusedColFor('disliked')}
          onPressItem={onPressCard}
          onContextMenuItem={onContextMenuVod}
          onSeeAll={() =>
            onSeeAll({ railId: 'disliked', title: i18n.t('library.railDisliked'), kind: 'poster' })
          }
        />
      </View>
    );
  }

  const hasWatched = watchedMovieCards.length > 0 || watchedSeriesCards.length > 0;
  if (!hasWatched) {
    return (
      <LibraryEmptyNotice
        testID="library-empty-watched"
        icon="check"
        title={i18n.t('library.emptyWatchedTitle')}
        body={i18n.t('library.emptyWatchedBody')}
        padX={padX}
      />
    );
  }

  return (
    <View testID="library-watched-content" style={styles.railsStack}>
      <LibraryRailSection
        railId="watched-movies"
        title={i18n.t('library.railWatchedMovies')}
        items={watchedMovieCards}
        variant="poster"
        cardWidth={posterWidth}
        padX={padX}
        isTv={isTv}
        focusedCardIndex={focusedColFor('watched-movies')}
        onPressItem={onPressCard}
        onContextMenuItem={onContextMenuVod}
        onSeeAll={() =>
          onSeeAll({
            railId: 'watched-movies',
            title: i18n.t('library.railWatchedMovies'),
            kind: 'poster',
          })
        }
      />
      <LibraryRailSection
        railId="watched-series"
        title={i18n.t('library.railWatchedSeries')}
        items={watchedSeriesCards}
        variant="poster"
        cardWidth={posterWidth}
        padX={padX}
        isTv={isTv}
        focusedCardIndex={focusedColFor('watched-series')}
        onPressItem={onPressCard}
        onContextMenuItem={onContextMenuVod}
        onSeeAll={() =>
          onSeeAll({
            railId: 'watched-series',
            title: i18n.t('library.railWatchedSeries'),
            kind: 'poster',
          })
        }
      />
    </View>
  );
}

function LibraryEmptyNotice({
  testID,
  icon,
  title,
  body,
  padX,
}: {
  readonly testID: string;
  readonly icon: 'star' | 'like' | 'check';
  readonly title: string;
  readonly body: string;
  readonly padX: number;
}): ReactElement {
  const theme = useTheme();
  return (
    <View
      testID={testID}
      style={[
        styles.emptyBox,
        {
          marginHorizontal: padX,
          borderRadius: theme.radius.card,
          backgroundColor: theme.colors.bgCard,
          borderColor: theme.colors.surfaceBorder,
          padding: theme.spacing.lg,
          gap: theme.spacing.xs,
        },
      ]}
    >
      <Icon name={icon} size={28} color={theme.colors.textMuted} />
      <Text style={[theme.typography.h2, { color: theme.colors.textPrimary }]}>{title}</Text>
      <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>{body}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  railsStack: { gap: 22 },
  emptyBox: {
    borderWidth: 1,
    alignItems: 'flex-start',
  },
});
