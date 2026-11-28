import type {
  CatalogService,
  CreateProfileInput,
  ParentalLockRecord,
  ParentalSettings,
  PinVerifyResult,
  ProfileRecord,
  SetParentalLockInput,
  UpdateParentalSettingsPatch,
  UpdateProfilePatch,
} from '@elv/data';
import {
  elvError,
  err,
  type KeymapStore,
  type ProfilePreferencesManager,
  type Result,
} from '@elv/domain';
import type { ReactNode } from 'react';

/** Props of {@link ProfileProvider}. */
export interface ProfileProviderProps {
  readonly catalog: CatalogService;
  /** Monotonic external refresh token (e.g. incoming E2EE sync) triggering live profile & parental reload. */
  readonly externalRefreshToken?: number;
  readonly profilePreferences?: ProfilePreferencesManager;
  readonly keymapStore?: KeymapStore;
  /** Suppresses automatic startup opening of the `"Who's Watching?"` picker while startup overlays are active (`#513`). */
  readonly suppressAutoProfilePicker?: boolean;
  readonly onProfileDeleted?: (profileId: string) => void | Promise<void>;
  readonly onProfileOrLockChange?: (next: {
    readonly activeProfileId: string;
    readonly parentalUnlocked: boolean;
    readonly reason: 'profile-switch' | 'parental-change';
  }) => void;
  readonly children: ReactNode;
}

/** Loaded parental snapshot for a single profile. */
export interface LoadedParentalSnapshot {
  readonly settings: ParentalSettings;
  readonly locks: readonly ParentalLockRecord[];
  readonly hasPin: boolean;
  readonly guardPinProfileId: string | null;
}

export const DEFAULT_PROFILE_ID = 'default';

/** Fallback default profile used before SQLite profiles resolve or on stub catalogs. */
export const DEFAULT_PROFILE_RECORD: ProfileRecord = {
  id: DEFAULT_PROFILE_ID,
  name: 'Default',
  avatarToken: 'crimson',
  isKids: false,
  isDefault: true,
  createdAt: 0,
  updatedAt: 0,
};

/** Fallback parental settings when no policy row has been persisted yet. */
export function defaultParentalSettings(profileId = DEFAULT_PROFILE_ID): ParentalSettings {
  return {
    profileId,
    enabled: false,
    blockAdultKeywords: true,
    maxRatingAge: null,
    unlockTimeoutMin: 30,
    updatedAt: 0,
  };
}

/** Strict fail-closed parental policy applied whenever storage reads reject. */
export function failClosedParentalSettings(profileId = DEFAULT_PROFILE_ID): ParentalSettings {
  return {
    profileId,
    enabled: true,
    blockAdultKeywords: true,
    maxRatingAge: 0,
    unlockTimeoutMin: 30,
    updatedAt: 0,
  };
}

/** Typed storage failure returned when parental state is unreadable and mutations are blocked. */
export function parentalUnavailableError<T = never>(): Result<T> {
  return err(
    elvError('storage', 'parental-state-unavailable', 'Parental controls could not be loaded'),
  );
}

/** Active in-tree PIN dialog request rendered at root level inside `AppShell`. */
export type PinDialogMode = 'verify' | 'create' | 'change' | 'remove';

/** Descriptor for an active PIN entry overlay request. */
export interface PinDialogRequest {
  readonly mode: PinDialogMode;
  readonly title?: string;
  readonly profileId?: string;
  /** When `true` in `verify` mode, verifies the PIN without unlocking the active parental session. */
  readonly verifyOnly?: boolean;
  readonly onSuccess?: () => void;
  readonly onCancel?: () => void;
}

/** Reactive local-profile and parental-control state exposed via `useProfile` and `useParental`. */
export interface ProfileContextValue {
  readonly profiles: readonly ProfileRecord[];
  readonly activeProfile: ProfileRecord;
  readonly activeProfileId: string;
  readonly profilesReady: boolean;
  readonly profileRevision: number;
  readonly parentalSettings: ParentalSettings;
  readonly parentalLocks: readonly ParentalLockRecord[];
  readonly hasParentalPin: boolean;
  /** Whether the active profile or a fallback parent/default profile has a PIN configured. */
  readonly hasGuardPin: boolean;
  /** Profile ID owning the effective guard PIN (active profile first, else default/parent profile). */
  readonly guardPinProfileId: string | null;
  readonly parentalUnlocked: boolean;
  readonly parentalUnlockExpiresAt: number | null;
  /** `true` when storage reads for profiles or parental controls failed (strict fail-closed mode). */
  readonly parentalLoadError: boolean;
  readonly pinDialog: PinDialogRequest | null;
  readonly profilePickerOpen: boolean;
  switchProfile(profileId: string): Promise<void>;
  createProfile(input: CreateProfileInput): Promise<Result<ProfileRecord>>;
  updateProfile(id: string, patch: UpdateProfilePatch): Promise<Result<ProfileRecord>>;
  deleteProfile(id: string): Promise<Result<void>>;
  verifyParentalPin(pin: string, profileId?: string): Promise<PinVerifyResult>;
  unlockParental(pin: string, profileId?: string): Promise<PinVerifyResult>;
  lockParentalNow(): void;
  updateParentalSettings(patch: UpdateParentalSettingsPatch): Promise<Result<ParentalSettings>>;
  setParentalLock(
    input: Omit<SetParentalLockInput, 'profileId'>,
    locked: boolean,
  ): Promise<Result<void>>;
  setParentalPin(pin: string, currentPin?: string, profileId?: string): Promise<Result<void>>;
  clearParentalPin(currentPin: string, profileId?: string): Promise<Result<void>>;
  /** Queries whether a specific profile has a parental PIN configured in the catalog. */
  hasProfilePin(profileId: string): Promise<boolean>;
  refreshParental(): Promise<void>;
  refreshProfiles(): Promise<void>;
  /** Retries loading profiles and parental controls to recover from a fail-closed load error. */
  retryParentalLoad(): Promise<void>;
  requestParentalUnlock(onSuccess: () => void, options?: { readonly title?: string }): void;
  openPinDialog(request: PinDialogRequest): void;
  closePinDialog(cancelled?: boolean): void;
  openProfilePicker(): void;
  closeProfilePicker(): void;
}

