export { DetailScreen, type DetailScreenProps } from './DetailScreen';
export {
  type BuildDetailNavRowsInput,
  type BuildEpisodePlayTargetInput,
  type BuildMoviePlayTargetInput,
  type BuildPrimaryPlayActionInput,
  buildDetailNavRows,
  buildEpisodePlayTarget,
  buildMoviePlayTarget,
  buildPrimaryPlayAction,
  type DescribedDetailError,
  type DetailNavRowDescriptor,
  type DetailNavRowId,
  describeDetailSeasonsError,
  detailProgressRatio,
  formatEpisodeDuration,
  type PrimaryPlayAction,
  resolveSeriesPrimaryEpisode,
  type SeriesPrimaryEpisodeSelection,
} from './detail-model';
export {
  buildEpisodeChunks,
  EPISODE_CHUNK_SIZE,
  EPISODE_CHUNK_THRESHOLD,
  type EpisodeChunk,
  resolveInitialEpisodeChunkIndex,
} from './episode-chunks';
