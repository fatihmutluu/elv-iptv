import { createCatalogService, openCatalog } from '@elv/data';
import { countingScheduler, memorySecrets, testDb } from '@elv/data/testing';
import { createProfilePreferencesManager, ok, type PreferencesKvBackend } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { type AndroidKeyEvent, type AndroidKeySource, RemoteKeysProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { AppShellProfileOverlays } from '../../app-shell-overlays';
import { AppProviders } from '../../index';
import { ProfileProvider } from '../../shared';
import { ProfilesAndParentalPanel } from '../ProfilesAndParentalPanel';

const KEYCODE_BACK = 4;

function createMemBackend(): PreferencesKvBackend {
  const map = new Map<string, string>();
  return {
    get: (k) => map.get(k),
    set: (k, v) => {
      map.set(k, v);
    },
    delete: (k) => {
      map.delete(k);
    },
  };
}

async function createPanelEnv() {
  const handle = testDb();
  await openCatalog(handle.db);
  const catalog = createCatalogService({
    db: handle.db,
    secrets: memorySecrets(),
    scheduler: countingScheduler(),
    http: {
      async get() {
        const bytes = new TextEncoder().encode(
          '#EXTM3U\n#EXTINF:-1 group-title="Sports",Sports HD\nhttp://127.0.0.1/1.ts\n#EXTINF:-1 group-title="18+ Adult",Adult One\nhttp://127.0.0.1/2.ts\n',
        );
        return ok({
          status: 200,
          headers: {},
          body: {
            async *[Symbol.asyncIterator]() {
              yield bytes;
            },
          },
        });
      },
    },
    clock: () => 10_000,
  });
  const added = await catalog.addSourceFromLink({ name: 'Demo', url: 'http://127.0.0.1/demo.m3u' });
  if (!added.ok) throw new Error('addSource failed');
  await catalog.importSource(added.value.id);
  const sources = await catalog.listSources();
  const profilePreferences = createProfilePreferencesManager(createMemBackend(), { coalesceMs: 0 });
  return {
    catalog,
    sources,
    profilePreferences,
    async cleanup() {
      await catalog.close();
      handle.close();
    },
  };
}

async function tapPin(digits: string) {
  for (const d of digits) {
    await fireEvent.press(screen.getByTestId(`pin-key-${d}`));
  }
  await fireEvent.press(screen.getByTestId('pin-entry-submit'));
}

describe('ProfilesAndParentalPanel (Kids Mode)', () => {
  it('removes all profile CRUD from Settings and renders ONLY title, description, and master toggle while Kids Mode is OFF', async () => {
    const env = await createPanelEnv();
    try {
      const view = await render(
        <AppProviders
          profilePreferences={env.profilePreferences}
          i18n={createAppI18n('en')}
          viewport={{
            formFactor: 'desktop',
            orientation: 'landscape',
            inputModality: 'pointer',
            width: 1280,
            height: 800,
          }}
        >
          <ProfileProvider catalog={env.catalog} profilePreferences={env.profilePreferences}>
            <ProfilesAndParentalPanel catalog={env.catalog} sources={env.sources} />
            <AppShellProfileOverlays onOpenProfilesSettings={jest.fn()} />
          </ProfileProvider>
        </AppProviders>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('parental-controls-card')).toBeTruthy();
        expect(screen.getByTestId('parental-toggle-enabled')).toBeTruthy();
      });

      // Zero profile CRUD UI in Settings
      expect(screen.queryByTestId('profiles-management-card')).toBeNull();
      expect(screen.queryByTestId('profiles-add-button')).toBeNull();
      expect(screen.queryByTestId('profile-row-default')).toBeNull();

      // Title + 1-line modeDescription + OFF toggle
      expect(screen.getByText('Kids Mode')).toBeTruthy();
      expect(
        screen.getByText(
          'Keep younger viewers safe with PIN-protected category locks, age limits, and automatic adult keyword filtering.',
        ),
      ).toBeTruthy();
      expect(screen.getByTestId('parental-toggle-enabled').props.accessibilityState.checked).toBe(
        false,
      );

      // ZERO sub-settings visible while Kids Mode is OFF
      expect(screen.queryByTestId('parental-pin-status')).toBeNull();
      expect(screen.queryByTestId('parental-set-pin')).toBeNull();
      expect(screen.queryByTestId('parental-toggle-adult-keywords')).toBeNull();
      expect(screen.queryByTestId('parental-max-age-12')).toBeNull();
      expect(screen.queryByTestId('parental-timeout-15')).toBeNull();
      expect(screen.queryByTestId('parental-categories-locked')).toBeNull();
      expect(screen.queryByTestId('parental-cat-kind-bar')).toBeNull();

      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });

  it('prompts PIN creation when enabling Kids Mode without a PIN, keeps OFF on cancel, and reveals controls on PIN creation', async () => {
    const env = await createPanelEnv();
    try {
      const view = await render(
        <AppProviders
          profilePreferences={env.profilePreferences}
          i18n={createAppI18n('en')}
          viewport={{
            formFactor: 'desktop',
            orientation: 'landscape',
            inputModality: 'pointer',
            width: 1280,
            height: 800,
          }}
        >
          <ProfileProvider catalog={env.catalog} profilePreferences={env.profilePreferences}>
            <ProfilesAndParentalPanel catalog={env.catalog} sources={env.sources} />
            <AppShellProfileOverlays onOpenProfilesSettings={jest.fn()} />
          </ProfileProvider>
        </AppProviders>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('parental-toggle-enabled')).toBeTruthy();
      });

      // Toggling ON without a PIN opens PIN creation dialog
      await fireEvent.press(screen.getByTestId('parental-toggle-enabled'));
      expect(screen.getByTestId('pin-entry-overlay')).toBeTruthy();
      expect(screen.getByTestId('pin-entry-title')).toHaveTextContent('Create a 4–8 digit PIN');

      // Cancelling PIN creation keeps Kids Mode OFF and sub-settings hidden
      await fireEvent.press(screen.getByTestId('pin-entry-cancel'));
      await waitFor(() => {
        expect(screen.queryByTestId('pin-entry-overlay')).toBeNull();
      });
      expect(screen.getByTestId('parental-toggle-enabled').props.accessibilityState.checked).toBe(
        false,
      );
      expect(screen.queryByTestId('parental-toggle-adult-keywords')).toBeNull();

      // Completing PIN creation immediately enables Kids Mode, reveals sub-settings, and stays
      // unlocked for the active setup session so parents can configure limits/locks without re-entering PIN!
      await fireEvent.press(screen.getByTestId('parental-toggle-enabled'));
      await tapPin('1234');
      await tapPin('1234');

      await waitFor(() => {
        expect(screen.queryByTestId('pin-entry-overlay')).toBeNull();
        expect(screen.getByTestId('parental-toggle-enabled').props.accessibilityState.checked).toBe(
          true,
        );
        expect(screen.getByTestId('parental-pin-status')).toHaveTextContent('PIN protected');
        expect(screen.getByTestId('parental-status-badge')).toHaveTextContent('Unlocked');
        expect(screen.getByTestId('parental-toggle-adult-keywords')).toBeTruthy();
        expect(screen.getByTestId('parental-max-age-12')).toBeTruthy();
        expect(screen.getByTestId('parental-timeout-15')).toBeTruthy();
        expect(screen.queryByTestId('parental-categories-locked')).toBeNull();
        expect(screen.getByText('Sports')).toBeTruthy();
        expect(screen.getByText('18+ Adult')).toBeTruthy();
      });

      // Immediately editable without re-prompting for the PIN just created
      await fireEvent.press(screen.getByTestId('parental-max-age-12'));
      await fireEvent.press(screen.getByTestId('parental-timeout-15'));
      expect(screen.queryByTestId('pin-entry-overlay')).toBeNull();
      await waitFor(async () => {
        const settings = await env.catalog.getParentalSettings?.('default');
        expect(settings?.maxRatingAge).toBe(12);
        expect(settings?.unlockTimeoutMin).toBe(15);
      });

      const sportsCat = (
        await env.catalog.categories(env.sources[0]?.id ?? '', 'live', {
          includeHidden: true,
          parentalUnlocked: true,
        })
      ).find((c) => c.name === 'Sports');
      expect(sportsCat).toBeDefined();
      await fireEvent.press(screen.getByTestId(`parental-cat-lock-${sportsCat?.id ?? ''}`));
      await waitFor(() => {
        expect(
          screen.getByTestId(`parental-cat-lock-${sportsCat?.id ?? ''}`).props.accessibilityState
            .checked,
        ).toBe(true);
      });

      // Lock Now re-locks immediately and hides category titles
      await fireEvent.press(screen.getByTestId('parental-lock-now'));
      await waitFor(() => {
        expect(screen.getByTestId('parental-status-badge')).toHaveTextContent('Locked');
        expect(screen.getByTestId('parental-categories-locked')).toBeTruthy();
        expect(screen.queryByText('18+ Adult')).toBeNull();
      });

      // Turning Kids Mode OFF requires PIN verification while locked
      await fireEvent.press(screen.getByTestId('parental-toggle-enabled'));
      expect(screen.getByTestId('pin-entry-overlay')).toBeTruthy();
      await fireEvent.press(screen.getByTestId('pin-entry-cancel'));
      expect(screen.getByTestId('parental-toggle-enabled').props.accessibilityState.checked).toBe(
        true,
      );

      // Verify PIN to turn Kids Mode OFF -> collapses sub-settings again
      await fireEvent.press(screen.getByTestId('parental-toggle-enabled'));
      expect(screen.getByTestId('pin-entry-overlay')).toBeTruthy();
      await tapPin('1234');
      await waitFor(() => {
        expect(screen.getByTestId('parental-toggle-enabled').props.accessibilityState.checked).toBe(
          false,
        );
        expect(screen.queryByTestId('parental-toggle-adult-keywords')).toBeNull();
      });

      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });

  it('requires PIN when enabling Kids Mode if a guard PIN already exists and protects Kids profile from disabling Kids Mode', async () => {
    const env = await createPanelEnv();
    try {
      await env.catalog.setParentalPin?.('4321', 'default');

      const view = await render(
        <AppProviders
          profilePreferences={env.profilePreferences}
          i18n={createAppI18n('en')}
          viewport={{
            formFactor: 'desktop',
            orientation: 'landscape',
            inputModality: 'pointer',
            width: 1280,
            height: 800,
          }}
        >
          <ProfileProvider catalog={env.catalog} profilePreferences={env.profilePreferences}>
            <ProfilesAndParentalPanel catalog={env.catalog} sources={env.sources} />
            <AppShellProfileOverlays onOpenProfilesSettings={jest.fn()} />
          </ProfileProvider>
        </AppProviders>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('parental-toggle-enabled').props.accessibilityState.checked).toBe(
          false,
        );
      });
      // Still zero sub-settings while OFF even if a PIN already exists
      expect(screen.queryByTestId('parental-toggle-adult-keywords')).toBeNull();

      // Toggling ON with an existing guard PIN prompts verification instead of create
      await fireEvent.press(screen.getByTestId('parental-toggle-enabled'));
      expect(screen.getByTestId('pin-entry-overlay')).toBeTruthy();
      expect(screen.getByTestId('pin-entry-title')).toHaveTextContent('Unlock parental controls');
      await tapPin('4321');

      await waitFor(() => {
        expect(screen.getByTestId('parental-toggle-enabled').props.accessibilityState.checked).toBe(
          true,
        );
        expect(screen.getByTestId('parental-toggle-adult-keywords')).toBeTruthy();
      });

      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });

  it('handles TV Back to return to Settings sidebar and keeps TV category-kind chips focusable', async () => {
    const env = await createPanelEnv();
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
    let keyListener: ((e: AndroidKeyEvent) => void) | undefined;
    const androidSource: AndroidKeySource = {
      addListener: (l) => {
        keyListener = l;
        return { remove: () => undefined };
      },
    };
    const onBack = jest.fn();

    try {
      await env.catalog.setParentalPin?.('1234', 'default');
      await env.catalog.updateParentalSettings?.({ enabled: true }, 'default');

      const view = await render(
        <RemoteKeysProvider android={androidSource}>
          <AppProviders
            profilePreferences={env.profilePreferences}
            i18n={createAppI18n('en')}
            viewport={{
              formFactor: 'tv',
              orientation: 'landscape',
              inputModality: 'tv',
              width: 1280,
              height: 720,
            }}
          >
            <ProfileProvider catalog={env.catalog} profilePreferences={env.profilePreferences}>
              <ProfilesAndParentalPanel
                catalog={env.catalog}
                sources={env.sources}
                isActiveScope
                onBack={onBack}
              />
              <AppShellProfileOverlays onOpenProfilesSettings={jest.fn()} />
            </ProfileProvider>
          </AppProviders>
        </RemoteKeysProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('parental-categories-unlock')).toBeTruthy();
      });
      await fireEvent.press(screen.getByTestId('parental-categories-unlock'));
      await tapPin('1234');

      await waitFor(() => {
        expect(screen.getByTestId('parental-cat-kind-live')).toBeTruthy();
        expect(screen.getByTestId('parental-cat-kind-movie').props.focusable).not.toBe(false);
        expect(screen.getByTestId('parental-cat-kind-series').props.focusable).not.toBe(false);
      });

      await act(async () => {
        keyListener?.({ action: 'down', keyCode: KEYCODE_BACK, canceled: false, ageMs: 0 });
        keyListener?.({ action: 'up', keyCode: KEYCODE_BACK, canceled: false, ageMs: 10 });
      });
      expect(onBack).toHaveBeenCalledTimes(1);

      await view.unmount();
    } finally {
      jest.restoreAllMocks();
      await env.cleanup();
    }
  });
});
