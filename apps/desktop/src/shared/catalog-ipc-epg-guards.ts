import {
  type AddGuideSourceInput,
  type CatchupProgrammeInput,
  type ChannelGuideOverrideRecord,
  type GuideChannelOption,
  type GuideSourceRecord,
  type ListRemindersOptions,
  MAX_EPG_SHIFT_MS,
  MAX_GUIDE_CHANNELS_LIMIT,
  MAX_GUIDE_SOURCE_NAME_LENGTH,
  MAX_REMINDER_LEAD_TIME_MS,
  MAX_REMINDERS_LIMIT,
  type ParentalQueryOptions,
  type ProgrammeReminderRecord,
  type ProgrammeRow,
  type SetChannelGuideOverrideInput,
  SOURCE_ID,
  type StreamRequest,
  type UpdateGuideSourcePatch,
  type UpsertReminderInput,
} from '@elv/data';
import type { Result } from '@elv/domain';
import {
  hasControlChar,
  hasOnlyKeys,
  isBoundedString,
  isCleanKey,
  isFiniteNumber,
  isNonNegativeFinite,
  isOptionalStrictProfileId,
  isParentalQueryOptions,
  isRecord,
  isSafeInt,
  isSafeRecentChannelKey,
  MAX_ID_CHARS,
} from './catalog-ipc-guards.ts';

const MAX_GUIDE_URL_CHARS = 4_096;
const MAX_GUIDE_PRIORITY = 10_000;
const MAX_ORDERED_GUIDE_IDS = 100;
const MAX_GUIDE_ID_CHARS = 256;
const MAX_GUIDE_QUERY_CHARS = 256;
const MAX_REMINDER_TEXT_CHARS = 256;
const GUIDE_SOURCE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** Discriminated union of all 16 Wave F3 catch-up, multi-guide, and reminder RPC calls (`#220`, `#306`, `#30`, `#35`). */
export type CatalogEpgOpsRpcCall =
  | {
      method: 'resolveCatchupStream';
      itemKey: string;
      programme: CatchupProgrammeInput;
      opts?: ParentalQueryOptions;
    }
  | {
      method: 'fetchChannelArchiveEpg';
      itemKey: string;
      opts?: ParentalQueryOptions;
    }
  | { method: 'listGuideSources'; sourceId: string }
  | { method: 'addGuideSource'; input: AddGuideSourceInput }
  | { method: 'updateGuideSource'; id: string; patch: UpdateGuideSourcePatch }
  | { method: 'removeGuideSource'; id: string }
  | { method: 'reorderGuideSources'; sourceId: string; orderedIds: readonly string[] }
  | { method: 'listGuideChannels'; sourceId: string; query?: string; limit?: number }
  | { method: 'listChannelGuideOverrides'; sourceId: string }
  | { method: 'setChannelGuideOverride'; input: SetChannelGuideOverrideInput }
  | { method: 'clearChannelGuideOverride'; sourceId: string; channelKey: string }
  | { method: 'listReminders'; profileId?: string; opts?: ListRemindersOptions }
  | { method: 'upsertReminder'; input: UpsertReminderInput }
  | { method: 'removeReminder'; channelKey: string; programmeStart: number; profileId?: string }
  | { method: 'markReminderFired'; channelKey: string; programmeStart: number; profileId?: string }
  | { method: 'pruneExpiredReminders'; nowMs?: number };

/** Preload bridge methods for Wave F3 catch-up, multi-guide management, and reminders (`#220`, `#306`, `#30`, `#35`). */
export interface CatalogBridgeEpgOps {
  resolveCatchupStream?(
    itemKey: string,
    programme: CatchupProgrammeInput,
    opts?: ParentalQueryOptions,
  ): Promise<Result<StreamRequest>>;
  fetchChannelArchiveEpg?(
    itemKey: string,
    opts?: ParentalQueryOptions,
  ): Promise<Result<ProgrammeRow[]>>;
  listGuideSources?(sourceId: string): Promise<GuideSourceRecord[]>;
  addGuideSource?(input: AddGuideSourceInput): Promise<Result<GuideSourceRecord>>;
  updateGuideSource?(id: string, patch: UpdateGuideSourcePatch): Promise<Result<GuideSourceRecord>>;
  removeGuideSource?(id: string): Promise<Result<void>>;
  reorderGuideSources?(sourceId: string, orderedIds: readonly string[]): Promise<Result<void>>;
  listGuideChannels?(
    sourceId: string,
    query?: string,
    limit?: number,
  ): Promise<GuideChannelOption[]>;
  listChannelGuideOverrides?(sourceId: string): Promise<ChannelGuideOverrideRecord[]>;
  setChannelGuideOverride?(
    input: SetChannelGuideOverrideInput,
  ): Promise<Result<ChannelGuideOverrideRecord>>;
  clearChannelGuideOverride?(sourceId: string, channelKey: string): Promise<Result<void>>;
  listReminders?(
    profileId?: string,
    opts?: ListRemindersOptions,
  ): Promise<ProgrammeReminderRecord[]>;
  upsertReminder?(input: UpsertReminderInput): Promise<Result<ProgrammeReminderRecord>>;
  removeReminder?(
    channelKey: string,
    programmeStart: number,
    profileId?: string,
  ): Promise<Result<void>>;
  markReminderFired?(
    channelKey: string,
    programmeStart: number,
    profileId?: string,
  ): Promise<Result<void>>;
  pruneExpiredReminders?(nowMs?: number): Promise<number>;
}

