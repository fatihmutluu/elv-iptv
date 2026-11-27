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
import {
  createContext,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

const DEFAULT_PROFILE_ID = 'default';

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

/** Reactive local-profile and parental-control state exposed via {@link useProfile} and {@link useParental}. */
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
  requestParentalUnlock(onSuccess: () => void, options?: { readonly title?: string }): void;
  openPinDialog(request: PinDialogRequest): void;
  closePinDialog(cancelled?: boolean): void;
  openProfilePicker(): void;
  closeProfilePicker(): void;
}

const unsupported = () => Promise.resolve(err(elvError('storage', 'unsupported')));

const DEFAULT_PROFILE_CONTEXT: ProfileContextValue = {
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
  requestParentalUnlock: () => undefined,
  openPinDialog: () => undefined,
  closePinDialog: () => undefined,
  openProfilePicker: () => undefined,
  closeProfilePicker: () => undefined,
};

const ProfileContext = createContext<ProfileContextValue>(DEFAULT_PROFILE_CONTEXT);

/** Props of {@link ProfileProvider}. */
export interface ProfileProviderProps {
  readonly catalog: CatalogService;
  /** Monotonic external refresh token (e.g. incoming E2EE sync) triggering live profile & parental reload. */
  readonly externalRefreshToken?: number;
  readonly profilePreferences?: ProfilePreferencesManager;
  readonly keymapStore?: KeymapStore;
  readonly onProfileDeleted?: (profileId: string) => void | Promise<void>;
  readonly onProfileOrLockChange?: (next: {
    readonly activeProfileId: string;
    readonly parentalUnlocked: boolean;
    readonly reason: 'profile-switch' | 'parental-change';
  }) => void;
  readonly children: ReactNode;
}

interface LoadedParentalSnapshot {
  readonly settings: ParentalSettings;
  readonly locks: readonly ParentalLockRecord[];
  readonly hasPin: boolean;
  readonly guardPinProfileId: string | null;
}

