import { createAppI18n } from '@elv/i18n';
import {
  type AndroidKeyEvent,
  type AndroidKeySource,
  type FormFactor,
  FormFactorProvider,
  I18nProvider,
  RemoteKeysProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { THIRD_PARTY_NOTICES } from '../notices-data';
import { ThirdPartyNoticesScreen } from '../ThirdPartyNoticesScreen';

const KEYCODE_DPAD_UP = 19;
const KEYCODE_DPAD_DOWN = 20;
const KEYCODE_DPAD_LEFT = 21;
const KEYCODE_DPAD_RIGHT = 22;
const KEYCODE_DPAD_CENTER = 23;
const KEYCODE_BACK = 4;

function createTvKeyHarness() {
  let listener: ((event: AndroidKeyEvent) => void) | undefined;
  let ageMs = 0;
  const source: AndroidKeySource = {
    addListener(cb) {
      listener = cb;
      return {
        remove() {
          listener = undefined;
        },
      };
    },
  };
  return {
    source,
    async press(keyCode: number) {
      await act(async () => {
        ageMs += 10;
        listener?.({ action: 'down', keyCode, canceled: false, ageMs });
        ageMs += 10;
        listener?.({ action: 'up', keyCode, canceled: false, ageMs });
      });
    },
  };
}

describe('ThirdPartyNoticesScreen', () => {
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

  it('renders LGPL summary, native engine pins, SQLite bindings, and JS entries offline with zero network calls', async () => {
    const fetchSpy =
      typeof globalThis.fetch === 'function' ? jest.spyOn(globalThis, 'fetch') : undefined;

    const view = await render(
      <FormFactorProvider value="desktop">
        <I18nProvider i18n={createAppI18n('en')}>
          <ThirdPartyNoticesScreen />
        </I18nProvider>
      </FormFactorProvider>,
    );

    expect(screen.getByTestId('notices-screen')).toBeTruthy();
    expect(screen.getByTestId('notices-lgpl-summary')).toHaveTextContent(/LGPL/);
    expect(screen.getByTestId('notices-list')).toBeTruthy();

    // Initial window includes AetherEngine 7.66.1, Media3 1.11.1, FFmpeg 9.0.2, libmpv 0.42.0, better-sqlite3, electron, expo
    expect(screen.getByTestId('notices-item-aether-engine')).toHaveTextContent(/AetherEngine/);
    expect(screen.getByTestId('notices-item-aether-engine')).toHaveTextContent(/7\.66\.1/);
    expect(screen.getByTestId('notices-item-androidx-media3')).toHaveTextContent(/AndroidX Media3/);
    expect(screen.getByTestId('notices-item-androidx-media3')).toHaveTextContent(/1\.11\.1/);
    expect(screen.getByTestId('notices-item-ffmpeg-media3')).toHaveTextContent(/9\.0\.2/);
    expect(screen.getByTestId('notices-item-desktop-libmpv')).toHaveTextContent(/0\.42\.0/);
    expect(screen.getByTestId('notices-item-npm-better-sqlite3')).toHaveTextContent(
      /better-sqlite3/,
    );
    expect(screen.getByTestId('notices-item-npm-electron')).toHaveTextContent(/electron/);

    // Detail pane shows full AetherEngine provenance & unmodified statement by default
    expect(screen.getByTestId('notices-detail-name')).toHaveTextContent('AetherEngine');
    expect(screen.getByTestId('notices-detail-source')).toHaveTextContent(
      /https:\/\/github\.com\/superuser404notfound\/AetherEngine\/tree\/7\.66\.1/,
    );
    expect(screen.getByTestId('notices-detail-modification')).toHaveTextContent(/Unmodified/i);

    // Selecting FFmpeg 9.0.2 row updates the detail pane
    await fireEvent.press(screen.getByTestId('notices-list-row-4'));
    expect(screen.getByTestId('notices-detail-name')).toHaveTextContent(
      'FFmpeg (Android Media3 Audio Extension)',
    );
    expect(screen.getByTestId('notices-detail-text')).toHaveTextContent(/ffmpeg-media3\.yml/);

    // Desktop keyboard PageDown/ArrowUp scrolls down to op-sqlite & react-native
    const desktopKeys = screen.getByTestId('notices-list-desktop-keys');
    await act(async () => {
      desktopKeys.props.onKeyDown({ key: 'PageDown', preventDefault: jest.fn() });
    });
    await act(async () => {
      desktopKeys.props.onKeyDown({ key: 'PageDown', preventDefault: jest.fn() });
    });
    expect(screen.getByTestId('notices-detail-name')).toHaveTextContent('react-native-web');
    await act(async () => {
      desktopKeys.props.onKeyDown({ key: 'ArrowUp', preventDefault: jest.fn() });
    });
    await act(async () => {
      desktopKeys.props.onKeyDown({ key: 'ArrowUp', preventDefault: jest.fn() });
    });
    expect(screen.getByTestId('notices-detail-name')).toHaveTextContent(/react-native-tvos/);
    expect(THIRD_PARTY_NOTICES.some((n) => n.name === '@op-engineering/op-sqlite')).toBe(true);

    if (fetchSpy) expect(fetchSpy).not.toHaveBeenCalled();
    await view.unmount();
  });

  it('supports TV remote D-pad Down/Up scrolling, non-hijacking detail step-scroll, scope parking, and Back to top nav', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);

    const keys = createTvKeyHarness();
    const onBack = jest.fn();

    const view = await render(
      <RemoteKeysProvider android={keys.source}>
        <FormFactorProvider value="tv">
          <I18nProvider i18n={createAppI18n('en')}>
            <ThirdPartyNoticesScreen onBack={onBack} isActiveScope />
          </I18nProvider>
        </FormFactorProvider>
      </RemoteKeysProvider>,
    );

    expect(screen.getByTestId('notices-list-ring')).toBeTruthy();
    expect(screen.getByTestId('notices-detail-scroll').props.focusable).toBe(false);
    expect(screen.getByTestId('notices-detail-name')).toHaveTextContent('AetherEngine');

    // Step down through Aether frameworks -> codecs -> Media3 -> FFmpeg -> libmpv
    await keys.press(KEYCODE_DPAD_DOWN);
    await keys.press(KEYCODE_DPAD_DOWN);
    expect(screen.getByTestId('notices-detail-name')).toHaveTextContent(/libdovi/);
    expect(screen.getByTestId('notices-detail-text')).toHaveTextContent(/dav1d/);

    await keys.press(KEYCODE_DPAD_DOWN);
    await keys.press(KEYCODE_DPAD_DOWN);
    await keys.press(KEYCODE_DPAD_DOWN);
    expect(screen.getByTestId('notices-detail-name')).toHaveTextContent(/libmpv/);

    // Enter detail reading mode with Select/Right; Back returns to list without calling onBack yet
    await keys.press(KEYCODE_DPAD_CENTER);
    expect(screen.getByTestId('notices-detail').props.accessibilityState?.selected).toBe(true);
    await keys.press(KEYCODE_DPAD_DOWN);
    await keys.press(KEYCODE_BACK);
    expect(screen.getByTestId('notices-detail').props.accessibilityState?.selected).toBe(false);
    expect(onBack).not.toHaveBeenCalled();

    // Right also enters detail mode and Left exits back to list
    await keys.press(KEYCODE_DPAD_RIGHT);
    expect(screen.getByTestId('notices-detail').props.accessibilityState?.selected).toBe(true);
    await keys.press(KEYCODE_DPAD_LEFT);
    expect(screen.getByTestId('notices-detail').props.accessibilityState?.selected).toBe(false);

    // Back from the list invokes onBack to return focus to Top Nav
    await keys.press(KEYCODE_BACK);
    expect(onBack).toHaveBeenCalledTimes(1);

    // Parking the scope (isActiveScope=false) hides the TV focus ring
    await view.rerender(
      <RemoteKeysProvider android={keys.source}>
        <FormFactorProvider value="tv">
          <I18nProvider i18n={createAppI18n('en')}>
            <ThirdPartyNoticesScreen onBack={onBack} isActiveScope={false} />
          </I18nProvider>
        </FormFactorProvider>
      </RemoteKeysProvider>,
    );
    expect(screen.queryByTestId('notices-list-ring')).toBeNull();

    // Restoring isActiveScope=true restores focus to the remembered libmpv item; Up back to row 0 then Up again steps to Top Nav
    await view.rerender(
      <RemoteKeysProvider android={keys.source}>
        <FormFactorProvider value="tv">
          <I18nProvider i18n={createAppI18n('en')}>
            <ThirdPartyNoticesScreen onBack={onBack} isActiveScope />
          </I18nProvider>
        </FormFactorProvider>
      </RemoteKeysProvider>,
    );
    expect(screen.getByTestId('notices-list-ring')).toBeTruthy();
    expect(screen.getByTestId('notices-detail-name')).toHaveTextContent(/libmpv/);

    for (let i = 0; i < 5; i++) {
      await keys.press(KEYCODE_DPAD_UP);
    }
    expect(screen.getByTestId('notices-detail-name')).toHaveTextContent('AetherEngine');
    await keys.press(KEYCODE_DPAD_UP);
    expect(onBack).toHaveBeenCalledTimes(2);

    await view.unmount();
  });

  it.each<FormFactor>(['phone', 'tablet'])(
    'renders localized Turkish notices and semantic testIDs on %s',
    async (formFactor) => {
      const opSqliteIndex = THIRD_PARTY_NOTICES.findIndex(
        (n) => n.id === 'npm-op-engineering-op-sqlite',
      );
      expect(opSqliteIndex).toBeGreaterThanOrEqual(0);
      const opSqliteSubset = THIRD_PARTY_NOTICES.slice(opSqliteIndex, opSqliteIndex + 4);

      const view = await render(
        <FormFactorProvider value={formFactor}>
          <I18nProvider i18n={createAppI18n('tr')}>
            <ThirdPartyNoticesScreen notices={opSqliteSubset} />
          </I18nProvider>
        </FormFactorProvider>,
      );

      expect(screen.getByTestId('notices-screen')).toBeTruthy();
      expect(screen.getByText('Üçüncü taraf yazılım bildirimleri')).toBeTruthy();
      expect(screen.getByTestId('notices-list')).toBeTruthy();
      expect(screen.getByTestId('notices-item-npm-op-engineering-op-sqlite')).toHaveTextContent(
        /@op-engineering\/op-sqlite/,
      );
      expect(screen.getByTestId('notices-detail-modification')).toHaveTextContent(
        /Değiştirilmemiş/,
      );

      await view.unmount();
    },
  );
});
