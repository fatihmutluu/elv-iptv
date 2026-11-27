import { createAppI18n } from '@elv/i18n';
import { I18nProvider, ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { render, screen } from '@testing-library/react-native';
import {
  ElvModeInteractivePreview,
  type ElvModeInteractivePreviewProps,
} from '../ElvModeInteractivePreview';

function renderPreview(
  props: ElvModeInteractivePreviewProps,
  options: { readonly highContrast?: boolean; readonly locale?: 'en' | 'tr' } = {},
): ReturnType<typeof render> {
  const i18n = createAppI18n(options.locale ?? 'en');
  return render(
    <ViewportProvider
      value={{
        formFactor: 'desktop',
        orientation: 'landscape',
        inputModality: 'pointer',
        width: 1280,
        height: 800,
      }}
    >
      <I18nProvider i18n={i18n}>
        <ThemeProvider preset={options.highContrast ? 'highContrast' : 'obsidianCrimson'}>
          <ElvModeInteractivePreview {...props} />
        </ThemeProvider>
      </I18nProvider>
    </ViewportProvider>,
  );
}

describe('ElvModeInteractivePreview (Wave E3 #513)', () => {
  it('renders 4 distinct clean cinema cards and 4 clean genre tabs when all ELV toggles are enabled', async (): Promise<void> => {
    await renderPreview({
      elvModeEnabled: true,
      mergeVersions: true,
      enrichMetadata: true,
      imdbCategories: true,
    });

    expect(screen.getByTestId('elv-preview-root')).toBeTruthy();
    expect(screen.getByTestId('elv-preview-status-badge')).toBeTruthy();
    expect(screen.getByTestId('elv-preview-categories')).toBeTruthy();
    expect(screen.getByTestId('elv-preview-cards')).toBeTruthy();

    for (let i = 0; i < 4; i += 1) {
      expect(screen.getByTestId(`elv-preview-card-${i}`)).toBeTruthy();
      expect(screen.getByTestId(`elv-preview-clean-poster-${i}`)).toBeTruthy();
      expect(screen.queryByTestId(`elv-preview-chaos-poster-${i}`)).toBeNull();
    }

    expect(screen.getByText('Velvet Meridian')).toBeTruthy();
    expect(screen.getByText('Solar Drift')).toBeTruthy();
    expect(screen.getByText('Glass Harbor')).toBeTruthy();
    expect(screen.getByText('Cinder Waltz')).toBeTruthy();
    expect(screen.getByText('Sci-Fi')).toBeTruthy();
    expect(screen.getByText('Drama')).toBeTruthy();
    expect(screen.getByText('8.8')).toBeTruthy();
    expect(screen.getByText('8.5')).toBeTruthy();
    expect(screen.getByText('8.2')).toBeTruthy();
    expect(screen.getByText('8.6')).toBeTruthy();
  });

  it('switches immediately to chaotic raw IPTV cards, broken posters, and 4 duplicate copies when elvModeEnabled is false', async (): Promise<void> => {
    await renderPreview({
      elvModeEnabled: false,
      mergeVersions: true,
      enrichMetadata: true,
      imdbCategories: true,
    });

    for (let i = 0; i < 4; i += 1) {
      expect(screen.getByTestId(`elv-preview-card-${i}`)).toBeTruthy();
      expect(screen.getByTestId(`elv-preview-chaos-poster-${i}`)).toBeTruthy();
      expect(screen.queryByTestId(`elv-preview-clean-poster-${i}`)).toBeNull();
    }

    expect(screen.getByText('[TR] VELVET MERIDIAN 4K UHD HEVC')).toBeTruthy();
    expect(screen.getByText('[TR] Velvet.Meridian.2025.FHD.NEW')).toBeTruthy();
    expect(screen.getByText('VELVET MERIDIAN (SD) BACKUP')).toBeTruthy();
    expect(screen.getByText('VELVET_MERIDIAN_CAM_v2')).toBeTruthy();
  });

  it('reacts independently to mergeVersions, enrichMetadata, and imdbCategories in compact and highContrast modes', async (): Promise<void> => {
    const view = await renderPreview(
      {
        elvModeEnabled: true,
        mergeVersions: false,
        enrichMetadata: true,
        imdbCategories: false,
        compact: true,
      },
      { highContrast: true, locale: 'tr' },
    );

    // Clean posters ON, merge OFF -> clean posters rendered alongside raw duplicate filenames
    for (let i = 0; i < 4; i += 1) {
      expect(screen.getByTestId(`elv-preview-clean-poster-${i}`)).toBeTruthy();
      expect(screen.queryByTestId(`elv-preview-chaos-poster-${i}`)).toBeNull();
    }
    expect(screen.getByText('[TR] VELVET MERIDIAN 4K UHD HEVC')).toBeTruthy();

    // Flip enrichMetadata OFF while mergeVersions ON -> 4 distinct cards with broken raw posters
    const i18n = createAppI18n('en');
    await view.rerender(
      <ViewportProvider>
        <I18nProvider i18n={i18n}>
          <ThemeProvider preset="obsidianCrimson">
            <ElvModeInteractivePreview
              elvModeEnabled
              mergeVersions
              enrichMetadata={false}
              imdbCategories
              compact
            />
          </ThemeProvider>
        </I18nProvider>
      </ViewportProvider>,
    );

    for (let i = 0; i < 4; i += 1) {
      expect(screen.getByTestId(`elv-preview-chaos-poster-${i}`)).toBeTruthy();
      expect(screen.queryByTestId(`elv-preview-clean-poster-${i}`)).toBeNull();
    }
  });

  it('keeps outer card slots and category slots mounted without unmount flicker when toggling ELV Mode', async (): Promise<void> => {
    const view = await renderPreview({
      elvModeEnabled: true,
      mergeVersions: true,
      enrichMetadata: true,
      imdbCategories: true,
    });

    const cardSlotsBefore = [0, 1, 2, 3].map((i) => screen.getByTestId(`elv-preview-card-${i}`));
    const catBarBefore = screen.getByTestId('elv-preview-categories');

    const i18n = createAppI18n('en');
    await view.rerender(
      <ViewportProvider
        value={{
          formFactor: 'desktop',
          orientation: 'landscape',
          inputModality: 'pointer',
          width: 1280,
          height: 800,
        }}
      >
        <I18nProvider i18n={i18n}>
          <ThemeProvider preset="obsidianCrimson">
            <ElvModeInteractivePreview
              elvModeEnabled={false}
              mergeVersions
              enrichMetadata
              imdbCategories
            />
          </ThemeProvider>
        </I18nProvider>
      </ViewportProvider>,
    );

    const cardSlotsAfterOff = [0, 1, 2, 3].map((i) => screen.getByTestId(`elv-preview-card-${i}`));
    for (let i = 0; i < 4; i += 1) {
      expect(cardSlotsAfterOff[i]).toBe(cardSlotsBefore[i]);
    }
    expect(screen.getByTestId('elv-preview-categories')).toBe(catBarBefore);

    await view.rerender(
      <ViewportProvider
        value={{
          formFactor: 'desktop',
          orientation: 'landscape',
          inputModality: 'pointer',
          width: 1280,
          height: 800,
        }}
      >
        <I18nProvider i18n={i18n}>
          <ThemeProvider preset="obsidianCrimson">
            <ElvModeInteractivePreview elvModeEnabled mergeVersions enrichMetadata imdbCategories />
          </ThemeProvider>
        </I18nProvider>
      </ViewportProvider>,
    );

    for (let i = 0; i < 4; i += 1) {
      expect(screen.getByTestId(`elv-preview-card-${i}`)).toBe(cardSlotsBefore[i]);
    }
  });
});
