import { describe, expect, it } from 'vitest';
import { openElvEnrichmentStore } from './elv-enrichment-repo';
import {
  detectFake4k,
  formatVerifiedResolution,
  hasClaimedQualityTag,
  recordPlaybackQuality,
  recordPlaybackVariantFailure,
  scoreMergedVariant,
} from './elv-quality-memory';
import { testDb } from './test-db';

describe('ELV real quality verification & broken-variant memory (#511)', () => {
  it('detectFake4k flags claimed 4K/UHD/2160p streams below real 4K while preserving cinema-scope 4K (3840x1600, 4096x1716)', () => {
    expect(detectFake4k('4K', 1080)).toBe(true);
    expect(detectFake4k('4K', 1080, 1920)).toBe(true);
    expect(detectFake4k('UHD HDR', 720, 1280)).toBe(true);
    expect(detectFake4k('[2160p] HEVC', 1080, 1920)).toBe(true);
    expect(detectFake4k('4K', 2160, 3840)).toBe(false);
    expect(detectFake4k('4K', 1600, 3840)).toBe(false);
    expect(detectFake4k('4K HDR', 1716, 4096)).toBe(false);
    expect(detectFake4k('4K', 1800)).toBe(false);
    expect(detectFake4k('1080p', 720, 1280)).toBe(false);
    expect(detectFake4k('4KIDS', 720, 1280)).toBe(false);
    expect(detectFake4k('4K', null, 3840)).toBe(false);
    expect(detectFake4k('4K', 0, 0)).toBe(false);
    expect(detectFake4k(null, 720, 1280)).toBe(false);

    expect(hasClaimedQualityTag('4K HDR')).toBe(true);
    expect(hasClaimedQualityTag('1080p')).toBe(true);
    expect(hasClaimedQualityTag('News One HD')).toBe(true);
    expect(hasClaimedQualityTag('Inception')).toBe(false);
    expect(hasClaimedQualityTag('4KIDS')).toBe(false);
    expect(hasClaimedQualityTag('HDR')).toBe(false);
    expect(hasClaimedQualityTag(null)).toBe(false);
  });

  it('formatVerifiedResolution maps standard and cinema-scope dimensions cleanly', () => {
    expect(formatVerifiedResolution(3840, 2160)).toBe('4K');
    expect(formatVerifiedResolution(3840, 1600)).toBe('4K');
    expect(formatVerifiedResolution(4096, 1716)).toBe('4K');
    expect(formatVerifiedResolution(1920, 1080)).toBe('1080p');
    expect(formatVerifiedResolution(1920, 800)).toBe('1080p');
    expect(formatVerifiedResolution(1280, 720)).toBe('720p');
    expect(formatVerifiedResolution(1280, 534)).toBe('720p');
    expect(formatVerifiedResolution(854, 480)).toBe('480p');
    expect(formatVerifiedResolution(640, 360)).toBe('360p');
    expect(formatVerifiedResolution(640, 0)).toBeNull();
    expect(formatVerifiedResolution(null, null)).toBeNull();
    expect(formatVerifiedResolution(0, 0)).toBeNull();
  });

  it('treats cinema-scope 4K (3840x1600) as real 4K with score 1000 in recordPlaybackQuality', async () => {
    const { db } = testDb();
    const store = await openElvEnrichmentStore(db, { clock: () => 5_000 });

    const cinema4k = await recordPlaybackQuality(store, {
      itemKey: 'x:s1:movie:scope4k',
      actualWidth: 3840,
      actualHeight: 1600,
      claimedLabel: '4K',
      nowMs: 5_000,
    });
    expect(cinema4k.isFake4k).toBe(false);
    const verifiedRes = formatVerifiedResolution(cinema4k.actualWidth, cinema4k.actualHeight);
    expect(verifiedRes).toBe('4K');
    expect(
      scoreMergedVariant({
        verifiedResolution: verifiedRes,
        actualHeight: cinema4k.actualHeight,
        isFake4k: cinema4k.isFake4k,
        failCount: cinema4k.failCount,
      }),
    ).toBe(1000);

    const fake4k = await recordPlaybackQuality(store, {
      itemKey: 'x:s1:movie:fake4k',
      actualWidth: 1920,
      actualHeight: 1080,
      claimedLabel: '4K',
      nowMs: 5_000,
    });
    expect(fake4k.isFake4k).toBe(true);
  });

  it('persists playback quality, resets fail_count on success, and increments fail_count on failure', async () => {
    const { db } = testDb();
    let now = 1_000;
    const store = await openElvEnrichmentStore(db, { clock: () => now });

    // 2 failures first
    const f1 = await recordPlaybackVariantFailure(store, 'x:s1:movie:1', 1_000);
    expect(f1.failCount).toBe(1);
    expect(f1.lastFailAt).toBe(1_000);

    const f2 = await recordPlaybackVariantFailure(store, 'x:s1:movie:1', 2_000);
    expect(f2.failCount).toBe(2);
    expect(f2.lastFailAt).toBe(2_000);

    // Successful playback records real specs, detects fake-4K, and resets failCount to 0
    now = 3_000;
    const q = await recordPlaybackQuality(store, {
      itemKey: 'x:s1:movie:1',
      actualWidth: 1920,
      actualHeight: 1080,
      actualVideoCodec: 'hevc',
      actualAudioCodec: 'eac3',
      actualAudioChannels: 6,
      actualHdr: 'HDR10',
      claimedLabel: '4K HDR',
      nowMs: 3_000,
    });
    expect(q.isFake4k).toBe(true);
    expect(q.failCount).toBe(0);
    expect(q.lastSuccessAt).toBe(3_000);
    expect(q.lastFailAt).toBe(2_000);
    expect(q.actualVideoCodec).toBe('hevc');
    expect(await store.getQualityMemory('x:s1:movie:1')).toEqual(q);
  });

  it('scoreMergedVariant ranks verified real 4K > verified 1080p > unverified claimed > fake-4K > broken (failCount >= 2)', () => {
    const verified4k = scoreMergedVariant({
      verifiedResolution: '4K',
      claimedQualityRank: 40,
      isFake4k: false,
      failCount: 0,
    });
    const verified1080 = scoreMergedVariant({
      verifiedResolution: '1080p',
      claimedQualityRank: 30,
      isFake4k: false,
      failCount: 0,
    });
    const unverified4k = scoreMergedVariant({
      verifiedResolution: null,
      claimedQualityRank: 40,
      isFake4k: false,
      failCount: 0,
    });
    const fake4k = scoreMergedVariant({
      verifiedResolution: '1080p',
      claimedQualityRank: 40,
      isFake4k: true,
      failCount: 0,
    });
    const brokenVerified4k = scoreMergedVariant({
      verifiedResolution: '4K',
      claimedQualityRank: 40,
      isFake4k: false,
      failCount: 2,
    });

    expect(verified4k).toBeGreaterThan(verified1080);
    expect(verified1080).toBeGreaterThan(unverified4k);
    expect(unverified4k).toBeGreaterThan(fake4k);
    expect(fake4k).toBeGreaterThan(brokenVerified4k);
  });
});
