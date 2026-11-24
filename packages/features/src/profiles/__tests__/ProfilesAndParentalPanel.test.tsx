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

  it('gates parental policy edits, hides locked categories until unlocked, and requires PIN for add/edit/delete', async () => {
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

      // Before any PIN is set, categories are visible in Settings Category Locks
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
        // Once PIN is set and locked, adult category titles are immediately hidden!
        expect(screen.getByTestId('parental-categories-locked')).toBeTruthy();
        expect(screen.queryByText('18+ Adult')).toBeNull();
        expect(screen.queryByText('Sports')).toBeNull();
      });

      // Add profile button is gated by PIN while locked!
      await fireEvent.press(screen.getByTestId('profiles-add-button'));
      expect(screen.getByTestId('pin-entry-overlay')).toBeTruthy();
      await fireEvent.press(screen.getByTestId('pin-entry-cancel'));
      expect(screen.queryByTestId('profile-form-card')).toBeNull();

      // Cancelling Change PIN after verifying old PIN MUST keep parental controls locked!
      await fireEvent.press(screen.getByTestId('parental-change-pin'));
      expect(screen.getByTestId('pin-entry-overlay')).toBeTruthy();
      await tapPin('1234');
      await waitFor(() => {
        expect(screen.getByTestId('pin-entry-title')).toHaveTextContent('Create a 4–8 digit PIN');
      });
      await fireEvent.press(screen.getByTestId('pin-entry-cancel'));
      expect(screen.getByTestId('parental-status-badge')).toHaveTextContent('Locked');
      expect(screen.getByTestId('parental-categories-locked')).toBeTruthy();

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
        expect(screen.getByText('Sports')).toBeTruthy();
        expect(screen.getByText('18+ Adult')).toBeTruthy();
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

      // Lock Now re-locks immediately and hides all adult/locked category titles behind Unlock CTA
      await fireEvent.press(screen.getByTestId('parental-lock-now'));
      await waitFor(() => {
        expect(screen.getByTestId('parental-status-badge')).toHaveTextContent('Locked');
        expect(screen.getByTestId('parental-categories-locked')).toBeTruthy();
        expect(screen.queryByText('18+ Adult')).toBeNull();
        expect(screen.queryByTestId(`parental-cat-lock-${sportsCat?.id ?? ''}`)).toBeNull();
      });

      // Unlocking via the locked-categories Unlock button reveals the list and permits unlocking Sports
      await fireEvent.press(screen.getByTestId('parental-categories-unlock'));
      expect(screen.getByTestId('pin-entry-overlay')).toBeTruthy();
      await tapPin('1234');
      await waitFor(() => {
        expect(screen.getByTestId(`parental-cat-lock-${sportsCat?.id ?? ''}`)).toBeTruthy();
      });
      await fireEvent.press(screen.getByTestId(`parental-cat-lock-${sportsCat?.id ?? ''}`));
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

  it('prevents Kids -> Adult escape using parent default PIN as guard even when Kids has no own PIN', async () => {
    const env = await createPanelEnv();
    try {
      await env.catalog.setParentalPin?.('4321', 'default');
      const kids = await env.catalog.createProfile?.({
        name: 'Kids',
        avatarToken: 'emerald',
        isKids: true,
      });
      if (!kids?.ok) throw new Error('createProfile failed');
      const kidsId = kids.value.id;
      await env.profilePreferences.switchProfile(kidsId);
      await env.profilePreferences.saveActiveProfileId(kidsId);

      const categoriesSpy = jest.spyOn(env.catalog, 'categories');

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
        expect(screen.getByTestId(`profile-active-badge-${kidsId}`)).toBeTruthy();
        expect(screen.getByTestId('parental-categories-locked')).toBeTruthy();
      });

      // Adult category titles must NEVER be queried or rendered while Kids is locked!
      expect(categoriesSpy).not.toHaveBeenCalled();
      expect(screen.queryByText('18+ Adult')).toBeNull();

      // Attempting to switch back to Default requires parent PIN ('4321')!
      await fireEvent.press(screen.getByTestId('profile-switch-default'));
      expect(screen.getByTestId('pin-entry-overlay')).toBeTruthy();
      await fireEvent.press(screen.getByTestId('pin-entry-cancel'));
      expect(screen.getByTestId(`profile-active-badge-${kidsId}`)).toBeTruthy();

      // Attempting to disable parental controls, add profile, or delete Default also requires parent PIN!
      await fireEvent.press(screen.getByTestId('parental-toggle-enabled'));
      expect(screen.getByTestId('pin-entry-overlay')).toBeTruthy();
      await fireEvent.press(screen.getByTestId('pin-entry-cancel'));

      await fireEvent.press(screen.getByTestId('profile-delete-default'));
      expect(screen.getByTestId('pin-entry-overlay')).toBeTruthy();
      await fireEvent.press(screen.getByTestId('pin-entry-cancel'));

      // Entering parent PIN '4321' permits switching back to Default cleanly
      await fireEvent.press(screen.getByTestId('profile-switch-default'));
      await tapPin('4321');
      await waitFor(() => {
        expect(screen.queryByTestId('pin-entry-overlay')).toBeNull();
        expect(screen.getByTestId('profile-active-badge-default')).toBeTruthy();
      });

      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });

  it('keeps TV Back inside ProfileFormCard TvTextInput instead of exiting to Settings sidebar', async () => {
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
            </ProfileProvider>
          </AppProviders>
        </RemoteKeysProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('profiles-add-button')).toBeTruthy();
      });

      await fireEvent.press(screen.getByTestId('profiles-add-button'));
      const input = screen.getByTestId('profile-form-name-input');
      await fireEvent(input, 'focus');

      // Back while TvTextInput is focused exits text entry without calling onBack()!
      await act(async () => {
        keyListener?.({ action: 'down', keyCode: KEYCODE_BACK, canceled: false, ageMs: 0 });
        keyListener?.({ action: 'up', keyCode: KEYCODE_BACK, canceled: false, ageMs: 10 });
      });
      expect(onBack).not.toHaveBeenCalled();

      // Next Back (after text entry exited) returns cleanly to Settings sidebar
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

  it('keeps category-kind chips TV-focusable and closes open profile form/delete UI on parental re-lock', async () => {
    const env = await createPanelEnv();
    try {
      await env.catalog.createProfile?.({ name: 'Kids', avatarToken: 'emerald', isKids: true });
      await env.catalog.setParentalPin?.('1234', 'default');

      const view = await render(
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
            <ProfilesAndParentalPanel catalog={env.catalog} sources={env.sources} />
            <AppShellProfileOverlays onOpenProfilesSettings={jest.fn()} />
          </ProfileProvider>
        </AppProviders>,
      );

      // Unlock parental controls via Settings unlock button
      await waitFor(() => {
        expect(screen.getByTestId('parental-categories-unlock')).toBeTruthy();
      });
      await fireEvent.press(screen.getByTestId('parental-categories-unlock'));
      await tapPin('1234');

      // On 10-foot TV, Live/Movies/Series FilterChips must remain focusable (never focusable={false})
      await waitFor(() => {
        expect(screen.getByTestId('parental-cat-kind-live')).toBeTruthy();
        expect(screen.getByTestId('parental-cat-kind-movie').props.focusable).not.toBe(false);
        expect(screen.getByTestId('parental-cat-kind-series').props.focusable).not.toBe(false);
      });

      // Open Add Profile form while unlocked, then re-lock via Lock Now -> form must close immediately
      await fireEvent.press(screen.getByTestId('profiles-add-button'));
      expect(screen.getByTestId('profile-form-card')).toBeTruthy();
      await fireEvent.press(screen.getByTestId('parental-lock-now'));
      await waitFor(() => {
        expect(screen.queryByTestId('profile-form-card')).toBeNull();
      });

      // Unlock again, open Delete confirmation on Kids profile, then re-lock -> confirm closes immediately
      await fireEvent.press(screen.getByTestId('parental-categories-unlock'));
      await tapPin('1234');
      await waitFor(() => {
        expect(screen.getByTestId('parental-lock-now')).toBeTruthy();
      });
      const kidsId = (await env.catalog.listProfiles?.())?.find((p) => p.isKids)?.id ?? '';
      await fireEvent.press(screen.getByTestId(`profile-delete-${kidsId}`));
      expect(screen.getByTestId(`profile-delete-confirm-${kidsId}`)).toBeTruthy();
      await fireEvent.press(screen.getByTestId('parental-lock-now'));
      await waitFor(() => {
        expect(screen.queryByTestId(`profile-delete-confirm-${kidsId}`)).toBeNull();
      });

      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });
});
