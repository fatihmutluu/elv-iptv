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
});
