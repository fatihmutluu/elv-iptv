import { createCatalogService, openCatalog } from '@elv/data';
import { countingScheduler, memorySecrets, testDb } from '@elv/data/testing';
import { createProfilePreferencesManager, ok, type PreferencesKvBackend } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { AppShellProfileOverlays } from '../../app-shell-overlays';
import { AppProviders } from '../../index';
import { ProfileProvider } from '../../shared';
import { ParentalControlsCard } from '../ParentalControlsCard';

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

async function createEnv() {
  const handle = testDb();
  await openCatalog(handle.db);
  const catalog = createCatalogService({
    db: handle.db,
    secrets: memorySecrets(),
    scheduler: countingScheduler(),
    http: {
      async get() {
        const bytes = new TextEncoder().encode(
          '#EXTM3U\n#EXTINF:-1 group-title="Sports",Sports HD\nhttp://127.0.0.1/1.ts\n#EXTINF:-1 group-title="Cinema",Cinema HD\nhttp://127.0.0.1/2.ts\n',
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

describe('ParentalControlsCard PIN re-verification & fail-closed UI (Wave Q5-A)', () => {
  it('requires fresh PIN re-verification even while parentalUnlocked=true before relaxing any protection, and leaves settings untouched on cancel', async () => {
    const env = await createEnv();
    try {
      await env.catalog.setParentalPin?.('1234', 'default');
      await env.catalog.updateParentalSettings?.(
        { enabled: true, blockAdultKeywords: true, maxRatingAge: 12, unlockTimeoutMin: 15 },
        'default',
      );
      const cats = await env.catalog.categories(env.sources[0]?.id ?? '', 'live', {
        includeHidden: true,
        parentalUnlocked: true,
      });
      const sportsCat = cats.find((c) => c.name === 'Sports');
      const cinemaCat = cats.find((c) => c.name === 'Cinema');
      if (!sportsCat || !cinemaCat) throw new Error('missing categories');

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
            <ParentalControlsCard catalog={env.catalog} sources={env.sources} />
            <AppShellProfileOverlays onOpenProfilesSettings={jest.fn()} />
          </ProfileProvider>
        </AppProviders>,
      );

      // Unlock session first so parentalUnlocked === true
      await waitFor(() => expect(screen.getByTestId('parental-unlock-button')).toBeTruthy());
      await fireEvent.press(screen.getByTestId('parental-unlock-button'));
      await tapPin('1234');
      await waitFor(() => {
        expect(screen.getByTestId('parental-status-badge')).toHaveTextContent('Unlocked');
        expect(screen.getByTestId(`parental-cat-lock-${sportsCat.id}`)).toBeTruthy();
      });

      // Tightening while unlocked works immediately WITHOUT re-prompting:
      // 1) Lowering maxRatingAge 12 -> 7
      await fireEvent.press(screen.getByTestId('parental-max-age-7'));
      expect(screen.queryByTestId('pin-entry-overlay')).toBeNull();
      await waitFor(async () => {
        expect((await env.catalog.getParentalSettings?.('default'))?.maxRatingAge).toBe(7);
      });
      // 2) Lowering timeout 15 -> 5
      await fireEvent.press(screen.getByTestId('parental-timeout-5'));
      expect(screen.queryByTestId('pin-entry-overlay')).toBeNull();
      await waitFor(async () => {
        expect((await env.catalog.getParentalSettings?.('default'))?.unlockTimeoutMin).toBe(5);
      });
      // 3) Locking a category (false -> true)
      await fireEvent.press(screen.getByTestId(`parental-cat-lock-${sportsCat.id}`));
      expect(screen.queryByTestId('pin-entry-overlay')).toBeNull();
      await waitFor(() => {
        expect(
          screen.getByTestId(`parental-cat-lock-${sportsCat.id}`).props.accessibilityState.checked,
        ).toBe(true);
      });

      // RELAXATION 1: Turning OFF blockAdultKeywords while unlocked MUST prompt PIN
      await fireEvent.press(screen.getByTestId('parental-toggle-adult-keywords'));
      expect(screen.getByTestId('pin-entry-overlay')).toBeTruthy();
      await fireEvent.press(screen.getByTestId('pin-entry-cancel'));
      expect((await env.catalog.getParentalSettings?.('default'))?.blockAdultKeywords).toBe(true);
      await fireEvent.press(screen.getByTestId('parental-toggle-adult-keywords'));
      await tapPin('1234');
      await waitFor(async () => {
        expect((await env.catalog.getParentalSettings?.('default'))?.blockAdultKeywords).toBe(
          false,
        );
      });

      // Tightening blockAdultKeywords back ON works immediately without PIN
      await fireEvent.press(screen.getByTestId('parental-toggle-adult-keywords'));
      expect(screen.queryByTestId('pin-entry-overlay')).toBeNull();
      await waitFor(async () => {
        expect((await env.catalog.getParentalSettings?.('default'))?.blockAdultKeywords).toBe(true);
      });

      // RELAXATION 2: Raising maxRatingAge (7 -> 16) and removing (16 -> Off) MUST prompt PIN
      await fireEvent.press(screen.getByTestId('parental-max-age-16'));
      expect(screen.getByTestId('pin-entry-overlay')).toBeTruthy();
      await fireEvent.press(screen.getByTestId('pin-entry-cancel'));
      expect((await env.catalog.getParentalSettings?.('default'))?.maxRatingAge).toBe(7);
      await fireEvent.press(screen.getByTestId('parental-max-age-16'));
      await tapPin('1234');
      await waitFor(async () => {
        expect((await env.catalog.getParentalSettings?.('default'))?.maxRatingAge).toBe(16);
      });

      await fireEvent.press(screen.getByTestId('parental-max-age-off'));
      expect(screen.getByTestId('pin-entry-overlay')).toBeTruthy();
      await fireEvent.press(screen.getByTestId('pin-entry-cancel'));
      expect((await env.catalog.getParentalSettings?.('default'))?.maxRatingAge).toBe(16);
      await fireEvent.press(screen.getByTestId('parental-max-age-off'));
      await tapPin('1234');
      await waitFor(async () => {
        expect((await env.catalog.getParentalSettings?.('default'))?.maxRatingAge).toBeNull();
      });

      // RELAXATION 3: Raising timeout (5 -> 30) and setting session-wide (30 -> 0) MUST prompt PIN
      await fireEvent.press(screen.getByTestId('parental-timeout-30'));
      expect(screen.getByTestId('pin-entry-overlay')).toBeTruthy();
      await fireEvent.press(screen.getByTestId('pin-entry-cancel'));
      expect((await env.catalog.getParentalSettings?.('default'))?.unlockTimeoutMin).toBe(5);
      await fireEvent.press(screen.getByTestId('parental-timeout-30'));
      await tapPin('1234');
      await waitFor(async () => {
        expect((await env.catalog.getParentalSettings?.('default'))?.unlockTimeoutMin).toBe(30);
      });

      await fireEvent.press(screen.getByTestId('parental-timeout-0'));
      expect(screen.getByTestId('pin-entry-overlay')).toBeTruthy();
      await fireEvent.press(screen.getByTestId('pin-entry-cancel'));
      expect((await env.catalog.getParentalSettings?.('default'))?.unlockTimeoutMin).toBe(30);
      await fireEvent.press(screen.getByTestId('parental-timeout-0'));
      await tapPin('1234');
      await waitFor(async () => {
        expect((await env.catalog.getParentalSettings?.('default'))?.unlockTimeoutMin).toBe(0);
      });

      // RELAXATION 4: Unlocking a locked category while unlocked MUST prompt PIN
      await fireEvent.press(screen.getByTestId(`parental-cat-lock-${sportsCat.id}`));
      expect(screen.getByTestId('pin-entry-overlay')).toBeTruthy();
      await fireEvent.press(screen.getByTestId('pin-entry-cancel'));
      expect(
        screen.getByTestId(`parental-cat-lock-${sportsCat.id}`).props.accessibilityState.checked,
      ).toBe(true);
      await fireEvent.press(screen.getByTestId(`parental-cat-lock-${sportsCat.id}`));
      await tapPin('1234');
      await waitFor(() => {
        expect(
          screen.getByTestId(`parental-cat-lock-${sportsCat.id}`).props.accessibilityState.checked,
        ).toBe(false);
      });

      // RELAXATION 5: Disabling master Kids Mode while unlocked MUST prompt PIN
      await fireEvent.press(screen.getByTestId('parental-toggle-enabled'));
      expect(screen.getByTestId('pin-entry-overlay')).toBeTruthy();
      await fireEvent.press(screen.getByTestId('pin-entry-cancel'));
      expect(screen.getByTestId('parental-toggle-enabled').props.accessibilityState.checked).toBe(
        true,
      );
      await fireEvent.press(screen.getByTestId('parental-toggle-enabled'));
      await tapPin('1234');
      await waitFor(() => {
        expect(screen.getByTestId('parental-toggle-enabled').props.accessibilityState.checked).toBe(
          false,
        );
      });

      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });

  it('shows a restrained error banner with Retry and disables mutating toggles when parentalLoadError is true', async () => {
    const env = await createEnv();
    try {
      let failOnce = true;
      const baseGetSettings = env.catalog.getParentalSettings?.bind(env.catalog);
      jest.spyOn(env.catalog, 'getParentalSettings').mockImplementation(async (pid) => {
        if (failOnce) throw new Error('storage error');
        if (!baseGetSettings) throw new Error('missing getParentalSettings');
        return baseGetSettings(pid);
      });

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
            <ParentalControlsCard catalog={env.catalog} sources={env.sources} />
            <AppShellProfileOverlays onOpenProfilesSettings={jest.fn()} />
          </ProfileProvider>
        </AppProviders>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('parental-load-error')).toBeTruthy();
        expect(screen.getByTestId('parental-retry-load')).toBeTruthy();
      });

      const masterToggle = screen.getByTestId('parental-toggle-enabled');
      expect(masterToggle.props.accessibilityState.disabled).toBe(true);
      expect(screen.queryByTestId('parental-toggle-adult-keywords')).toBeNull();

      // Recover via Retry button
      failOnce = false;
      await fireEvent.press(screen.getByTestId('parental-retry-load'));

      await waitFor(() => {
        expect(screen.queryByTestId('parental-load-error')).toBeNull();
        expect(
          screen.getByTestId('parental-toggle-enabled').props.accessibilityState.disabled,
        ).toBe(false);
      });

      await view.unmount();
    } finally {
      jest.restoreAllMocks();
      await env.cleanup();
    }
  });

  it('requires fresh guard PIN verification before setting a Kids profile PIN while parentalUnlocked is true (prevents guard PIN shadowing)', async () => {
    const env = await createEnv();
    try {
      await env.catalog.setParentalPin?.('1234', 'default');
      const kidsRes = await env.catalog.createProfile?.({
        name: 'Kids',
        avatarToken: 'emerald',
        isKids: true,
      });
      if (!kidsRes?.ok) throw new Error('createProfile failed');
      const kidsId = kidsRes.value.id;
      await env.profilePreferences.switchProfile(kidsId);
      await env.profilePreferences.saveActiveProfileId(kidsId);

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
            <ParentalControlsCard catalog={env.catalog} sources={env.sources} />
            <AppShellProfileOverlays onOpenProfilesSettings={jest.fn()} />
          </ProfileProvider>
        </AppProviders>,
      );

      // Unlock session first using default guard PIN
      await waitFor(() => expect(screen.getByTestId('parental-unlock-button')).toBeTruthy());
      await fireEvent.press(screen.getByTestId('parental-unlock-button'));
      await tapPin('1234');
      await waitFor(() => expect(screen.getByTestId('parental-lock-now')).toBeTruthy());

      // Now press Set PIN on Kids profile while unlocked -> MUST prompt fresh guard PIN verify first
      await fireEvent.press(screen.getByTestId('parental-set-pin'));
      expect(screen.getByTestId('pin-entry-overlay')).toBeTruthy();
      expect(screen.getByText('Verify parental PIN')).toBeTruthy();

      // Cancelling MUST NOT open the create PIN step
      await fireEvent.press(screen.getByTestId('pin-entry-cancel'));
      expect(screen.queryByTestId('pin-entry-overlay')).toBeNull();
      expect(await env.catalog.hasParentalPin?.(kidsId)).toBe(false);

      // Re-verifying with guard PIN opens Create PIN dialog
      await fireEvent.press(screen.getByTestId('parental-set-pin'));
      await tapPin('1234');
      await waitFor(() => {
        expect(screen.getByTestId('pin-entry-overlay')).toBeTruthy();
        expect(screen.getAllByText('Create a 4–8 digit PIN').length).toBeGreaterThan(0);
      });

      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });
});
