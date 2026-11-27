import { createCatalogService, openCatalog } from '@elv/data';
import { countingScheduler, memorySecrets, testDb } from '@elv/data/testing';
import { elvError, err, type HttpClient } from '@elv/domain';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Pressable, Text, View } from 'react-native';
import { ProfileProvider, useProfile } from '../ProfileContext';

const offlineHttp: HttpClient = {
  async get() {
    return err(elvError('network', 'offline'));
  },
};

async function openTestCatalog() {
  const handle = testDb();
  const migrated = await openCatalog(handle.db);
  if (!migrated.ok) throw new Error('migrate failed');
  let now = 1_700_000_000_000;
  let seq = 1;
  const catalog = createCatalogService({
    db: handle.db,
    secrets: memorySecrets(),
    scheduler: countingScheduler(),
    http: offlineHttp,
    clock: () => {
      now += 10;
      return now;
    },
    newId: () => `id-${seq++}`,
  });
  return { catalog, cleanup: () => handle.close() };
}

function ProfileInspector() {
  const profile = useProfile();
  return (
    <View>
      <Text testID="profiles-ready">{String(profile.profilesReady)}</Text>
      <Text testID="active-profile-id">{profile.activeProfileId}</Text>
      <Text testID="active-profile-name">{profile.activeProfile.name}</Text>
      <Text testID="profile-names">{profile.profiles.map((p) => p.name).join(',')}</Text>
      <Text testID="parental-enabled">{String(profile.parentalSettings.enabled)}</Text>
      <Text testID="has-parental-pin">{String(profile.hasParentalPin)}</Text>
      <Text testID="picker-open">{String(profile.profilePickerOpen)}</Text>
      <Pressable testID="close-picker" onPress={profile.closeProfilePicker} />
      {profile.profiles.map((p) => (
        <Pressable
          key={p.id}
          testID={`switch-to-${p.id}`}
          onPress={() => {
            void profile.switchProfile(p.id);
          }}
        />
      ))}
    </View>
  );
}

