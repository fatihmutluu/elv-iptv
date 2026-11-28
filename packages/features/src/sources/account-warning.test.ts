import { createAppI18n } from '@elv/i18n';
import { describe, expect, it } from 'vitest';
import {
  EXPIRING_SOON_WINDOW_MS,
  formatAccountExpiryDate,
  formatSourceAccountHealthCaption,
  resolveSourceAccountHealth,
  resolveSourceAccountWarning,
  type SourceAccountWarning,
} from './account-warning';

const DAY_MS = 86_400_000;
const NOW = 1_700_000_000_000;

describe('resolveSourceAccountWarning (#170)', () => {
  it('uses a 7-day expiring-soon window', () => {
    expect(EXPIRING_SOON_WINDOW_MS).toBe(7 * DAY_MS);
  });

  it('returns null when metadata is missing or healthy (> 7 days and not trial)', () => {
    expect(resolveSourceAccountWarning(undefined, NOW)).toBeNull();
    expect(resolveSourceAccountWarning({}, NOW)).toBeNull();
    expect(resolveSourceAccountWarning({ isTrial: false }, NOW)).toBeNull();
    expect(
      resolveSourceAccountWarning({ isTrial: false, expiresAt: NOW + 7 * DAY_MS + 1 }, NOW),
    ).toBeNull();
    expect(
      resolveSourceAccountWarning({ isTrial: false, expiresAt: NOW + 30 * DAY_MS }, NOW),
    ).toBeNull();
  });

  it('returns expired when expiresAt is at or before nowMs (takes precedence over trial)', () => {
    const atBoundary: SourceAccountWarning | null = resolveSourceAccountWarning(
      { isTrial: true, expiresAt: NOW },
      NOW,
    );
    expect(atBoundary).toEqual({ kind: 'expired' });
    expect(resolveSourceAccountWarning({ expiresAt: NOW - 1 }, NOW)).toEqual({ kind: 'expired' });
    expect(
      resolveSourceAccountWarning({ isTrial: false, expiresAt: NOW - 5 * DAY_MS }, NOW),
    ).toEqual({ kind: 'expired' });
  });

  it('returns expiring-soon with ceiled days (>= 1) within the 7-day window and takes precedence over trial', () => {
    expect(resolveSourceAccountWarning({ expiresAt: NOW + 1 }, NOW)).toEqual({
      kind: 'expiring-soon',
      days: 1,
    });
    expect(resolveSourceAccountWarning({ expiresAt: NOW + 12 * 3_600_000 }, NOW)).toEqual({
      kind: 'expiring-soon',
      days: 1,
    });
    expect(resolveSourceAccountWarning({ expiresAt: NOW + 3 * DAY_MS }, NOW)).toEqual({
      kind: 'expiring-soon',
      days: 3,
    });
    expect(resolveSourceAccountWarning({ expiresAt: NOW + 2 * DAY_MS + 1 }, NOW)).toEqual({
      kind: 'expiring-soon',
      days: 3,
    });
    expect(
      resolveSourceAccountWarning({ isTrial: true, expiresAt: NOW + 7 * DAY_MS }, NOW),
    ).toEqual({
      kind: 'expiring-soon',
      days: 7,
    });
  });

  it('returns trial when isTrial is true and expiry is absent, non-finite, or beyond 7 days', () => {
    expect(resolveSourceAccountWarning({ isTrial: true }, NOW)).toEqual({ kind: 'trial' });
    expect(
      resolveSourceAccountWarning({ isTrial: true, expiresAt: NOW + 14 * DAY_MS }, NOW),
    ).toEqual({ kind: 'trial' });
    expect(resolveSourceAccountWarning({ isTrial: true, expiresAt: Number.NaN }, NOW)).toEqual({
      kind: 'trial',
    });
    expect(
      resolveSourceAccountWarning({ isTrial: true, expiresAt: Number.POSITIVE_INFINITY }, NOW),
    ).toEqual({ kind: 'trial' });
  });

  it('ignores non-finite expiresAt when not a trial', () => {
    expect(resolveSourceAccountWarning({ expiresAt: Number.NaN }, NOW)).toBeNull();
    expect(resolveSourceAccountWarning({ expiresAt: Number.POSITIVE_INFINITY }, NOW)).toBeNull();
    expect(resolveSourceAccountWarning({ expiresAt: Number.NEGATIVE_INFINITY }, NOW)).toBeNull();
  });

  it('skips expiry comparison when nowMs is non-finite or negative and falls through to trial or null', () => {
    const invalidNows = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1000];
    for (const badNow of invalidNows) {
      expect(resolveSourceAccountWarning({ isTrial: false, expiresAt: NOW }, badNow)).toBeNull();
      expect(resolveSourceAccountWarning({ isTrial: false, expiresAt: -2000 }, badNow)).toBeNull();
      expect(resolveSourceAccountWarning({ isTrial: true, expiresAt: NOW }, badNow)).toEqual({
        kind: 'trial',
      });
    }
  });
});

