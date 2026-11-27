import {
  type AddSourceInput,
  type ImportProgress,
  type LinkSourceInput,
  parseXtreamLink,
} from '@elv/data';
import {
  err,
  type HomeLayoutSectionId,
  type HomeLayoutSectionPref,
  normalizeHomeLayout,
  normalizeMacAddress,
  ok,
  type Result,
} from '@elv/domain';
import type { MessageId } from '@elv/i18n';
import type { FormFactor } from '@elv/ui-kit';

/** Active step inside Wave E3 Smart Onboarding (`#513`). */
export type OnboardingStep =
  | 'welcome'
  | 'syncing'
  | 'source'
  | 'elvMode'
  | 'personalize'
  | 'waiting';

/** Sequential card index inside the Personalization step (`0..3`). */
export type PersonalizeCardIndex = 0 | 1 | 2 | 3;

/** Read-only snapshot of the shell-lifted background import state. */
export interface OnboardingImportSnapshot {
  readonly status: 'idle' | 'importing' | 'ready' | 'error';
  readonly sourceId: string | null;
  readonly progress: ImportProgress | null;
  readonly errorMessageId: MessageId | null;
}

/** Controlled Screen 2 source form state preserved across Edit Source jumps. */
export interface OnboardingSourceDraft {
  readonly mode: 'm3u' | 'xtream' | 'stalker';
  readonly name: string;
  readonly playlistUrl: string;
  readonly server: string;
  readonly username: string;
  readonly password: string;
  readonly portalUrl: string;
  readonly macAddress: string;
  readonly serialNumber: string;
}

/** Validated source payload ready to submit to `CatalogService`. */
export type ValidatedOnboardingSource =
  | { readonly kind: 'link'; readonly input: LinkSourceInput }
  | { readonly kind: 'xtream'; readonly input: AddSourceInput & { kind: 'xtream' } }
  | { readonly kind: 'stalker'; readonly input: AddSourceInput & { kind: 'stalker' } };

/** Localized validation failure for Screen 2 source input. */
export interface OnboardingSourceValidationError {
  readonly messageId: MessageId;
  readonly hintId: MessageId;
}

/** One-shot startup gate decision evaluated after `preferences`, `profiles`, and `sources` resolve. */
export type StartupGateDecision = 'onboarding' | 'auto_migrate' | 'returning';

