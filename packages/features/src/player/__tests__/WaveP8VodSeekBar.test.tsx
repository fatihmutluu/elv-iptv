import { ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { createFakePlayerEngine } from '@elv/playback/testing';
import {
  type FormFactor,
  FormFactorProvider,
  I18nProvider,
  ThemeProvider,
  TvRemoteProvider,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { StyleSheet, View } from 'react-native';
import type { PlayTarget } from '../../ports/play-target';
import { PlayerScreen } from '../PlayerScreen';
import { createManualClock } from './player-test-harness';

const VOD_TARGET: PlayTarget = {
  itemKey: 'x:src-1:movie:507',
  kind: 'vod',
  title: 'Cinema Feature',
  sourceId: 'src-1',
};

// Spec canonical example: 20:09 elapsed out of 44:58 total -> 24:49 remaining
const ELAPSED_MS = (20 * 60 + 9) * 1000;
const DURATION_MS = (44 * 60 + 58) * 1000;

interface VariantCase {
  readonly name: string;
  readonly formFactor: FormFactor;
  readonly overlayMode?: 'floating' | 'docked';
  readonly width: number;
  readonly height: number;
}

const CASES: readonly VariantCase[] = [
  {
    name: 'Desktop (floating)',
    formFactor: 'desktop',
    overlayMode: 'floating',
    width: 1280,
    height: 720,
  },
  {
    name: 'Desktop (docked)',
    formFactor: 'desktop',
    overlayMode: 'docked',
    width: 1280,
    height: 720,
  },
  { name: 'Mobile (phone)', formFactor: 'phone', width: 393, height: 852 },
  { name: 'TV (10-ft)', formFactor: 'tv', width: 1920, height: 1080 },
];

describe('Wave P8 Standardized VOD Seek Bar (#507 [1.15])', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each(CASES)(
    'defaults to 20:09 [===] 24:49 and silently toggles remaining <-> total (44:58) on $name',
    async ({ formFactor, overlayMode, width, height }) => {
      const manual = createManualClock();
      const engine = createFakePlayerEngine({
        now: manual.now,
        schedule: manual.schedule,
        cancel: manual.cancel,
      });

      const view = await render(
        <ThemeProvider preset="obsidianCrimson">
          <TvRemoteProvider>
            <ViewportProvider
              value={{
                formFactor,
                orientation: width >= height ? 'landscape' : 'portrait',
                inputModality:
                  formFactor === 'tv' ? 'tv' : formFactor === 'desktop' ? 'pointer' : 'touch',
                width,
                height,
              }}
            >
              <FormFactorProvider value={formFactor}>
                <I18nProvider i18n={createAppI18n('en')}>
                  <PlayerScreen
                    catalog={{
                      resolveStream: async () =>
                        ok({ url: 'http://sim.example.test/vod.mp4', headers: {} }),
                      getProgress: async () => null,
                      saveProgress: async (input) =>
                        ok({
                          profileId: input.profileId ?? 'default',
                          sourceId: input.sourceId,
                          itemKey: input.itemKey,
                          kind: input.kind,
                          title: input.title,
                          subtitle: input.subtitle ?? null,
                          logo: input.logo ?? null,
                          seriesKey: input.seriesKey ?? null,
                          season: input.season ?? null,
                          episode: input.episode ?? null,
                          positionMs: input.positionMs,
                          durationMs: input.durationMs,
                          watched: input.watched ?? false,
                          updatedAt: 0,
                        }),
                    }}
                    videoHost={{
                      open: () => ({
                        engine,
                        ...(overlayMode !== undefined ? { overlayMode } : {}),
                        renderSurface: () => <View testID="mock-surface" />,
                      }),
                    }}
                    target={VOD_TARGET}
                    clock={{ now: manual.now }}
                    timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
                    onExit={jest.fn()}
                  />
                </I18nProvider>
              </FormFactorProvider>
            </ViewportProvider>
          </TvRemoteProvider>
        </ThemeProvider>,
      );

      await waitFor(() => expect(engine.commands.some((c) => c.name === 'load')).toBe(true));
      const attempt = engine.commands.find((c) => c.name === 'load')?.attempt ?? 1;
      await act(async () => {
        manual.advance(350);
        engine.emit({
          attempt,
          type: 'clock',
          anchor: { positionMs: ELAPSED_MS, atMs: manual.now(), rate: 0, durationMs: DURATION_MS },
        });
      });

      // Default mode: elapsed on left, clean remaining (NO minus sign) on right, tabular numerals, LTR row lock
      const rowNode = screen.getByTestId('player-progress-row');
      const currentNode = screen.getByTestId('player-progress-time-current');
      const endTextNode = screen.getByTestId('player-progress-time');
      const endBtnNode = screen.getByTestId('player-progress-time-end');
      expect(StyleSheet.flatten(rowNode.props.style)?.direction).toBe('ltr');
      expect(currentNode).toHaveTextContent('20:09');
      expect(endTextNode).toHaveTextContent('24:49');
      expect(endBtnNode.props.accessibilityLabel).toBe('24:49 remaining');
      expect(StyleSheet.flatten(currentNode.props.style)?.fontVariant).toEqual(['tabular-nums']);
      expect(StyleSheet.flatten(endTextNode.props.style)?.fontVariant).toEqual(['tabular-nums']);

      // Click/press silently toggles to total duration (44:58)
      await fireEvent.press(endBtnNode);
      expect(screen.getByTestId('player-progress-time')).toHaveTextContent('44:58');
      expect(screen.getByTestId('player-progress-time-end').props.accessibilityLabel).toBe(
        'Total duration: 44:58',
      );

      // Click/press again silently toggles straight back to remaining (24:49) — strictly 2-mode (no endsAt)
      await fireEvent.press(screen.getByTestId('player-progress-time-end'));
      expect(screen.getByTestId('player-progress-time')).toHaveTextContent('24:49');

      await view.unmount();
    },
  );
});
