import type { CatalogService, SourceRow } from '@elv/data';
import { ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { I18nProvider, ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { StyleSheet } from 'react-native';
import { ProfileProvider } from '../../shared';
import { SourcesScreen } from '../SourcesScreen';

const PROFILES = [
  {
    id: 'default',
    name: 'Adult',
    avatarToken: 'crimson',
    isKids: false,
    isDefault: true,
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: 'kids-1',
    name: 'Kids',
    avatarToken: 'emerald',
    isKids: true,
    isDefault: false,
    createdAt: 2,
    updatedAt: 2,
  },
];

function createStatefulCatalog(initialSources: readonly SourceRow[]): {
  readonly catalog: CatalogService;
  readonly renameSource: jest.Mock;
  readonly setSourceExcludedProfiles: jest.Mock;
  readonly importGuide: jest.Mock;
} {
  let sources = [...initialSources];
  const renameSource = jest.fn(async (id: string, name: string) => {
    sources = sources.map((s) => (s.id === id ? { ...s, name } : s));
    const found = sources.find((s) => s.id === id);
    return ok(found as SourceRow);
  });
  const setSourceExcludedProfiles = jest.fn(
    async (id: string, excludedProfileIds: readonly string[]) => {
      sources = sources.map((s) => (s.id === id ? { ...s, excludedProfileIds } : s));
      const found = sources.find((s) => s.id === id);
      return ok(found as SourceRow);
    },
  );
  const importGuide = jest.fn(async (id: string) =>
    ok({ sourceId: id, programmes: 5, channels: 2 }),
  );

  const catalog = {
    addSource: jest.fn(),
    addSourceFromLink: jest.fn(),
    removeSource: jest.fn(async (id: string) => {
      sources = sources.filter((s) => s.id !== id);
      return ok(undefined);
    }),
    importSource: jest.fn(async (id: string) =>
      ok({ sourceId: id, liveCount: 4, movieCount: 2, seriesCount: 1, categories: 2 }),
    ),
    importGuide,
    discoverSourceCategories: jest.fn(async () => ok({ live: [], movie: [], series: [] })),
    renameSource,
    setSourceExcludedProfiles,
    listSources: jest.fn(async () => [...sources]),
    listProfiles: jest.fn(async () => [...PROFILES]),
    getParentalSettings: jest.fn(async () => ({
      profileId: 'default',
      enabled: false,
      blockAdultKeywords: false,
      maxRatingAge: null,
      unlockTimeoutMin: 30,
      updatedAt: 0,
    })),
    listParentalLocks: jest.fn(async () => []),
    hasParentalPin: jest.fn(async () => false),
    categories: jest.fn(async () => []),
    items: jest.fn(async () => []),
    seasons: jest.fn(async () => ok([])),
    episodes: jest.fn(async () => []),
    resolveStream: jest.fn(),
    listGuideSources: jest.fn(async () => []),
    listGuideChannels: jest.fn(async () => []),
    listChannelGuideOverrides: jest.fn(async () => []),
    updateSourceSettings: jest.fn(async (id: string) => ok(sources.find((s) => s.id === id))),
    close: jest.fn(async () => undefined),
  } as unknown as CatalogService;

  return { catalog, renameSource, setSourceExcludedProfiles, importGuide };
}

function wrap(catalog: CatalogService, child: ReactElement): ReactElement {
  return (
    <ThemeProvider>
      <ViewportProvider
        value={{ formFactor: 'desktop', orientation: 'landscape', width: 1280, height: 800 }}
      >
        <I18nProvider i18n={createAppI18n('en')}>
          <ProfileProvider catalog={catalog}>{child}</ProfileProvider>
        </I18nProvider>
      </ViewportProvider>
    </ThemeProvider>
  );
}

describe('Wave P7 Sources cleanup, 3-button saved card & SourceAdvancedOverlay', () => {
  it('defaults Add Source tab to M3U in M3U -> Xtream -> Stalker order, right-aligns submit, removes upfront category button, and hides Browse catalog when embedded', async () => {
    const { catalog } = createStatefulCatalog([
      {
        id: 's1',
        kind: 'm3u',
        name: 'My IPTV',
        createdAt: 1,
        needsImport: false,
      },
    ]);

    const view = await render(
      wrap(catalog, <SourcesScreen catalog={catalog} embedded onOpenMenu={jest.fn()} />),
    );

    // Tab order: M3U -> Xtream Codes -> Stalker, with M3U active by default
    expect(screen.getByTestId('sources-mode-m3u').props.accessibilityState?.selected).toBe(true);
    expect(screen.getByTestId('sources-mode-xtream').props.accessibilityState?.selected).toBe(
      false,
    );
    expect(screen.getByTestId('sources-mode-stalker').props.accessibilityState?.selected).toBe(
      false,
    );
    expect(screen.getByTestId('sources-input-playlist-url')).toBeTruthy();

    // Upfront "Choose categories" button is removed from Add Source form
    expect(screen.queryByTestId('sources-submit-choose-categories')).toBeNull();

    // Primary "Add & import" button row is right-aligned
    const submitRowStyle = StyleSheet.flatten(screen.getByTestId('sources-submit-row').props.style);
    expect(submitRowStyle.justifyContent).toBe('flex-end');

    // Redundant "Browse catalog" button is suppressed when embedded in Settings
    await waitFor(() => expect(screen.getByTestId('source-row-s1')).toBeTruthy());
    expect(screen.queryByTestId('sources-open-menu')).toBeNull();

    // Saved source card renders ONLY 3 clean buttons (Refresh, Remove, Advanced) without source-name suffixes
    expect(screen.getByTestId('source-refresh-s1')).toHaveTextContent(/^Refresh$/);
    expect(screen.getByTestId('source-remove-s1')).toHaveTextContent(/^Remove$/);
    expect(screen.getByTestId('source-advanced-s1')).toHaveTextContent(/^Advanced$/);
    expect(screen.queryByTestId('source-categories-s1')).toBeNull();
    expect(screen.queryByTestId('source-guide-s1')).toBeNull();
    expect(screen.queryByTestId('source-guides-s1')).toBeNull();
    expect(screen.queryByTestId('source-network-s1')).toBeNull();

    await view.unmount();
  });

  it('opens SourceAdvancedOverlay with all 6 actions and supports Rename source, Shared with profiles toggles, and Network sub-view', async () => {
    const { catalog, renameSource, setSourceExcludedProfiles, importGuide } = createStatefulCatalog(
      [
        {
          id: 's1',
          kind: 'xtream',
          name: 'Living Room',
          createdAt: 1,
          needsImport: false,
        },
      ],
    );

    const view = await render(wrap(catalog, <SourcesScreen catalog={catalog} embedded />));
    await waitFor(() => expect(screen.getByTestId('source-advanced-s1')).toBeTruthy());

    // Open Advanced popup
    await fireEvent.press(screen.getByTestId('source-advanced-s1'));
    await waitFor(() => expect(screen.getByTestId('source-advanced-overlay-s1')).toBeTruthy());

    // All 6 items present in menu
    expect(screen.getByTestId('source-advanced-rename-s1')).toBeTruthy();
    expect(screen.getByTestId('source-advanced-profiles-s1')).toBeTruthy();
    expect(screen.getByTestId('source-categories-s1')).toBeTruthy();
    expect(screen.getByTestId('source-refresh-guide-s1')).toBeTruthy();
    expect(screen.getByTestId('source-guides-s1')).toBeTruthy();
    expect(screen.getByTestId('source-network-s1')).toBeTruthy();

    // 1) Rename source
    await fireEvent.press(screen.getByTestId('source-advanced-rename-s1'));
    await waitFor(() => expect(screen.getByTestId('source-rename-input')).toBeTruthy());
    await fireEvent.changeText(screen.getByTestId('source-rename-input'), '  Family Streams  ');
    await fireEvent.press(screen.getByTestId('source-rename-save'));
    await waitFor(() => expect(renameSource).toHaveBeenCalledWith('s1', 'Family Streams'));
    await waitFor(() =>
      expect(screen.getByTestId('source-row-s1')).toHaveTextContent(/Family Streams/),
    );

    // 2) Shared with profiles — default ALL checked; unchecking Kids updates excludedProfileIds
    await fireEvent.press(screen.getByTestId('source-advanced-profiles-s1'));
    await waitFor(() => expect(screen.getByTestId('source-profile-toggle-kids-1')).toBeTruthy());
    expect(
      screen.getByTestId('source-profile-toggle-default').props.accessibilityState?.checked,
    ).toBe(true);
    expect(
      screen.getByTestId('source-profile-toggle-kids-1').props.accessibilityState?.checked,
    ).toBe(true);

    await fireEvent.press(screen.getByTestId('source-profile-toggle-kids-1'));
    await waitFor(() => expect(setSourceExcludedProfiles).toHaveBeenCalledWith('s1', ['kids-1']));
    await waitFor(() =>
      expect(
        screen.getByTestId('source-profile-toggle-kids-1').props.accessibilityState?.checked,
      ).toBe(false),
    );

    // Return to Advanced menu -> open Network editor sub-view
    await fireEvent.press(screen.getByTestId('source-advanced-back'));
    await fireEvent.press(screen.getByTestId('source-network-s1'));
    await waitFor(() => expect(screen.getByTestId('source-network-editor-s1')).toBeTruthy());

    // Return to Advanced menu -> trigger Refresh guide
    await fireEvent.press(screen.getByTestId('source-advanced-back'));
    await fireEvent.press(screen.getByTestId('source-refresh-guide-s1'));
    await waitFor(() => expect(importGuide).toHaveBeenCalledWith('s1', expect.anything()));

    await view.unmount();
  });
});
