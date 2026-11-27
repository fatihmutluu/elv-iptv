import type { CatalogService, LiveVariantOption } from '@elv/data';
import type { PlaybackStatus, StreamVideoInfo } from '@elv/playback';
import { render, waitFor } from '@testing-library/react-native';
import type { PlayTarget } from '../../ports/play-target';
import { useElvQualityReporting } from '../useElvQualityReporting';
import { useLiveQualityVariants } from '../useLiveQualityVariants';

function LiveVariantsProbe({
  catalog,
  target,
  onSelect,
}: {
  readonly catalog: Partial<Pick<CatalogService, 'liveVariants'>>;
  readonly target: PlayTarget;
  readonly onSelect: (itemKey: string, title?: string) => void;
}): null {
  useLiveQualityVariants({
    catalog,
    activeTarget: target,
    crossCategory: true,
    onSelect,
  });
  return null;
}

function QualityReportingProbe({
  catalog,
  target,
  status,
  videoInfo,
  liveAutoFailover = false,
  liveVariants,
  onFailoverVariant,
}: {
  readonly catalog: Partial<
    Pick<CatalogService, 'recordPlaybackQuality' | 'recordPlaybackVariantFailure'>
  >;
  readonly target: PlayTarget;
  readonly status: PlaybackStatus;
  readonly videoInfo?: StreamVideoInfo;
  readonly liveAutoFailover?: boolean;
  readonly liveVariants: readonly LiveVariantOption[];
  readonly onFailoverVariant: (itemKey: string, title?: string) => void;
}): null {
  useElvQualityReporting({
    catalog,
    activeTarget: target,
    status,
    videoInfo,
    verifyRealQuality: true,
    liveAutoFailover,
    liveVariants,
    onFailoverVariant,
  });
  return null;
}

