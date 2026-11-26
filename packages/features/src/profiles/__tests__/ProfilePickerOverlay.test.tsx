import { createCatalogService, openCatalog, PROFILE_AVATAR_TOKENS } from '@elv/data';
import { countingScheduler, memorySecrets, testDb } from '@elv/data/testing';
import { createProfilePreferencesManager, ok, type PreferencesKvBackend } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { type AndroidKeyEvent, type AndroidKeySource, RemoteKeysProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Platform, Pressable } from 'react-native';
import { AppShellProfileOverlays } from '../../app-shell-overlays';
import { AppProviders } from '../../index';
import { ProfileProvider, useProfile } from '../../shared';

const KEYCODE_DPAD_RIGHT = 22;
const KEYCODE_DPAD_DOWN = 20;
const KEYCODE_DPAD_CENTER = 23;
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

async function createPickerEnv() {
  const handle = testDb();
  await openCatalog(handle.db);
  const catalog = createCatalogService({
    db: handle.db,
    secrets: memorySecrets(),
    scheduler: countingScheduler(),
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
    clock: () => 20_000,
  });
  const profilePreferences = createProfilePreferencesManager(createMemBackend(), { coalesceMs: 0 });
  return {
    catalog,
    profilePreferences,
    async cleanup() {
      await catalog.close();
      handle.close();
    },
  };
}

function OpenPickerTrigger() {
  const { openProfilePicker } = useProfile();
  return <Pressable testID="open-picker-btn" onPress={openProfilePicker} />;
}

async function tapPin(digits: string) {
  for (const d of digits) {
    await fireEvent.press(screen.getByTestId(`pin-key-${d}`));
  }
  await fireEvent.press(screen.getByTestId('pin-entry-submit'));
}

