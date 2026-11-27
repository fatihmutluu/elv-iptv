import { PROFILE_AVATAR_TOKENS, type ProfileAvatarToken, type ProfileRecord } from '@elv/data';

/** Warm English cinema-themed default profile names assigned quietly on first-run onboarding (`#513`). */
export const ONBOARDING_PROFILE_NAMES_EN = [
  'Cinema Fan',
  'Starlight',
  'Night Owl',
  'Silver Screen',
  'Premiere',
  'Velvet Seat',
] as const;

/** Warm Turkish cinema-themed default profile names assigned quietly on first-run onboarding (`#513`). */
export const ONBOARDING_PROFILE_NAMES_TR = [
  'Sinefil',
  'Gece Kuşu',
  'Galaksili',
  'Perde Önü',
  'İlk Gösterim',
  'Kadife Koltuk',
] as const;

/** Options for {@link pickRandomOnboardingProfile}. */
export interface PickRandomOnboardingProfileOptions {
  /** Active BCP-47 locale tag (e.g. `'tr'`, `'tr-TR'`, `'en-US'`). */
  readonly locale?: string;
  /** Optional deterministic RNG returning a float in `[0, 1)`. Defaults to `Math.random`. */
  readonly random?: () => number;
}

/** Randomized friendly profile name + built-in avatar token pair. */
export interface OnboardingRandomProfile {
  readonly name: string;
  readonly avatarToken: ProfileAvatarToken;
}

function pickIndex(length: number, random: () => number): number {
  const raw = random();
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  if (raw >= 1) return length - 1;
  return Math.min(length - 1, Math.floor(raw * length));
}

function isTurkishLocale(locale: string | undefined): boolean {
  if (locale === undefined) return false;
  const normalized = locale.trim().toLowerCase();
  return normalized === 'tr' || normalized.startsWith('tr-') || normalized.startsWith('tr_');
}

/**
 * Picks a warm, localized cinema-themed profile name together with 1 of the 9 built-in
 * {@link PROFILE_AVATAR_TOKENS} for first-run default-profile personalization (`#513`).
 */
export function pickRandomOnboardingProfile(
  opts?: PickRandomOnboardingProfileOptions,
): OnboardingRandomProfile {
  const random = opts?.random ?? Math.random;
  const namePool = isTurkishLocale(opts?.locale)
    ? ONBOARDING_PROFILE_NAMES_TR
    : ONBOARDING_PROFILE_NAMES_EN;
  const name = namePool[pickIndex(namePool.length, random)] ?? namePool[0];
  const avatarToken =
    PROFILE_AVATAR_TOKENS[pickIndex(PROFILE_AVATAR_TOKENS.length, random)] ??
    PROFILE_AVATAR_TOKENS[0];
  return { name, avatarToken };
}

/**
 * Returns `true` strictly when `profile` is still the untouched SQLite-seeded `'Default'` profile
 * (`id === 'default'` or `isDefault`, `name === 'Default'`, and `createdAt === updatedAt`),
 * guaranteeing onboarding never overwrites a user-renamed or previously edited profile (`#513`).
 */
export function isUntouchedDefaultProfile(
  profile: Pick<ProfileRecord, 'id' | 'name' | 'isDefault' | 'createdAt' | 'updatedAt'>,
): boolean {
  const isDefaultSlot = profile.id === 'default' || profile.isDefault;
  return isDefaultSlot && profile.name === 'Default' && profile.createdAt === profile.updatedAt;
}
