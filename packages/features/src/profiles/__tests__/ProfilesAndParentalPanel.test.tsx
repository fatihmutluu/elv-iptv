import { createCatalogService, openCatalog } from '@elv/data';
import { countingScheduler, memorySecrets, testDb } from '@elv/data/testing';
import { createProfilePreferencesManager, ok, type PreferencesKvBackend } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { AppShellProfileOverlays } from '../../app-shell-overlays';
import { AppProviders } from '../../index';
import { ProfileProvider } from '../../shared';
import { ProfilesAndParentalPanel } from '../ProfilesAndParentalPanel';

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

describe('ProfilesAndParentalPanel', () => {
  it('supports profile CRUD (create Kids profile, edit, switch, delete) and enforces last-profile delete guard', async () => {
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

      // Single default profile disables Delete and shows last-profile hint
      await waitFor(() => {
        expect(screen.getByTestId('profile-row-default')).toBeTruthy();
        expect(screen.getByTestId('profiles-cannot-delete-last-hint')).toBeTruthy();
        expect(screen.getByTestId('profile-delete-default').props.accessibilityState.disabled).toBe(
          true,
        );
      });

      // Add a Kids profile
      await fireEvent.press(screen.getByTestId('profiles-add-button'));
      await fireEvent.changeText(screen.getByTestId('profile-form-name-input'), 'Kids Room');
      await fireEvent.press(screen.getByTestId('profile-avatar-option-emerald'));
      await fireEvent.press(screen.getByTestId('profile-form-kids-toggle'));
      await fireEvent.press(screen.getByTestId('profile-form-save'));

      await waitFor(() => {
        expect(screen.getByText('Kids Room')).toBeTruthy();
        expect(screen.queryByTestId('profiles-cannot-delete-last-hint')).toBeNull();
      });

      const listAfterCreate = await env.catalog.listProfiles?.();
      const kidsProfile = listAfterCreate?.find((p) => p.name === 'Kids Room');
      expect(kidsProfile?.isKids).toBe(true);
      expect(kidsProfile?.avatarToken).toBe('emerald');
      const kidsId = kidsProfile?.id ?? '';

      // Switch to Kids profile -> parental controls become enabled automatically
      await fireEvent.press(screen.getByTestId(`profile-switch-${kidsId}`));
      await waitFor(() => {
        expect(screen.getByTestId(`profile-active-badge-${kidsId}`)).toBeTruthy();
        expect(screen.getByTestId('parental-toggle-enabled').props.accessibilityState.checked).toBe(
          true,
        );
      });

      // Edit Kids profile name
      await fireEvent.press(screen.getByTestId(`profile-edit-${kidsId}`));
      await fireEvent.changeText(screen.getByTestId('profile-form-name-input'), 'Little Ones');
      await fireEvent.press(screen.getByTestId('profile-form-save'));
      await waitFor(() => {
        expect(screen.getByText('Little Ones')).toBeTruthy();
      });

      // Delete active profile -> confirms inline and switches cleanly back to Default
      await fireEvent.press(screen.getByTestId(`profile-delete-${kidsId}`));
      expect(screen.getByTestId(`profile-delete-confirm-${kidsId}`)).toBeTruthy();
      await fireEvent.press(screen.getByTestId(`profile-delete-confirm-btn-${kidsId}`));

      await waitFor(() => {
        expect(screen.queryByTestId(`profile-row-${kidsId}`)).toBeNull();
        expect(screen.getByTestId('profile-active-badge-default')).toBeTruthy();
        expect(screen.getByTestId('profiles-cannot-delete-last-hint')).toBeTruthy();
      });

      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });

  it('gates parental policy edits and category unlock behind PIN entry and keeps locked categories visible in Settings', async () => {
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

      // Both Sports and 18+ Adult categories are visible in Settings Category Locks
      await waitFor(() => {
        expect(screen.getByText('Sports')).toBeTruthy();
        expect(screen.getByText('18+ Adult')).toBeTruthy();
      });

      // Set a 4-digit PIN
      await fireEvent.press(screen.getByTestId('parental-set-pin'));
      expect(screen.getByTestId('pin-entry-overlay')).toBeTruthy();
      await tapPin('1234');
      await tapPin('1234');
      await waitFor(() => {
        expect(screen.getByTestId('parental-pin-status')).toHaveTextContent('PIN protected');
      });

      // Enabling parental controls while locked gates through PinEntryOverlay first
      await fireEvent.press(screen.getByTestId('parental-toggle-enabled'));
      expect(screen.getByTestId('pin-entry-overlay')).toBeTruthy();
      await tapPin('1234');

      await waitFor(() => {
        expect(screen.queryByTestId('pin-entry-overlay')).toBeNull();
        expect(screen.getByTestId('parental-toggle-enabled').props.accessibilityState.checked).toBe(
          true,
        );
        expect(screen.getByTestId('parental-status-badge')).toHaveTextContent('Unlocked');
      });

      // While unlocked, changing max age rating & unlock timeout applies directly
      await fireEvent.press(screen.getByTestId('parental-max-age-12'));
      await fireEvent.press(screen.getByTestId('parental-timeout-15'));
      await waitFor(async () => {
        const settings = await env.catalog.getParentalSettings?.('default');
        expect(settings?.maxRatingAge).toBe(12);
        expect(settings?.unlockTimeoutMin).toBe(15);
      });

      // Lock Sports category
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

      // Lock Now re-locks immediately; locked Sports category stays visible in Settings to unlock
      await fireEvent.press(screen.getByTestId('parental-lock-now'));
      await waitFor(() => {
        expect(screen.getByTestId('parental-status-badge')).toHaveTextContent('Locked');
        expect(screen.getByTestId(`parental-cat-lock-${sportsCat?.id ?? ''}`)).toBeTruthy();
      });

      // Unlocking the category while locked requires PIN first
      await fireEvent.press(screen.getByTestId(`parental-cat-lock-${sportsCat?.id ?? ''}`));
      expect(screen.getByTestId('pin-entry-overlay')).toBeTruthy();
      await tapPin('1234');
      await waitFor(() => {
        expect(
          screen.getByTestId(`parental-cat-lock-${sportsCat?.id ?? ''}`).props.accessibilityState
            .checked,
        ).toBe(false);
      });

      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });
});
