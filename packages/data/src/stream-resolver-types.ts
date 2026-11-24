import type { DnsFamilyPreference, Result } from '@elv/domain';
import type { ItemRow } from './queries';

/** Resolved alternate/backup stream endpoint with its own cloned headers map (`#430`, `#157`, `#317`, `#172`). */
export interface StreamAlternate {
  url: string;
  headers: Record<string, string>;
  readonly accountKey?: string;
  readonly maxConnections?: number;
  readonly sourceId?: string;
  readonly channelKey?: string;
  readonly allowLegacyTls?: boolean;
  readonly dnsFamily?: DnsFamilyPreference;
  readonly hostOverride?: string;
}

/** What a player needs to open an item. Never log or store it. */
export interface StreamRequest {
  url: string;
  /** Lower-case header names. */
  headers: Record<string, string>;
  /** Opaque account pool key (`credentialFingerprint` when known, else `sourceId`) for connection pooling (`#265`). */
  accountKey?: string;
  /** Normalized per-source concurrent connection limit (`>= 1`, default `1`, `#87`). */
  maxConnections?: number;
  /** Optional provider-reported active connection count when known (`#87`). */
  providerActiveConnections?: number;
  /** Catalog source identifier associated with this stream (`#157`, `#317`). */
  readonly sourceId?: string;
  /** Catalog channel key associated with this stream (`#157`). */
  readonly channelKey?: string;
  /** Optional resolved backup and failover stream endpoints (`#430`, `#157`, `#317`). */
  alternates?: readonly StreamAlternate[];
  /** Opt-in legacy TLS flag forwarded from the source's transport settings (`#182`). */
  readonly allowLegacyTls?: boolean;
  /** Optional per-source DNS address-family preference (`#172`). */
  readonly dnsFamily?: DnsFamilyPreference;
  /** Optional validated literal IP host override scoped strictly to the initial host (`#172`). */
  readonly hostOverride?: string;
}

/** Alias for {@link StreamRequest}. */
export type ResolvedStream = StreamRequest;

/** Rebuilds the stored templates of one source in memory. */
export interface StreamResolver {
  resolve(template: string): string | undefined;
}

/** @internal Parsed Xtream credential secret including optional backup mirror URLs (`#317`). */
export interface XtreamSecret {
  readonly server: string;
  readonly username: string;
  readonly password: string;
  readonly backupServers?: readonly string[];
}

/** Programme time window and optional archive availability flag for {@link PlaytimeResolverCache.resolveCatchupStream}. */
export interface CatchupProgrammeInput {
  readonly startMs: number;
  readonly stopMs: number;
  readonly hasArchive?: boolean;
  /** Optional programme title checked against active parental-control filters (`#31`). */
  readonly title?: string;
}

/** @internal Per-source resolved transport and connection metadata shared by live/VOD/catchup resolution. */
export interface SourceStreamMeta {
  readonly headers: Record<string, string>;
  readonly accountKey: string;
  readonly connectionMeta: {
    readonly maxConnections: number;
    readonly providerActiveConnections?: number;
    readonly allowLegacyTls?: boolean;
    readonly dnsFamily?: DnsFamilyPreference;
    readonly hostOverride?: string;
  };
}

/** @internal Session cache for M3U `urlvars` resolvers, Xtream secrets, and split-failover Xtream clients. */
export interface PlaytimeResolverCache {
  evict(sourceId: string): void;
  clear(): void;
  resolveLogos<T extends ItemRow>(items: T[], sourceId: string): Promise<T[]>;
  resolveRowLogos<T extends { sourceId: string; logo: string | null }>(rows: T[]): Promise<T[]>;
  resolveStream(itemKey: string): Promise<Result<StreamRequest>>;
  resolveCatchupStream(
    itemKey: string,
    programme: CatchupProgrammeInput,
    nowMs?: number,
  ): Promise<Result<StreamRequest>>;
  reportStreamOutcome(sourceId: string, serverUrl: string, succeeded: boolean): void;
}
