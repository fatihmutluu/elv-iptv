import type { ItemRow, RatingValue } from '@elv/data';
import type { ElvModePreferences } from '@elv/domain';
import { createContext, memo, type ReactElement, useContext } from 'react';
import { View } from 'react-native';
import type { DetailTarget, PersonLibraryModalPerson } from '../shared';
import { DetailCastStrip } from './DetailCastStrip';
import { DetailEpisodes } from './DetailEpisodes';
import { DetailFranchiseStrip } from './DetailFranchiseStrip';
import { DetailHero, type DetailHeroDownloadState, type DetailHeroFocusSlot } from './DetailHero';
import { DetailRelatedRail } from './DetailRelatedRail';
import type { DetailVersionOption } from './detail-data-helpers';
import type { DetailNavRowId, PrimaryPlayAction } from './detail-model';
import type { DetailDataState } from './useDetailData';
import type { DetailExtrasState } from './useDetailExtrasState';

/** Props of {@link DetailListHeader}. */
interface DetailListHeaderProps {
  readonly target: DetailTarget;
  readonly data: DetailDataState;
  readonly extras: DetailExtrasState;
  readonly activeVersion: DetailVersionOption | undefined;
  readonly elvPreferences?: ElvModePreferences;
  readonly seasonsCount: number;
  readonly heroWatched: boolean;
  readonly heroDownloadState: DetailHeroDownloadState | undefined;
  readonly hasTrailer: boolean;
  readonly detailTrailerMuted: boolean;
  readonly trailerPreviewActive: boolean;
  readonly primaryAction: PrimaryPlayAction;
  readonly focusedHeroSlot: DetailHeroFocusSlot | null;
  readonly focusedRowId: DetailNavRowId | null;
  readonly focusedCol: number | null;
  readonly isTv: boolean;
  readonly isPortrait: boolean;
  readonly heroTopClearance: number;
  readonly padX: number;
  readonly posterRailWidth: number;
  readonly railGap: number;
  readonly onBack: () => void;
  readonly onPlayPrimary: () => void;
  readonly onToggleMyList: () => void;
  readonly onToggleRating: (next: RatingValue) => void;
  readonly onPressHeroWatched: () => void;
  readonly onPressHeroDownload: () => void;
  readonly onOpenTrailer: () => void;
  readonly onToggleDetailTrailerMuted?: () => void;
  readonly onSelectVersion: (key: string) => void;
  readonly onSelectPerson: (person: PersonLibraryModalPerson) => void;
  readonly onSearchPerson?: (name: string) => void;
  readonly onPressFranchise: (item: ItemRow) => void;
  readonly onRecordCastY: (y: number) => void;
  readonly onRecordFranchiseY: (y: number) => void;
  readonly onRecordEpisodesY: (y: number) => void;
  readonly onHeaderHeightChange?: (height: number) => void;
}

/** Props of {@link DetailListFooterSlot}. */
interface DetailListFooterProps {
  readonly data: DetailDataState;
  readonly favoriteKeys: ReadonlySet<string>;
  readonly watchedOverrides: ReadonlyMap<string, boolean>;
  readonly cardWidth: number;
  readonly gap: number;
  readonly padX: number;
  readonly isTv: boolean;
  readonly focusedIndex: number | null;
  readonly onPressItem: (item: ItemRow) => void;
  readonly onQuickPlay: (item: ItemRow) => void;
  readonly onQuickToggleFavorite: (item: ItemRow) => void;
  readonly onQuickToggleWatched: (item: ItemRow, currentWatched: boolean) => void;
}

/** Combined slot props supplied to the `FlatList` header/footer via context. */
export interface DetailListSlotsValue {
  readonly header: DetailListHeaderProps;
  readonly footer: DetailListFooterProps;
}

/** Context providing live header/footer props to stable `FlatList` slot components. */
export const DetailListSlotsContext = createContext<DetailListSlotsValue | null>(null);

/**
 * Memoized `FlatList` header for {@link DetailScreen}: renders Hero -> Cast -> Franchise ->
 * Series Season Selector & status block above the virtualized single-column episode rows.
 */
