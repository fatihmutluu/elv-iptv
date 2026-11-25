import { describe, expect, it } from 'vitest';
import {
  mapSyncErrorCodeToMessageId,
  validateSignInFields,
  validateSignUpFields,
} from './account-helpers';

describe('account-helpers (#26)', () => {
  it('maps pairing expiry, server origin mismatch, and validation error codes cleanly', () => {
    expect(mapSyncErrorCodeToMessageId('pairing-expired')).toBe('account.qrExpired');
    expect(mapSyncErrorCodeToMessageId('pair_expired')).toBe('account.qrExpired');
    expect(mapSyncErrorCodeToMessageId('pair-expired')).toBe('account.qrExpired');
    expect(mapSyncErrorCodeToMessageId('pairing_expired')).toBe('account.qrExpired');
    expect(mapSyncErrorCodeToMessageId('expired')).toBe('account.qrExpired');
    expect(mapSyncErrorCodeToMessageId('PAIRING-EXPIRED')).toBe('account.qrExpired');

    expect(mapSyncErrorCodeToMessageId('server_origin_mismatch')).toBe(
      'source.validation.invalidAddress',
    );
    expect(mapSyncErrorCodeToMessageId('server-origin-mismatch')).toBe(
      'source.validation.invalidAddress',
    );
    expect(mapSyncErrorCodeToMessageId('server_not_configured')).toBe(
      'source.validation.invalidAddress',
    );

    expect(mapSyncErrorCodeToMessageId('invalid_email')).toBe('account.errorInvalidEmail');
    expect(mapSyncErrorCodeToMessageId('invalid-email')).toBe('account.errorInvalidEmail');
    expect(mapSyncErrorCodeToMessageId('weak_password')).toBe('account.errorWeakPassword');
    expect(mapSyncErrorCodeToMessageId('weak-password')).toBe('account.errorWeakPassword');
    expect(mapSyncErrorCodeToMessageId('password_mismatch')).toBe('account.errorPasswordMismatch');
    expect(mapSyncErrorCodeToMessageId('password-mismatch')).toBe('account.errorPasswordMismatch');

    expect(mapSyncErrorCodeToMessageId(null)).toBe('account.errorGeneric');
    expect(mapSyncErrorCodeToMessageId(undefined)).toBe('account.errorGeneric');
    expect(mapSyncErrorCodeToMessageId('')).toBe('account.errorGeneric');
    expect(mapSyncErrorCodeToMessageId('unexpected_code')).toBe('account.errorGeneric');
  });

  it('validates sign-in and sign-up fields', () => {
    expect(validateSignInFields('bad-email', 'secret')).toBe('account.errorInvalidEmail');
    expect(validateSignInFields('alice@example.com', '')).toBe('account.errorWeakPassword');
    expect(validateSignInFields('alice@example.com', 'secret')).toBeNull();

    expect(validateSignUpFields('bad-email', 'longpassword123', 'longpassword123')).toBe(
      'account.errorInvalidEmail',
    );
    expect(validateSignUpFields('alice@example.com', 'short9', 'short9')).toBe(
      'account.errorWeakPassword',
    );
    expect(validateSignUpFields('alice@example.com', 'longpassword123', 'mismatch1234')).toBe(
      'account.errorPasswordMismatch',
    );
    expect(
      validateSignUpFields('alice@example.com', 'longpassword123', 'longpassword123'),
    ).toBeNull();
  });
});
