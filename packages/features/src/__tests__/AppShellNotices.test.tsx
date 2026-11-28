import { createCatalogService, openCatalog } from '@elv/data';
import { countingScheduler, memorySecrets, testDb } from '@elv/data/testing';
import { elvError, err, type HttpClient } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { createFakePlayerEngine } from '@elv/playback/testing';
import {
  type AndroidKeyEvent,
  type AndroidKeySource,
  type FormFactor,
  FormFactorProvider,
  I18nProvider,
  RemoteKeysProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Platform, View } from 'react-native';
import { AppShell } from '../AppShell';
import type { VideoHost } from '../ports/video-host';

const KEYCODE_DPAD_DOWN = 20;
const KEYCODE_DPAD_LEFT = 21;
const KEYCODE_DPAD_RIGHT = 22;
const KEYCODE_BACK = 4;

const offlineHttpClient: HttpClient = {
  async get() {
    return err(elvError('network', 'offline'));
  },
};

async function openOfflineShell() {
  const handle = testDb();
  const migrated = await openCatalog(handle.db);
  if (!migrated.ok) throw new Error('migrate failed');
  let now = 1_700_000_000_000;
  let nextId = 1;
  const catalog = createCatalogService({
    db: handle.db,
    secrets: memorySecrets(),
    scheduler: countingScheduler(),
    http: offlineHttpClient,
    clock: () => {
      now += 10;
      return now;
    },
    newId: () => `src-${nextId++}`,
  });
  const engine = createFakePlayerEngine({
    now: () => performance.now(),
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });
  const videoHost: VideoHost = {
    open: () => ({
      engine,
      renderSurface: ({ testID }) => <View testID={testID ?? 'shell-surface'} />,
    }),
  };
  return {
    catalog,
    videoHost,
    async cleanup() {
      await catalog.close();
      handle.close();
    },
  };
}

