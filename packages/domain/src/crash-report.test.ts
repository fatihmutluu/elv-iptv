import { describe, expect, it } from 'vitest';
import {
  buildCrashReportMarkdown,
  type CrashReportInput,
  createRingLogBuffer,
  MAX_CRASH_LOG_LINES,
} from './index';

describe('createRingLogBuffer (#226)', () => {
  it('caps lines at maxLines with FIFO eviction and redacts secrets and home paths on push', () => {
    expect(MAX_CRASH_LOG_LINES).toBe(250);
    const buf = createRingLogBuffer(3);
    expect(buf.size()).toBe(0);
    expect(buf.tail()).toEqual([]);

    buf.push('GET https://u:secret@provider.test/live/u/p/1.ts?token=abc', '2026-11-25T10:00:00Z');
    buf.push('Read C:\\Users\\Alice\\playlist.m3u\nAuthorization: Bearer tok123');
    buf.push('Opened /Users/bob/db.sqlite');
    buf.push('Android /data/user/0/com.elv.iptv/files/x.db');

    expect(buf.size()).toBe(3);
    const lines = buf.tail();
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('Read <redacted-path> Authorization: ***');
    expect(lines[1]).toBe('Opened <redacted-path>');
    expect(lines[2]).toBe('Android <redacted-path>');
    expect(lines.join('\n')).not.toContain('Alice');
    expect(lines.join('\n')).not.toContain('bob');
    expect(lines.join('\n')).not.toContain('tok123');

    expect(buf.tail(2)).toEqual([lines[1], lines[2]]);
    expect(buf.tail(0)).toEqual([]);
    expect(buf.tail(-5)).toEqual([]);

    buf.clear();
    expect(buf.size()).toBe(0);
    expect(buf.tail()).toEqual([]);
  });

  it('ignores blank lines and respects MAX_CRASH_LOG_LINES ceiling', () => {
    const buf = createRingLogBuffer(999);
    buf.push('   \r\n  ');
    expect(buf.size()).toBe(0);

    for (let i = 0; i < MAX_CRASH_LOG_LINES + 15; i += 1) {
      buf.push(`entry-${i}`, '2026-11-25T10:00:00Z');
    }
    expect(buf.size()).toBe(MAX_CRASH_LOG_LINES);
    expect(buf.tail(1)).toEqual([`[2026-11-25T10:00:00Z] entry-${MAX_CRASH_LOG_LINES + 14}`]);
  });
});

describe('buildCrashReportMarkdown (#226)', () => {
  const baseInput: CrashReportInput = {
    appVersion: '1.2.3',
    platform: 'android-tv',
    osVersion: 'Android 14',
    errorCode: 'ELV-ERR-42',
    errorMessage: 'Failed to load http://user:pass@stream.test/live/user/pass/9.ts?token=xyz',
    stack: 'Error: boom\n  at play (/Users/alice/src/player.ts:10:5)',
    componentStack: 'in PlayerScreen (/home/bob/src/PlayerScreen.tsx:22:3)',
    includeLogs: false,
    logLines: ['Authorization: Bearer topsecret', 'Opened C:\\Users\\Alice\\secret.m3u'],
    generatedAtIso: '2026-11-25T12:00:00Z',
  };

  it('omits Recent Logs section when includeLogs is false and redacts all fields', () => {
    const md = buildCrashReportMarkdown(baseInput);
    expect(md).toContain('# ELV IPTV Diagnostic Report');
    expect(md).toContain('1.2.3');
    expect(md).toContain('android-tv');
    expect(md).toContain('Android 14');
    expect(md).toContain('2026-11-25T12:00:00Z');
    expect(md).toContain('## Error Summary');
    expect(md).toContain('ELV-ERR-42');
    expect(md).toContain('## Component Stack');
    expect(md).not.toContain('## Recent Logs (redacted)');
    expect(md).not.toContain('topsecret');
    expect(md).not.toContain('user:pass');
    expect(md).not.toContain('Alice');
    expect(md).not.toContain('alice');
    expect(md).not.toContain('bob');
    expect(md).toContain('http://stream.test/***/***/***/***.ts');
    expect(md).toContain('<redacted-path>');
  });

  it('includes Recent Logs (redacted) capped at MAX_CRASH_LOG_LINES when includeLogs is true', () => {
    const manyLogs = Array.from({ length: MAX_CRASH_LOG_LINES + 20 }, (_, idx) =>
      idx === MAX_CRASH_LOG_LINES + 19
        ? 'final line Bearer secret-tok /home/dave/x.ts'
        : `line-${idx}`,
    );
    const md = buildCrashReportMarkdown({
      ...baseInput,
      includeLogs: true,
      logLines: manyLogs,
    });
    expect(md).toContain('## Recent Logs (redacted)');
    expect(md).not.toContain('line-0\n');
    expect(md).toContain('line-20');
    expect(md).toContain('final line Bearer *** <redacted-path>');
    expect(md).not.toContain('secret-tok');
    expect(md).not.toContain('dave');
  });

  it('handles minimal input without optional fields or logs', () => {
    const md = buildCrashReportMarkdown({
      appVersion: '0.1.0',
      platform: 'desktop',
      errorCode: 'E_UNKNOWN',
      includeLogs: true,
      logLines: [],
    });
    expect(md).toContain('# ELV IPTV Diagnostic Report');
    expect(md).toContain('## Error Summary');
    expect(md).not.toContain('## Component Stack');
    expect(md).toContain('## Recent Logs (redacted)');
  });
});