describe('Wave E1 Player Quality Verification & Live ELV Failover (#511)', () => {
  it('useLiveQualityVariants passes crossCategory: true when elvLiveEnhance is enabled', async () => {
    const liveVariants = jest.fn(async () => [
      { key: 'x:s1:live:1', title: 'CNN 4K', qualityLabel: '4K', qualityRank: 40 },
      { key: 'x:s1:live:2', title: 'CNN FHD', qualityLabel: 'FHD', qualityRank: 30 },
    ]);
    const target: PlayTarget = {
      kind: 'live',
      itemKey: 'x:s1:live:1',
      sourceId: 's1',
      title: 'CNN 4K',
      categoryId: 's1|live|news',
    };
    const variantCatalog = { liveVariants };
    const onSelect = jest.fn();

    await render(
      <LiveVariantsProbe catalog={variantCatalog} target={target} onSelect={onSelect} />,
    );
    await waitFor(() => {
      expect(liveVariants).toHaveBeenCalledWith('x:s1:live:1', 's1|live|news', {
        crossCategory: true,
      });
    });
  });

  it('useElvQualityReporting records verified resolution once on playing, records failure on failed, and auto-fails over live variants', async () => {
    const recordPlaybackQuality = jest.fn(async () => null);
    const recordPlaybackVariantFailure = jest.fn(async () => null);
    const onFailoverVariant = jest.fn();
    const reportCatalog = { recordPlaybackQuality, recordPlaybackVariantFailure };
    const variants: readonly LiveVariantOption[] = [
      { key: 'x:s1:live:1', title: 'CNN 4K', qualityLabel: '4K', qualityRank: 40 },
      {
        key: 'x:s1:live:bad',
        title: 'CNN Bad',
        qualityLabel: 'FHD',
        qualityRank: 30,
        isUnreliable: true,
      },
      { key: 'x:s1:live:2', title: 'CNN HD', qualityLabel: 'HD', qualityRank: 20 },
    ];

    const vodTarget: PlayTarget = {
      kind: 'vod',
      itemKey: 'x:s1:movie:1',
      sourceId: 's1',
      title: 'Inception 4K',
    };
    const view = await render(
      <QualityReportingProbe
        catalog={reportCatalog}
        target={vodTarget}
        status={{ kind: 'playing' }}
        videoInfo={{ width: 1920, height: 1080, codec: 'h264', hdr: 'sdr' }}
        liveVariants={variants}
        onFailoverVariant={onFailoverVariant}
      />,
    );

    expect(recordPlaybackQuality).toHaveBeenCalledTimes(1);
    expect(recordPlaybackQuality).toHaveBeenCalledWith({
      itemKey: 'x:s1:movie:1',
      actualWidth: 1920,
      actualHeight: 1080,
      actualVideoCodec: 'h264',
      actualHdr: 'sdr',
      claimedLabel: 'Inception 4K',
    });

    await view.rerender(
      <QualityReportingProbe
        catalog={reportCatalog}
        target={vodTarget}
        status={{ kind: 'playing' }}
        videoInfo={{ width: 1920, height: 1080, codec: 'h264', hdr: 'sdr' }}
        liveVariants={variants}
        onFailoverVariant={onFailoverVariant}
      />,
    );
    expect(recordPlaybackQuality).toHaveBeenCalledTimes(1);

    const liveTarget: PlayTarget = {
      kind: 'live',
      itemKey: 'x:s1:live:1',
      sourceId: 's1',
      title: 'CNN 4K',
    };
    // Transition through tuning before failed for the new live target
    await view.rerender(
      <QualityReportingProbe
        catalog={reportCatalog}
        target={liveTarget}
        status={{ kind: 'tuning' }}
        liveAutoFailover
        liveVariants={variants}
        onFailoverVariant={onFailoverVariant}
      />,
    );
    await view.rerender(
      <QualityReportingProbe
        catalog={reportCatalog}
        target={liveTarget}
        status={{ kind: 'failed', error: { category: 'network', code: 'timeout' } }}
        liveAutoFailover
        liveVariants={variants}
        onFailoverVariant={onFailoverVariant}
      />,
    );
    expect(recordPlaybackVariantFailure).toHaveBeenCalledWith('x:s1:live:1');
    expect(onFailoverVariant).toHaveBeenCalledWith('x:s1:live:2', 'CNN HD');
  });

  it('prevents cascading multi-variant failover burn-through when status remains stale failed after target swap (P0-3)', async () => {
    const recordPlaybackQuality = jest.fn(async () => null);
    const recordPlaybackVariantFailure = jest.fn(async () => null);
    const onFailoverVariant = jest.fn();
    const reportCatalog = { recordPlaybackQuality, recordPlaybackVariantFailure };
    const variants: readonly LiveVariantOption[] = [
      { key: 'x:s1:live:A', title: 'CNN 4K', qualityLabel: '4K', qualityRank: 40 },
      { key: 'x:s1:live:B', title: 'CNN FHD', qualityLabel: 'FHD', qualityRank: 30 },
      { key: 'x:s1:live:C', title: 'CNN HD', qualityLabel: 'HD', qualityRank: 20 },
    ];
    const targetA: PlayTarget = {
      kind: 'live',
      itemKey: 'x:s1:live:A',
      sourceId: 's1',
      title: 'CNN 4K',
    };
    const targetB: PlayTarget = {
      kind: 'live',
      itemKey: 'x:s1:live:B',
      sourceId: 's1',
      title: 'CNN FHD',
    };

    const view = await render(
      <QualityReportingProbe
        catalog={reportCatalog}
        target={targetA}
        status={{ kind: 'tuning' }}
        liveAutoFailover
        liveVariants={variants}
        onFailoverVariant={onFailoverVariant}
      />,
    );

    // Variant A genuinely fails -> triggers failover to B
    await view.rerender(
      <QualityReportingProbe
        catalog={reportCatalog}
        target={targetA}
        status={{ kind: 'failed', error: { category: 'network', code: 'timeout' } }}
        liveAutoFailover
        liveVariants={variants}
        onFailoverVariant={onFailoverVariant}
      />,
    );
    expect(recordPlaybackVariantFailure).toHaveBeenCalledTimes(1);
    expect(recordPlaybackVariantFailure).toHaveBeenCalledWith('x:s1:live:A');
    expect(onFailoverVariant).toHaveBeenCalledTimes(1);
    expect(onFailoverVariant).toHaveBeenCalledWith('x:s1:live:B', 'CNN FHD');

    // Target swaps to B while status is STILL stale 'failed' from A -> MUST NOT record failure or cascade to C!
    await view.rerender(
      <QualityReportingProbe
        catalog={reportCatalog}
        target={targetB}
        status={{ kind: 'failed', error: { category: 'network', code: 'timeout' } }}
        liveAutoFailover
        liveVariants={variants}
        onFailoverVariant={onFailoverVariant}
      />,
    );
    expect(recordPlaybackVariantFailure).toHaveBeenCalledTimes(1);
    expect(onFailoverVariant).toHaveBeenCalledTimes(1);

    // Once B actually tunes and then fails, B IS recorded and fails over to C
    await view.rerender(
      <QualityReportingProbe
        catalog={reportCatalog}
        target={targetB}
        status={{ kind: 'tuning' }}
        liveAutoFailover
        liveVariants={variants}
        onFailoverVariant={onFailoverVariant}
      />,
    );
    await view.rerender(
      <QualityReportingProbe
        catalog={reportCatalog}
        target={targetB}
        status={{ kind: 'failed', error: { category: 'network', code: 'timeout' } }}
        liveAutoFailover
        liveVariants={variants}
        onFailoverVariant={onFailoverVariant}
      />,
    );
    expect(recordPlaybackVariantFailure).toHaveBeenCalledTimes(2);
    expect(recordPlaybackVariantFailure).toHaveBeenLastCalledWith('x:s1:live:B');
    expect(onFailoverVariant).toHaveBeenCalledTimes(2);
    expect(onFailoverVariant).toHaveBeenLastCalledWith('x:s1:live:C', 'CNN HD');
  });

  it('prevents zapBy quality poisoning when activeTarget changes while stale playing videoInfo is still mounted (P0-3)', async () => {
    const recordPlaybackQuality = jest.fn(async () => null);
    const recordPlaybackVariantFailure = jest.fn(async () => null);
    const onFailoverVariant = jest.fn();
    const reportCatalog = { recordPlaybackQuality, recordPlaybackVariantFailure };

    const channelA: PlayTarget = {
      kind: 'live',
      itemKey: 'x:s1:live:A',
      sourceId: 's1',
      title: 'Channel A 4K',
    };
    const channelB: PlayTarget = {
      kind: 'live',
      itemKey: 'x:s1:live:B',
      sourceId: 's1',
      title: 'Channel B 720p',
    };

    const view = await render(
      <QualityReportingProbe
        catalog={reportCatalog}
        target={channelA}
        status={{ kind: 'playing' }}
        videoInfo={{ width: 3840, height: 2160, codec: 'hevc', hdr: 'hdr10' }}
        liveVariants={[]}
        onFailoverVariant={onFailoverVariant}
      />,
    );
    expect(recordPlaybackQuality).toHaveBeenCalledTimes(1);
    expect(recordPlaybackQuality).toHaveBeenLastCalledWith(
      expect.objectContaining({ itemKey: 'x:s1:live:A', actualWidth: 3840, actualHeight: 2160 }),
    );

    // zapBy updates activeTarget to Channel B while status is still 'playing' with Channel A's 4K videoInfo!
    await view.rerender(
      <QualityReportingProbe
        catalog={reportCatalog}
        target={channelB}
        status={{ kind: 'playing' }}
        videoInfo={{ width: 3840, height: 2160, codec: 'hevc', hdr: 'hdr10' }}
        liveVariants={[]}
        onFailoverVariant={onFailoverVariant}
      />,
    );
    expect(recordPlaybackQuality).toHaveBeenCalledTimes(1);

    // Channel B begins tuning, then plays with its real 720p videoInfo
    await view.rerender(
      <QualityReportingProbe
        catalog={reportCatalog}
        target={channelB}
        status={{ kind: 'tuning' }}
        videoInfo={{ width: 3840, height: 2160, codec: 'hevc', hdr: 'hdr10' }}
        liveVariants={[]}
        onFailoverVariant={onFailoverVariant}
      />,
    );
    await view.rerender(
      <QualityReportingProbe
        catalog={reportCatalog}
        target={channelB}
        status={{ kind: 'playing' }}
        videoInfo={{ width: 1280, height: 720, codec: 'h264', hdr: 'sdr' }}
        liveVariants={[]}
        onFailoverVariant={onFailoverVariant}
      />,
    );
    expect(recordPlaybackQuality).toHaveBeenCalledTimes(2);
    expect(recordPlaybackQuality).toHaveBeenLastCalledWith(
      expect.objectContaining({ itemKey: 'x:s1:live:B', actualWidth: 1280, actualHeight: 720 }),
    );
  });

  it('ignores non-stream errors (auth/parental-locked, source-excluded, connection-limit, cancelled) and resets reported refs on retry tuning (P0-3)', async () => {
    const recordPlaybackQuality = jest.fn(async () => null);
    const recordPlaybackVariantFailure = jest.fn(async () => null);
    const onFailoverVariant = jest.fn();
    const reportCatalog = { recordPlaybackQuality, recordPlaybackVariantFailure };
    const variants: readonly LiveVariantOption[] = [
      { key: 'x:s1:live:1', title: 'News 4K', qualityLabel: '4K', qualityRank: 40 },
      { key: 'x:s1:live:2', title: 'News HD', qualityLabel: 'HD', qualityRank: 20 },
    ];
    const target: PlayTarget = {
      kind: 'live',
      itemKey: 'x:s1:live:1',
      sourceId: 's1',
      title: 'News 4K',
    };

    const view = await render(
      <QualityReportingProbe
        catalog={reportCatalog}
        target={target}
        status={{ kind: 'tuning' }}
        liveAutoFailover
        liveVariants={variants}
        onFailoverVariant={onFailoverVariant}
      />,
    );

    const nonStreamErrors = [
      { category: 'auth' as const, code: 'parental-locked' },
      { category: 'auth' as const, code: 'source-excluded' },
      { category: 'network' as const, code: 'connection-limit' },
      { category: 'playback' as const, code: 'cancelled' },
    ];

    for (const error of nonStreamErrors) {
      await view.rerender(
        <QualityReportingProbe
          catalog={reportCatalog}
          target={target}
          status={{ kind: 'tuning' }}
          liveAutoFailover
          liveVariants={variants}
          onFailoverVariant={onFailoverVariant}
        />,
      );
      await view.rerender(
        <QualityReportingProbe
          catalog={reportCatalog}
          target={target}
          status={{ kind: 'failed', error }}
          liveAutoFailover
          liveVariants={variants}
          onFailoverVariant={onFailoverVariant}
        />,
      );
    }

    expect(recordPlaybackVariantFailure).not.toHaveBeenCalled();
    expect(onFailoverVariant).not.toHaveBeenCalled();

    // Retry same item twice with stream failures -> records both failures so fail_count reaches >= 2
    await view.rerender(
      <QualityReportingProbe
        catalog={reportCatalog}
        target={target}
        status={{ kind: 'tuning' }}
        liveAutoFailover={false}
        liveVariants={variants}
        onFailoverVariant={onFailoverVariant}
      />,
    );
    await view.rerender(
      <QualityReportingProbe
        catalog={reportCatalog}
        target={target}
        status={{ kind: 'failed', error: { category: 'network', code: 'timeout' } }}
        liveAutoFailover={false}
        liveVariants={variants}
        onFailoverVariant={onFailoverVariant}
      />,
    );
    expect(recordPlaybackVariantFailure).toHaveBeenCalledTimes(1);

    await view.rerender(
      <QualityReportingProbe
        catalog={reportCatalog}
        target={target}
        status={{ kind: 'tuning' }}
        liveAutoFailover={false}
        liveVariants={variants}
        onFailoverVariant={onFailoverVariant}
      />,
    );
    await view.rerender(
      <QualityReportingProbe
        catalog={reportCatalog}
        target={target}
        status={{ kind: 'failed', error: { category: 'network', code: 'timeout' } }}
        liveAutoFailover={false}
        liveVariants={variants}
        onFailoverVariant={onFailoverVariant}
      />,
    );
    expect(recordPlaybackVariantFailure).toHaveBeenCalledTimes(2);

    // Retry recovers -> records verified quality
    await view.rerender(
      <QualityReportingProbe
        catalog={reportCatalog}
        target={target}
        status={{ kind: 'tuning' }}
        liveAutoFailover={false}
        liveVariants={variants}
        onFailoverVariant={onFailoverVariant}
      />,
    );
    await view.rerender(
      <QualityReportingProbe
        catalog={reportCatalog}
        target={target}
        status={{ kind: 'playing' }}
        videoInfo={{ width: 1920, height: 1080, codec: 'h264', hdr: 'sdr' }}
        liveAutoFailover={false}
        liveVariants={variants}
        onFailoverVariant={onFailoverVariant}
      />,
    );
    expect(recordPlaybackQuality).toHaveBeenCalledTimes(1);
  });
});