function buildGuardPinCandidates(
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
 * Manages local viewer profiles (`#15`) and temporary PIN-gated parental unlocks (`#31`)
 * without remounting the navigation shell or flashing blank screens.
 */
export function ProfileProvider({
  catalog,
  externalRefreshToken,
  profilePreferences,
  keymapStore,
  onProfileDeleted,
  onProfileOrLockChange,
  children,
}: ProfileProviderProps): ReactElement {
  const hasAsyncHydration =
    catalog.listProfiles !== undefined ||
    profilePreferences !== undefined ||
    catalog.getParentalSettings !== undefined ||
    catalog.listParentalLocks !== undefined ||
    catalog.hasParentalPin !== undefined;

  const [profiles, setProfiles] = useState<readonly ProfileRecord[]>([DEFAULT_PROFILE_RECORD]);
  const [activeProfileId, setActiveProfileId] = useState<string>(
    () => profilePreferences?.getActiveProfileId() ?? DEFAULT_PROFILE_ID,
  );
  const [profilesReady, setProfilesReady] = useState(() => !hasAsyncHydration);
  const [profileRevision, setProfileRevision] = useState(0);

  const [parentalSettings, setParentalSettings] = useState<ParentalSettings>(() =>
    defaultParentalSettings(profilePreferences?.getActiveProfileId() ?? DEFAULT_PROFILE_ID),
  );
  const [parentalLocks, setParentalLocks] = useState<readonly ParentalLockRecord[]>([]);
  const [hasParentalPin, setHasParentalPin] = useState(false);
  const [guardPinProfileId, setGuardPinProfileId] = useState<string | null>(null);
  const [parentalUnlocked, setParentalUnlocked] = useState(false);
  const [parentalUnlockExpiresAt, setParentalUnlockExpiresAt] = useState<number | null>(null);
  const [pinDialog, setPinDialog] = useState<PinDialogRequest | null>(null);
  const [profilePickerOpen, setProfilePickerOpen] = useState(false);

  const mountedRef = useRef(true);
  const profilesRef = useRef(profiles);
  profilesRef.current = profiles;
  const activeProfileIdRef = useRef(activeProfileId);
  activeProfileIdRef.current = activeProfileId;
  const parentalSettingsRef = useRef(parentalSettings);
  parentalSettingsRef.current = parentalSettings;
  const parentalUnlockedRef = useRef(parentalUnlocked);
  parentalUnlockedRef.current = parentalUnlocked;
  const guardPinProfileIdRef = useRef<string | null>(guardPinProfileId);
  guardPinProfileIdRef.current = guardPinProfileId;
  const switchSeqRef = useRef(0);
  const relockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onChangeRef = useRef(onProfileOrLockChange);
  onChangeRef.current = onProfileOrLockChange;
  const onProfileDeletedRef = useRef(onProfileDeleted);
  onProfileDeletedRef.current = onProfileDeleted;

  const clearRelockTimer = useCallback(() => {
    if (relockTimerRef.current !== null) {
      clearTimeout(relockTimerRef.current);
      relockTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearRelockTimer();
    };
  }, [clearRelockTimer]);

  const fetchParentalSnapshot = useCallback(
    async (
      profileId: string,
      profileList: readonly ProfileRecord[],
    ): Promise<LoadedParentalSnapshot> => {
      const candidates = buildGuardPinCandidates(profileId, profileList);
      const hasPinFn = catalog.hasParentalPin;
      const [settings, locks, pinFlags] = await Promise.all([
        catalog.getParentalSettings
          ? catalog.getParentalSettings(profileId).catch(() => defaultParentalSettings(profileId))
          : Promise.resolve(defaultParentalSettings(profileId)),
        catalog.listParentalLocks
          ? catalog.listParentalLocks(profileId).catch(() => [] as ParentalLockRecord[])
          : Promise.resolve([] as ParentalLockRecord[]),
        hasPinFn
          ? Promise.all(candidates.map((id) => hasPinFn(id).catch(() => false)))
          : Promise.resolve(candidates.map(() => false)),
      ]);
      const hasPin = pinFlags[0] === true;
      const guardIdx = pinFlags.indexOf(true);
      const nextGuardId = guardIdx >= 0 ? (candidates[guardIdx] ?? null) : null;
      return { settings, locks, hasPin, guardPinProfileId: nextGuardId };
    },
    [catalog],
  );

  const loadParentalStateFor = useCallback(
    async (profileId: string, overrideList?: readonly ProfileRecord[]): Promise<void> => {
      const snapshot = await fetchParentalSnapshot(profileId, overrideList ?? profilesRef.current);
      if (!mountedRef.current || activeProfileIdRef.current !== profileId) return;
      parentalSettingsRef.current = snapshot.settings;
      guardPinProfileIdRef.current = snapshot.guardPinProfileId;
      setParentalSettings(snapshot.settings);
      setParentalLocks(snapshot.locks);
      setHasParentalPin(snapshot.hasPin);
      setGuardPinProfileId(snapshot.guardPinProfileId);
    },
    [fetchParentalSnapshot],
  );

  const switchProfileInternal = useCallback(
    async (nextProfileId: string, overrideList?: readonly ProfileRecord[]): Promise<void> => {
      const targetId = nextProfileId.trim() || DEFAULT_PROFILE_ID;
      const seq = ++switchSeqRef.current;
      setProfilePickerOpen(false);

      if (profilePreferences) {
        await profilePreferences.switchProfile(targetId).catch(() => undefined);
        if (!mountedRef.current || switchSeqRef.current !== seq) return;
        await profilePreferences.saveActiveProfileId(targetId).catch(() => undefined);
        if (!mountedRef.current || switchSeqRef.current !== seq) return;
      }

      const snapshot = await fetchParentalSnapshot(targetId, overrideList ?? profilesRef.current);
      if (!mountedRef.current || switchSeqRef.current !== seq) return;

      // Atomic batched commit: zero double cache clear, zero double prewarm, zero stale window.
      clearRelockTimer();
      activeProfileIdRef.current = targetId;
      parentalSettingsRef.current = snapshot.settings;
      parentalUnlockedRef.current = false;
      guardPinProfileIdRef.current = snapshot.guardPinProfileId;
      setActiveProfileId(targetId);
      setParentalSettings(snapshot.settings);
      setParentalLocks(snapshot.locks);
      setHasParentalPin(snapshot.hasPin);
      setGuardPinProfileId(snapshot.guardPinProfileId);
      setParentalUnlocked(false);
      setParentalUnlockExpiresAt(null);
      setProfileRevision((r) => r + 1);
      onChangeRef.current?.({
        activeProfileId: targetId,
        parentalUnlocked: false,
        reason: 'profile-switch',
      });
    },
    [clearRelockTimer, fetchParentalSnapshot, profilePreferences],
  );

  const refreshProfiles = useCallback(async (): Promise<void> => {
    const loaded = catalog.listProfiles
      ? await catalog.listProfiles().catch(() => [DEFAULT_PROFILE_RECORD])
      : [DEFAULT_PROFILE_RECORD];
    if (!mountedRef.current) return;
    const safeList = loaded.length > 0 ? loaded : [DEFAULT_PROFILE_RECORD];
    profilesRef.current = safeList;
    setProfiles(safeList);
    const currentActiveId = activeProfileIdRef.current;
    if (!safeList.some((p) => p.id === currentActiveId)) {
      const defaultProfile =
        safeList.find((p) => p.isDefault || p.id === DEFAULT_PROFILE_ID) ?? safeList[0];
      await switchProfileInternal(defaultProfile?.id ?? DEFAULT_PROFILE_ID, safeList);
      if (!mountedRef.current) return;
      setProfilesReady(true);
      return;
    }
    await loadParentalStateFor(currentActiveId, safeList);
    if (!mountedRef.current) return;
    setProfilesReady(true);
  }, [catalog, loadParentalStateFor, switchProfileInternal]);

  const prevExternalRefreshTokenRef = useRef<number>(externalRefreshToken ?? 0);
  useEffect(() => {
    const nextToken = externalRefreshToken ?? 0;
    if (nextToken <= 0 || nextToken === prevExternalRefreshTokenRef.current) return;
    prevExternalRefreshTokenRef.current = nextToken;
    void refreshProfiles();
  }, [externalRefreshToken, refreshProfiles]);

  // Initial hydration: resolve profiles, persisted active profile ID, preferences, and parental
  // state BEFORE committing `profilesReady = true` so frame 1 never leaks Adult content for Kids.
  useEffect(() => {
    if (!hasAsyncHydration) {
      setProfilesReady(true);
      return undefined;
    }
    let cancelled = false;
    const initSeq = ++switchSeqRef.current;
    void (async () => {
      const [loadedProfiles, savedId] = await Promise.all([
        catalog.listProfiles
          ? catalog.listProfiles().catch(() => [DEFAULT_PROFILE_RECORD])
          : Promise.resolve([DEFAULT_PROFILE_RECORD]),
        profilePreferences
          ? profilePreferences.loadActiveProfileId().catch(() => DEFAULT_PROFILE_ID)
          : Promise.resolve(DEFAULT_PROFILE_ID),
      ]);
      if (cancelled || !mountedRef.current || switchSeqRef.current !== initSeq) return;
      const safeList = loadedProfiles.length > 0 ? loadedProfiles : [DEFAULT_PROFILE_RECORD];
      const validTarget = safeList.some((p) => p.id === savedId)
        ? savedId
        : (safeList[0]?.id ?? DEFAULT_PROFILE_ID);

      if (profilePreferences && profilePreferences.getActiveProfileId() !== validTarget) {
        await profilePreferences.switchProfile(validTarget).catch(() => undefined);
      }
      if (cancelled || !mountedRef.current || switchSeqRef.current !== initSeq) return;

      const snapshot = await fetchParentalSnapshot(validTarget, safeList);
      if (cancelled || !mountedRef.current || switchSeqRef.current !== initSeq) return;

      const profileChanged = validTarget !== activeProfileIdRef.current;
      profilesRef.current = safeList;
      activeProfileIdRef.current = validTarget;
      parentalSettingsRef.current = snapshot.settings;
      guardPinProfileIdRef.current = snapshot.guardPinProfileId;
      setProfiles(safeList);
      setActiveProfileId(validTarget);
      setParentalSettings(snapshot.settings);
      setParentalLocks(snapshot.locks);
      setHasParentalPin(snapshot.hasPin);
      setGuardPinProfileId(snapshot.guardPinProfileId);
      setProfilesReady(true);
      if (profileChanged) {
        setProfileRevision((r) => r + 1);
        onChangeRef.current?.({
          activeProfileId: validTarget,
          parentalUnlocked: false,
          reason: 'profile-switch',
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [catalog, fetchParentalSnapshot, hasAsyncHydration, profilePreferences]);

  const lockParentalNow = useCallback(() => {
    clearRelockTimer();
    const wasUnlocked = parentalUnlockedRef.current;
    parentalUnlockedRef.current = false;
    setParentalUnlocked(false);
    setParentalUnlockExpiresAt(null);
    if (wasUnlocked) {
      setProfileRevision((r) => r + 1);
      onChangeRef.current?.({
        activeProfileId: activeProfileIdRef.current,
        parentalUnlocked: false,
        reason: 'parental-change',
      });
    }
  }, [clearRelockTimer]);

  const switchProfile = useCallback(
    async (nextProfileId: string): Promise<void> => switchProfileInternal(nextProfileId),
    [switchProfileInternal],
  );

  const createProfileAction = useCallback(
    async (input: CreateProfileInput): Promise<Result<ProfileRecord>> => {
      if (!catalog.createProfile) return err(elvError('storage', 'unsupported'));
      const res = await catalog.createProfile(input);
      if (res.ok && mountedRef.current) {
        await refreshProfiles();
      }
      return res;
    },
    [catalog, refreshProfiles],
  );

  const updateProfileAction = useCallback(
    async (id: string, patch: UpdateProfilePatch): Promise<Result<ProfileRecord>> => {
      if (!catalog.updateProfile) return err(elvError('storage', 'unsupported'));
      const res = await catalog.updateProfile(id, patch);
      if (res.ok && mountedRef.current) {
        await refreshProfiles();
      }
      return res;
    },
    [catalog, refreshProfiles],
  );

  const deleteProfileAction = useCallback(
    async (id: string): Promise<Result<void>> => {
      if (!catalog.deleteProfile) return err(elvError('storage', 'unsupported'));
      const res = await catalog.deleteProfile(id);
      if (!res.ok) return res;

      await Promise.all([
        profilePreferences?.deleteProfilePreferences(id).catch(() => undefined),
        keymapStore?.deleteProfileKeymap(id).catch(() => undefined),
        Promise.resolve(onProfileDeletedRef.current?.(id)).catch(() => undefined),
      ]);
      if (!mountedRef.current) return res;

      const loaded = catalog.listProfiles
        ? await catalog.listProfiles().catch(() => [DEFAULT_PROFILE_RECORD])
        : [DEFAULT_PROFILE_RECORD];
      if (!mountedRef.current) return res;
      const safeList = loaded.length > 0 ? loaded : [DEFAULT_PROFILE_RECORD];
      profilesRef.current = safeList;
      setProfiles(safeList);
      if (activeProfileIdRef.current === id) {
        const fallbackId = safeList[0]?.id ?? DEFAULT_PROFILE_ID;
        await switchProfileInternal(fallbackId, safeList);
      } else {
        await loadParentalStateFor(activeProfileIdRef.current, safeList);
      }
      return res;
    },
    [catalog, keymapStore, loadParentalStateFor, profilePreferences, switchProfileInternal],
  );

  const verifyParentalPin = useCallback(
    async (pin: string, targetProfileId?: string): Promise<PinVerifyResult> => {
      const pid = targetProfileId ?? guardPinProfileIdRef.current ?? activeProfileIdRef.current;
      if (!catalog.verifyParentalPin) {
        return { ok: false, remainingAttempts: 0 };
      }
      return catalog.verifyParentalPin(pin, pid);
    },
    [catalog],
  );

  const startParentalUnlockSession = useCallback(() => {
    clearRelockTimer();
    parentalUnlockedRef.current = true;
    setParentalUnlocked(true);
    const timeoutMin = parentalSettingsRef.current.unlockTimeoutMin;
    if (timeoutMin > 0) {
      const durationMs = timeoutMin * 60_000;
      setParentalUnlockExpiresAt(Date.now() + durationMs);
      relockTimerRef.current = setTimeout(() => {
        relockTimerRef.current = null;
        if (mountedRef.current) lockParentalNow();
      }, durationMs);
    } else {
      setParentalUnlockExpiresAt(null);
    }
    setProfileRevision((r) => r + 1);
    onChangeRef.current?.({
      activeProfileId: activeProfileIdRef.current,
      parentalUnlocked: true,
      reason: 'parental-change',
    });
  }, [clearRelockTimer, lockParentalNow]);

  const unlockParental = useCallback(
    async (pin: string, targetProfileId?: string): Promise<PinVerifyResult> => {
      const pid = targetProfileId ?? guardPinProfileIdRef.current ?? activeProfileIdRef.current;
      if (!catalog.verifyParentalPin) {
        return { ok: false, remainingAttempts: 0 };
      }
      const res = await catalog.verifyParentalPin(pin, pid);
      if (!mountedRef.current) return res;
      if (res.ok && (pid === activeProfileIdRef.current || pid === guardPinProfileIdRef.current)) {
        startParentalUnlockSession();
      }
      return res;
    },
    [catalog, startParentalUnlockSession],
  );

  const updateParentalSettingsAction = useCallback(
    async (patch: UpdateParentalSettingsPatch): Promise<Result<ParentalSettings>> => {
      if (!catalog.updateParentalSettings) return err(elvError('storage', 'unsupported'));
      const pid = activeProfileIdRef.current;
      const res = await catalog.updateParentalSettings(patch, pid);
      if (res.ok && mountedRef.current && activeProfileIdRef.current === pid) {
        parentalSettingsRef.current = res.value;
        setParentalSettings(res.value);
        setProfileRevision((r) => r + 1);
        onChangeRef.current?.({
          activeProfileId: pid,
          parentalUnlocked: parentalUnlockedRef.current,
          reason: 'parental-change',
        });
      }
      return res;
    },
    [catalog],
  );

  const setParentalLockAction = useCallback(
    async (
      input: Omit<SetParentalLockInput, 'profileId'>,
      locked: boolean,
    ): Promise<Result<void>> => {
      if (!catalog.setParentalLock) return err(elvError('storage', 'unsupported'));
      const pid = activeProfileIdRef.current;
      const res = await catalog.setParentalLock({ ...input, profileId: pid }, locked);
      if (res.ok && mountedRef.current && activeProfileIdRef.current === pid) {
        await loadParentalStateFor(pid);
        setProfileRevision((r) => r + 1);
        onChangeRef.current?.({
          activeProfileId: pid,
          parentalUnlocked: parentalUnlockedRef.current,
          reason: 'parental-change',
        });
      }
      return res;
    },
    [catalog, loadParentalStateFor],
  );

  const setParentalPinAction = useCallback(
    async (pin: string, currentPin?: string, targetProfileId?: string): Promise<Result<void>> => {
      if (!catalog.setParentalPin) return err(elvError('storage', 'unsupported'));
      const pid = targetProfileId ?? activeProfileIdRef.current;
      const isCreate = currentPin === undefined;
      const res = await catalog.setParentalPin(pin, pid, currentPin);
      if (res.ok && mountedRef.current) {
        await loadParentalStateFor(activeProfileIdRef.current);
        if (
          mountedRef.current &&
          isCreate &&
          (pid === activeProfileIdRef.current || pid === guardPinProfileIdRef.current)
        ) {
          startParentalUnlockSession();
        }
      }
      return res;
    },
    [catalog, loadParentalStateFor, startParentalUnlockSession],
  );

  const hasProfilePinAction = useCallback(
    async (profileId: string): Promise<boolean> => {
      if (!catalog.hasParentalPin) return false;
      return catalog.hasParentalPin(profileId).catch(() => false);
    },
    [catalog],
  );

  const clearParentalPinAction = useCallback(
    async (currentPin: string, targetProfileId?: string): Promise<Result<void>> => {
      if (!catalog.clearParentalPin) return err(elvError('storage', 'unsupported'));
      const pid = targetProfileId ?? activeProfileIdRef.current;
      const res = await catalog.clearParentalPin(currentPin, pid);
      if (res.ok && mountedRef.current) {
        await loadParentalStateFor(activeProfileIdRef.current);
        if (activeProfileIdRef.current === pid) {
          lockParentalNow();
        }
      }
      return res;
    },
    [catalog, loadParentalStateFor, lockParentalNow],
  );

  const refreshParental = useCallback(async (): Promise<void> => {
    await loadParentalStateFor(activeProfileIdRef.current);
  }, [loadParentalStateFor]);

  const openPinDialog = useCallback((request: PinDialogRequest) => {
    setPinDialog(request);
  }, []);

  const closePinDialog = useCallback((cancelled = true) => {
    setPinDialog((prev) => {
      if (cancelled) prev?.onCancel?.();
      return null;
    });
  }, []);

  const requestParentalUnlock = useCallback(
    (onSuccess: () => void, options?: { readonly title?: string }) => {
      if (parentalUnlockedRef.current) {
        onSuccess();
        return;
      }
      setPinDialog({
        mode: 'verify',
        ...(options?.title !== undefined ? { title: options.title } : {}),
        profileId: guardPinProfileIdRef.current ?? activeProfileIdRef.current,
        onSuccess,
      });
    },
    [],
  );

  const openProfilePicker = useCallback(() => setProfilePickerOpen(true), []);
  const closeProfilePicker = useCallback(() => setProfilePickerOpen(false), []);

  const activeProfile = useMemo(
    () => profiles.find((p) => p.id === activeProfileId) ?? profiles[0] ?? DEFAULT_PROFILE_RECORD,
    [activeProfileId, profiles],
  );

  const hasGuardPin = guardPinProfileId !== null;

  const value = useMemo<ProfileContextValue>(
    () => ({
      profiles,
      activeProfile,
      activeProfileId,
      profilesReady,
      profileRevision,
      parentalSettings,
      parentalLocks,
      hasParentalPin,
      hasGuardPin,
      guardPinProfileId,
      parentalUnlocked,
      parentalUnlockExpiresAt,
      pinDialog,
      profilePickerOpen,
      switchProfile,
      createProfile: createProfileAction,
      updateProfile: updateProfileAction,
      deleteProfile: deleteProfileAction,
      verifyParentalPin,
      unlockParental,
      lockParentalNow,
      updateParentalSettings: updateParentalSettingsAction,
      setParentalLock: setParentalLockAction,
      setParentalPin: setParentalPinAction,
      clearParentalPin: clearParentalPinAction,
      hasProfilePin: hasProfilePinAction,
      refreshParental,
      refreshProfiles,
      requestParentalUnlock,
      openPinDialog,
      closePinDialog,
      openProfilePicker,
      closeProfilePicker,
    }),
    [
      profiles,
      activeProfile,
      activeProfileId,
      profilesReady,
      profileRevision,
      parentalSettings,
      parentalLocks,
      hasParentalPin,
      hasGuardPin,
      guardPinProfileId,
      parentalUnlocked,
      parentalUnlockExpiresAt,
      pinDialog,
      profilePickerOpen,
      switchProfile,
      createProfileAction,
      updateProfileAction,
      deleteProfileAction,
      verifyParentalPin,
      unlockParental,
      lockParentalNow,
      updateParentalSettingsAction,
      setParentalLockAction,
      setParentalPinAction,
      clearParentalPinAction,
      hasProfilePinAction,
      refreshParental,
      refreshProfiles,
      requestParentalUnlock,
      openPinDialog,
      closePinDialog,
      openProfilePicker,
      closeProfilePicker,
    ],
  );

  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>;
}

/** Reads and mutates local viewer profile state provided by {@link ProfileProvider}. */
export function useProfile(): ProfileContextValue {
  return useContext(ProfileContext);
}

/** Reads and mutates parental-control and PIN unlock state provided by {@link ProfileProvider}. */
export function useParental(): ProfileContextValue {
  return useContext(ProfileContext);
}
