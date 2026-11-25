/** Supported DRM schemes parsed from M3U `#KODIPROP` and forwarded at play time (`#272`). */
export type DrmScheme = 'clearkey' | 'widevine' | 'playready';

/** One ClearKey key-id / key pair (32-char hex or base64url, `#272`). Never log or store in SQLite. */
export interface DrmClearKeyPair {
  readonly kid: string;
  readonly key: string;
}

/** Play-time DRM configuration attached to a resolved stream. Never stored in SQLite or logs (`#272`). */
export interface DrmConfig {
  readonly scheme: DrmScheme;
  readonly licenseUrl?: string;
  readonly licenseHeaders?: Readonly<Record<string, string>>;
  readonly clearKeys?: readonly DrmClearKeyPair[];
  readonly multiSession?: boolean;
}