describe('ProfileProvider live externalRefreshToken sync (P1-2)', () => {
  it('updates profiles, renamed active profile, parental settings/PIN, and falls back to default when active profile is deleted by incoming sync', async () => {
    const env = await openTestCatalog();
    let view: Awaited<ReturnType<typeof render>> | undefined;
    try {
      view = await render(
        <ProfileProvider catalog={env.catalog} externalRefreshToken={0}>
          <ProfileInspector />
        </ProfileProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('profiles-ready')).toHaveTextContent('true');
        expect(screen.getByTestId('active-profile-id')).toHaveTextContent('default');
        expect(screen.getByTestId('profile-names')).toHaveTextContent('Default');
      });

      // 1. Incoming sync adds a new profile directly to SQLite -> bumping externalRefreshToken updates ProfileContext live
      const created = await env.catalog.createProfile?.({
        name: 'Kids',
        avatarToken: 'amber',
        isKids: true,
      });
      if (!created?.ok) throw new Error('createProfile failed');
      const kidsId = created.value.id;

      await view.rerender(
        <ProfileProvider catalog={env.catalog} externalRefreshToken={1}>
          <ProfileInspector />
        </ProfileProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('profile-names')).toHaveTextContent('Default,Kids');
      });

      // Switch to Kids profile
      await fireEvent.press(screen.getByTestId(`switch-to-${kidsId}`));
      await waitFor(() => {
        expect(screen.getByTestId('active-profile-id')).toHaveTextContent(kidsId);
        expect(screen.getByTestId('active-profile-name')).toHaveTextContent('Kids');
      });

      // 2. Incoming sync renames active profile and updates parental settings + PIN directly in SQLite
      const renamed = await env.catalog.updateProfile?.(kidsId, { name: 'Junior' });
      if (!renamed?.ok) throw new Error('updateProfile failed');
      const settingsRes = await env.catalog.updateParentalSettings?.({ enabled: true }, kidsId);
      if (!settingsRes?.ok) throw new Error('updateParentalSettings failed');
      const pinRes = await env.catalog.setParentalPin?.('1234', kidsId);
      if (!pinRes?.ok) throw new Error('setParentalPin failed');

      await view.rerender(
        <ProfileProvider catalog={env.catalog} externalRefreshToken={2}>
          <ProfileInspector />
        </ProfileProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('active-profile-name')).toHaveTextContent('Junior');
        expect(screen.getByTestId('profile-names')).toHaveTextContent('Default,Junior');
        expect(screen.getByTestId('parental-enabled')).toHaveTextContent('true');
        expect(screen.getByTestId('has-parental-pin')).toHaveTextContent('true');
      });

      // 3. Incoming sync deletes the currently active profile -> automatically falls back to default & refreshes parental/PIN state
      const deleted = await env.catalog.deleteProfile?.(kidsId);
      if (!deleted?.ok) throw new Error('deleteProfile failed');

      await view.rerender(
        <ProfileProvider catalog={env.catalog} externalRefreshToken={3}>
          <ProfileInspector />
        </ProfileProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('active-profile-id')).toHaveTextContent('default');
        expect(screen.getByTestId('active-profile-name')).toHaveTextContent('Default');
        expect(screen.getByTestId('profile-names')).toHaveTextContent('Default');
        expect(screen.getByTestId('parental-enabled')).toHaveTextContent('false');
        expect(screen.getByTestId('has-parental-pin')).toHaveTextContent('false');
      });
    } finally {
      await view?.unmount();
      await env.cleanup();
    }
  });

  it('opens Who is Watching once on startup for 2+ profiles after suppressAutoProfilePicker clears, and never for 1 profile (#513)', async () => {
    const singleEnv = await openTestCatalog();
    let singleView: Awaited<ReturnType<typeof render>> | undefined;
    try {
      singleView = await render(
        <ProfileProvider catalog={singleEnv.catalog} suppressAutoProfilePicker={false}>
          <ProfileInspector />
        </ProfileProvider>,
      );
      await waitFor(() => {
        expect(screen.getByTestId('profiles-ready')).toHaveTextContent('true');
      });
      expect(screen.getByTestId('picker-open')).toHaveTextContent('false');
    } finally {
      await singleView?.unmount();
      await singleEnv.cleanup();
    }

    const multiEnv = await openTestCatalog();
    const added = await multiEnv.catalog.createProfile?.({
      name: 'Guest',
      avatarToken: 'sapphire',
      isKids: false,
    });
    if (!added?.ok) throw new Error('createProfile failed');

    let multiView: Awaited<ReturnType<typeof render>> | undefined;
    try {
      multiView = await render(
        <ProfileProvider catalog={multiEnv.catalog} suppressAutoProfilePicker>
          <ProfileInspector />
        </ProfileProvider>,
      );
      await waitFor(() => {
        expect(screen.getByTestId('profiles-ready')).toHaveTextContent('true');
      });
      // Suppressed while onboarding or startup refresh is active
      expect(screen.getByTestId('picker-open')).toHaveTextContent('false');

      // Releasing suppression opens profile picker automatically once
      await multiView.rerender(
        <ProfileProvider catalog={multiEnv.catalog} suppressAutoProfilePicker={false}>
          <ProfileInspector />
        </ProfileProvider>,
      );
      await waitFor(() => {
        expect(screen.getByTestId('picker-open')).toHaveTextContent('true');
      });

      // Closing it keeps it closed even on subsequent rerenders
      await fireEvent.press(screen.getByTestId('close-picker'));
      expect(screen.getByTestId('picker-open')).toHaveTextContent('false');
      await multiView.rerender(
        <ProfileProvider catalog={multiEnv.catalog} suppressAutoProfilePicker={false}>
          <ProfileInspector />
        </ProfileProvider>,
      );
      expect(screen.getByTestId('picker-open')).toHaveTextContent('false');
    } finally {
      await multiView?.unmount();
      await multiEnv.cleanup();
    }
  });
});