const unsupported = () => Promise.resolve(err(elvError('storage', 'unsupported')));

/** Safe fallback context returned when hooks are called outside `ProfileProvider`. */
export const DEFAULT_PROFILE_CONTEXT: ProfileContextValue = {
  profiles: [DEFAULT_PROFILE_RECORD],
  activeProfile: DEFAULT_PROFILE_RECORD,
  activeProfileId: DEFAULT_PROFILE_ID,
  profilesReady: false,
  profileRevision: 0,
  parentalSettings: defaultParentalSettings(),
  parentalLocks: [],
  hasParentalPin: false,
  hasGuardPin: false,
  guardPinProfileId: null,
  parentalUnlocked: false,
  parentalUnlockExpiresAt: null,
  parentalLoadError: false,
  pinDialog: null,
  profilePickerOpen: false,
  switchProfile: async () => undefined,
  createProfile: unsupported,
  updateProfile: unsupported,
  deleteProfile: unsupported,
  verifyParentalPin: async () => ({ ok: false, remainingAttempts: 0 }),
  unlockParental: async () => ({ ok: false, remainingAttempts: 0 }),
  lockParentalNow: () => undefined,
  updateParentalSettings: unsupported,
  setParentalLock: unsupported,
  setParentalPin: unsupported,
  clearParentalPin: unsupported,
  hasProfilePin: async () => false,
  refreshParental: async () => undefined,
  refreshProfiles: async () => undefined,
  retryParentalLoad: async () => undefined,
  requestParentalUnlock: () => undefined,
  openPinDialog: () => undefined,
  closePinDialog: () => undefined,
  openProfilePicker: () => undefined,
  closeProfilePicker: () => undefined,
};

/** Builds ordered candidate profile IDs checked when resolving the effective guard PIN owner. */
export function buildGuardPinCandidates(
  activeProfileId: string,
  profileList: readonly ProfileRecord[],
): readonly string[] {
  const candidates: string[] = [activeProfileId];
  const seen = new Set<string>([activeProfileId]);
  const defaultProfile = profileList.find((p) => p.isDefault || p.id === DEFAULT_PROFILE_ID);
  if (defaultProfile && !seen.has(defaultProfile.id)) {
    seen.add(defaultProfile.id);
    candidates.push(defaultProfile.id);
  } else if (!seen.has(DEFAULT_PROFILE_ID)) {
    seen.add(DEFAULT_PROFILE_ID);
    candidates.push(DEFAULT_PROFILE_ID);
  }
  for (const p of profileList) {
    if (!p.isKids && !seen.has(p.id)) {
      seen.add(p.id);
      candidates.push(p.id);
    }
  }
  return candidates;
}

/**
 * Returns `true` when `patch` weakens or disables any active parental restriction relative to
 * `current`, requiring fresh current-PIN re-verification even during an unlocked session.
 */
export function isRelaxingParentalPatch(
  current: ParentalSettings,
  patch: UpdateParentalSettingsPatch,
): boolean {
  if (patch.enabled === false && current.enabled) return true;
  if (patch.blockAdultKeywords === false && current.blockAdultKeywords) return true;
  if (patch.maxRatingAge !== undefined && patch.maxRatingAge !== current.maxRatingAge) {
    if (patch.maxRatingAge === null) return true;
    if (current.maxRatingAge !== null && patch.maxRatingAge > current.maxRatingAge) return true;
  }
  if (patch.unlockTimeoutMin !== undefined && patch.unlockTimeoutMin !== current.unlockTimeoutMin) {
    if (patch.unlockTimeoutMin === 0) return true;
    if (current.unlockTimeoutMin > 0 && patch.unlockTimeoutMin > current.unlockTimeoutMin) {
      return true;
    }
  }
  return false;
}