const CATCHUP_PROGRAMME_KEYS = new Set(['startMs', 'stopMs', 'hasArchive']);
const ADD_GUIDE_SOURCE_KEYS = new Set([
  'sourceId',
  'name',
  'url',
  'priority',
  'epgShiftMs',
  'enabled',
]);
const UPDATE_GUIDE_SOURCE_KEYS = new Set(['name', 'url', 'priority', 'epgShiftMs', 'enabled']);
const SET_CHANNEL_GUIDE_OVERRIDE_KEYS = new Set([
  'sourceId',
  'channelKey',
  'guideSourceId',
  'guideId',
  'epgShiftMs',
]);
const LIST_REMINDERS_OPT_KEYS = new Set(['includeFired', 'fromMs', 'limit']);
const UPSERT_REMINDER_KEYS = new Set([
  'profileId',
  'sourceId',
  'channelKey',
  'channelName',
  'programmeTitle',
  'programmeStart',
  'programmeStop',
  'leadTimeMs',
]);

const RESOLVE_CATCHUP_CALL_KEYS = new Set(['method', 'itemKey', 'programme', 'opts']);
const FETCH_ARCHIVE_EPG_CALL_KEYS = new Set(['method', 'itemKey', 'opts']);
const LIST_GUIDE_SOURCES_CALL_KEYS = new Set(['method', 'sourceId']);
const ADD_GUIDE_SOURCE_CALL_KEYS = new Set(['method', 'input']);
const UPDATE_GUIDE_SOURCE_CALL_KEYS = new Set(['method', 'id', 'patch']);
const REMOVE_GUIDE_SOURCE_CALL_KEYS = new Set(['method', 'id']);
const REORDER_GUIDE_SOURCES_CALL_KEYS = new Set(['method', 'sourceId', 'orderedIds']);
const LIST_GUIDE_CHANNELS_CALL_KEYS = new Set(['method', 'sourceId', 'query', 'limit']);
const LIST_GUIDE_OVERRIDES_CALL_KEYS = new Set(['method', 'sourceId']);
const SET_GUIDE_OVERRIDE_CALL_KEYS = new Set(['method', 'input']);
const CLEAR_GUIDE_OVERRIDE_CALL_KEYS = new Set(['method', 'sourceId', 'channelKey']);
const LIST_REMINDERS_CALL_KEYS = new Set(['method', 'profileId', 'opts']);
const UPSERT_REMINDER_CALL_KEYS = new Set(['method', 'input']);
const REMINDER_KEY_CALL_KEYS = new Set(['method', 'channelKey', 'programmeStart', 'profileId']);
const PRUNE_REMINDERS_CALL_KEYS = new Set(['method', 'nowMs']);

const isSafeSourceId = (x: unknown): x is string =>
  isBoundedString(x, 1, MAX_ID_CHARS) && SOURCE_ID.test(x);

const isSafeGuideSourceId = (x: unknown): x is string =>
  typeof x === 'string' && GUIDE_SOURCE_ID_RE.test(x);

const isSafeEpgShiftMs = (x: unknown): x is number =>
  isSafeInt(x) && x >= -MAX_EPG_SHIFT_MS && x <= MAX_EPG_SHIFT_MS;

const isSafePriority = (x: unknown): x is number =>
  isSafeInt(x) && x >= 0 && x <= MAX_GUIDE_PRIORITY;

const isSafeGuideName = (x: unknown): x is string =>
  isBoundedString(x, 1, MAX_GUIDE_SOURCE_NAME_LENGTH) && x.trim().length > 0 && !hasControlChar(x);

function isHttpGuideUrl(x: unknown): x is string {
  if (!isBoundedString(x, 1, MAX_GUIDE_URL_CHARS) || hasControlChar(x)) return false;
  const trimmed = x.trim();
  if (trimmed.length === 0 || !/^https?:\/\//i.test(trimmed)) return false;
  try {
    const parsed = new URL(trimmed);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname.length > 0
    );
  } catch {
    return false;
  }
}

