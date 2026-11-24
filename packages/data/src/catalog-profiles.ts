import { elvError, err, ok, type Result, type SecretStore, type SqlDriver } from '@elv/domain';
import {
  createPinAttemptLimiter,
  hashParentalPin,
  isValidParentalPin,
  MAX_PIN_ATTEMPTS,
  type ParentalLockFilter,
  type ParentalLockRecord,
  type ParentalSettings,
  type PinVerifyResult,
  pinSecretKey,
  type SetParentalLockInput,
  type UpdateParentalSettingsPatch,
  verifyParentalPinHash,
} from './parental-policy';
import {
  getParentalSettings,
  listParentalLocks,
  setParentalLock,
  updateParentalSettings,
} from './parental-repo';
import {
  type CreateProfileInput,
  createProfile,
  deleteProfile,
  listProfiles,
  type ProfileRecord,
  type UpdateProfilePatch,
  updateProfile,
} from './profiles-repo';
import { normalizeProfileId } from './user-state-helpers';

/** Profile and parental-control subset of `CatalogService` (`#15`, `#31`). */
export interface CatalogProfileMethods {
  listProfiles(): Promise<ProfileRecord[]>;
  createProfile(input: CreateProfileInput): Promise<Result<ProfileRecord>>;
  updateProfile(id: string, patch: UpdateProfilePatch): Promise<Result<ProfileRecord>>;
  deleteProfile(id: string): Promise<Result<void>>;
  getParentalSettings(profileId?: string): Promise<ParentalSettings>;
  updateParentalSettings(
    patch: UpdateParentalSettingsPatch,
    profileId?: string,
  ): Promise<Result<ParentalSettings>>;
  listParentalLocks(profileId?: string, filter?: ParentalLockFilter): Promise<ParentalLockRecord[]>;
  setParentalLock(input: SetParentalLockInput, locked: boolean): Promise<Result<void>>;
  hasParentalPin(profileId?: string): Promise<boolean>;
  setParentalPin(pin: string, profileId?: string, currentPin?: string): Promise<Result<void>>;
  verifyParentalPin(pin: string, profileId?: string): Promise<PinVerifyResult>;
  clearParentalPin(currentPin: string, profileId?: string): Promise<Result<void>>;
}

/** @internal Creates profile management and SecretStore-backed parental PIN methods for `CatalogService`. */
export function createCatalogProfileMethods(deps: {
  db: SqlDriver;
  secrets: SecretStore;
  clock: () => number;
  syncUserData: () => Promise<void> | undefined;
}): CatalogProfileMethods {
  const { db, secrets, clock, syncUserData } = deps;
  const pinLimiter = createPinAttemptLimiter();

  const verifyPinInternal = async (pin: string, profileId?: string): Promise<PinVerifyResult> => {
    const normalized = normalizeProfileId(profileId);
    const now = clock();
    const locked = pinLimiter.checkLocked(normalized, now);
    if (locked !== null) return locked;

    const stored = await secrets.get(pinSecretKey(normalized));
    if (stored === undefined || stored === '') {
      return { ok: false, remainingAttempts: MAX_PIN_ATTEMPTS };
    }
    if (verifyParentalPinHash(pin, stored)) {
      return pinLimiter.recordSuccess(normalized);
    }
    return pinLimiter.recordFailure(normalized, now);
  };

  return {
    listProfiles: () => listProfiles(db),

    async createProfile(input) {
      const created = await createProfile(db, input, clock);
      if (created.ok) await syncUserData();
      return created;
    },

    async updateProfile(id, patch) {
      const updated = await updateProfile(db, id, patch, clock);
      if (updated.ok) await syncUserData();
      return updated;
    },

    async deleteProfile(id) {
      const deleted = await deleteProfile(db, secrets, id);
      if (deleted.ok) {
        pinLimiter.clear(id);
        await syncUserData();
      }
      return deleted;
    },

    getParentalSettings: (profileId) => getParentalSettings(db, profileId),

    updateParentalSettings: (patch, profileId) =>
      updateParentalSettings(db, profileId, patch, clock),

    listParentalLocks: (profileId, filter) => listParentalLocks(db, profileId, filter),

    setParentalLock: (input, locked) => setParentalLock(db, input, locked, clock),

    async hasParentalPin(profileId) {
      const stored = await secrets.get(pinSecretKey(profileId));
      return typeof stored === 'string' && stored.trim() !== '';
    },

    async setParentalPin(pin, profileId, currentPin) {
      if (!isValidParentalPin(pin)) {
        return err(elvError('source-format', 'invalid-pin'));
      }
      const normalized = normalizeProfileId(profileId);
      const existing = await secrets.get(pinSecretKey(normalized));
      if (typeof existing === 'string' && existing.trim() !== '') {
        const verified = await verifyPinInternal(currentPin ?? '', normalized);
        if (!verified.ok) {
          return err(
            elvError('auth', verified.lockedUntilMs !== undefined ? 'pin-locked' : 'invalid-pin'),
          );
        }
      }
      const hashed = hashParentalPin(pin);
      try {
        await secrets.set(pinSecretKey(normalized), hashed);
      } catch {
        return err(elvError('storage', 'secret-store-failed'));
      }
      pinLimiter.clear(normalized);
      return ok(undefined);
    },

    verifyParentalPin: (pin, profileId) => verifyPinInternal(pin, profileId),

    async clearParentalPin(currentPin, profileId) {
      const normalized = normalizeProfileId(profileId);
      const existing = await secrets.get(pinSecretKey(normalized));
      if (existing === undefined || existing.trim() === '') {
        pinLimiter.clear(normalized);
        return ok(undefined);
      }
      const verified = await verifyPinInternal(currentPin, normalized);
      if (!verified.ok) {
        return err(
          elvError('auth', verified.lockedUntilMs !== undefined ? 'pin-locked' : 'invalid-pin'),
        );
      }
      try {
        await secrets.delete(pinSecretKey(normalized));
      } catch {
        return err(elvError('storage', 'secret-delete-failed'));
      }
      pinLimiter.clear(normalized);
      return ok(undefined);
    },
  };
}
