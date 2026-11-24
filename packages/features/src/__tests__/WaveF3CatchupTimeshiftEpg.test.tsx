import type {
  CatalogService,
  ChannelGuideOverrideRecord,
  GuideSourceRecord,
  ItemRow,
  ProgrammeRow,
  SourceRow,
} from '@elv/data';
import { ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { createFakePlayerEngine } from '@elv/playback/testing';
import { FormFactorProvider, I18nProvider, ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { View } from 'react-native';
import {
  buildReminderKey,
  EpgChannelRow,
  EpgProgrammeDetailModal,
  GuideManagementOverlay,
  PlayerScreen,
  type PlayTarget,
  ReminderToastBanner,
  type VideoHost,
} from '../index';

function createManualClock(startMs = 1_000) {
  let current = startMs;
  let nextId = 1;
  const scheduled = new Map<number, () => void>();
  return {
    now: () => current,
    schedule: (fn: () => void, _ms: number) => {
      const id = nextId++;
      scheduled.set(id, fn);
      return id;
    },
    cancel: (handle: unknown) => {
      scheduled.delete(handle as number);
    },
    advance: (ms: number) => {
      current += ms;
    },
  };
}

const NOW_MS = new Date(2026, 4, 15, 18, 0, 0, 0).getTime();
const HOUR_MS = 3_600_000;

function wrap(node: ReactElement): ReactElement {
  return (
    <ThemeProvider>
      <ViewportProvider
        value={{
          width: 1280,
          height: 720,
          formFactor: 'desktop',
          inputModality: 'pointer',
          orientation: 'landscape',
          safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
        }}
      >
        <FormFactorProvider value="desktop">
          <I18nProvider i18n={createAppI18n('en')}>{node}</I18nProvider>
        </FormFactorProvider>
      </ViewportProvider>
    </ThemeProvider>
  );
}

const CATCHUP_CHANNEL: ItemRow = {
  id: 1,
  key: 'x:s1:live:10',
  kind: 'live',
  sourceId: 's1',
  providerId: '10',
  name: 'News 24',
  logo: null,
  rating: null,
  year: null,
  num: 10,
  catchupDays: 3,
};

const PAST_PROGRAMME: ProgrammeRow = {
  channelKey: CATCHUP_CHANNEL.key,
  sourceId: 's1',
  guideId: 'news24',
  start: NOW_MS - 2 * HOUR_MS,
  stop: NOW_MS - HOUR_MS,
  title: 'Afternoon Bulletin',
  subTitle: null,
  description: 'Full afternoon headlines.',
  episodeNum: null,
  icon: null,
  genre: 'news',
  flags: 0,
};

const UPCOMING_PROGRAMME: ProgrammeRow = {
  channelKey: CATCHUP_CHANNEL.key,
  sourceId: 's1',
  guideId: 'news24',
  start: NOW_MS + HOUR_MS,
  stop: NOW_MS + 2 * HOUR_MS,
  title: 'Prime Time Report',
  subTitle: null,
  description: 'Upcoming evening report.',
  episodeNum: null,
  icon: null,
  genre: 'news',
  flags: 0,
};

describe('Wave F3 UI — Catch-Up, Live Time-Shift, Multi-Guide & Reminders', () => {
  beforeEach(() => {
    jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1);
    jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders catch-up & reminder badges on EpgChannelRow and handles Watch catch-up / archive check / expired / reminders in EpgProgrammeDetailModal', async () => {
    const reminderKeys = new Set([buildReminderKey(CATCHUP_CHANNEL.key, UPCOMING_PROGRAMME.start)]);
    const rowView = await render(
      wrap(
        <EpgChannelRow
          rowIndex={0}
          channel={CATCHUP_CHANNEL}
          programmes={[PAST_PROGRAMME, UPCOMING_PROGRAMME]}
          windowStartMs={NOW_MS - 2 * HOUR_MS}
          spanMs={5 * HOUR_MS}
          nowMs={NOW_MS}
          channelColWidth={176}
          rowHeight={60}
          isTv={false}
          isFocusedRow={false}
          focusedSlotIndex={0}
          scheduledReminderKeys={reminderKeys}
          onSelectCell={jest.fn()}
        />,
      ),
    );
    expect(screen.getByTestId('epg-cell-catchup-0-0')).toBeTruthy();
    expect(screen.getByTestId('epg-cell-reminder-0-2')).toBeTruthy();
    await rowView.unmount();

    // Detail modal: past programme with catchupDays > 0 -> primary "Watch catch-up" CTA
    const onWatchCatchup = jest.fn();
    const fetchArchiveOk = jest.fn(async () => ok([{ ...PAST_PROGRAMME, hasArchive: true }]));
    const modalView = await render(
      wrap(
        <EpgProgrammeDetailModal
          visible
          channel={CATCHUP_CHANNEL}
          channelIndex={0}
          programme={PAST_PROGRAMME}
          nowMs={NOW_MS}
          isFavorite={false}
          isTv={false}
          catalog={{ fetchChannelArchiveEpg: fetchArchiveOk } as unknown as CatalogService}
          onTuneChannel={jest.fn()}
          onWatchCatchup={onWatchCatchup}
          onClose={jest.fn()}
        />,
      ),
    );
    await waitFor(() => expect(fetchArchiveOk).toHaveBeenCalledWith(CATCHUP_CHANNEL.key));
    await fireEvent.press(screen.getByTestId('epg-detail-catchup'));
    expect(onWatchCatchup).toHaveBeenCalledWith(CATCHUP_CHANNEL, 0, PAST_PROGRAMME, true);
    await modalView.unmount();

    // Detail modal: Xtream archive explicitly reports hasArchive === false -> hides CTA and shows unavailable hint
    const fetchArchiveFalse = jest.fn(async () => ok([{ ...PAST_PROGRAMME, hasArchive: false }]));
    const unavailableView = await render(
      wrap(
        <EpgProgrammeDetailModal
          visible
          channel={CATCHUP_CHANNEL}
          channelIndex={0}
          programme={PAST_PROGRAMME}
          nowMs={NOW_MS}
          isFavorite={false}
          isTv={false}
          catalog={{ fetchChannelArchiveEpg: fetchArchiveFalse } as unknown as CatalogService}
          onTuneChannel={jest.fn()}
          onWatchCatchup={jest.fn()}
          onClose={jest.fn()}
        />,
      ),
    );
    await waitFor(() => {
      expect(screen.queryByTestId('epg-detail-catchup')).toBeNull();
      expect(screen.getByTestId('epg-detail-catchup-hint').props.children).toBe(
        'Catch-up is not available for this programme.',
      );
    });
    await unavailableView.unmount();

    // Detail modal: expired programme shows epg.catchupExpired
    const expiredProg: ProgrammeRow = {
      ...PAST_PROGRAMME,
      start: NOW_MS - 6 * 24 * HOUR_MS,
      stop: NOW_MS - 5 * 24 * HOUR_MS,
    };
    const expiredView = await render(
      wrap(
        <EpgProgrammeDetailModal
          visible
          channel={CATCHUP_CHANNEL}
          channelIndex={0}
          programme={expiredProg}
          nowMs={NOW_MS}
          isFavorite={false}
          isTv={false}
          onTuneChannel={jest.fn()}
          onWatchCatchup={jest.fn()}
          onClose={jest.fn()}
        />,
      ),
    );
    expect(screen.getByTestId('epg-detail-catchup-hint').props.children).toBe(
      'Catch-up window has expired for this programme.',
    );
    await expiredView.unmount();

    // Detail modal: upcoming programme Remind me / Cancel reminder toggle
    const upsertReminder = jest.fn(async (input) =>
      ok({
        profileId: 'default',
        ...input,
        leadTimeMs: input.leadTimeMs ?? 300_000,
        fired: false,
        createdAt: NOW_MS,
      }),
    );
    const removeReminder = jest.fn(async () => ok(undefined));
    const onReminderChanged = jest.fn();
    const upcomingView = await render(
      wrap(
        <EpgProgrammeDetailModal
          visible
          channel={CATCHUP_CHANNEL}
          channelIndex={0}
          programme={UPCOMING_PROGRAMME}
          nowMs={NOW_MS}
          isFavorite={false}
          isTv={false}
          catalog={{ upsertReminder, removeReminder } as unknown as CatalogService}
          hasReminder={false}
          onTuneChannel={jest.fn()}
          onReminderChanged={onReminderChanged}
          onClose={jest.fn()}
        />,
      ),
    );
    await fireEvent.press(screen.getByTestId('epg-detail-reminder-lead-10'));
    await fireEvent.press(screen.getByTestId('epg-detail-reminder'));
    await waitFor(() =>
      expect(upsertReminder).toHaveBeenCalledWith(
        expect.objectContaining({
          channelKey: CATCHUP_CHANNEL.key,
          programmeStart: UPCOMING_PROGRAMME.start,
          leadTimeMs: 600_000,
        }),
      ),
    );
    expect(onReminderChanged).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByTestId('epg-detail-reminder'));
    await waitFor(() =>
      expect(removeReminder).toHaveBeenCalledWith(CATCHUP_CHANNEL.key, UPCOMING_PROGRAMME.start),
    );
    await upcomingView.unmount();
  });

  it('plays catch-up via resolveCatchupStream without writing watch_progress and switches cleanly Back to live', async () => {
    const manual = createManualClock();
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });
    const callLog: string[] = [];
    const origStop = engine.stop.bind(engine);
    const origLoad = engine.load.bind(engine);
    jest.spyOn(engine, 'stop').mockImplementation((attempt) => {
      callLog.push('stop');
      origStop(attempt);
    });
    jest.spyOn(engine, 'load').mockImplementation((cmd) => {
      callLog.push(`load:${cmd.kind}:${cmd.url}`);
      origLoad(cmd);
    });

    const videoHost: VideoHost = {
      open: () => ({
        engine,
        renderSurface: ({ testID }) => <View testID={testID ?? 'surface'} />,
      }),
    };

    const resolveStream = jest.fn(async () =>
      ok({ url: 'http://sim.example.test/live.ts', headers: {} }),
    );
    const resolveCatchupStream = jest.fn(async () =>
      ok({ url: 'http://sim.example.test/timeshift.ts', headers: {} }),
    );
    const saveProgress = jest.fn(async () => ok({} as never));
    const getProgress = jest.fn(async () => null);

    const catchupTarget: PlayTarget = {
      itemKey: CATCHUP_CHANNEL.key,
      sourceId: 's1',
      title: PAST_PROGRAMME.title,
      subtitle: CATCHUP_CHANNEL.name,
      kind: 'vod',
      startPositionMs: 0,
      catchup: {
        startMs: PAST_PROGRAMME.start,
        stopMs: PAST_PROGRAMME.stop,
        programmeTitle: PAST_PROGRAMME.title,
        hasArchive: true,
        liveTarget: {
          itemKey: CATCHUP_CHANNEL.key,
          sourceId: 's1',
          title: '10. News 24',
          kind: 'live',
          itemKind: 'live',
        },
      },
    };

    const view = await render(
      wrap(
        <PlayerScreen
          catalog={{ resolveStream, resolveCatchupStream, saveProgress, getProgress }}
          videoHost={videoHost}
          target={catchupTarget}
          clock={{ now: manual.now }}
          timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
          onExit={jest.fn()}
        />,
      ),
    );

    await waitFor(() => expect(resolveCatchupStream).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(engine.commands.some((c) => c.name === 'load')).toBe(true));
    expect(resolveStream).not.toHaveBeenCalled();
    expect(getProgress).not.toHaveBeenCalled();
    expect(screen.getByTestId('player-catchup-badge')).toBeTruthy();
    expect(screen.getByTestId('player-back-to-live')).toBeTruthy();

    // Advance catch-up playback and pause -> must NEVER call saveProgress
    const firstLoad = engine.commands.find((c) => c.name === 'load');
    const firstAttempt: number =
      firstLoad && 'attempt' in firstLoad && typeof firstLoad.attempt === 'number'
        ? firstLoad.attempt
        : 1;
    await act(async () => {
      engine.emit({ attempt: firstAttempt, type: 'state', state: 'playing' });
      engine.emit({
        attempt: firstAttempt,
        type: 'clock',
        anchor: { positionMs: 120_000, atMs: manual.now(), rate: 1, durationMs: 3_600_000 },
      });
      engine.emit({ attempt: firstAttempt, type: 'state', state: 'paused' });
    });
    expect(saveProgress).not.toHaveBeenCalled();

    // Click "Back to live" -> stops catch-up stream BEFORE loading live stream (max_connections=1 safe!)
    callLog.length = 0;
    await fireEvent.press(screen.getByTestId('player-back-to-live'));
    await waitFor(() => expect(resolveStream).toHaveBeenCalledWith(CATCHUP_CHANNEL.key));
    await waitFor(() => expect(callLog).toContain('load:live:http://sim.example.test/live.ts'));
    expect(callLog[0]).toBe('stop');
    expect(saveProgress).not.toHaveBeenCalled();
    await view.unmount();
  });

  it('renders LiveTimeShiftBar with behind-live offset, Jump to live CTA, and omits bar when unsupported', async () => {
    const manual = createManualClock();
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });
    const jumpSpy = jest.fn();
    engine.jumpToLiveEdge = jumpSpy;

    const videoHost: VideoHost = {
      open: () => ({
        engine,
        renderSurface: ({ testID }) => <View testID={testID ?? 'surface'} />,
      }),
    };

    const liveTarget: PlayTarget = {
      itemKey: CATCHUP_CHANNEL.key,
      sourceId: 's1',
      title: '10. News 24',
      kind: 'live',
    };

    const view = await render(
      wrap(
        <PlayerScreen
          catalog={{
            resolveStream: jest.fn(async () =>
              ok({ url: 'http://sim.example.test/live.ts', headers: {} }),
            ),
            getProgress: jest.fn(async () => null),
            saveProgress: jest.fn(async () => ok({} as never)),
          }}
          videoHost={videoHost}
          target={liveTarget}
          clock={{ now: manual.now }}
          timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
          onExit={jest.fn()}
        />,
      ),
    );

    await waitFor(() => expect(engine.commands.some((c) => c.name === 'load')).toBe(true));
    const firstLoad = engine.commands.find((c) => c.name === 'load');
    const attempt: number =
      firstLoad && 'attempt' in firstLoad && typeof firstLoad.attempt === 'number'
        ? firstLoad.attempt
        : 1;

    // Unsupported live stream: no time-shift scrubber
    await act(async () => {
      engine.emit({ attempt, type: 'state', state: 'playing' });
      engine.emit({
        attempt,
        type: 'clock',
        anchor: { positionMs: 50_000, atMs: manual.now(), rate: 1, timeShiftSupported: false },
      });
    });
    expect(screen.queryByTestId('player-live-timeshift-bar')).toBeNull();

    // Supported live stream behind live by 02:14 -> shows scrubber, status pill, -10s/+10s, and Jump to live
    await act(async () => {
      engine.emit({
        attempt,
        type: 'clock',
        anchor: {
          positionMs: 100_000,
          atMs: manual.now(),
          rate: 1,
          liveSeekableStartMs: 0,
          liveEdgeMs: 234_000,
          timeShiftSupported: true,
        },
      });
    });
    await waitFor(() => expect(screen.getByTestId('player-live-timeshift-bar')).toBeTruthy());
    expect(screen.getByTestId('player-live-timeshift-status')).toBeTruthy();
    expect(screen.getByTestId('player-seek-back')).toBeTruthy();
    expect(screen.getByTestId('player-seek-forward')).toBeTruthy();
    expect(screen.getByTestId('player-jump-to-live')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('player-jump-to-live'));
    expect(jumpSpy).toHaveBeenCalledTimes(1);
    await view.unmount();
  });

  it('manages guide sources and manual channel mapping in GuideManagementOverlay', async () => {
    let guides: GuideSourceRecord[] = [
      {
        id: 'g1',
        sourceId: 's1',
        priority: 0,
        name: 'Primary Guide',
        urlTemplate: '{{g:g1}}',
        epgShiftMs: 0,
        enabled: true,
        lastSyncAt: null,
      },
      {
        id: 'g2',
        sourceId: 's1',
        priority: 1,
        name: 'Backup Guide',
        urlTemplate: '{{g:g2}}',
        epgShiftMs: 0,
        enabled: true,
        lastSyncAt: null,
      },
    ];
    let overrides: ChannelGuideOverrideRecord[] = [];
    const source: SourceRow = {
      id: 's1',
      kind: 'm3u',
      name: 'Demo IPTV',
      createdAt: 1,
      needsImport: false,
      lastCatalogSyncAt: 1,
      lastGuideSyncAt: 1,
    };

    const addGuideSource = jest.fn(async (input) => {
      const rec: GuideSourceRecord = {
        id: 'g3',
        sourceId: input.sourceId,
        priority: guides.length,
        name: input.name,
        urlTemplate: '{{g:g3}}',
        epgShiftMs: input.epgShiftMs ?? 0,
        enabled: true,
        lastSyncAt: null,
      };
      guides = [...guides, rec];
      return ok(rec);
    });
    const reorderGuideSources = jest.fn(async (_sid: string, ids: readonly string[]) => {
      guides = ids
        .map((id, idx) => {
          const found = guides.find((g) => g.id === id);
          return found ? { ...found, priority: idx } : null;
        })
        .filter((g): g is GuideSourceRecord => g !== null);
      return ok(undefined);
    });
    const removeGuideSource = jest.fn(async (id: string) => {
      guides = guides.filter((g) => g.id !== id);
      return ok(undefined);
    });
    const setChannelGuideOverride = jest.fn(async (input) => {
      const rec: ChannelGuideOverrideRecord = {
        sourceId: input.sourceId,
        channelKey: input.channelKey,
        guideSourceId: null,
        guideId: input.guideId ?? null,
        epgShiftMs: input.epgShiftMs ?? 0,
        isManual: true,
        updatedAt: NOW_MS,
      };
      overrides = [rec];
      return ok(rec);
    });
    const clearChannelGuideOverride = jest.fn(async () => {
      overrides = [];
      return ok(undefined);
    });

    const catalog = {
      listGuideSources: jest.fn(async () => guides),
      addGuideSource,
      reorderGuideSources,
      removeGuideSource,
      listChannelGuideOverrides: jest.fn(async () => overrides),
      listGuideChannels: jest.fn(async () => [
        { guideId: 'news24.eu', name: 'News 24 Europe', icon: null, lcn: null },
      ]),
      setChannelGuideOverride,
      clearChannelGuideOverride,
      allSourcesItems: jest.fn(async () => [CATCHUP_CHANNEL]),
      nowNext: jest.fn(async () => []),
    } as unknown as CatalogService;

    const view = await render(
      wrap(
        <GuideManagementOverlay visible source={source} catalog={catalog} onClose={jest.fn()} />,
      ),
    );

    await waitFor(() => expect(screen.getByTestId('guide-source-row-g1')).toBeTruthy());

    // Move g2 up
    await fireEvent.press(screen.getByTestId('guide-source-up-g2'));
    await waitFor(() => expect(reorderGuideSources).toHaveBeenCalledWith('s1', ['g2', 'g1']));

    // Add g3
    await fireEvent.press(screen.getByTestId('guide-source-open-add'));
    await fireEvent.changeText(screen.getByTestId('guide-source-input-name'), 'Third Guide');
    await fireEvent.changeText(
      screen.getByTestId('guide-source-input-url'),
      'http://example.invalid/third.xml',
    );
    await fireEvent.press(screen.getByTestId('guide-source-save'));
    await waitFor(() =>
      expect(addGuideSource).toHaveBeenCalledWith({
        sourceId: 's1',
        name: 'Third Guide',
        url: 'http://example.invalid/third.xml',
        epgShiftMs: 0,
      }),
    );

    // Remove g1
    await fireEvent.press(screen.getByTestId('guide-source-remove-g1'));
    await waitFor(() => expect(removeGuideSource).toHaveBeenCalledWith('g1'));

    // Switch to Channel Mapper tab, assign guide channel & offset, then reset override
    await fireEvent.press(screen.getByTestId('guide-manage-tab-mapper'));
    await waitFor(() =>
      expect(screen.getByTestId(`mapper-channel-row-${CATCHUP_CHANNEL.key}`)).toBeTruthy(),
    );
    expect(screen.getByTestId(`mapper-badge-unmatched-${CATCHUP_CHANNEL.key}`)).toBeTruthy();

    await fireEvent.press(screen.getByTestId(`mapper-assign-${CATCHUP_CHANNEL.key}`));
    await waitFor(() => expect(screen.getByTestId('mapper-guide-option-news24.eu')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('mapper-guide-option-news24.eu'));
    await fireEvent.press(screen.getByTestId(`mapper-offset-inc-${CATCHUP_CHANNEL.key}`));
    await fireEvent.press(screen.getByTestId(`mapper-save-${CATCHUP_CHANNEL.key}`));
    await waitFor(() =>
      expect(setChannelGuideOverride).toHaveBeenCalledWith({
        sourceId: 's1',
        channelKey: CATCHUP_CHANNEL.key,
        guideSourceId: null,
        guideId: 'news24.eu',
        epgShiftMs: HOUR_MS,
      }),
    );

    await waitFor(() =>
      expect(screen.getByTestId(`mapper-badge-manual-${CATCHUP_CHANNEL.key}`)).toBeTruthy(),
    );
    await fireEvent.press(screen.getByTestId(`mapper-clear-${CATCHUP_CHANNEL.key}`));
    await waitFor(() =>
      expect(clearChannelGuideOverride).toHaveBeenCalledWith('s1', CATCHUP_CHANNEL.key),
    );
    await view.unmount();
  });

  it('renders ReminderToastBanner and invokes Tune now and Dismiss cleanly', async () => {
    const onTune = jest.fn();
    const onDismiss = jest.fn();
    const view = await render(
      wrap(
        <ReminderToastBanner
          banner={{
            reminder: {
              profileId: 'default',
              sourceId: 's1',
              channelKey: CATCHUP_CHANNEL.key,
              channelName: CATCHUP_CHANNEL.name,
              programmeTitle: UPCOMING_PROGRAMME.title,
              programmeStart: UPCOMING_PROGRAMME.start,
              programmeStop: UPCOMING_PROGRAMME.stop,
              leadTimeMs: 300_000,
              fired: true,
              createdAt: NOW_MS,
            },
            startsInMinutes: 5,
          }}
          onTune={onTune}
          onDismiss={onDismiss}
        />,
      ),
    );
    expect(screen.getByTestId('reminder-banner-programme').props.children).toBe(
      'Prime Time Report',
    );
    expect(screen.getByTestId('reminder-banner-meta').props.children).toBe(
      'News 24 · Starts in 5 min',
    );
    await fireEvent.press(screen.getByTestId('reminder-banner-tune'));
    expect(onTune).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByTestId('reminder-banner-dismiss'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    await view.unmount();
  });
});