function isCatchupProgrammeInput(x: unknown): x is CatchupProgrammeInput {
  if (!isRecord(x) || !hasOnlyKeys(x, CATCHUP_PROGRAMME_KEYS)) return false;
  const startMs = x['startMs'];
  const stopMs = x['stopMs'];
  if (!isFiniteNumber(startMs) || startMs <= 0) return false;
  if (!isFiniteNumber(stopMs) || stopMs <= startMs) return false;
  return x['hasArchive'] === undefined || typeof x['hasArchive'] === 'boolean';
}

function isAddGuideSourceInput(x: unknown): x is AddGuideSourceInput {
  if (!isRecord(x) || !hasOnlyKeys(x, ADD_GUIDE_SOURCE_KEYS)) return false;
  if (!isSafeSourceId(x['sourceId']) || !isSafeGuideName(x['name']) || !isHttpGuideUrl(x['url'])) {
    return false;
  }
  if (x['priority'] !== undefined && !isSafePriority(x['priority'])) return false;
  if (x['epgShiftMs'] !== undefined && !isSafeEpgShiftMs(x['epgShiftMs'])) return false;
  return x['enabled'] === undefined || typeof x['enabled'] === 'boolean';
}

function isUpdateGuideSourcePatch(x: unknown): x is UpdateGuideSourcePatch {
  if (!isRecord(x) || !hasOnlyKeys(x, UPDATE_GUIDE_SOURCE_KEYS)) return false;
  if (x['name'] !== undefined && !isSafeGuideName(x['name'])) return false;
  if (x['url'] !== undefined && !isHttpGuideUrl(x['url'])) return false;
  if (x['priority'] !== undefined && !isSafePriority(x['priority'])) return false;
  if (x['epgShiftMs'] !== undefined && !isSafeEpgShiftMs(x['epgShiftMs'])) return false;
  return x['enabled'] === undefined || typeof x['enabled'] === 'boolean';
}

function isOrderedGuideIdList(x: unknown): x is readonly string[] {
  return (
    Array.isArray(x) &&
    x.length <= MAX_ORDERED_GUIDE_IDS &&
    x.every((id) => isSafeGuideSourceId(id))
  );
}

function isSetChannelGuideOverrideInput(x: unknown): x is SetChannelGuideOverrideInput {
  if (!isRecord(x) || !hasOnlyKeys(x, SET_CHANNEL_GUIDE_OVERRIDE_KEYS)) return false;
  if (!isSafeSourceId(x['sourceId']) || !isSafeRecentChannelKey(x['channelKey'])) return false;
  const guideSourceId = x['guideSourceId'];
  if (guideSourceId !== undefined && guideSourceId !== null) {
    if (!isBoundedString(guideSourceId, 0, 64) || hasControlChar(guideSourceId)) return false;
    const trimmed = guideSourceId.trim();
    if (trimmed.length > 0 && !GUIDE_SOURCE_ID_RE.test(trimmed)) return false;
  }
  const guideId = x['guideId'];
  if (
    guideId !== undefined &&
    guideId !== null &&
    (!isBoundedString(guideId, 0, MAX_GUIDE_ID_CHARS) || hasControlChar(guideId))
  ) {
    return false;
  }
  return x['epgShiftMs'] === undefined || isSafeEpgShiftMs(x['epgShiftMs']);
}

function isListRemindersOptions(x: unknown): x is ListRemindersOptions {
  if (!isRecord(x) || !hasOnlyKeys(x, LIST_REMINDERS_OPT_KEYS)) return false;
  if (x['includeFired'] !== undefined && typeof x['includeFired'] !== 'boolean') return false;
  if (x['fromMs'] !== undefined && !isNonNegativeFinite(x['fromMs'])) return false;
  const limit = x['limit'];
  return limit === undefined || (isSafeInt(limit) && limit >= 0 && limit <= MAX_REMINDERS_LIMIT);
}

const isSafeReminderLabel = (x: unknown): x is string =>
  isBoundedString(x, 1, MAX_REMINDER_TEXT_CHARS) && x.trim().length > 0 && !hasControlChar(x);

function isUpsertReminderInput(x: unknown): x is UpsertReminderInput {
  if (!isRecord(x) || !hasOnlyKeys(x, UPSERT_REMINDER_KEYS)) return false;
  if (!isOptionalStrictProfileId(x['profileId'])) return false;
  if (!isSafeSourceId(x['sourceId']) || !isSafeRecentChannelKey(x['channelKey'])) return false;
  if (!isSafeReminderLabel(x['channelName']) || !isSafeReminderLabel(x['programmeTitle'])) {
    return false;
  }
  const start = x['programmeStart'];
  const stop = x['programmeStop'];
  if (!isNonNegativeFinite(start) || !isNonNegativeFinite(stop) || stop <= start) return false;
  const lead = x['leadTimeMs'];
  return (
    lead === undefined || (isFiniteNumber(lead) && lead >= 0 && lead <= MAX_REMINDER_LEAD_TIME_MS)
  );
}