describe('AppShell Settings -> About & Licenses', () => {
  beforeEach(() => {
    jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each<FormFactor>(['phone', 'desktop'])(
    'opens ThirdPartyNoticesScreen offline from Settings -> About & Licenses on %s',
    async (formFactor) => {
      const env = await openOfflineShell();
      let view: Awaited<ReturnType<typeof render>> | undefined;
      try {
        view = await render(
          <FormFactorProvider value={formFactor}>
            <I18nProvider i18n={createAppI18n('en')}>
              <AppShell catalog={env.catalog} videoHost={env.videoHost} />
            </I18nProvider>
          </FormFactorProvider>,
        );

        expect(screen.getByTestId('nav-tab-home')).toBeTruthy();
        expect(screen.getByTestId('nav-utility-search').props.accessibilityLabel).toBe('Search');
        expect(screen.getByTestId('nav-utility-library').props.accessibilityLabel).toBe('Library');
        expect(screen.getByTestId('nav-tab-home').props.accessibilityState.selected).toBe(false);

        await fireEvent.press(screen.getByTestId('settings-tab-licenses'));

        expect(screen.getByTestId('settings-about-card')).toBeTruthy();
        expect(screen.getByTestId('notices-screen')).toBeTruthy();
        expect(screen.getByText('ELV IPTV')).toBeTruthy();
        if (formFactor === 'phone') {
          expect(screen.queryByTestId('notices-detail')).toBeNull();
          await fireEvent.press(screen.getByTestId('notices-list-row-0'));
          expect(screen.getByTestId('notices-back-to-list')).toHaveTextContent('Back to notices');
        }
        expect(screen.getByTestId('notices-detail-name')).toHaveTextContent('AetherEngine');
        expect(screen.getByTestId('notices-detail-version')).toHaveTextContent(/7\.66\.1/);
      } finally {
        await view?.unmount();
        await env.cleanup();
      }
    },
  );

  it('navigates Top Nav -> Settings -> About & Licenses on TV, scrolls with D-pad, and returns cleanly to sidebar then Top Nav on Back', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);

    let keyListener: ((e: AndroidKeyEvent) => void) | undefined;
    const androidSource: AndroidKeySource = {
      addListener: (l) => {
        keyListener = l;
        return {
          remove: () => {
            keyListener = undefined;
          },
        };
      },
    };
    const pressKey = async (keyCode: number) => {
      await act(async () => {
        keyListener?.({ action: 'down', keyCode, canceled: false, ageMs: 0 });
        keyListener?.({ action: 'up', keyCode, canceled: false, ageMs: 10 });
      });
    };

    const env = await openOfflineShell();
    let view: Awaited<ReturnType<typeof render>> | undefined;
    try {
      view = await render(
        <RemoteKeysProvider android={androidSource}>
          <FormFactorProvider value="tv">
            <I18nProvider i18n={createAppI18n('en')}>
              <AppShell catalog={env.catalog} videoHost={env.videoHost} />
            </I18nProvider>
          </FormFactorProvider>
        </RemoteKeysProvider>,
      );

      // Start on empty catalog (Settings -> Sources content pane)
      expect(screen.getByTestId('sources-screen')).toBeTruthy();

      // Back -> Settings sidebar -> Back -> Top Nav -> Left highlights Profile (without leaving Settings)
      await pressKey(KEYCODE_BACK);
      expect(
        screen.getByTestId('settings-tv-focus-anchor', { includeHiddenElements: true }),
      ).toBeTruthy();

      await pressKey(KEYCODE_BACK);
      expect(
        screen.getByTestId('nav-tv-focus-anchor', { includeHiddenElements: true }),
      ).toBeTruthy();

      await pressKey(KEYCODE_DPAD_LEFT);
      expect(screen.queryByTestId('profile-dropdown-menu')).toBeNull();
      expect(screen.getByTestId('settings-screen')).toBeTruthy();

      // Down enters Settings sidebar -> Down moves from Sources to About & Licenses
      await pressKey(KEYCODE_DPAD_DOWN);
      expect(
        screen.queryByTestId('nav-tv-focus-anchor', { includeHiddenElements: true }),
      ).toBeNull();
      expect(
        screen.getByTestId('settings-tv-focus-anchor', { includeHiddenElements: true }),
      ).toBeTruthy();

      await pressKey(KEYCODE_DPAD_DOWN);
      await pressKey(KEYCODE_DPAD_DOWN);
      await pressKey(KEYCODE_DPAD_DOWN);
      expect(screen.getByTestId('settings-tab-licenses').props.accessibilityState.selected).toBe(
        true,
      );
      expect(screen.getByTestId('notices-screen')).toBeTruthy();
      expect(screen.queryByTestId('notices-list-ring')).toBeNull();

      // Right enters embedded Notices list -> Down x2 scrolls to libdovi
      await pressKey(KEYCODE_DPAD_RIGHT);
      expect(
        screen.queryByTestId('settings-tv-focus-anchor', { includeHiddenElements: true }),
      ).toBeNull();
      expect(screen.getByTestId('notices-list-ring')).toBeTruthy();

      await pressKey(KEYCODE_DPAD_DOWN);
      await pressKey(KEYCODE_DPAD_DOWN);
      expect(screen.getByTestId('notices-detail-name')).toHaveTextContent(/libdovi/);

      // Back returns cleanly to Settings sidebar (parking notices list ring)
      await pressKey(KEYCODE_BACK);
      expect(
        screen.getByTestId('settings-tv-focus-anchor', { includeHiddenElements: true }),
      ).toBeTruthy();
      expect(screen.queryByTestId('notices-list-ring')).toBeNull();

      // Back again returns cleanly to Top Nav
      await pressKey(KEYCODE_BACK);
      expect(
        screen.getByTestId('nav-tv-focus-anchor', { includeHiddenElements: true }),
      ).toBeTruthy();
    } finally {
      await view?.unmount();
      await env.cleanup();
    }
  });
});
