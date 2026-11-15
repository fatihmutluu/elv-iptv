import type { CatalogService, SourceRow } from '@elv/data';
import { elvError, err } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import {
  type AndroidKeyEvent,
  type AndroidKeySource,
  FormFactorProvider,
  I18nProvider,
  RemoteKeysProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react-native';
import { BackHandler, Platform, ScrollView } from 'react-native';
import type { PlaybackGuard } from '../../ports/playback-guard';
import { SourcesScreen } from '../SourcesScreen';
import { useSourcesController } from '../useSourcesController';
import { openTestCatalog } from './sources-test-harness';

const KEYCODE_DPAD_DOWN = 20;
const KEYCODE_DPAD_LEFT = 21;
const KEYCODE_DPAD_RIGHT = 22;
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

describe('SourcesScreen native TV focus & controller concurrency (#71)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('opts buttons and inactive inputs out of native TV focus, renders parking anchor, navigates row groups with Left/Right, scrolls into view, and handles Back vs text-entry Back', async () => {
    const originalOs = Platform.OS;
    Platform.OS = 'android';
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
    jest.spyOn(BackHandler, 'addEventListener').mockImplementation(() => ({ remove: () => {} }));
    jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    const scrollToSpy = jest
      .spyOn(ScrollView.prototype, 'scrollTo')
      .mockImplementation(() => undefined);

    const remote = createFakeAndroidKeys();
    const onBack = jest.fn();
    const env = await openTestCatalog();
    try {
      const view = await render(
        <RemoteKeysProvider android={remote.source}>
          <FormFactorProvider value="tv">
            <I18nProvider i18n={createAppI18n('en')}>
              <SourcesScreen catalog={env.catalog} onBack={onBack} />
            </I18nProvider>
          </FormFactorProvider>
        </RemoteKeysProvider>,
      );

      // 1. Focusable TV parking anchor is a sibling OUTSIDE non-focusable ScrollView (so ReactScrollView.executeKeyEvent cannot hijack D-pad)
      const scrollView = screen.getByTestId('sources-screen');
      expect(scrollView.props.focusable).toBe(false);
      const anchor = screen.getByTestId('sources-tv-focus-anchor');
      expect(anchor.props.focusable).toBe(true);
      expect(anchor.props.hasTVPreferredFocus).toBe(true);
      let cursor = anchor.parent;
      while (cursor !== null) {
        expect(cursor.props?.testID).not.toBe('sources-screen');
        cursor = cursor.parent;
      }

      // 2. Action buttons opt out of native focus on TV (preventing native + FocusStore double-press)
      expect(screen.getByTestId('sources-mode-xtream').props.focusable).toBe(false);
      expect(screen.getByTestId('sources-toggle-advanced').props.focusable).toBe(false);
      expect(screen.getByTestId('sources-submit').props.focusable).toBe(false);

      // 3. TvTextInputs start non-editable & non-focusable on TV so D-pad never steals focus into IME
      const serverInput = screen.getByTestId('sources-input-server');
      expect(serverInput.props.editable).toBe(false);
      expect(serverInput.props.focusable).toBe(false);

      // 4. Horizontal Left/Right moves within [Xtream] <-> [M3U URL] row group
      expect(screen.getByTestId('sources-mode-xtream').props.accessibilityState?.selected).toBe(
        true,
      );
      await act(async () => {
        remote.tap(KEYCODE_DPAD_RIGHT);
      });
      expect(screen.getByTestId('sources-mode-m3u').props.accessibilityState?.selected).toBe(true);
      await act(async () => {
        remote.tap(KEYCODE_DPAD_LEFT);
      });
      expect(screen.getByTestId('sources-mode-xtream').props.accessibilityState?.selected).toBe(
        true,
      );

      // 5. Simulate ScrollView viewport height (300px) and offscreen submit button layout (y: 720, height: 48)
      await fireEvent(screen.getByTestId('sources-screen'), 'layout', {
        nativeEvent: { layout: { x: 0, y: 0, width: 1280, height: 300 } },
      });
      await fireEvent(screen.getByTestId('sources-focus-submit'), 'layout', {
        nativeEvent: { layout: { x: 0, y: 720, width: 200, height: 48 } },
      });

      // Move down to input-server (0: mode-xtream -> 1: mode-m3u -> 2: input-name -> 3: input-server)
      await act(async () => {
        remote.tap(KEYCODE_DPAD_DOWN);
        remote.tap(KEYCODE_DPAD_DOWN);
        remote.tap(KEYCODE_DPAD_DOWN);
      });
      expect(
        screen.getByTestId('sources-focus-input-server').props.accessibilityState?.selected,
      ).toBe(true);
      expect(screen.getByTestId('sources-input-server').props.editable).toBe(false);

      // Press OK (select) on input-server -> enables editable & focusable on ONLY input-server
      await act(async () => {
        remote.tap(KEYCODE_DPAD_CENTER);
      });
      expect(screen.getByTestId('sources-input-server').props.editable).toBe(true);
      expect(screen.getByTestId('sources-input-server').props.focusable).toBe(true);
      expect(screen.getByTestId('sources-input-name').props.editable).toBe(false);

      await fireEvent(screen.getByTestId('sources-input-server'), 'focus');
      await fireEvent.changeText(
        screen.getByTestId('sources-input-server'),
        'http://sim.example.test:7878',
      );

      // Short Back while editing blurs the input WITHOUT calling onBack
      await act(async () => {
        remote.tap(KEYCODE_BACK);
      });
      await fireEvent(screen.getByTestId('sources-input-server'), 'blur');
      expect(onBack).not.toHaveBeenCalled();
      expect(screen.getByTestId('sources-input-server').props.editable).toBe(false);
      expect(screen.getByTestId('sources-input-server').props.focusable).toBe(false);

      // Navigate down to submit (3 -> 4: username -> 5: password -> 6: toggle-advanced -> 7: submit)
      scrollToSpy.mockClear();
      await act(async () => {
        remote.tap(KEYCODE_DPAD_DOWN);
        remote.tap(KEYCODE_DPAD_DOWN);
        remote.tap(KEYCODE_DPAD_DOWN);
        remote.tap(KEYCODE_DPAD_DOWN);
      });
      expect(screen.getByTestId('sources-submit').props.accessibilityState?.selected).toBe(true);
      expect(scrollToSpy).toHaveBeenCalled();

      // Second short Back (outside text entry) triggers screen onBack
      await act(async () => {
        remote.tap(KEYCODE_BACK);
      });
      expect(onBack).toHaveBeenCalledTimes(1);

      // 6. Unmounting an active editing input without onBlur (e.g. mode switch) clears stale editingInputId so Back still works
      // Navigate back up to input-server (7 -> 3) and press select to enter edit mode without firing focus/blur
      await act(async () => {
        // Jump to mode-m3u (index 1) after activating input-server: first focus input-server by moving up 4 steps
        remote.tap(19);
        remote.tap(19);
        remote.tap(19);
        remote.tap(19);
      });
      await act(async () => {
        remote.tap(KEYCODE_DPAD_CENTER);
      });
      expect(screen.getByTestId('sources-input-server').props.editable).toBe(true);
      // Switch mode to M3U (unmounting input-server without firing onBlur)
      await fireEvent.press(screen.getByTestId('sources-mode-m3u'));
      expect(screen.queryByTestId('sources-input-server')).toBeNull();
      // Short Back must NOT be swallowed by stale editingInputId
      await act(async () => {
        remote.tap(KEYCODE_BACK);
      });
      expect(onBack).toHaveBeenCalledTimes(2);

      await view.unmount();
    } finally {
      Platform.OS = originalOs;
      await env.cleanup();
    }
  });

  it('prevents same-tick double submit, survives throwing playbackGuard on remove, guards out-of-order listSources, and clears stale importInProgress', async () => {
    const env = await openTestCatalog();
    try {
      let addCalls = 0;
      const realAddSource = env.catalog.addSource.bind(env.catalog);
      let resolveStaleList: ((rows: SourceRow[]) => void) | undefined;
      let interceptNextList = false;
      let forceImportInProgress = false;
      const realListSources = env.catalog.listSources.bind(env.catalog);

      const wrappedCatalog: CatalogService = {
        ...env.catalog,
        async addSource(input) {
          addCalls += 1;
          await new Promise<void>((r) => setTimeout(r, 15));
          return realAddSource(input);
        },
        async listSources() {
          if (interceptNextList) {
            interceptNextList = false;
            return new Promise<SourceRow[]>((resolve) => {
              resolveStaleList = resolve;
            });
          }
          return realListSources();
        },
        async importSource(id, opts) {
          if (forceImportInProgress) {
            return err(elvError('storage', 'import-in-progress'));
          }
          return env.catalog.importSource(id, opts);
        },
      };

      const throwingGuard: PlaybackGuard = {
        async stopIfUsingSource() {
          throw new Error('player engine unavailable');
        },
      };

      const hook = await renderHook(
        (token: number) =>
          useSourcesController({
            catalog: wrappedCatalog,
            playbackGuard: throwingGuard,
            externalRefreshToken: token,
          }),
        { initialProps: 0 },
      );

      await act(async () => {
        hook.result.current.updateField('server', 'http://sim.example.test:7878');
        hook.result.current.updateField('username', 'demo');
        hook.result.current.updateField('password', 'demo');
      });

      // 1. Two synchronous same-tick submit() calls add only ONE source
      await act(async () => {
        const p1 = hook.result.current.submit();
        const p2 = hook.result.current.submit();
        await Promise.all([p1, p2]);
      });
      expect(addCalls).toBe(1);
      await waitFor(() => {
        expect(hook.result.current.statusById['src-1']?.kind).toBe('ready');
      });

      // 2. Out-of-order listSources resolution must not overwrite newer sources
      interceptNextList = true;
      await hook.rerender(1);
      await hook.rerender(2);
      await act(async () => {
        resolveStaleList?.([]);
      });
      expect(hook.result.current.sources.map((s) => s.id)).toEqual(['src-1']);

      // 3. Stale importInProgress error clears when externalRefreshToken observes needsImport === false
      forceImportInProgress = true;
      await act(async () => {
        await hook.result.current.runImport('src-1');
      });
      expect(hook.result.current.statusById['src-1']).toEqual({
        kind: 'error',
        failure: {
          messageId: 'source.error.importInProgress',
          hintId: 'source.hint.importInProgress',
        },
      });
      forceImportInProgress = false;
      await hook.rerender(3);
      await waitFor(() => {
        expect(hook.result.current.statusById['src-1']).toBeUndefined();
      });

      // 4. Throwing playbackGuard.stopIfUsingSource does not block source removal
      await act(async () => {
        await hook.result.current.remove('src-1');
      });
      expect(hook.result.current.sources).toEqual([]);
      expect(await realListSources()).toEqual([]);

      await hook.unmount();
    } finally {
      await env.cleanup();
    }
  });
});
