import { createCatalogService, openCatalog } from '@elv/data';
import { countingScheduler, memorySecrets, testDb } from '@elv/data/testing';
import { createProfilePreferencesManager, ok, type PreferencesKvBackend } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Platform, Pressable, Text } from 'react-native';
import { AppShellProfileOverlays } from '../../app-shell-overlays';
import { AppProviders } from '../../index';
import { ProfileProvider, useProfile } from '../../shared';

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

async function tapPin(digits: string): Promise<void> {
  for (const ch of digits) {
    await fireEvent.press(screen.getByTestId(`pin-key-${ch}`));
  }
  await fireEvent.press(screen.getByTestId('pin-entry-submit'));
}

async function createPickerEnv() {
  const handle = testDb();
  await openCatalog(handle.db);
  const catalog = createCatalogService({
    db: handle.db,
    secrets: memorySecrets(),
    scheduler: countingScheduler(),
    clock: () => Date.now(),
    http: {
      async get() {
        return ok({
          status: 200,
          headers: {},
          body: {
            async *[Symbol.asyncIterator]() {
              yield new Uint8Array();
            },
          },
        });
      },
    },
  });
  const profilePreferences = createProfilePreferencesManager(createMemBackend());
  return {
    catalog,
    profilePreferences,
    cleanup: async () => {
      await catalog.close();
      await handle.close();
    },
  };
}

function PickerTriggers() {
  const { openProfilePicker, unlockParental, parentalUnlocked, parentalLoadError } = useProfile();
  return (
    <>
      <Pressable testID="open-picker-btn" onPress={openProfilePicker}>
        <Text>Open Picker</Text>
      </Pressable>
      <Pressable testID="unlock-btn" onPress={() => void unlockParental('4321')}>
        <Text>Unlock</Text>
      </Pressable>
      <Text testID="unlocked-flag">{String(parentalUnlocked)}</Text>
      <Text testID="load-error-flag">{String(parentalLoadError)}</Text>
    </>
  );
}

describe('ProfilePickerOverlay re-verification & fail-closed guards (Wave Q5-A)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('requires fresh PIN verification while parentalUnlocked is true before turning Kids OFF, setting a PIN when guard PIN exists, or deleting a Kids/PIN-protected profile', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    const env = await createPickerEnv();
    try {
      await env.catalog.setParentalPin?.('4321', 'default');
      const kids = await env.catalog.createProfile?.({
        name: 'Kids',
        avatarToken: 'emerald',
        isKids: true,
      });
      if (!kids?.ok) throw new Error('createProfile failed');
      const kidsId = kids.value.id;

      const view = await render(
        <AppProviders
          profilePreferences={env.profilePreferences}
          i18n={createAppI18n('en')}
          viewport={{
            formFactor: 'phone',
            orientation: 'portrait',
            inputModality: 'touch',
            width: 393,
            height: 852,
          }}
        >
          <ProfileProvider
            catalog={env.catalog}
            profilePreferences={env.profilePreferences}
            suppressAutoProfilePicker
          >
            <PickerTriggers />
            <AppShellProfileOverlays onOpenProfilesSettings={jest.fn()} />
          </ProfileProvider>
        </AppProviders>,
      );

      // Unlock parental session first
      await waitFor(() => expect(screen.getByTestId('unlock-btn')).toBeTruthy());
      await fireEvent.press(screen.getByTestId('unlock-btn'));
      await waitFor(() => expect(screen.getByTestId('unlocked-flag')).toHaveTextContent('true'));

      // Open profile picker and edit Kids profile (already unlocked -> opens edit modal)
      await fireEvent.press(screen.getByTestId('open-picker-btn'));
      await waitFor(() => expect(screen.getByTestId(`profile-picker-edit-${kidsId}`)).toBeTruthy());
      await fireEvent.press(screen.getByTestId(`profile-picker-edit-${kidsId}`));
      await waitFor(() => expect(screen.getByTestId('profile-edit-modal')).toBeTruthy());

      // 1. Toggling Kids OFF while unlocked MUST re-verify guard PIN
      await fireEvent.press(screen.getByTestId('profile-form-kids-toggle'));
      expect(screen.getByTestId('pin-entry-overlay')).toBeTruthy();
      expect(screen.getByText('Verify parental PIN')).toBeTruthy();
      await fireEvent.press(screen.getByTestId('pin-entry-cancel'));
      expect(screen.queryByTestId('pin-entry-overlay')).toBeNull();
      expect(screen.getByTestId('profile-form-kids-toggle').props.accessibilityState.checked).toBe(
        true,
      );

      // 2. Setting a PIN on Kids profile while guard PIN already exists MUST re-verify guard PIN first
      await fireEvent.press(screen.getByTestId('profile-edit-set-pin'));
      expect(screen.getByTestId('pin-entry-overlay')).toBeTruthy();
      expect(screen.getByText('Verify parental PIN')).toBeTruthy();
      await fireEvent.press(screen.getByTestId('pin-entry-cancel'));
      expect(screen.queryByTestId('pin-entry-overlay')).toBeNull();

      // 3. Deleting a Kids profile while unlocked MUST re-verify guard PIN first
      await fireEvent.press(screen.getByTestId('profile-edit-delete'));
      expect(screen.getByTestId('pin-entry-overlay')).toBeTruthy();
      expect(screen.getByText('Verify parental PIN')).toBeTruthy();
      await fireEvent.press(screen.getByTestId('pin-entry-cancel'));
      expect(screen.queryByTestId('profile-edit-delete-confirm')).toBeNull();

      // Verifying PIN allows delete confirmation and deletion
      await fireEvent.press(screen.getByTestId('profile-edit-delete'));
      await tapPin('4321');
      await waitFor(() => expect(screen.getByTestId('profile-edit-delete-confirm')).toBeTruthy());
      await fireEvent.press(screen.getByTestId('profile-edit-delete-confirm-btn'));
      await waitFor(() => expect(screen.queryByTestId('profile-edit-modal')).toBeNull());

      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });

  it('blocks profile add and edit mutations when parentalLoadError is true', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    const env = await createPickerEnv();
    try {
      jest.spyOn(env.catalog, 'getParentalSettings').mockRejectedValue(new Error('sqlite failed'));

      const view = await render(
        <AppProviders
          profilePreferences={env.profilePreferences}
          i18n={createAppI18n('en')}
          viewport={{
            formFactor: 'phone',
            orientation: 'portrait',
            inputModality: 'touch',
            width: 393,
            height: 852,
          }}
        >
          <ProfileProvider
            catalog={env.catalog}
            profilePreferences={env.profilePreferences}
            suppressAutoProfilePicker
          >
            <PickerTriggers />
            <AppShellProfileOverlays onOpenProfilesSettings={jest.fn()} />
          </ProfileProvider>
        </AppProviders>,
      );

      await waitFor(() => expect(screen.getByTestId('load-error-flag')).toHaveTextContent('true'));

      await fireEvent.press(screen.getByTestId('open-picker-btn'));
      await waitFor(() => expect(screen.getByTestId('profile-picker-add')).toBeTruthy());

      await fireEvent.press(screen.getByTestId('profile-picker-add'));
      expect(screen.queryByTestId('profile-submodal-backdrop')).toBeNull();

      await fireEvent.press(screen.getByTestId('profile-picker-edit-default'));
      expect(screen.queryByTestId('profile-edit-modal')).toBeNull();

      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });
});
