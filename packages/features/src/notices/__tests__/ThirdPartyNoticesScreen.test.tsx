import { createAppI18n } from '@elv/i18n';
import {
  type AndroidKeyEvent,
  type AndroidKeySource,
  buildTheme,
  FormFactorProvider,
  I18nProvider,
  RemoteKeysProvider,
  ThemeProvider,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Platform, StyleSheet } from 'react-native';
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
        listener?.({ action: 'down', keyCode, canceled: false, ageMs: 0 });
        listener?.({ action: 'up', keyCode, canceled: false, ageMs: 0 });
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

    expect(screen.getByTestId('notices-detail-name')).toHaveTextContent('AetherEngine');
    expect(screen.getByTestId('notices-detail-source')).toHaveTextContent(
      /https:\/\/github\.com\/superuser404notfound\/AetherEngine\/tree\/7\.66\.1/,
    );
    expect(screen.getByTestId('notices-detail-modification')).toHaveTextContent(/Unmodified/i);

    await fireEvent.press(screen.getByTestId('notices-list-row-4'));
    expect(screen.getByTestId('notices-detail-name')).toHaveTextContent(
      'FFmpeg (Android Media3 Audio Extension)',
    );
    expect(screen.getByTestId('notices-detail-text')).toHaveTextContent(/ffmpeg-media3\.yml/);

    const desktopKeys = screen.getByTestId('notices-list-desktop-keys');
    await act(async () => {
      desktopKeys.props.onKeyDown({ key: 'PageDown', preventDefault: jest.fn() });
    });
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

  it('supports TV remote D-pad scrolling, single active focus border, clamped detail step-scroll, scope parking, and Back to top nav', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);

    const keys = createTvKeyHarness();
    const onBack = jest.fn();
    const detailStepOffsets: number[] = [];

    const view = await render(
      <RemoteKeysProvider android={keys.source}>
        <FormFactorProvider value="tv">
          <I18nProvider i18n={createAppI18n('en')}>
            <ThirdPartyNoticesScreen
              onBack={onBack}
              isActiveScope
              onDetailStepScroll={(y) => detailStepOffsets.push(y)}
            />
          </I18nProvider>
        </FormFactorProvider>
      </RemoteKeysProvider>,
    );

    expect(screen.getByTestId('notices-list-ring')).toBeTruthy();
    expect(screen.getByTestId('notices-detail-scroll').props.focusable).toBe(false);
    expect(screen.getByTestId('notices-detail-name')).toHaveTextContent('AetherEngine');

    await keys.press(KEYCODE_DPAD_DOWN);
    await keys.press(KEYCODE_DPAD_DOWN);
    expect(screen.getByTestId('notices-detail-name')).toHaveTextContent(/libdovi/);
    expect(screen.getByTestId('notices-detail-text')).toHaveTextContent(/dav1d/);

    await keys.press(KEYCODE_DPAD_DOWN);
    await keys.press(KEYCODE_DPAD_DOWN);
    await keys.press(KEYCODE_DPAD_DOWN);
    expect(screen.getByTestId('notices-detail-name')).toHaveTextContent(/libass-android/);
    expect(screen.getByTestId('notices-detail-text')).toHaveTextContent(/FriBidi/);

    await keys.press(KEYCODE_DPAD_DOWN);
    expect(screen.getByTestId('notices-detail-name')).toHaveTextContent(/libmpv/);

    // Configure detail viewport (300dp) & content (500dp -> max scroll 200dp)
    await fireEvent(screen.getByTestId('notices-detail-scroll'), 'layout', {
      nativeEvent: { layout: { x: 0, y: 0, width: 520, height: 300 } },
    });
    await fireEvent(screen.getByTestId('notices-detail-scroll'), 'contentSizeChange', 520, 500);

    // Enter detail reading mode with Select: list ring hides (no dual white focus borders),
    // 5 Down presses clamp at max offset 200, and 1 Up press steps immediately to 60 (200 - 140)
    await keys.press(KEYCODE_DPAD_CENTER);
    expect(screen.getByTestId('notices-detail').props.accessibilityState?.selected).toBe(true);
    expect(screen.queryByTestId('notices-list-ring')).toBeNull();

    detailStepOffsets.length = 0;
    for (let i = 0; i < 5; i++) {
      await keys.press(KEYCODE_DPAD_DOWN);
    }
    expect(detailStepOffsets[detailStepOffsets.length - 1]).toBe(200);
    await keys.press(KEYCODE_DPAD_UP);
    expect(detailStepOffsets[detailStepOffsets.length - 1]).toBe(60);

    // Back exits detail mode back to the same libmpv list item and restores list ring
    await keys.press(KEYCODE_BACK);
    expect(screen.getByTestId('notices-detail').props.accessibilityState?.selected).toBe(false);
    expect(screen.getByTestId('notices-list-ring')).toBeTruthy();
    expect(screen.getByTestId('notices-detail-name')).toHaveTextContent(/libmpv/);
    expect(onBack).not.toHaveBeenCalled();

    // Right also enters detail mode (hiding list ring) and Left exits back to list
    await keys.press(KEYCODE_DPAD_RIGHT);
    expect(screen.getByTestId('notices-detail').props.accessibilityState?.selected).toBe(true);
    expect(screen.queryByTestId('notices-list-ring')).toBeNull();
    await keys.press(KEYCODE_DPAD_LEFT);
    expect(screen.getByTestId('notices-detail').props.accessibilityState?.selected).toBe(false);
    expect(screen.getByTestId('notices-list-ring')).toBeTruthy();

    await keys.press(KEYCODE_BACK);
    expect(onBack).toHaveBeenCalledTimes(1);

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

    for (let i = 0; i < 6; i++) {
      await keys.press(KEYCODE_DPAD_UP);
    }
    expect(screen.getByTestId('notices-detail-name')).toHaveTextContent('AetherEngine');
    await keys.press(KEYCODE_DPAD_UP);
    expect(onBack).toHaveBeenCalledTimes(2);

    await view.unmount();
  });

  it('sizes visible rows from listPane onLayout on 540dp TV so row 23 and FocusRing never clip off-screen', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);

    const keys = createTvKeyHarness();
    const view = await render(
      <RemoteKeysProvider android={keys.source}>
        <FormFactorProvider value="tv">
          <I18nProvider i18n={createAppI18n('en')}>
            <ThirdPartyNoticesScreen isActiveScope />
          </I18nProvider>
        </FormFactorProvider>
      </RemoteKeysProvider>,
    );

    await fireEvent(screen.getByTestId('notices-list-pane'), 'layout', {
      nativeEvent: { layout: { x: 0, y: 0, width: 440, height: 300 } },
    });

    for (let i = 0; i < THIRD_PARTY_NOTICES.length - 1; i++) {
      await keys.press(KEYCODE_DPAD_DOWN);
    }

    expect(screen.getByTestId('notices-detail-name')).toHaveTextContent('react-native-web');
    const ringStyle = screen.getByTestId('notices-list-ring').props.style as { top?: number };
    expect(ringStyle.top).toBeGreaterThanOrEqual(0);
    expect(ringStyle.top).toBeLessThanOrEqual(240);

    await view.unmount();
  });

  it('uses single-pane list -> detail drilldown with Back button on phone and split view on tablet', async () => {
    const opSqliteIndex = THIRD_PARTY_NOTICES.findIndex(
      (n) => n.id === 'npm-op-engineering-op-sqlite',
    );
    expect(opSqliteIndex).toBeGreaterThanOrEqual(0);
    const opSqliteSubset = THIRD_PARTY_NOTICES.slice(opSqliteIndex, opSqliteIndex + 4);

    const phoneView = await render(
      <FormFactorProvider value="phone">
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
    expect(screen.queryByTestId('notices-detail')).toBeNull();

    await fireEvent.press(screen.getByTestId('notices-list-row-0'));
    expect(screen.queryByTestId('notices-list')).toBeNull();
    expect(screen.getByTestId('notices-detail')).toBeTruthy();
    expect(screen.getByTestId('notices-detail-name')).toHaveTextContent(
      '@op-engineering/op-sqlite',
    );
    expect(screen.getByTestId('notices-detail-modification')).toHaveTextContent(/Değiştirilmemiş/);
    expect(screen.getByTestId('notices-back-to-list')).toHaveTextContent('Bildirimlere dön');

    await fireEvent.press(screen.getByTestId('notices-back-to-list'));
    expect(screen.getByTestId('notices-list')).toBeTruthy();
    expect(screen.queryByTestId('notices-detail')).toBeNull();
    await phoneView.unmount();

    const tabletView = await render(
      <FormFactorProvider value="tablet">
        <I18nProvider i18n={createAppI18n('tr')}>
          <ThirdPartyNoticesScreen notices={opSqliteSubset} />
        </I18nProvider>
      </FormFactorProvider>,
    );
    expect(screen.getByTestId('notices-list')).toBeTruthy();
    expect(screen.getByTestId('notices-detail')).toBeTruthy();
    expect(screen.getByTestId('notices-detail-modification')).toHaveTextContent(/Değiştirilmemiş/);
    await tabletView.unmount();
  });

  it('supports embedded mode, dynamic highContrast theme tokens, TvFocusAnchor, and >=40dp touch targets', async () => {
    const hcTheme = buildTheme({ preset: 'highContrast' });
    const standalone = await render(
      <ThemeProvider preset="highContrast">
        <ViewportProvider value={{ formFactor: 'phone', inputModality: 'touch' }}>
          <I18nProvider i18n={createAppI18n('en')}>
            <ThirdPartyNoticesScreen />
          </I18nProvider>
        </ViewportProvider>
      </ThemeProvider>,
    );

    const rootStyle = StyleSheet.flatten(screen.getByTestId('notices-screen').props.style);
    expect(rootStyle.backgroundColor).toBe(hcTheme.colors.bgCanvas);

    await fireEvent.press(screen.getByTestId('notices-list-row-0'));
    const backBtn = screen.getByTestId('notices-back-to-list');
    const backStyle = StyleSheet.flatten(
      typeof backBtn.props.style === 'function'
        ? backBtn.props.style({ pressed: false })
        : backBtn.props.style,
    );
    expect(backStyle.minHeight).toBeGreaterThanOrEqual(40);
    expect(backStyle.minWidth).toBeGreaterThanOrEqual(40);
    await standalone.unmount();

    const embedded = await render(
      <ThemeProvider preset="highContrast">
        <ViewportProvider value={{ formFactor: 'tv', inputModality: 'tv' }}>
          <I18nProvider i18n={createAppI18n('en')}>
            <ThirdPartyNoticesScreen embedded isActiveScope />
          </I18nProvider>
        </ViewportProvider>
      </ThemeProvider>,
    );

    const embeddedStyle = StyleSheet.flatten(screen.getByTestId('notices-screen').props.style);
    expect(embeddedStyle.backgroundColor).toBe('transparent');
    expect(embeddedStyle.padding).toBe(0);
    expect(screen.queryByTestId('notices-lgpl-summary')).toBeNull();
    const listPaneStyle = StyleSheet.flatten(screen.getByTestId('notices-list-pane').props.style);
    expect(listPaneStyle.width).toBe(270);
    const anchor = screen.getByTestId('notices-tv-focus-anchor', { includeHiddenElements: true });
    expect(anchor.props.focusable).toBe(true);
    expect(anchor.props.accessibilityElementsHidden).toBe(true);
    await embedded.unmount();

    const embeddedWide = await render(
      <ThemeProvider preset="highContrast">
        <ViewportProvider value={{ formFactor: 'desktop', inputModality: 'pointer' }}>
          <I18nProvider i18n={createAppI18n('en')}>
            <ThirdPartyNoticesScreen embedded />
          </I18nProvider>
        </ViewportProvider>
      </ThemeProvider>,
    );
    const wideListStyle = StyleSheet.flatten(screen.getByTestId('notices-list-pane').props.style);
    expect(wideListStyle.width).toBe(240);
    await embeddedWide.unmount();
  });
});