const DetailListHeader = memo(function DetailListHeaderInner({
  target,
  data,
  extras,
  activeVersion,
  elvPreferences,
  seasonsCount,
  heroWatched,
  heroDownloadState,
  hasTrailer,
  detailTrailerMuted,
  trailerPreviewActive,
  primaryAction,
  focusedHeroSlot,
  focusedRowId,
  focusedCol,
  isTv,
  isPortrait,
  heroTopClearance,
  padX,
  posterRailWidth,
  railGap,
  onBack,
  onPlayPrimary,
  onToggleMyList,
  onToggleRating,
  onPressHeroWatched,
  onPressHeroDownload,
  onOpenTrailer,
  onToggleDetailTrailerMuted,
  onSelectVersion,
  onSelectPerson,
  onSearchPerson,
  onPressFranchise,
  onRecordCastY,
  onRecordFranchiseY,
  onRecordEpisodesY,
  onHeaderHeightChange,
}: DetailListHeaderProps): ReactElement {
  return (
    <View
      testID="detail-list-header"
      onLayout={(e) => onHeaderHeightChange?.(e.nativeEvent.layout.height)}
    >
      <DetailHero
        kind={target.kind}
        title={data.title}
        titleKey={target.itemKey}
        backdropUri={data.backdropUri}
        posterUri={data.posterUri}
        trailerStreamUrl={data.trailerStreamUrl}
        trailerYoutubeId={data.trailerYoutubeId}
        detailTrailerMuted={detailTrailerMuted}
        trailerPreviewActive={trailerPreviewActive}
        {...(onToggleDetailTrailerMuted !== undefined ? { onToggleDetailTrailerMuted } : {})}
        year={data.year}
        rating={data.rating}
        votes={data.votes}
        runtimeMin={data.runtimeMin}
        plot={data.plot}
        genres={data.genres}
        {...(heroDownloadState !== undefined
          ? {
              downloadState: heroDownloadState,
              onPressDownload: onPressHeroDownload,
            }
          : {})}
        {...(hasTrailer ? { onPressTrailer: onOpenTrailer } : {})}
        {...(target.technicalMeta !== undefined ? { technicalMeta: target.technicalMeta } : {})}
        seasonsCount={seasonsCount}
        inMyList={data.inMyList}
        userRating={data.userRating}
        watched={heroWatched}
        primaryAction={primaryAction}
        {...(activeVersion !== undefined && data.versions.length > 1
          ? {
              versions: data.versions,
              activeVersionKey: activeVersion.key,
              activeVersionLabel: activeVersion.versionLabel || activeVersion.title,
              versionMenuOpen: extras.versionMenuOpen,
              versionMenuIndex: extras.versionMenuIndex,
              onToggleVersionMenu: extras.toggleVersionMenu,
              onCloseVersionMenu: extras.closeVersionMenu,
              onSelectVersion,
            }
          : {})}
        synopsisExpanded={extras.synopsisExpanded}
        onToggleSynopsis={extras.toggleSynopsis}
        onDismissSynopsis={extras.dismissSynopsis}
        onBack={onBack}
        onPlayPrimary={onPlayPrimary}
        onToggleMyList={onToggleMyList}
        onToggleRating={onToggleRating}
        onToggleWatched={onPressHeroWatched}
        isTv={isTv}
        isPortrait={isPortrait}
        topClearance={heroTopClearance}
        padX={padX}
        focusedSlot={focusedHeroSlot}
      />

      {extras.castPeople.length > 0 ? (
        <DetailCastStrip
          cast={data.cast}
          {...(data.director !== null ? { director: data.director } : {})}
          padX={padX}
          isTv={isTv}
          focusedIndex={focusedRowId === 'cast' ? focusedCol : null}
          onSelectPerson={onSelectPerson}
          {...(onSearchPerson !== undefined ? { onSearchPerson } : {})}
          onLayoutY={onRecordCastY}
        />
      ) : null}

      {data.franchiseItems.length >= 2 ? (
        <DetailFranchiseStrip
          items={data.franchiseItems}
          currentItemKey={target.itemKey}
          {...(elvPreferences !== undefined ? { elvPreferences } : {})}
          cardWidth={posterRailWidth}
          gap={railGap}
          padX={padX}
          isTv={isTv}
          focusedIndex={focusedRowId === 'franchise' ? focusedCol : null}
          onPressItem={onPressFranchise}
          onLayoutY={onRecordFranchiseY}
        />
      ) : null}

      {target.kind === 'series' ? (
        <DetailEpisodes
          seasonsState={data.seasonsState}
          selectedSeason={data.selectedSeason}
          episodesCount={data.episodes.length}
          episodesLoading={data.episodesLoading}
          onSelectSeason={data.selectSeason}
          onRetrySeasons={data.retrySeasons}
          isTv={isTv}
          isPortrait={isPortrait}
          padX={padX}
          focusedSeasonIndex={focusedRowId === 'seasons' ? focusedCol : null}
          focusedRetry={focusedRowId === 'retry'}
          onLayoutY={onRecordEpisodesY}
        />
      ) : null}
    </View>
  );
});

/** Stable module-level `FlatList` `ListHeaderComponent` (never unmounts on parent re-render). */
export function DetailListHeaderSlot(): ReactElement | null {
  const slots = useContext(DetailListSlotsContext);
  if (slots === null) return null;
  return <DetailListHeader {...slots.header} />;
}

/** Stable module-level `FlatList` `ListFooterComponent` (never unmounts on parent re-render). */
export function DetailListFooterSlot(): ReactElement | null {
  const slots = useContext(DetailListSlotsContext);
  if (slots === null) return null;
  const f = slots.footer;
  return (
    <DetailRelatedRail
      items={f.data.related}
      progressByKey={f.data.relatedProgressByKey}
      favoriteKeys={f.favoriteKeys}
      watchedOverrides={f.watchedOverrides}
      unplayedBySeriesKey={f.data.relatedUnplayedBySeriesKey}
      cardWidth={f.cardWidth}
      gap={f.gap}
      padX={f.padX}
      isTv={f.isTv}
      focusedIndex={f.focusedIndex}
      onPressItem={f.onPressItem}
      onQuickPlay={f.onQuickPlay}
      onQuickToggleFavorite={f.onQuickToggleFavorite}
      onQuickToggleWatched={f.onQuickToggleWatched}
    />
  );
}
