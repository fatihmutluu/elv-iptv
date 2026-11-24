import { updateSourceSettings } from '@elv/data';
import { createAppI18n } from '@elv/i18n';
import {
  type AndroidKeyEvent,
  type AndroidKeySource,
  buildTheme,
  type FormFactor,
  FormFactorProvider,
  I18nProvider,
  RemoteKeysProvider,
  ThemeProvider,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { BackHandler, Platform, StyleSheet } from 'react-native';
import type { PlaybackGuard } from '../../ports/playback-guard';
import { SourcesScreen } from '../SourcesScreen';
import { openTestCatalog } from './sources-test-harness';

const KEYCODE_DPAD_UP = 19;
const KEYCODE_DPAD_DOWN = 20;
const KEYCODE_DPAD_CENTER = 23;
const KEYCODE_BACK = 4;

function createFakeAndroidKeys() {
  let listener: ((e: AndroidKeyEvent) => void) | undefined;
  const source: AndroidKeySource = {
    addListener: (l) => {
      listener = l;
      return {
        remove: () => {
          listener = undefined;
        },
      };
    },
  };
  return {
    source,
    tap(keyCode: number) {
      listener?.({ action: 'down', keyCode, canceled: false, ageMs: 0 });
      listener?.({ action: 'up', keyCode, canceled: false, ageMs: 10 });
    },
  };
}

describe('SourcesScreen (#71)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('adds an Xtream demo source, imports immediately, and displays live/movie/series counts', async () => {
    const env = await openTestCatalog();
    try {
      const view = await render(
        <FormFactorProvider value="desktop">
          <I18nProvider i18n={createAppI18n('en')}>
            <SourcesScreen catalog={env.catalog} />
          </I18nProvider>
        </FormFactorProvider>,
      );

      await fireEvent.changeText(
        screen.getByTestId('sources-input-server'),
        'http://sim.example.test:7878',
      );
      await fireEvent.changeText(screen.getByTestId('sources-input-username'), 'demo');
      await fireEvent.changeText(screen.getByTestId('sources-input-password'), 'demo');
      await fireEvent.press(screen.getByTestId('sources-submit'));

      await waitFor(() => {
        expect(screen.getByTestId('source-status-src-1')).toHaveTextContent(
          '2 live channels, 1 movie, 1 series',
        );
      });

      const categories = await env.catalog.categories('src-1', 'live');
      expect(categories.length).toBe(1);
      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });

  it('auto-converts pasted get.php links in M3U mode unless Keep as M3U is toggled', async () => {
    const env = await openTestCatalog();
    try {
      const view = await render(
        <FormFactorProvider value="desktop">
          <I18nProvider i18n={createAppI18n('en')}>
            <SourcesScreen catalog={env.catalog} />
          </I18nProvider>
        </FormFactorProvider>,
      );

      await fireEvent.press(screen.getByTestId('sources-mode-m3u'));
      const getPhpUrl =
        'http://sim.example.test:7878/get.php?username=demo&password=demo&output=ts';
      await fireEvent.changeText(screen.getByTestId('sources-input-playlist-url'), getPhpUrl);

      expect(screen.getByTestId('sources-xtream-detected-notice')).toBeTruthy();

      await fireEvent.press(screen.getByTestId('sources-submit'));
      await waitFor(() => {
        expect(screen.getByTestId('source-status-src-1')).toHaveTextContent(
          '2 live channels, 1 movie, 1 series',
        );
      });
      const firstList = await env.catalog.listSources();
      expect(firstList[0]?.kind).toBe('xtream');

      // Add a second time with Keep as M3U enabled
      await fireEvent.changeText(screen.getByTestId('sources-input-playlist-url'), getPhpUrl);
      await fireEvent.press(screen.getByTestId('sources-toggle-keep-m3u'));
      await fireEvent.press(screen.getByTestId('sources-submit'));

      await waitFor(() => {
        expect(screen.getByTestId('source-status-src-2')).toHaveTextContent(
          '2 live channels, 0 movies, 0 series',
        );
      });
      const secondList = await env.catalog.listSources();
      expect(secondList.find((s) => s.id === 'src-2')?.kind).toBe('m3u');
      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });

  it('renders distinct localized errors for missing scheme, invalid credentials, unreachable host, and empty playlists in en and tr', async () => {
    const env = await openTestCatalog();
    const i18n = createAppI18n('en');
    try {
      const view = await render(
        <FormFactorProvider value="phone">
          <I18nProvider i18n={i18n}>
            <SourcesScreen catalog={env.catalog} />
          </I18nProvider>
        </FormFactorProvider>,
      );

      // 1. Missing scheme (pre-import validation)
      await fireEvent.changeText(
        screen.getByTestId('sources-input-server'),
        'panel.example.test:8080',
      );
      await fireEvent.changeText(screen.getByTestId('sources-input-username'), 'demo');
      await fireEvent.changeText(screen.getByTestId('sources-input-password'), 'demo');
      await fireEvent.press(screen.getByTestId('sources-submit'));
      const missingSchemeEn = screen.getByTestId('sources-form-error').props.children as string;
      expect(missingSchemeEn).toContain('http://');

      // 2. Wrong credentials -> auth/invalid-credentials
      await fireEvent.changeText(
        screen.getByTestId('sources-input-server'),
        'http://sim.example.test:7878',
      );
      await fireEvent.changeText(screen.getByTestId('sources-input-username'), 'demo');
      await fireEvent.changeText(screen.getByTestId('sources-input-password'), 'pass');
      await fireEvent.press(screen.getByTestId('sources-submit'));

      await waitFor(() => {
        expect(screen.getByTestId('source-error-src-1')).toBeTruthy();
      });
      const authMsgEn = screen.getByTestId('source-error-src-1').props.children as string;

      // 3. Unreachable server -> network/unreachable
      await fireEvent.changeText(
        screen.getByTestId('sources-input-server'),
        'http://unreachable.example.test:7878',
      );
      await fireEvent.changeText(screen.getByTestId('sources-input-username'), 'demo');
      await fireEvent.changeText(screen.getByTestId('sources-input-password'), 'demo');
      await fireEvent.press(screen.getByTestId('sources-submit'));

      await waitFor(() => {
        expect(screen.getByTestId('source-error-src-2')).toBeTruthy();
      });
      const netMsgEn = screen.getByTestId('source-error-src-2').props.children as string;

      // 4. Empty playlist -> source-format/empty-source -> emptyPlaylist
      await fireEvent.press(screen.getByTestId('sources-mode-m3u'));
      await fireEvent.changeText(
        screen.getByTestId('sources-input-playlist-url'),
        'http://sim.example.test:7878/playlists/empty.m3u8',
      );
      await fireEvent.press(screen.getByTestId('sources-submit'));

      await waitFor(() => {
        expect(screen.getByTestId('source-error-src-3')).toBeTruthy();
      });
      const emptyMsgEn = screen.getByTestId('source-error-src-3').props.children as string;

      expect(new Set([missingSchemeEn, authMsgEn, netMsgEn, emptyMsgEn]).size).toBe(4);

      // Switch to Turkish and verify every error message localizes distinctly
      await act(async () => {
        i18n.setLocale('tr');
      });
      const authMsgTr = screen.getByTestId('source-error-src-1').props.children as string;
      const netMsgTr = screen.getByTestId('source-error-src-2').props.children as string;
      const emptyMsgTr = screen.getByTestId('source-error-src-3').props.children as string;
      expect(authMsgTr).not.toBe(authMsgEn);
      expect(new Set([authMsgTr, netMsgTr, emptyMsgTr]).size).toBe(3);
      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });

  it('stops active playback and aborts an in-flight import cleanly when Remove is pressed', async () => {
    let releaseLive!: () => void;
    const hangLiveUntil = new Promise<void>((resolve) => {
      releaseLive = resolve;
    });
    const env = await openTestCatalog({ hangLiveUntil });
    const stoppedIds: string[] = [];
    const playbackGuard: PlaybackGuard = {
      stopIfUsingSource: (id) => {
        stoppedIds.push(id);
      },
    };

    try {
      const view = await render(
        <FormFactorProvider value="tablet">
          <I18nProvider i18n={createAppI18n('en')}>
            <SourcesScreen catalog={env.catalog} playbackGuard={playbackGuard} />
          </I18nProvider>
        </FormFactorProvider>,
      );

      await fireEvent.changeText(
        screen.getByTestId('sources-input-server'),
        'http://sim.example.test:7878',
      );
      await fireEvent.changeText(screen.getByTestId('sources-input-username'), 'demo');
      await fireEvent.changeText(screen.getByTestId('sources-input-password'), 'demo');
      await fireEvent.press(screen.getByTestId('sources-submit'));

      await waitFor(() => {
        expect(screen.getByTestId('source-cancel-src-1')).toBeTruthy();
      });

      await fireEvent.press(screen.getByTestId('source-remove-src-1'));
      releaseLive();

      await waitFor(() => {
        expect(screen.queryByTestId('source-row-src-1')).toBeNull();
      });
      expect(stoppedIds).toEqual(['src-1']);
      expect(await env.catalog.listSources()).toEqual([]);
      expect(env.secrets.dump()).toEqual({});
      await view.unmount();
    } finally {
      releaseLive();
      await env.cleanup();
    }
  });

  it.each<FormFactor>(['tv', 'phone', 'tablet', 'desktop'])(
    'renders stable semantic testIDs across %s form factor',
    async (ff) => {
      const env = await openTestCatalog();
      try {
        const view = await render(
          <FormFactorProvider value={ff}>
            <I18nProvider i18n={createAppI18n('en')}>
              <SourcesScreen catalog={env.catalog} onOpenMenu={() => undefined} />
            </I18nProvider>
          </FormFactorProvider>,
        );

        expect(screen.getByTestId('sources-screen')).toBeTruthy();
        expect(screen.getByTestId(`sources-layout-${ff}`)).toBeTruthy();
        expect(screen.getByTestId('sources-open-menu')).toBeTruthy();
        expect(screen.getByTestId('sources-mode-xtream')).toBeTruthy();
        expect(screen.getByTestId('sources-mode-m3u')).toBeTruthy();
        expect(screen.getByTestId('sources-input-name')).toBeTruthy();
        expect(screen.getByTestId('sources-input-server')).toBeTruthy();
        expect(screen.getByTestId('sources-submit')).toBeTruthy();
        await view.unmount();
      } finally {
        await env.cleanup();
      }
    },
  );

  it('navigates controls via D-pad on TV without entering inputs until select, and exits text entry on short Back', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
    jest.spyOn(BackHandler, 'addEventListener').mockImplementation(() => ({ remove: () => {} }));
    jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 0;
    });

    const remote = createFakeAndroidKeys();
    const env = await openTestCatalog();
    try {
      const view = await render(
        <RemoteKeysProvider android={remote.source}>
          <FormFactorProvider value="tv">
            <I18nProvider i18n={createAppI18n('en')}>
              <SourcesScreen catalog={env.catalog} />
            </I18nProvider>
          </FormFactorProvider>
        </RemoteKeysProvider>,
      );

      // Initial focus starts on first control: sources-mode-xtream (index 0)
      expect(screen.getByTestId('sources-mode-xtream').props.accessibilityState?.selected).toBe(
        true,
      );
      // Offset outer focus ring renders on tvFocused active mode button (visible over ctaBg)
      const modeRingStyle = StyleSheet.flatten(
        screen.getByTestId('sources-mode-xtream-focus-ring').props.style,
      );
      expect(modeRingStyle.top).toBe(-4);
      expect(modeRingStyle.borderColor).toBe(buildTheme().colors.focusRingColor);

      // Move down to sources-mode-m3u (1) -> sources-mode-stalker (2) -> sources-input-name (3) -> sources-input-server (4)
      await act(async () => {
        remote.tap(KEYCODE_DPAD_DOWN);
        remote.tap(KEYCODE_DPAD_DOWN);
        remote.tap(KEYCODE_DPAD_DOWN);
        remote.tap(KEYCODE_DPAD_DOWN);
      });

      const serverInput = screen.getByTestId('sources-input-server');
      const serverRow = screen.getByTestId('sources-focus-input-server');
      expect(serverRow.props.accessibilityState?.selected).toBe(true);

      // Moving down once more reaches sources-input-username (4) because text entry was NOT entered yet
      await act(async () => {
        remote.tap(KEYCODE_DPAD_DOWN);
      });
      expect(
        screen.getByTestId('sources-focus-input-username').props.accessibilityState?.selected,
      ).toBe(true);

      // Move back up to server input and press OK (select) to enter text entry
      await act(async () => {
        remote.tap(KEYCODE_DPAD_UP);
      });
      expect(serverRow.props.accessibilityState?.selected).toBe(true);

      await act(async () => {
        remote.tap(KEYCODE_DPAD_CENTER);
      });
      // Simulate RN native focus callback resulting from imperative input.focus()
      await fireEvent(serverInput, 'focus');
      await fireEvent.changeText(serverInput, 'http://sim.example.test:7878');

      // While text input is focused, D-pad down is suppressed from moving TV control focus!
      await act(async () => {
        remote.tap(KEYCODE_DPAD_DOWN);
      });
      expect(serverRow.props.accessibilityState?.selected).toBe(true);

      // Short Back exits text entry (blurs input) while preserving entered text and focus position
      await act(async () => {
        remote.tap(KEYCODE_BACK);
      });
      await fireEvent(serverInput, 'blur');

      expect(serverInput.props.value).toBe('http://sim.example.test:7878');
      expect(serverRow.props.accessibilityState?.selected).toBe(true);

      // Now D-pad down moves focus again to username!
      await act(async () => {
        remote.tap(KEYCODE_DPAD_DOWN);
      });
      expect(
        screen.getByTestId('sources-focus-input-username').props.accessibilityState?.selected,
      ).toBe(true);
      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });

  it('supports embedded mode (transparent canvas, no duplicate brand label, compact padding) and dynamic highContrast theme tokens', async () => {
    const env = await openTestCatalog();
    const hcTheme = buildTheme({ preset: 'highContrast' });
    try {
      const standalone = await render(
        <ThemeProvider preset="highContrast">
          <ViewportProvider value={{ formFactor: 'phone', inputModality: 'touch' }}>
            <I18nProvider i18n={createAppI18n('en')}>
              <SourcesScreen catalog={env.catalog} />
            </I18nProvider>
          </ViewportProvider>
        </ThemeProvider>,
      );

      expect(screen.getByText('ELV IPTV')).toBeTruthy();
      const standaloneStyle = StyleSheet.flatten(screen.getByTestId('sources-screen').props.style);
      expect(standaloneStyle.backgroundColor).toBe(hcTheme.colors.bgCanvas);

      const submitStyle = StyleSheet.flatten(
        typeof screen.getByTestId('sources-submit').props.style === 'function'
          ? screen.getByTestId('sources-submit').props.style({ pressed: false })
          : screen.getByTestId('sources-submit').props.style,
      );
      expect(submitStyle.backgroundColor).toBe(hcTheme.colors.ctaBg);
      expect(submitStyle.minHeight).toBeGreaterThanOrEqual(40);
      await standalone.unmount();

      const embedded = await render(
        <ThemeProvider preset="highContrast">
          <ViewportProvider value={{ formFactor: 'desktop', inputModality: 'pointer' }}>
            <I18nProvider i18n={createAppI18n('en')}>
              <SourcesScreen catalog={env.catalog} embedded />
            </I18nProvider>
          </ViewportProvider>
        </ThemeProvider>,
      );

      expect(screen.queryByText('ELV IPTV')).toBeNull();
      const embeddedStyle = StyleSheet.flatten(screen.getByTestId('sources-screen').props.style);
      expect(embeddedStyle.backgroundColor).toBe('transparent');
      const embeddedContent = StyleSheet.flatten(
        screen.getByTestId('sources-screen').props.contentContainerStyle,
      );
      expect(embeddedContent.padding).toBe(0);
      await embedded.unmount();
    } finally {
      await env.cleanup();
    }
  });

  it('ignores IME-composing Enter events on text inputs and submits cleanly on normal Enter', async () => {
    const env = await openTestCatalog();
    try {
      const view = await render(
        <FormFactorProvider value="desktop">
          <I18nProvider i18n={createAppI18n('en')}>
            <SourcesScreen catalog={env.catalog} />
          </I18nProvider>
        </FormFactorProvider>,
      );

      const serverInput = screen.getByTestId('sources-input-server');
      const userInput = screen.getByTestId('sources-input-username');
      const passInput = screen.getByTestId('sources-input-password');

      await fireEvent.changeText(serverInput, 'http://sim.example.test:7878');
      await fireEvent.changeText(userInput, 'demo');
      await fireEvent.changeText(passInput, 'demo');

      // IME-composing Enter events must never trigger form submission
      await fireEvent(passInput, 'submitEditing', { nativeEvent: { isComposing: true } });
      await fireEvent(passInput, 'submitEditing', { isComposing: true });
      await fireEvent(passInput, 'submitEditing', { nativeEvent: { keyCode: 229 } });
      await fireEvent(passInput, 'keyPress', { nativeEvent: { key: 'Enter', isComposing: true } });
      await fireEvent(passInput, 'submitEditing', { nativeEvent: { text: 'demo' } });

      expect(await env.catalog.listSources()).toEqual([]);

      // Normal non-composing Enter submits cleanly
      await fireEvent(passInput, 'keyPress', { nativeEvent: { key: 'Enter', isComposing: false } });
      await fireEvent(passInput, 'submitEditing', {
        nativeEvent: { isComposing: false, text: 'demo' },
      });

      await waitFor(() => {
        expect(screen.getByTestId('source-status-src-1')).toHaveTextContent(
          '2 live channels, 1 movie, 1 series',
        );
      });
      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });

  it('renders localized Cinema Quietude warning badges for expired, expiring-soon, and trial sources, and omits badges for healthy accounts (#170)', async () => {
    const DAY_MS = 86_400_000;
    const NOW = 1_700_000_000_000;
    const env = await openTestCatalog();
    const i18n = createAppI18n('en');
    const hcTheme = buildTheme({ preset: 'highContrast' });
    try {
      const add = async (name: string) => {
        const res = await env.catalog.addSource({
          kind: 'xtream',
          name,
          server: 'http://sim.example.test:7878',
          username: 'demo',
          password: 'demo',
        });
        if (!res.ok) throw new Error(res.error.code);
        return res.value.id;
      };

      const expiredId = await add('Expired Account');
      const expiringId = await add('Expiring Soon Account');
      const trialId = await add('Trial Account');
      const healthyId = await add('Healthy Account');

      await updateSourceSettings(env.db, expiredId, {
        accountMeta: { isTrial: true, expiresAt: NOW - DAY_MS },
      });
      await updateSourceSettings(env.db, expiringId, {
        accountMeta: { isTrial: false, expiresAt: NOW + 3 * DAY_MS },
      });
      await updateSourceSettings(env.db, trialId, {
        accountMeta: { isTrial: true, expiresAt: NOW + 30 * DAY_MS },
      });
      await updateSourceSettings(env.db, healthyId, {
        accountMeta: { isTrial: false, expiresAt: NOW + 30 * DAY_MS },
      });

      const view = await render(
        <ThemeProvider preset="highContrast">
          <FormFactorProvider value="desktop">
            <I18nProvider i18n={i18n}>
              <SourcesScreen catalog={env.catalog} now={() => NOW} />
            </I18nProvider>
          </FormFactorProvider>
        </ThemeProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId(`source-row-${healthyId}`)).toBeTruthy();
      });

      const expiredPill = screen.getByTestId(`source-account-warning-${expiredId}`);
      const expiringPill = screen.getByTestId(`source-account-warning-${expiringId}`);
      const trialPill = screen.getByTestId(`source-account-warning-${trialId}`);

      expect(expiredPill).toHaveTextContent('Expired');
      expect(expiringPill).toHaveTextContent('Expires in 3d');
      expect(trialPill).toHaveTextContent('Trial');
      expect(screen.queryByTestId(`source-account-warning-${healthyId}`)).toBeNull();

      expect(StyleSheet.flatten(expiredPill.props.style).borderColor).toBe(
        hcTheme.colors.liveColor,
      );
      expect(StyleSheet.flatten(expiringPill.props.style).borderColor).toBe(hcTheme.colors.accent);
      expect(StyleSheet.flatten(trialPill.props.style).borderColor).toBe(hcTheme.colors.accent);

      await act(async () => {
        i18n.setLocale('tr');
      });
      expect(screen.getByTestId(`source-account-warning-${expiredId}`)).toHaveTextContent(
        'Süresi doldu',
      );
      expect(screen.getByTestId(`source-account-warning-${expiringId}`)).toHaveTextContent(
        '3 gün içinde doluyor',
      );
      expect(screen.getByTestId(`source-account-warning-${trialId}`)).toHaveTextContent('Deneme');

      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });

  it('stages an incoming OS-launched local playlist into M3U mode with clean filename stem (#259)', async () => {
    const env = await openTestCatalog();
    const onConsume = jest.fn();
    const incoming = {
      name: 'weekend-sports.m3u.gz',
      bytes: new TextEncoder().encode('#EXTM3U\n#EXTINF:-1,Sports\nhttp://a/1.ts\n'),
    };
    try {
      const view = await render(
        <FormFactorProvider value="desktop">
          <I18nProvider i18n={createAppI18n('en')}>
            <SourcesScreen
              catalog={env.catalog}
              incomingLocalPlaylist={incoming}
              onConsumeIncomingLocalPlaylist={onConsume}
            />
          </I18nProvider>
        </FormFactorProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('sources-local-file-selected')).toHaveTextContent(
          'File: weekend-sports.m3u.gz',
        );
      });
      expect(screen.getByTestId('sources-input-name').props.value).toBe('weekend-sports');
      expect(screen.getByTestId('sources-mode-m3u').props.accessibilityState?.selected).toBe(true);
      expect(onConsume).toHaveBeenCalledTimes(1);

      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });
});