/** Validates all 16 Wave F3 catch-up, multi-guide source, channel mapping, and reminder RPC calls (`#220`, `#306`, `#30`, `#35`). */
export function isEpgOpsRpcCall(x: Record<string, unknown>): boolean {
  switch (x['method']) {
    case 'resolveCatchupStream':
      return (
        hasOnlyKeys(x, RESOLVE_CATCHUP_CALL_KEYS) &&
        isCleanKey(x['itemKey']) &&
        isCatchupProgrammeInput(x['programme']) &&
        (x['opts'] === undefined || isParentalQueryOptions(x['opts']))
      );
    case 'fetchChannelArchiveEpg':
      return (
        hasOnlyKeys(x, FETCH_ARCHIVE_EPG_CALL_KEYS) &&
        isCleanKey(x['itemKey']) &&
        (x['opts'] === undefined || isParentalQueryOptions(x['opts']))
      );
    case 'listGuideSources':
      return hasOnlyKeys(x, LIST_GUIDE_SOURCES_CALL_KEYS) && isSafeSourceId(x['sourceId']);
    case 'addGuideSource':
      return hasOnlyKeys(x, ADD_GUIDE_SOURCE_CALL_KEYS) && isAddGuideSourceInput(x['input']);
    case 'updateGuideSource':
      return (
        hasOnlyKeys(x, UPDATE_GUIDE_SOURCE_CALL_KEYS) &&
        isSafeGuideSourceId(x['id']) &&
        isUpdateGuideSourcePatch(x['patch'])
      );
    case 'removeGuideSource':
      return hasOnlyKeys(x, REMOVE_GUIDE_SOURCE_CALL_KEYS) && isSafeGuideSourceId(x['id']);
    case 'reorderGuideSources':
      return (
        hasOnlyKeys(x, REORDER_GUIDE_SOURCES_CALL_KEYS) &&
        isSafeSourceId(x['sourceId']) &&
        isOrderedGuideIdList(x['orderedIds'])
      );
    case 'listGuideChannels':
      return (
        hasOnlyKeys(x, LIST_GUIDE_CHANNELS_CALL_KEYS) &&
        isSafeSourceId(x['sourceId']) &&
        (x['query'] === undefined ||
          (isBoundedString(x['query'], 0, MAX_GUIDE_QUERY_CHARS) && !hasControlChar(x['query']))) &&
        (x['limit'] === undefined ||
          (isSafeInt(x['limit']) && x['limit'] >= 0 && x['limit'] <= MAX_GUIDE_CHANNELS_LIMIT))
      );
    case 'listChannelGuideOverrides':
      return hasOnlyKeys(x, LIST_GUIDE_OVERRIDES_CALL_KEYS) && isSafeSourceId(x['sourceId']);
    case 'setChannelGuideOverride':
      return (
        hasOnlyKeys(x, SET_GUIDE_OVERRIDE_CALL_KEYS) && isSetChannelGuideOverrideInput(x['input'])
      );
    case 'clearChannelGuideOverride':
      return (
        hasOnlyKeys(x, CLEAR_GUIDE_OVERRIDE_CALL_KEYS) &&
        isSafeSourceId(x['sourceId']) &&
        isSafeRecentChannelKey(x['channelKey'])
      );
    case 'listReminders':
      return (
        hasOnlyKeys(x, LIST_REMINDERS_CALL_KEYS) &&
        isOptionalStrictProfileId(x['profileId']) &&
        (x['opts'] === undefined || isListRemindersOptions(x['opts']))
      );
    case 'upsertReminder':
      return hasOnlyKeys(x, UPSERT_REMINDER_CALL_KEYS) && isUpsertReminderInput(x['input']);
    case 'removeReminder':
    case 'markReminderFired':
      return (
        hasOnlyKeys(x, REMINDER_KEY_CALL_KEYS) &&
        isSafeRecentChannelKey(x['channelKey']) &&
        isNonNegativeFinite(x['programmeStart']) &&
        isOptionalStrictProfileId(x['profileId'])
      );
    case 'pruneExpiredReminders':
      return (
        hasOnlyKeys(x, PRUNE_REMINDERS_CALL_KEYS) &&
        (x['nowMs'] === undefined || isNonNegativeFinite(x['nowMs']))
      );
    default:
      return false;
  }
}
