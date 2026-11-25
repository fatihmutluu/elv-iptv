import { describe, expect, it } from 'vitest';
import {
  FEEDBACK_CATEGORIES,
  isFeedbackCategory,
  MAX_FEEDBACK_MESSAGE_CHARS,
  sanitizeFeedbackSubmission,
  submitFeedback,
} from './feedback';
import type { SyncHttpPort, SyncHttpRequest } from './ports';

describe('feedback sanitization and submission', () => {
  it('validates categories, clamps to 2000 chars, and redacts URLs, paths, and credentials', () => {
    expect(FEEDBACK_CATEGORIES).toEqual([
      'playback_issue',
      'channel_epg',
      'ui_remote',
      'sync_account',
      'feature_request',
      'other',
    ]);
    expect(isFeedbackCategory('playback_issue')).toBe(true);
    expect(isFeedbackCategory('invalid')).toBe(false);

    const fakeXtreamUrl = [
      'https://alice:secret@provider.example',
      'live',
      'alice',
      'secret',
      '123.ts',
    ].join('/');
    const fakeQuery = ['pass', 'word=abc'].join('');
    const sanitized = sanitizeFeedbackSubmission({
      category: 'playback_issue',
      message: `Stream failed on ${fakeXtreamUrl}?${fakeQuery} with Bearer eyJ123 at C:\\Users\\Alice\\list.m3u`,
      platform: 'android-tv',
      appVersion: '1.0.0',
      locale: 'en',
      diagnostics: 'Authorization: Bearer topsecret\nengine=media3 codec=hevc',
    });
    expect(sanitized.ok).toBe(true);
    if (!sanitized.ok) return;
    expect(sanitized.value.message).not.toContain('alice:secret');
    expect(sanitized.value.message).not.toContain('password=abc');
    expect(sanitized.value.message).not.toContain('eyJ123');
    expect(sanitized.value.message).not.toContain('Alice');
    expect(sanitized.value.locale).toBe('en');
    expect(String(sanitized.value.diagnostics?.summary)).not.toContain('topsecret');
    expect(String(sanitized.value.diagnostics?.summary)).toContain('engine=media3');

    // Structured diagnostics record redaction
    const structured = sanitizeFeedbackSubmission({
      category: 'playback_issue',
      message: 'Codec decode failure on HEVC channel',
      platform: 'android-tv',
      appVersion: '1.0.0',
      diagnostics: {
        engine: 'media3',
        retries: 2,
        isLive: true,
        note: 'token=secret123',
      },
    });
    expect(structured.ok).toBe(true);
    if (structured.ok) {
      expect(structured.value.diagnostics?.engine).toBe('media3');
      expect(structured.value.diagnostics?.retries).toBe(2);
      expect(structured.value.diagnostics?.isLive).toBe(true);
      expect(String(structured.value.diagnostics?.note)).not.toContain('secret123');
    }

    // Clamp > 2000 chars
    const longRes = sanitizeFeedbackSubmission({
      category: 'feature_request',
      message: 'x'.repeat(2500),
      platform: 'desktop',
      appVersion: '1.0.0',
    });
    expect(longRes.ok).toBe(true);
    if (longRes.ok) {
      expect(longRes.value.message.length).toBe(MAX_FEEDBACK_MESSAGE_CHARS);
    }

    // Reject empty message or invalid category
    expect(
      sanitizeFeedbackSubmission({
        category: 'other',
        message: '   \u0000  ',
        platform: 'ios',
        appVersion: '1.0.0',
      }).ok,
    ).toBe(false);
    expect(
      sanitizeFeedbackSubmission({
        category: 'bogus' as never,
        message: 'hello',
        platform: 'ios',
        appVersion: '1.0.0',
      }).ok,
    ).toBe(false);
  });

  it('submits sanitized feedback via POST /v1/feedback and handles errors cleanly', async () => {
    const calls: SyncHttpRequest[] = [];
    const http: SyncHttpPort = {
      async request(req) {
        calls.push(req);
        return { status: 201, bodyText: JSON.stringify({ id: 'fb_42' }) };
      },
    };

    // Empty message makes ZERO HTTP calls
    const bad = await submitFeedback({
      baseUrl: 'https://sync.example.test',
      http,
      submission: {
        category: 'other',
        message: '   ',
        platform: 'desktop',
        appVersion: '1.0.0',
      },
    });
    expect(bad.ok).toBe(false);
    expect(calls).toHaveLength(0);

    const res = await submitFeedback({
      baseUrl: 'https://sync.example.test/',
      http,
      submission: {
        category: 'ui_remote',
        message: 'Back button works great!',
        platform: 'android-tv',
        appVersion: '1.0.0',
      },
    });
    expect(res).toEqual({ ok: true, value: { id: 'fb_42' } });
    expect(calls[0]?.url).toBe('https://sync.example.test/v1/feedback');

    const failHttp: SyncHttpPort = {
      async request() {
        return { status: 429, bodyText: '{}' };
      },
    };
    const rateLimited = await submitFeedback({
      baseUrl: 'https://sync.example.test',
      http: failHttp,
      submission: {
        category: 'other',
        message: 'Testing rate limit',
        platform: 'desktop',
        appVersion: '1.0.0',
      },
    });
    expect(rateLimited.ok).toBe(false);
  });

  it('strips all URI schemes, file:, IPv4/IPv6, and OS paths to [redacted] in message and diagnostics', () => {
    const rawText = [
      'Tried https://provider.secret.example:8443/live/ch1.m3u8',
      'rtsp://10.0.0.5:554/stream',
      'rtmp://iptv.myhost.tv/live/abc',
      'udp://239.1.2.3:1234',
      'rtp://192.168.1.10:5000',
      'tcp://edge.provider.net:9000/x',
      'file:///storage/emulated/0/Download/list.m3u',
      'file:/etc/passwd',
      'ip4=192.168.1.50:8080',
      'ip6a=2001:db8::1',
      'ip6b=[fe80::1]:8080',
      'ip6c=2001:0db8:85a3:0000:0000:8a2e:0370:7334',
      'ip6d=::1',
      'unix1=/home/alice/list.m3u',
      'unix2=/Users/bob/Desktop/list.m3u',
      'unix3=/data/user/0/com.elv.iptv/files/db',
      'unix4=/storage/emulated/0/Movies/sample.ts',
      'unix5=/tmp/mpv.log',
      'unix6=/var/log/app.log',
      'win1=C:\\Users\\Alice\\list.m3u',
      'win2=D:\\streams\\live.ts',
      'unc=\\\\nas-box\\share\\playlist.m3u',
      'ver=1.0.0 time=12:34:56 engine=media3',
    ].join(' ');

    const res = sanitizeFeedbackSubmission({
      category: 'playback_issue',
      message: rawText,
      platform: 'android-tv',
      appVersion: '1.0.0',
      diagnostics: {
        summary: rawText,
        engine: 'media3',
      },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    for (const field of [res.value.message, String(res.value.diagnostics?.summary)]) {
      expect(field).not.toMatch(/:\/\//);
      expect(field).not.toMatch(/\bfile:/i);
      expect(field).not.toContain('provider.secret.example');
      expect(field).not.toContain('iptv.myhost.tv');
      expect(field).not.toContain('edge.provider.net');
      expect(field).not.toContain('192.168.1.50');
      expect(field).not.toContain('10.0.0.5');
      expect(field).not.toContain('239.1.2.3');
      expect(field).not.toContain('2001:db8');
      expect(field).not.toContain('fe80::1');
      expect(field).not.toContain('2001:0db8:85a3');
      expect(field).not.toContain('::1');
      expect(field).not.toContain('/home/alice');
      expect(field).not.toContain('/Users/bob');
      expect(field).not.toContain('/data/user');
      expect(field).not.toContain('/storage/emulated');
      expect(field).not.toContain('/tmp/mpv');
      expect(field).not.toContain('/var/log');
      expect(field).not.toContain('C:\\Users');
      expect(field).not.toContain('D:\\streams');
      expect(field).not.toContain('nas-box');
      expect(field).toContain('[redacted]');
      expect(field).toContain('ver=1.0.0');
      expect(field).toContain('time=12:34:56');
      expect(field).toContain('engine=media3');
    }
  });

  it('filters __proto__, constructor, and prototype keys when sanitizing diagnostics records', () => {
    const rawDiag: Record<string, string | number | boolean> = {
      engine: 'mpv',
      constructor: 'polluted-ctor',
      prototype: 'polluted-proto',
    };
    Object.defineProperty(rawDiag, '__proto__', {
      value: 'polluted-dunder',
      enumerable: true,
      configurable: true,
    });

    const res = sanitizeFeedbackSubmission({
      category: 'sync_account',
      message: 'Checking diagnostics key filtering',
      platform: 'desktop',
      appVersion: '1.0.0',
      diagnostics: rawDiag,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const diag = res.value.diagnostics;
    expect(diag).toBeDefined();
    expect(Object.keys(diag ?? {})).toEqual(['engine']);
    if (diag) {
      expect(Object.hasOwn(diag, '__proto__')).toBe(false);
      expect(Object.hasOwn(diag, 'constructor')).toBe(false);
      expect(Object.hasOwn(diag, 'prototype')).toBe(false);
    }
  });
});
