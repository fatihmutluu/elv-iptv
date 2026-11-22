import { describe, expect, it } from 'vitest';
import { formatSqliteOpenError } from './sqlite-open-retry.ts';

describe('formatSqliteOpenError', () => {
  it('preserves SQLite error codes for retry classification', () => {
    const busy = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    expect(formatSqliteOpenError(busy)).toBe('SQLITE_BUSY: database is locked');
    expect(formatSqliteOpenError(new Error('SQLITE_LOCKED: database table is locked'))).toBe(
      'SQLITE_LOCKED: database table is locked',
    );
    expect(formatSqliteOpenError('non-error')).toBe('open failed');
  });

  it('redacts Windows and POSIX local filesystem paths from error details', () => {
    const winErr = Object.assign(
      new Error(
        'unable to open database file: C:\\Users\\alice\\AppData\\Roaming\\elv\\catalog.db',
      ),
      { code: 'SQLITE_CANTOPEN' },
    );
    const formattedWin = formatSqliteOpenError(winErr);
    expect(formattedWin).toContain('SQLITE_CANTOPEN');
    expect(formattedWin).not.toContain('alice');
    expect(formattedWin).not.toContain('C:\\Users');
    expect(formattedWin).toContain('<path>');

    const macErr = new Error(
      "SQLITE_CANTOPEN: unable to open '/Users/alice/Library/Application Support/elv/catalog.db'",
    );
    const formattedMac = formatSqliteOpenError(macErr);
    expect(formattedMac).not.toContain('alice');
    expect(formattedMac).not.toContain('/Users/');
    expect(formattedMac).toContain('<path>');

    const linuxErr = new Error(
      'SQLITE_READONLY: failed on /home/bob/.config/elv/catalog.db and /var/tmp/catalog.db-wal',
    );
    const formattedLinux = formatSqliteOpenError(linuxErr);
    expect(formattedLinux).not.toContain('bob');
    expect(formattedLinux).not.toContain('/home/');
    expect(formattedLinux).not.toContain('/var/tmp/');
  });

  it('redacts file:// and http(s):// URLs embedded in error messages', () => {
    const fileUrlErr = new Error(
      'SQLITE_CANTOPEN: cannot open file:///Users/alice/catalog.db?mode=rwc',
    );
    const formattedFile = formatSqliteOpenError(fileUrlErr);
    expect(formattedFile).toContain('file://<redacted>');
    expect(formattedFile).not.toContain('alice');

    const httpUrlErr = new Error(
      'SQLITE_ERROR: near https://demo:pass@sim.test/live/demo/pass/1.ts?token=secret',
    );
    const formattedHttp = formatSqliteOpenError(httpUrlErr);
    expect(formattedHttp).not.toContain('demo');
    expect(formattedHttp).not.toContain('pass');
    expect(formattedHttp).not.toContain('secret');
    expect(formattedHttp).toContain('https://sim.test/***/***/***/***.ts');
  });

  it('redacts single-slash file:/ URLs, colon-prefixed POSIX paths, and unquoted Windows paths with spaces', () => {
    const singleSlashFile = formatSqliteOpenError(
      new Error('SQLITE_CANTOPEN: cannot open file:/Users/alice/catalog.db'),
    );
    expect(singleSlashFile).toContain('file://<redacted>');
    expect(singleSlashFile).not.toContain('alice');

    const colonPosix = formatSqliteOpenError(new Error('SQLITE_CANTOPEN:/Users/alice/catalog.db'));
    expect(colonPosix).toBe('SQLITE_CANTOPEN:<path>');
    expect(colonPosix).not.toContain('alice');

    const spacedWin = formatSqliteOpenError(
      new Error(
        'SQLITE_CANTOPEN: unable to open C:\\Users\\Alice Smith\\AppData\\Local\\elv\\catalog.db',
      ),
    );
    expect(spacedWin).toBe('SQLITE_CANTOPEN: unable to open <path>');
    expect(spacedWin).not.toContain('Alice');
    expect(spacedWin).not.toContain('Smith');
    expect(spacedWin).not.toContain('catalog.db');

    const spacedPosix = formatSqliteOpenError(
      new Error(
        'SQLITE_CANTOPEN: unable to open /Users/Alice Smith/Library/Application Support/elv/catalog.db',
      ),
    );
    expect(spacedPosix).toBe('SQLITE_CANTOPEN: unable to open <path>');
    expect(spacedPosix).not.toContain('Alice');
    expect(spacedPosix).not.toContain('Smith');
  });
});