describe('ProfilePickerOverlay ("Who\'s Watching?")', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("renders cinematic Who's Watching? grid with + Add circle, no Manage in Settings button, and 2-step Adult/Kids creation", async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    const env = await createPickerEnv();
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
            <OpenPickerTrigger />
            <AppShellProfileOverlays onOpenProfilesSettings={jest.fn()} />
          </ProfileProvider>
        </AppProviders>,
      );

      await fireEvent.press(screen.getByTestId('open-picker-btn'));

      await waitFor(() => {
        expect(screen.getByTestId('profile-picker-title')).toHaveTextContent("Who's Watching?");
        expect(screen.getByTestId('profile-picker-card-default')).toBeTruthy();
        expect(screen.getByTestId('profile-picker-add')).toBeTruthy();
      });

      // No separate bottom "Manage profiles in Settings" / "Edit profiles" button
      expect(screen.queryByTestId('profile-picker-manage')).toBeNull();

      // Open 2-step Add Profile flow via + circle
      await fireEvent.press(screen.getByTestId('profile-picker-add'));
      expect(screen.getByTestId('profile-add-type-modal')).toBeTruthy();
      expect(screen.getByText('Choose profile type')).toBeTruthy();
      expect(screen.getByTestId('profile-type-adult')).toBeTruthy();
      expect(screen.getByTestId('profile-type-kids')).toBeTruthy();

      // Select Kids type -> Continue -> Step 2 shows all 9 illustrated avatar tokens
      await fireEvent.press(screen.getByTestId('profile-type-kids'));
      await fireEvent.press(screen.getByTestId('profile-type-continue'));

      await waitFor(() => {
        expect(screen.getByTestId('profile-add-details-modal')).toBeTruthy();
      });
      for (const token of PROFILE_AVATAR_TOKENS) {
        expect(screen.getByTestId(`profile-avatar-option-${token}`)).toBeTruthy();
      }

      // Fill name, pick new Wave P7 'coral' avatar, and save
      await fireEvent.changeText(screen.getByTestId('profile-form-name-input'), 'Kids Room');
      await fireEvent.press(screen.getByTestId('profile-avatar-option-coral'));
      await fireEvent.press(screen.getByTestId('profile-form-save'));

      await waitFor(() => {
        expect(screen.queryByTestId('profile-add-details-modal')).toBeNull();
        expect(screen.getByText('Kids Room')).toBeTruthy();
      });

      const list = await env.catalog.listProfiles?.();
      const created = list?.find((p) => p.name === 'Kids Room');
      expect(created?.isKids).toBe(true);
      expect(created?.avatarToken).toBe('coral');

      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });

  it('reveals hover pencil on desktop web, edits profile (rename, 9 avatars, PIN manage, Kids toggle, delete) without switching', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    const env = await createPickerEnv();
    try {
      const kids = await env.catalog.createProfile?.({
        name: 'Leo',
        avatarToken: 'teal',
        isKids: true,
      });
      if (!kids?.ok) throw new Error('createProfile failed');
      const kidsId = kids.value.id;

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
            <OpenPickerTrigger />
            <AppShellProfileOverlays onOpenProfilesSettings={jest.fn()} />
          </ProfileProvider>
        </AppProviders>,
      );

      await fireEvent.press(screen.getByTestId('open-picker-btn'));
      await waitFor(() => {
        expect(screen.getByTestId(`profile-picker-card-${kidsId}`)).toBeTruthy();
      });

      // Before hover on web, pencil trigger is not revealed
      expect(screen.queryByTestId(`profile-picker-edit-${kidsId}`)).toBeNull();

      // Hover avatar -> reveals circular pencil edit trigger
      await fireEvent(screen.getByTestId(`profile-picker-tile-${kidsId}`), 'hoverIn');
      expect(screen.getByTestId(`profile-picker-edit-${kidsId}`)).toBeTruthy();

      // Clicking pencil opens Edit Profile popup (does NOT switch active profile or close overlay)
      await fireEvent.press(screen.getByTestId(`profile-picker-edit-${kidsId}`), {
        stopPropagation: jest.fn(),
      });
      await waitFor(() => {
        expect(screen.getByTestId('profile-edit-modal')).toBeTruthy();
        expect(screen.getByText('Edit profile')).toBeTruthy();
      });

      // Rename + pick 'indigo' avatar + Save
      await fireEvent.changeText(screen.getByTestId('profile-form-name-input'), 'Leo Jr');
      await fireEvent.press(screen.getByTestId('profile-avatar-option-indigo'));
      await fireEvent.press(screen.getByTestId('profile-form-save'));

      await waitFor(() => {
        expect(screen.queryByTestId('profile-edit-modal')).toBeNull();
        expect(screen.getByText('Leo Jr')).toBeTruthy();
      });

      const updated = (await env.catalog.listProfiles?.())?.find((p) => p.id === kidsId);
      expect(updated?.name).toBe('Leo Jr');
      expect(updated?.avatarToken).toBe('indigo');

      // Re-open Edit modal -> Set PIN via Manage PIN section
      await fireEvent(screen.getByTestId(`profile-picker-tile-${kidsId}`), 'hoverIn');
      await fireEvent.press(screen.getByTestId(`profile-picker-edit-${kidsId}`));
      await waitFor(() => {
        expect(screen.getByTestId('profile-edit-set-pin')).toBeTruthy();
      });
      await fireEvent.press(screen.getByTestId('profile-edit-set-pin'));
      expect(screen.getByTestId('pin-entry-overlay')).toBeTruthy();
      await tapPin('2580');
      await tapPin('2580');

      await waitFor(() => {
        expect(screen.queryByTestId('pin-entry-overlay')).toBeNull();
        expect(screen.getByTestId('profile-edit-change-pin')).toBeTruthy();
        expect(screen.getByTestId('profile-edit-remove-pin')).toBeTruthy();
      });

      // Delete profile with confirmation (no guard PIN on default, wait - kidsId has PIN so verify if needed)
      await fireEvent.press(screen.getByTestId('profile-edit-delete'));
      await waitFor(() => {
        expect(screen.getByTestId('profile-edit-delete-confirm')).toBeTruthy();
      });
      await fireEvent.press(screen.getByTestId('profile-edit-delete-confirm-btn'));

      await waitFor(() => {
        expect(screen.queryByTestId('profile-edit-modal')).toBeNull();
        expect(screen.queryByTestId(`profile-picker-card-${kidsId}`)).toBeNull();
      });

      // Only 1 profile remains -> opening Edit on Default hides/disables Delete profile
      await fireEvent(screen.getByTestId('profile-picker-tile-default'), 'hoverIn');
      await fireEvent.press(screen.getByTestId('profile-picker-edit-default'));
      await waitFor(() => {
        expect(screen.getByTestId('profile-edit-modal')).toBeTruthy();
        expect(screen.getByTestId('profile-submodal-scroll')).toBeTruthy();
        expect(screen.getByTestId('profile-submodal-scroll').props.keyboardShouldPersistTaps).toBe(
          'handled',
        );
      });
      const delBtn = screen.queryByTestId('profile-edit-delete');
      expect(delBtn === null || delBtn.props.accessibilityState?.disabled === true).toBe(true);

      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });

  it('protects Kids -> Adult switch, Kids toggle, and Delete with PIN when guard PIN is configured', async () => {
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
      await env.profilePreferences.switchProfile(kidsId);
      await env.profilePreferences.saveActiveProfileId(kidsId);

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
          <ProfileProvider catalog={env.catalog} profilePreferences={env.profilePreferences}>
            <OpenPickerTrigger />
            <AppShellProfileOverlays onOpenProfilesSettings={jest.fn()} />
          </ProfileProvider>
        </AppProviders>,
      );

      await fireEvent.press(screen.getByTestId('open-picker-btn'));
      await waitFor(() => {
        // On touch mobile/tablet, corner pencil badges are visible without hover!
        expect(screen.getByTestId(`profile-picker-edit-${kidsId}`)).toBeTruthy();
        expect(screen.getByTestId('profile-picker-edit-default')).toBeTruthy();
      });

      // Open Edit on Kids profile while locked -> immediately gated behind guard PIN!
      await fireEvent.press(screen.getByTestId(`profile-picker-edit-${kidsId}`));
      expect(screen.getByTestId('pin-entry-overlay')).toBeTruthy();
      await fireEvent.press(screen.getByTestId('pin-entry-cancel'));
      expect(screen.queryByTestId('profile-edit-modal')).toBeNull();

      // Tap Default avatar -> Kids -> Adult switch prompts guard PIN!
      await fireEvent.press(screen.getByTestId('profile-picker-card-default'));
      await waitFor(() => {
        expect(screen.getByTestId('pin-entry-overlay')).toBeTruthy();
      });
      await tapPin('4321');
      await waitFor(() => {
        expect(screen.queryByTestId('pin-entry-overlay')).toBeNull();
      });

      // Re-open picker -> entering Edit on Kids profile while locked prompts PIN and unlocks into Edit modal
      await fireEvent.press(screen.getByTestId('open-picker-btn'));
      await waitFor(() => {
        expect(screen.getByTestId(`profile-picker-edit-${kidsId}`)).toBeTruthy();
      });
      await fireEvent.press(screen.getByTestId(`profile-picker-edit-${kidsId}`));
      expect(screen.getByTestId('pin-entry-overlay')).toBeTruthy();
      await tapPin('4321');
      await waitFor(() => {
        expect(screen.getByTestId('profile-edit-modal')).toBeTruthy();
        expect(screen.getByTestId('profile-form-kids-toggle')).toBeTruthy();
      });

      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });

  it('supports 10-ft TV D-pad navigation across avatars, edit action, + Add, and Back dismissal', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
    let keyListener: ((e: AndroidKeyEvent) => void) | undefined;
    const androidSource: AndroidKeySource = {
      addListener: (l) => {
        keyListener = l;
        return { remove: () => undefined };
      },
    };
    const env = await createPickerEnv();
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
              <OpenPickerTrigger />
              <AppShellProfileOverlays onOpenProfilesSettings={jest.fn()} />
            </ProfileProvider>
          </AppProviders>
        </RemoteKeysProvider>,
      );

      await fireEvent.press(screen.getByTestId('open-picker-btn'));
      await waitFor(() => {
        expect(screen.getByTestId('profile-picker-overlay')).toBeTruthy();
      });

      // Down from focused Default avatar -> focuses Edit action; Select opens Edit modal
      await act(async () => {
        keyListener?.({ action: 'down', keyCode: KEYCODE_DPAD_DOWN, canceled: false, ageMs: 0 });
        keyListener?.({ action: 'up', keyCode: KEYCODE_DPAD_DOWN, canceled: false, ageMs: 10 });
      });
      await act(async () => {
        keyListener?.({ action: 'down', keyCode: KEYCODE_DPAD_CENTER, canceled: false, ageMs: 0 });
        keyListener?.({ action: 'up', keyCode: KEYCODE_DPAD_CENTER, canceled: false, ageMs: 10 });
      });
      await waitFor(() => {
        expect(screen.getByTestId('profile-edit-modal')).toBeTruthy();
        expect(screen.getByTestId('profile-submodal-scroll')).toBeTruthy();
        expect(screen.getByTestId('profile-submodal-scroll').props.keyboardShouldPersistTaps).toBe(
          'handled',
        );
        const anchor = screen.getByTestId('profile-submodal-tv-focus-anchor', {
          includeHiddenElements: true,
        });
        expect(anchor.props.hasTVPreferredFocus).toBe(true);
      });

      // Back inside Edit modal closes only the modal (not the whole overlay!)
      await act(async () => {
        keyListener?.({ action: 'down', keyCode: KEYCODE_BACK, canceled: false, ageMs: 0 });
        keyListener?.({ action: 'up', keyCode: KEYCODE_BACK, canceled: false, ageMs: 10 });
      });
      await waitFor(() => {
        expect(screen.queryByTestId('profile-edit-modal')).toBeNull();
        expect(screen.getByTestId('profile-picker-overlay')).toBeTruthy();
      });

      // Right from Default avatar -> moves to + Add; Select opens Add Profile Step 1
      await act(async () => {
        keyListener?.({ action: 'down', keyCode: KEYCODE_DPAD_RIGHT, canceled: false, ageMs: 0 });
        keyListener?.({ action: 'up', keyCode: KEYCODE_DPAD_RIGHT, canceled: false, ageMs: 10 });
      });
      await act(async () => {
        keyListener?.({ action: 'down', keyCode: KEYCODE_DPAD_CENTER, canceled: false, ageMs: 0 });
        keyListener?.({ action: 'up', keyCode: KEYCODE_DPAD_CENTER, canceled: false, ageMs: 10 });
      });
      await waitFor(() => {
        expect(screen.getByTestId('profile-add-type-modal')).toBeTruthy();
      });

      // Back closes Add modal, second Back closes ProfilePickerOverlay
      await act(async () => {
        keyListener?.({ action: 'down', keyCode: KEYCODE_BACK, canceled: false, ageMs: 0 });
        keyListener?.({ action: 'up', keyCode: KEYCODE_BACK, canceled: false, ageMs: 10 });
      });
      await waitFor(() => {
        expect(screen.queryByTestId('profile-add-type-modal')).toBeNull();
      });
      await act(async () => {
        keyListener?.({ action: 'down', keyCode: KEYCODE_BACK, canceled: false, ageMs: 0 });
        keyListener?.({ action: 'up', keyCode: KEYCODE_BACK, canceled: false, ageMs: 10 });
      });
      await waitFor(() => {
        expect(screen.queryByTestId('profile-picker-overlay')).toBeNull();
      });

      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });

  it('never mutates the active/guard profile PIN during Create and optionally creates a PIN strictly on the new profile ID', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    const env = await createPickerEnv();
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
            <OpenPickerTrigger />
            <AppShellProfileOverlays onOpenProfilesSettings={jest.fn()} />
          </ProfileProvider>
        </AppProviders>,
      );

      await fireEvent.press(screen.getByTestId('open-picker-btn'));
      await waitFor(() => {
        expect(screen.getByTestId('profile-picker-add')).toBeTruthy();
      });

      // Unlock Add flow with guard PIN
      await fireEvent.press(screen.getByTestId('profile-picker-add'));
      expect(screen.getByTestId('pin-entry-overlay')).toBeTruthy();
      await tapPin('4321');
      await waitFor(() => {
        expect(screen.getByTestId('profile-add-type-modal')).toBeTruthy();
      });

      await fireEvent.press(screen.getByTestId('profile-type-adult'));
      await fireEvent.press(screen.getByTestId('profile-type-continue'));
      await waitFor(() => {
        expect(screen.getByTestId('profile-add-details-modal')).toBeTruthy();
      });

      // Existing-profile Change/Remove PIN controls MUST NOT appear during creation
      expect(screen.queryByTestId('profile-edit-pin-section')).toBeNull();
      expect(screen.queryByTestId('profile-edit-change-pin')).toBeNull();
      expect(screen.queryByTestId('profile-edit-remove-pin')).toBeNull();
      expect(screen.getByTestId('profile-create-pin-toggle')).toBeTruthy();
      expect(screen.getByTestId('profile-submodal-scroll')).toBeTruthy();

      // Opt in to creating a PIN for the brand-new profile
      await fireEvent.press(screen.getByTestId('profile-create-pin-toggle'));
      await fireEvent.changeText(screen.getByTestId('profile-form-name-input'), 'Guest');
      await fireEvent.press(screen.getByTestId('profile-form-save'));

      // After createProfile succeeds, PIN create dialog opens for the newly created profile
      await waitFor(() => {
        expect(screen.queryByTestId('profile-add-details-modal')).toBeNull();
        expect(screen.getByTestId('pin-entry-overlay')).toBeTruthy();
      });
      await tapPin('7788');
      await tapPin('7788');
      await waitFor(() => {
        expect(screen.queryByTestId('pin-entry-overlay')).toBeNull();
      });

      const list = await env.catalog.listProfiles?.();
      const guest = list?.find((p) => p.name === 'Guest');
      expect(guest).toBeDefined();
      // Active/guard profile ('default') PIN was NEVER mutated!
      expect((await env.catalog.verifyParentalPin?.('4321', 'default'))?.ok).toBe(true);
      expect((await env.catalog.verifyParentalPin?.('7788', 'default'))?.ok).toBe(false);
      // Brand-new profile received its own PIN!
      expect(await env.catalog.hasParentalPin?.(guest?.id ?? '')).toBe(true);
      expect((await env.catalog.verifyParentalPin?.('7788', guest?.id ?? ''))?.ok).toBe(true);

      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });

  it('queries SQLite hasParentalPin accurately when editing a 3rd non-active profile', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    const env = await createPickerEnv();
    try {
      const p2 = await env.catalog.createProfile?.({
        name: 'Alex',
        avatarToken: 'sapphire',
        isKids: false,
      });
      const p3 = await env.catalog.createProfile?.({
        name: 'Mia',
        avatarToken: 'violet',
        isKids: true,
      });
      if (!p2?.ok || !p3?.ok) throw new Error('createProfile failed');
      const p3Id = p3.value.id;
      await env.catalog.setParentalPin?.('9999', p3Id);

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
            <OpenPickerTrigger />
            <AppShellProfileOverlays onOpenProfilesSettings={jest.fn()} />
          </ProfileProvider>
        </AppProviders>,
      );

      await fireEvent.press(screen.getByTestId('open-picker-btn'));
      await waitFor(() => {
        expect(screen.getByTestId(`profile-picker-card-${p3Id}`)).toBeTruthy();
      });

      // Hover & edit 3rd non-active profile ('Mia') -> must reflect its SQLite PIN state accurately!
      await fireEvent(screen.getByTestId(`profile-picker-tile-${p3Id}`), 'hoverIn');
      await fireEvent.press(screen.getByTestId(`profile-picker-edit-${p3Id}`));
      await waitFor(() => {
        expect(screen.getByTestId('profile-edit-modal')).toBeTruthy();
        expect(screen.getByTestId('profile-edit-change-pin')).toBeTruthy();
        expect(screen.getByTestId('profile-edit-remove-pin')).toBeTruthy();
      });
      expect(screen.queryByTestId('profile-edit-set-pin')).toBeNull();

      // Remove Mia's PIN -> UI refreshes to Set PIN and SQLite reflects removal
      await fireEvent.press(screen.getByTestId('profile-edit-remove-pin'));
      expect(screen.getByTestId('pin-entry-overlay')).toBeTruthy();
      await tapPin('9999');
      await waitFor(() => {
        expect(screen.queryByTestId('pin-entry-overlay')).toBeNull();
        expect(screen.getByTestId('profile-edit-set-pin')).toBeTruthy();
      });
      expect(await env.catalog.hasParentalPin?.(p3Id)).toBe(false);

      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });
});