describe('resolveSourceAccountHealth & formatSourceAccountHealthCaption (Wave Q6)', () => {
  it('resolves healthy expiry beyond 7d window and connection quota cleanly', () => {
    const healthyExpiry = Date.UTC(2027, 0, 15, 0, 0, 0);
    expect(resolveSourceAccountHealth(undefined, NOW)).toBeNull();
    expect(resolveSourceAccountHealth({ isTrial: false }, NOW)).toBeNull();
    // Expired or <= 7d expiry is handled by SourceAccountWarningPill, not duplicated in health expiry
    expect(resolveSourceAccountHealth({ expiresAt: NOW + 3 * DAY_MS }, NOW)).toBeNull();
    expect(resolveSourceAccountHealth({ expiresAt: NOW - DAY_MS }, NOW)).toBeNull();
    // Connection quota still surfaces even when expiry is expiring-soon or unlimited
    expect(
      resolveSourceAccountHealth(
        { expiresAt: NOW + 3 * DAY_MS, maxConnections: 2, activeConnections: 1 },
        NOW,
      ),
    ).toEqual({ maxConnections: 2, activeConnections: 1 });
    expect(
      resolveSourceAccountHealth(
        { expiresAt: healthyExpiry, maxConnections: 3, activeConnections: 1 },
        NOW,
      ),
    ).toEqual({ healthyExpiresAt: healthyExpiry, maxConnections: 3, activeConnections: 1 });
  });

  it('formats localized EN and TR secondary captions using Intl.DateTimeFormat', () => {
    const healthyExpiry = Date.UTC(2027, 0, 15, 0, 0, 0);
    const en = createAppI18n('en');
    const tr = createAppI18n('tr');

    const enDate = formatAccountExpiryDate(healthyExpiry, 'en');
    const trDate = formatAccountExpiryDate(healthyExpiry, 'tr');
    expect(enDate).toContain('2027');
    expect(trDate).toContain('2027');

    expect(
      formatSourceAccountHealthCaption(
        { expiresAt: healthyExpiry, maxConnections: 3, activeConnections: 1 },
        NOW,
        en,
      ),
    ).toBe(`Expires ${enDate} · 1/3 connections`);

    expect(
      formatSourceAccountHealthCaption(
        { expiresAt: healthyExpiry, maxConnections: 3, activeConnections: 1 },
        NOW,
        tr,
      ),
    ).toBe(`Bitiş ${trDate} · 1/3 bağlantı`);

    expect(formatSourceAccountHealthCaption({ maxConnections: 2 }, NOW, en)).toBe('2 connections');
    expect(formatSourceAccountHealthCaption({ maxConnections: 1 }, NOW, tr)).toBe('1 bağlantı');
    expect(formatSourceAccountHealthCaption({}, NOW, en)).toBeNull();
  });
});
