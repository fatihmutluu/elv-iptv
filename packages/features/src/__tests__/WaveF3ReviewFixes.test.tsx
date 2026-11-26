import type {
  CatalogService,
  ChannelGuideOverrideRecord,
  GuideChannelOption,
  GuideSourceRecord,
  ItemRow,
  ProgrammeRow,
  SourceRow,
} from '@elv/data';
import { ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { createFakePlayerEngine } from '@elv/playback/testing';
import {
  type AndroidKeyEvent,
  type AndroidKeySource,
  FormFactorProvider,
  I18nProvider,
  RemoteKeysProvider,
  ThemeProvider,
  TvRemoteProvider,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { Platform, View } from 'react-native';
import {
  AppShell,
  EpgProgrammeDetailModal,
  GuideManagementOverlay,
  ReminderToastBanner,
  type VideoHost,
} from '../index';

const KEYCODE_BACK = 4;
const KEYCODE_DPAD_UP = 19;
const KEYCODE_DPAD_DOWN = 20;
const KEYCODE_DPAD_LEFT = 21;
const KEYCODE_DPAD_RIGHT = 22;
const KEYCODE_DPAD_CENTER = 23;

const NOW_MS = new Date(2026, 4, 15, 18, 0, 0, 0).getTime();
const HOUR_MS = 3_600_000;

function createManualAndroidKeySource() {
  let listener: ((ev: AndroidKeyEvent) => void) | null = null;
  const source: AndroidKeySource = {
    addListener(fn) {
      listener = fn;
      return {
        remove() {
          if (listener === fn) listener = null;
        },
      };
    },
  };
  const sendKey = async (keyCode: number) => {
    await act(async () => {
      listener?.({ keyCode, action: 'down', canceled: false, ageMs: 0 });
      listener?.({ keyCode, action: 'up', canceled: false, ageMs: 0 });
    });
  };
  return { source, sendKey };
}

function wrap(
  node: ReactElement,
  opts?: {
    readonly formFactor?: 'tv' | 'desktop';
    readonly androidSource?: AndroidKeySource;
  },
): ReactElement {
  const formFactor = opts?.formFactor ?? 'desktop';
  const isTv = formFactor === 'tv';
  const inner = (
    <TvRemoteProvider>
      <ThemeProvider>
        <ViewportProvider
          value={{
            width: isTv ? 1920 : 1280,
            height: isTv ? 1080 : 720,
            formFactor,
            inputModality: isTv ? 'tv' : 'pointer',
            orientation: 'landscape',
            safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
          }}
        >
          <FormFactorProvider value={formFactor}>
            <I18nProvider i18n={createAppI18n('en')}>{node}</I18nProvider>
          </FormFactorProvider>
        </ViewportProvider>
      </ThemeProvider>
    </TvRemoteProvider>
  );
  return opts?.androidSource !== undefined ? (
    <RemoteKeysProvider android={opts.androidSource}>{inner}</RemoteKeysProvider>
  ) : (
    inner
  );
}

const DEMO_SOURCE: SourceRow = {
  id: 's1',
  kind: 'm3u',
  name: 'Demo IPTV',
  createdAt: 1,
  needsImport: false,
};

const makeChannel = (idx: number, overrides: Partial<ItemRow> = {}): ItemRow => ({
  id: idx,
  key: `m:s1:live:${idx}`,
  kind: 'live',
  sourceId: 's1',
  providerId: String(idx),
  name: `Channel ${idx}`,
  logo: null,
  rating: null,
  year: null,
  num: idx,
  catchupDays: 3,
  ...overrides,
});

describe('Wave F3 Review Fixes — Guides TV D-Pad, Uncapped Mapper, Reminder Banner TV & Modal Hardening', () => {
  beforeEach(() => {
    jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1);
    jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('supports full TV D-pad navigation in GuideManagementOverlay across GuideSourcesTab and ChannelMapperTab (#1, #11, #14)', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
    const remote = createManualAndroidKeySource();
    const guides: GuideSourceRecord[] = [
      {
        id: 'g1',
        sourceId: 's1',
        priority: 0,
        name: 'Primary XMLTV',
        urlTemplate: '{{g:g1}}',
        epgShiftMs: 0,
        enabled: true,
        lastSyncAt: null,
      },
    ];
    const ch1 = makeChannel(1, { name: 'News 24' });
    const guideOptions: GuideChannelOption[] = [
      {
        guideId: 'news24.eu',
        name: 'News 24 EU',
        icon: null,
        lcn: null,
        guideSourceId: 'g1',
      },
    ];
    const updateGuideSource = jest.fn(async (id: string, patch: { epgShiftMs?: number }) => {
      const target = guides.find((g) => g.id === id);
      if (target && patch.epgShiftMs !== undefined) {
        guides[0] = { ...target, epgShiftMs: patch.epgShiftMs };
      }
      return ok(guides[0] as GuideSourceRecord);
    });
    const listGuideChannels = jest.fn(async () => guideOptions);
    const setChannelGuideOverride = jest.fn(async (input) =>
      ok({
        sourceId: input.sourceId,
        channelKey: input.channelKey,
        guideSourceId: input.guideSourceId ?? null,
        guideId: input.guideId ?? null,
        epgShiftMs: input.epgShiftMs ?? 0,
        isManual: true,
        updatedAt: NOW_MS,
      }),
    );

    const catalog = {
      listGuideSources: jest.fn(async () => [...guides]),
      addGuideSource: jest.fn(async () => ok(guides[0] as GuideSourceRecord)),
      updateGuideSource,
      removeGuideSource: jest.fn(async () => ok(undefined)),
      reorderGuideSources: jest.fn(async () => ok(undefined)),
      listGuideChannels,
      listChannelGuideOverrides: jest.fn(async () => [] as ChannelGuideOverrideRecord[]),
      setChannelGuideOverride,
      clearChannelGuideOverride: jest.fn(async () => ok(undefined)),
      allSourcesItems: jest.fn(async () => [ch1]),
      nowNext: jest.fn(async () => []),
    } as unknown as CatalogService;

    const onClose = jest.fn();
    const view = await render(
      wrap(
        <GuideManagementOverlay visible source={DEMO_SOURCE} catalog={catalog} onClose={onClose} />,
        { formFactor: 'tv', androidSource: remote.source },
      ),
    );
    await waitFor(() => expect(screen.getByTestId('guide-source-row-g1')).toBeTruthy());

    await remote.sendKey(KEYCODE_DPAD_DOWN); // add-cta
    await remote.sendKey(KEYCODE_DPAD_DOWN); // g1 row col 0
    await remote.sendKey(KEYCODE_DPAD_RIGHT); // down
    await remote.sendKey(KEYCODE_DPAD_RIGHT); // -1h
    await remote.sendKey(KEYCODE_DPAD_RIGHT); // +1h
    await remote.sendKey(KEYCODE_DPAD_CENTER);
    await waitFor(() =>
      expect(updateGuideSource).toHaveBeenCalledWith('g1', { epgShiftMs: HOUR_MS }),
    );

    await remote.sendKey(KEYCODE_DPAD_UP);
    await remote.sendKey(KEYCODE_DPAD_UP);
    await remote.sendKey(KEYCODE_DPAD_RIGHT);
    await remote.sendKey(KEYCODE_DPAD_CENTER);
    await waitFor(() => expect(screen.getByTestId(`mapper-channel-row-${ch1.key}`)).toBeTruthy());

    await remote.sendKey(KEYCODE_DPAD_DOWN); // filters
    await remote.sendKey(KEYCODE_DPAD_DOWN); // search
    await remote.sendKey(KEYCODE_DPAD_DOWN); // ch1 row (assign)
    await remote.sendKey(KEYCODE_DPAD_CENTER); // open editor
    await waitFor(() => expect(screen.getByTestId('mapper-guide-option-news24.eu')).toBeTruthy());
    expect(listGuideChannels).toHaveBeenCalledTimes(1);

    await remote.sendKey(KEYCODE_DPAD_DOWN); // editor-options (news24.eu)
    await remote.sendKey(KEYCODE_DPAD_CENTER);
    await remote.sendKey(KEYCODE_DPAD_DOWN); // editor-offset (-1h)
    await remote.sendKey(KEYCODE_DPAD_RIGHT); // editor-offset (+1h)
    await remote.sendKey(KEYCODE_DPAD_CENTER);
    await remote.sendKey(KEYCODE_DPAD_DOWN); // editor-actions
    await remote.sendKey(KEYCODE_DPAD_LEFT); // col 0 = save
    await remote.sendKey(KEYCODE_DPAD_CENTER);

    await waitFor(() =>
      expect(setChannelGuideOverride).toHaveBeenCalledWith({
        sourceId: 's1',
        channelKey: ch1.key,
        guideSourceId: 'g1',
        guideId: 'news24.eu',
        epgShiftMs: HOUR_MS,
      }),
    );
    expect(onClose).not.toHaveBeenCalled();
    await view.unmount();
  });

  it('searches and maps channels beyond the 200-channel page in ChannelMapperTab (#14)', async () => {
    const page1 = Array.from({ length: 201 }, (_, i) => makeChannel(i + 1));
    const ch250 = makeChannel(250, { name: 'Canal 250 Special' });
    const search = jest.fn(async () => ({
      live: [ch250],
      epg: [],
      movies: [],
      series: [],
      episodes: [],
    }));
    const catalog = {
      listGuideSources: jest.fn(async () => []),
      listChannelGuideOverrides: jest.fn(async () => []),
      listGuideChannels: jest.fn(async () => []),
      allSourcesItems: jest.fn(async (_k: string, offset: number) =>
        offset === 0 ? page1 : [ch250],
      ),
      search,
      nowNext: jest.fn(async () => []),
    } as unknown as CatalogService;

    const view = await render(
      wrap(
        <GuideManagementOverlay
          visible
          initialTab="mapper"
          source={DEMO_SOURCE}
          catalog={catalog}
          onClose={jest.fn()}
        />,
      ),
    );
    await waitFor(() => expect(screen.getByTestId('mapper-load-more')).toBeTruthy());

    await fireEvent.changeText(screen.getByTestId('mapper-search-input'), 'Canal 250');
    await waitFor(() =>
      expect(search).toHaveBeenCalledWith('Canal 250', {
        scope: 'live',
        sourceId: 's1',
        limit: 200,
      }),
    );
    await waitFor(() => expect(screen.getByTestId(`mapper-channel-row-${ch250.key}`)).toBeTruthy());
    await view.unmount();
  });

  it('supports TV remote Left/Right/Select/Back on ReminderToastBanner (#2)', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
    const remote = createManualAndroidKeySource();
    const onTune = jest.fn();
    const onDismiss = jest.fn();
    const banner = {
      reminder: {
        profileId: 'default',
        sourceId: 's1',
        channelKey: 'm:s1:live:1',
        channelName: 'News 24',
        programmeTitle: 'Evening News',
        programmeStart: NOW_MS + 300_000,
        programmeStop: NOW_MS + HOUR_MS,
        leadTimeMs: 300_000,
        fired: true,
        createdAt: 1,
      },
      startsInMinutes: 5,
    };

    const view = await render(
      wrap(<ReminderToastBanner banner={banner} onTune={onTune} onDismiss={onDismiss} />, {
        formFactor: 'tv',
        androidSource: remote.source,
      }),
    );

    await remote.sendKey(KEYCODE_DPAD_CENTER);
    expect(onTune).toHaveBeenCalledTimes(1);

    await remote.sendKey(KEYCODE_DPAD_RIGHT);
    await remote.sendKey(KEYCODE_DPAD_CENTER);
    expect(onDismiss).toHaveBeenCalledTimes(1);

    await remote.sendKey(KEYCODE_DPAD_LEFT);
    await remote.sendKey(KEYCODE_BACK);
    expect(onDismiss).toHaveBeenCalledTimes(2);
    await view.unmount();
  });

  it('truncates >256-char reminder labels and clears archiveCacheRef when catalog prop changes (#17, #19)', async () => {
    const longChannel = makeChannel(1, { name: `CH_${'A'.repeat(300)}\u0007` });
    const longUpcoming: ProgrammeRow = {
      channelKey: longChannel.key,
      sourceId: 's1',
      guideId: 'ch1',
      start: NOW_MS + HOUR_MS,
      stop: NOW_MS + 2 * HOUR_MS,
      title: `SHOW_${'B'.repeat(310)}\n`,
      subTitle: null,
      description: null,
      episodeNum: null,
      icon: null,
      genre: null,
      flags: 0,
    };
    const upsertReminder = jest.fn(async (input) =>
      ok({
        profileId: 'default',
        ...input,
        leadTimeMs: 300_000,
        fired: false,
        createdAt: NOW_MS,
      }),
    );
    const view = await render(
      wrap(
        <EpgProgrammeDetailModal
          visible
          channel={longChannel}
          channelIndex={0}
          programme={longUpcoming}
          nowMs={NOW_MS}
          isFavorite={false}
          isTv={false}
          catalog={
            {
              upsertReminder,
              removeReminder: jest.fn(async () => ok(undefined)),
            } as unknown as CatalogService
          }
          onTuneChannel={jest.fn()}
          onClose={jest.fn()}
        />,
      ),
    );
    await fireEvent.press(screen.getByTestId('epg-detail-reminder'));
    await waitFor(() => expect(upsertReminder).toHaveBeenCalledTimes(1));
    const arg = upsertReminder.mock.calls[0]?.[0] as {
      channelName: string;
      programmeTitle: string;
    };
    expect(arg.channelName.length).toBeLessThanOrEqual(256);
    expect(arg.programmeTitle.length).toBeLessThanOrEqual(256);
    expect(arg.channelName).not.toContain('\u0007');
    expect(arg.programmeTitle).not.toContain('\n');
    await view.unmount();

    const pastProg: ProgrammeRow = {
      ...longUpcoming,
      start: NOW_MS - 2 * HOUR_MS,
      stop: NOW_MS - HOUR_MS,
      title: 'Past Show',
    };
    const fetch1 = jest.fn(async () => ok([{ ...pastProg, hasArchive: true }]));
    const fetch2 = jest.fn(async () => ok([{ ...pastProg, hasArchive: false }]));
    const cat1 = { fetchChannelArchiveEpg: fetch1 } as unknown as CatalogService;
    const cat2 = { fetchChannelArchiveEpg: fetch2 } as unknown as CatalogService;

    const cacheView = await render(
      wrap(
        <EpgProgrammeDetailModal
          visible
          channel={makeChannel(1, { catchupDays: 3 })}
          channelIndex={0}
          programme={pastProg}
          nowMs={NOW_MS}
          isFavorite={false}
          isTv={false}
          catalog={cat1}
          onTuneChannel={jest.fn()}
          onWatchCatchup={jest.fn()}
          onClose={jest.fn()}
        />,
      ),
    );
    await waitFor(() => expect(fetch1).toHaveBeenCalledTimes(1));
    await cacheView.rerender(
      wrap(
        <EpgProgrammeDetailModal
          visible
          channel={makeChannel(1, { catchupDays: 3 })}
          channelIndex={0}
          programme={pastProg}
          nowMs={NOW_MS}
          isFavorite={false}
          isTv={false}
          catalog={cat2}
          onTuneChannel={jest.fn()}
          onWatchCatchup={jest.fn()}
          onClose={jest.fn()}
        />,
      ),
    );
    await waitFor(() => expect(fetch2).toHaveBeenCalledTimes(1));
    await cacheView.unmount();
  });

  it('gates GuideManagementOverlay at AppShell root behind parental PIN when locked (#14)', async () => {
    const engine = createFakePlayerEngine({
      now: () => 1_000,
      schedule: () => 1,
      cancel: () => undefined,
    });
    const catalog = {
      listSources: jest.fn(async () => [DEMO_SOURCE]),
      listProfiles: jest.fn(async () => [
        { id: 'default', name: 'Viewer', avatarToken: 'crimson', isKids: false, createdAt: 1 },
      ]),
      getParentalSettings: jest.fn(async () => ({
        enabled: true,
        hideAdultKeywords: true,
        maxRating: null,
        sessionMinutes: 30,
      })),
      listParentalLocks: jest.fn(async () => []),
      hasParentalPin: jest.fn(async () => true),
      verifyParentalPin: jest.fn(async (pin: string) => ({
        ok: pin === '1234',
        attemptsRemaining: 3,
      })),
      categories: jest.fn(async () => []),
      items: jest.fn(async () => []),
      allSourcesItems: jest.fn(async () => []),
      listGuideSources: jest.fn(async () => []),
      listChannelGuideOverrides: jest.fn(async () => []),
      listContinueWatching: jest.fn(async () => []),
      listFavorites: jest.fn(async () => []),
      listFavoriteKeys: jest.fn(async () => []),
      listReminders: jest.fn(async () => []),
      pruneExpiredReminders: jest.fn(async () => 0),
      close: jest.fn(async () => undefined),
    } as unknown as CatalogService;
    const videoHost: VideoHost = {
      open: () => ({
        engine,
        renderSurface: () => <View />,
      }),
    };

    const view = await render(wrap(<AppShell catalog={catalog} videoHost={videoHost} />));
    await waitFor(() => expect(screen.getByTestId('nav-tab-settings')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('nav-tab-settings'));
    await waitFor(() => expect(screen.getByTestId('settings-tab-sources')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('settings-tab-sources'));
    await waitFor(() => expect(screen.getByTestId('source-advanced-s1')).toBeTruthy());

    await fireEvent.press(screen.getByTestId('source-advanced-s1'));
    await waitFor(() => expect(screen.getByTestId('source-guides-s1')).toBeTruthy());

    await fireEvent.press(screen.getByTestId('source-guides-s1'));
    await waitFor(() => expect(screen.getByTestId('pin-entry-overlay')).toBeTruthy());
    expect(screen.queryByTestId('guide-management-overlay')).toBeNull();
    await view.unmount();
  });
});