const MIN_ONBOARDING_PASSWORD_LENGTH = 6;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const OTHER_URI_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:(?!\d+(?:[/?#]|$))/;

/** Ordered cinema & evening motivation quote keys (`onboarding.quote.1..6`). */
export const ONBOARDING_QUOTE_KEYS: readonly MessageId[] = [
  'onboarding.quote.1',
  'onboarding.quote.2',
  'onboarding.quote.3',
  'onboarding.quote.4',
  'onboarding.quote.5',
  'onboarding.quote.6',
] as const;

/** Maps each customizable Home screen section id to its i18n label key. */
export const ONBOARDING_HOME_SECTION_LABELS: Readonly<Record<HomeLayoutSectionId, MessageId>> = {
  continue: 'settings.homeSectionContinue',
  newEpisodes: 'settings.homeSectionNewEpisodes',
  live: 'settings.homeSectionLive',
  movies: 'settings.homeSectionMovies',
  series: 'settings.homeSectionSeries',
  mylist: 'settings.homeSectionMyList',
  collections: 'settings.homeSectionCollections',
};

/** Decides once at cold startup whether to launch onboarding, silently migrate, or enter returning mode. */
export function resolveStartupGateDecision(params: {
  readonly onboardingCompleted: boolean;
  readonly welcomeDismissed: boolean;
  readonly sourcesCount: number;
  readonly profilesCount?: number;
}): StartupGateDecision {
  if (params.onboardingCompleted) return 'returning';
  if (params.welcomeDismissed || params.sourcesCount > 0 || (params.profilesCount ?? 1) >= 2) {
    return 'auto_migrate';
  }
  return 'onboarding';
}

/** Validates an email address on Screen 1. Returns a localized error key or `null`. */
export function validateOnboardingEmail(email: string): MessageId | null {
  return EMAIL_RE.test(email.trim()) ? null : 'account.errorInvalidEmail';
}

/** Validates email + non-empty password for Screen 1 Sign In. */
export function validateOnboardingSignIn(email: string, password: string): MessageId | null {
  const emailErr = validateOnboardingEmail(email);
  if (emailErr !== null) return emailErr;
  if (password.length === 0) return 'account.errorWeakPassword';
  return null;
}

/** Validates email + password (>= 6 chars) + matching confirm password for Screen 1 Registration. */
export function validateOnboardingSignUp(
  email: string,
  password: string,
  confirmPassword: string,
): MessageId | null {
  const emailErr = validateOnboardingEmail(email);
  if (emailErr !== null) return emailErr;
  if (password.length < MIN_ONBOARDING_PASSWORD_LENGTH) return 'account.errorWeakPassword';
  if (password !== confirmPassword) return 'account.errorPasswordMismatch';
  return null;
}

/** Maps a sync port auth error code to a localized message key. */
export function mapOnboardingAuthError(errorCode: string | null | undefined): MessageId {
  if (!errorCode) return 'account.errorGeneric';
  const normalized = errorCode.trim().toLowerCase();
  if (normalized === 'invalid_email' || normalized === 'invalid-email') {
    return 'account.errorInvalidEmail';
  }
  if (normalized === 'weak_password' || normalized === 'weak-password') {
    return 'account.errorWeakPassword';
  }
  if (normalized === 'password_mismatch' || normalized === 'password-mismatch') {
    return 'account.errorPasswordMismatch';
  }
  return 'account.errorGeneric';
}

/** Creates an empty M3U-first source form draft for Onboarding Screen 2. */
export function createInitialOnboardingSourceDraft(): OnboardingSourceDraft {
  return {
    mode: 'm3u',
    name: '',
    playlistUrl: '',
    server: '',
    username: '',
    password: '',
    portalUrl: '',
    macAddress: '',
    serialNumber: '',
  };
}

function hasControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function validateHttpUrl(trimmed: string): Result<URL, OnboardingSourceValidationError> {
  if (!trimmed.includes('://')) {
    if (OTHER_URI_SCHEME.test(trimmed)) {
      return err({
        messageId: 'source.validation.unsupportedScheme',
        hintId: 'source.hint.unsupportedScheme',
      });
    }
    return err({
      messageId: 'source.validation.missingScheme',
      hintId: 'source.hint.missingScheme',
    });
  }
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.+)$/s.exec(trimmed);
  if (match === null) {
    return err({
      messageId: 'source.validation.invalidAddress',
      hintId: 'source.hint.invalidAddress',
    });
  }
  const scheme = (match[1] ?? '').toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') {
    return err({
      messageId: 'source.validation.unsupportedScheme',
      hintId: 'source.hint.unsupportedScheme',
    });
  }
  try {
    const parsed = new URL(trimmed);
    if (!parsed.hostname) {
      return err({
        messageId: 'source.validation.invalidAddress',
        hintId: 'source.hint.invalidAddress',
      });
    }
    return ok(parsed);
  } catch {
    return err({
      messageId: 'source.validation.invalidAddress',
      hintId: 'source.hint.invalidAddress',
    });
  }
}

function normalizeServerBase(serverUrl: string): string {
  return serverUrl
    .replace(/[?#].*$/s, '')
    .replace(/\/+$/, '')
    .replace(/\/(?:player_api|get|xmltv)\.php$/i, '')
    .replace(/\/+$/, '');
}

/** Validates Screen 2 M3U, Xtream Codes, or Stalker input before submitting to `CatalogService`. */
export function validateOnboardingSourceDraft(
  draft: OnboardingSourceDraft,
): Result<ValidatedOnboardingSource, OnboardingSourceValidationError> {
  const fields = [
    draft.name,
    draft.playlistUrl,
    draft.server,
    draft.username,
    draft.password,
    draft.portalUrl,
    draft.macAddress,
    draft.serialNumber,
  ];
  if (fields.some(hasControlChars)) {
    return err({
      messageId: 'source.validation.invalidCharacters',
      hintId: 'source.hint.invalidCharacters',
    });
  }

  if (draft.mode === 'xtream') {
    const serverRaw = draft.server.trim();
    if (serverRaw === '') {
      return err({
        messageId: 'source.validation.missingServer',
        hintId: 'source.hint.missingServer',
      });
    }
    const parsed = validateHttpUrl(serverRaw);
    if (!parsed.ok) return parsed;
    const pasted = parseXtreamLink(serverRaw);
    if (pasted !== undefined) {
      const username = draft.username.trim() || pasted.username;
      const password = draft.password.trim() || pasted.password;
      const name = draft.name.trim() || new URL(pasted.server).host;
      return ok({
        kind: 'xtream',
        input: { kind: 'xtream', name, server: pasted.server, username, password },
      });
    }
    if (/\.m3u8?$/i.test(parsed.value.pathname)) {
      return err({
        messageId: 'source.validation.m3uInXtream',
        hintId: 'source.hint.m3uInXtream',
      });
    }
    const username = draft.username.trim();
    const password = draft.password.trim();
    if (username === '' || password === '') {
      return err({
        messageId: 'source.validation.missingCredentials',
        hintId: 'source.hint.missingCredentials',
      });
    }
    const normalized = normalizeServerBase(serverRaw);
    const name = draft.name.trim() || new URL(normalized).host;
    return ok({
      kind: 'xtream',
      input: { kind: 'xtream', name, server: normalized, username, password },
    });
  }

  if (draft.mode === 'stalker') {
    const portalRaw = draft.portalUrl.trim();
    if (portalRaw === '') {
      return err({
        messageId: 'source.validation.missingServer',
        hintId: 'source.hint.missingServer',
      });
    }
    let candidate = portalRaw;
    if (!portalRaw.includes('://')) {
      if (OTHER_URI_SCHEME.test(portalRaw)) {
        return err({
          messageId: 'source.validation.unsupportedScheme',
          hintId: 'source.hint.unsupportedScheme',
        });
      }
      candidate = `http://${portalRaw}`;
    }
    const parsed = validateHttpUrl(candidate);
    if (!parsed.ok) return parsed;
    const macRes = normalizeMacAddress(draft.macAddress);
    if (!macRes.ok) {
      return err({
        messageId: 'sources.stalker.invalidMac',
        hintId: 'sources.stalker.invalidMacHint',
      });
    }
    const serialNumber = draft.serialNumber.trim();
    const name = draft.name.trim() || parsed.value.host;
    return ok({
      kind: 'stalker',
      input: {
        kind: 'stalker',
        name,
        portalUrl: candidate,
        mac: macRes.value,
        ...(serialNumber !== '' ? { serialNumber } : {}),
      },
    });
  }

  const urlRaw = draft.playlistUrl.trim();
  if (urlRaw === '') {
    return err({
      messageId: 'source.validation.missingUrl',
      hintId: 'source.hint.missingUrl',
    });
  }
  const parsed = validateHttpUrl(urlRaw);
  if (!parsed.ok) return parsed;
  const name = draft.name.trim() || parsed.value.host;
  return ok({
    kind: 'link',
    input: { name, url: urlRaw },
  });
}

/** Maps `ImportProgress.phase` to its localized `@elv/i18n` message key. */
export function onboardingPhaseMessageId(phase: ImportProgress['phase']): MessageId {
  switch (phase) {
    case 'categories':
      return 'sources.phase.categories';
    case 'live':
      return 'sources.phase.live';
    case 'movies':
      return 'sources.phase.movies';
    case 'series':
      return 'sources.phase.series';
    case 'episodes':
      return 'sources.phase.episodes';
    case 'guide-channels':
      return 'sources.phase.guideChannels';
    case 'programmes':
      return 'sources.phase.programmes';
    case 'cleanup':
      return 'sources.phase.cleanup';
  }
}

/** Computes a clamped integer percentage `[0, 100]` when `progress.total > 0`, otherwise `null`. */
export function computeImportPercent(progress: ImportProgress | null): number | null {
  if (progress === null || progress.total === undefined || progress.total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((progress.done / progress.total) * 100)));
}

/** Advances the rotating cinema quote index with wrap-around. */
export function nextQuoteIndex(current: number): number {
  return (current + 1) % ONBOARDING_QUOTE_KEYS.length;
}

/** Moves a Home layout section up or down by one slot. */
export function moveOnboardingLayoutSection(
  layout: readonly HomeLayoutSectionPref[],
  index: number,
  direction: 'up' | 'down',
): readonly HomeLayoutSectionPref[] {
  const normalized = normalizeHomeLayout(layout);
  const target = direction === 'up' ? index - 1 : index + 1;
  if (index < 0 || index >= normalized.length || target < 0 || target >= normalized.length) {
    return normalized;
  }
  const next = [...normalized];
  const [moved] = next.splice(index, 1);
  if (moved === undefined) return normalized;
  next.splice(target, 0, moved);
  return normalizeHomeLayout(next);
}

/** Toggles visibility of a Home layout section. */
export function toggleOnboardingLayoutSection(
  layout: readonly HomeLayoutSectionPref[],
  id: HomeLayoutSectionId,
): readonly HomeLayoutSectionPref[] {
  const normalized = normalizeHomeLayout(layout);
  return normalizeHomeLayout(
    normalized.map((entry) => (entry.id === id ? { ...entry, visible: !entry.visible } : entry)),
  );
}

/** Resolves the 2 platform-specific Quick Tips message keys for the active form factor. */
export function resolveTipsMessageKeys(formFactor: FormFactor): readonly [MessageId, MessageId] {
  if (formFactor === 'desktop') {
    return ['onboarding.personalize.tipDesktop1', 'onboarding.personalize.tipDesktop2'];
  }
  if (formFactor === 'tv') {
    return ['onboarding.personalize.tipTv1', 'onboarding.personalize.tipTv2'];
  }
  return ['onboarding.personalize.tipMobile1', 'onboarding.personalize.tipMobile2'];
}
