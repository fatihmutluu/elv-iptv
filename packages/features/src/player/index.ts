export type { MediaSessionMetadata, QueuedEpisodeHostRequest } from '../ports/video-host';
export {
  type DescribedPlaybackFailure,
  describePlaybackFailure,
  type PlaybackFailureContext,
} from './errors';
export { DEFAULT_AUTO_HIDE_OSD_MS, PlayerScreen, type PlayerScreenProps } from './PlayerScreen';
