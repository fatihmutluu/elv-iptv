import { createAppI18n } from '@elv/i18n';
import { EMPTY_TRACKS, type MediaTracks } from '@elv/playback';
import { describe, expect, it } from 'vitest';
import {
  buildStreamQualityBadges,
  computeProgrammeProgress,
  formatProgrammeWindow,
} from './player-info-model';

const makeLocalTime = (hour: number, minute: number): number => {
  const d = new Date(2026, 10, 15, hour, minute, 0, 0);
  return d.getTime();
};

const TRACKS: MediaTracks = {
  audio: [
    { id: 'a:1', language: 'eng', codec: 'eac3', channels: 6 },
    { id: 'a:2', language: 'fra', codec: 'aac', channels: 2 },
    { id: 'a:3', language: 'tur' },
    { id: 'a:4', channels: 1 },
    { id: 'a:5', channels: 8 },
    { id: 'a:6', channels: 4 },
  ],
  subtitles: [
    { id: 's:1', language: 'eng' },
    { id: 's:2', label: 'Forced' },
  ],
  selectedAudioId: 'a:1',
  selectedSubtitleId: 's:1',
};

describe('player-info-model', () => {
  it('formats local HH:MM–HH:MM programme windows and guards non-finite timestamps', () => {
    const start = makeLocalTime(20, 0);
    const stop = makeLocalTime(21, 5);
    expect(formatProgrammeWindow(start, stop)).toBe('20:00–21:05');
    expect(formatProgrammeWindow(Number.NaN, stop)).toBe('');
    expect(formatProgrammeWindow(start, Number.POSITIVE_INFINITY)).toBe('');
  });

  it('computes clamped [0, 100] programme progress percentage', () => {
    const start = makeLocalTime(20, 0);
    const stop = makeLocalTime(21, 0);
    expect(computeProgrammeProgress(start, stop, start - 60_000)).toBe(0);
    expect(computeProgrammeProgress(start, stop, makeLocalTime(20, 30))).toBe(50);
    expect(computeProgrammeProgress(start, stop, stop + 60_000)).toBe(100);
    expect(computeProgrammeProgress(stop, start, start)).toBe(0);
    expect(computeProgrammeProgress(start, stop, Number.NaN)).toBe(0);
  });

  it('derives decoded stream quality and track badges without fabricating missing telemetry', () => {
    const i18n = createAppI18n('en');

    expect(buildStreamQualityBadges(undefined, EMPTY_TRACKS, i18n)).toEqual([]);

    expect(
      buildStreamQualityBadges(
        { width: 3840, height: 2160, fps: 50, codec: 'hevc', hdr: 'hdr10' },
        TRACKS,
        i18n,
      ),
    ).toEqual([
      { key: 'resolution', label: '4K · 3840×2160', tone: 'accent' },
      { key: 'fps', label: '50 fps', tone: 'neutral' },
      { key: 'vcodec', label: 'HEVC', tone: 'neutral' },
      { key: 'hdr', label: 'HDR10', tone: 'accent' },
      { key: 'audio', label: 'EAC3 5.1', tone: 'neutral' },
      { key: 'subtitle', label: 'Subtitles: English', tone: 'neutral' },
    ]);

    expect(
      buildStreamQualityBadges(
        { width: 2560, height: 1440, fps: 23.976, codec: 'h264', hdr: 'dv' },
        { ...TRACKS, selectedAudioId: 'a:3', selectedSubtitleId: 's:2' },
        i18n,
      ),
    ).toEqual([
      { key: 'resolution', label: '1440p · 2560×1440', tone: 'neutral' },
      { key: 'fps', label: '23.98 fps', tone: 'neutral' },
      { key: 'vcodec', label: 'H264', tone: 'neutral' },
      { key: 'hdr', label: 'DV', tone: 'accent' },
      { key: 'audio', label: 'Turkish', tone: 'neutral' },
      { key: 'subtitle', label: 'Subtitles: Forced', tone: 'neutral' },
    ]);

    expect(
      buildStreamQualityBadges(
        { height: 1080, hdr: 'hlg' },
        { ...TRACKS, selectedAudioId: 'a:4', selectedSubtitleId: null },
        i18n,
      ),
    ).toEqual([
      { key: 'resolution', label: '1080p', tone: 'neutral' },
      { key: 'hdr', label: 'HLG', tone: 'accent' },
      { key: 'audio', label: '1.0', tone: 'neutral' },
    ]);

    expect(
      buildStreamQualityBadges(
        { width: 1280 },
        { ...TRACKS, selectedAudioId: 'a:2', selectedSubtitleId: null },
        i18n,
      ),
    ).toEqual([
      { key: 'resolution', label: '720p', tone: 'neutral' },
      { key: 'audio', label: 'AAC 2.0', tone: 'neutral' },
    ]);

    expect(
      buildStreamQualityBadges(
        { height: 480 },
        { ...TRACKS, selectedAudioId: 'a:5', selectedSubtitleId: null },
        i18n,
      ),
    ).toEqual([
      { key: 'resolution', label: '480p', tone: 'neutral' },
      { key: 'audio', label: '7.1', tone: 'neutral' },
    ]);

    expect(
      buildStreamQualityBadges(
        { width: 640 },
        { ...TRACKS, selectedAudioId: 'a:6', selectedSubtitleId: null },
        i18n,
      ),
    ).toEqual([
      { key: 'resolution', label: '640w', tone: 'neutral' },
      { key: 'audio', label: '4ch', tone: 'neutral' },
    ]);
  });
});
