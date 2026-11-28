import type {
  CatalogService,
  ParentalLockRecord,
  ParentalSettings,
  ProfileRecord,
} from '@elv/data';
import { ok } from '@elv/domain';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Pressable, Text, View } from 'react-native';
import { type ProfileContextValue, ProfileProvider, useProfile } from '../ProfileContext';

const BASE_PROFILES: readonly ProfileRecord[] = [
  {
    id: 'default',
    name: 'Default',
    avatarToken: 'crimson',
    isKids: false,
    isDefault: true,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: 'kids-1',
    name: 'Kids',
    avatarToken: 'emerald',
    isKids: true,
    isDefault: false,
    createdAt: 1,
    updatedAt: 1,
  },
];

function createStubCatalog(overrides: Partial<CatalogService> = {}): CatalogService {
  return {
    addSource: jest.fn(),
    addSourceFromLink: jest.fn(),
    removeSource: jest.fn(),
    importSource: jest.fn(),
    listSources: jest.fn(async () => []),
    categories: jest.fn(async () => []),
    items: jest.fn(async () => []),
    seasons: jest.fn(async () => ok([])),
    episodes: jest.fn(async () => []),
    resolveStream: jest.fn(),
    close: jest.fn(async () => undefined),
    listProfiles: jest.fn(async () => [...BASE_PROFILES]),
    getParentalSettings: jest.fn(
      async (pid?: string): Promise<ParentalSettings> => ({
        profileId: pid ?? 'default',
        enabled: false,
        blockAdultKeywords: true,
        maxRatingAge: null,
        unlockTimeoutMin: 30,
        updatedAt: 10,
      }),
    ),
    listParentalLocks: jest.fn(async (): Promise<ParentalLockRecord[]> => []),
    hasParentalPin: jest.fn(async () => false),
    verifyParentalPin: jest.fn(async () => ({ ok: true as const })),
    updateParentalSettings: jest.fn(async (patch, pid?: string) =>
      ok({
        profileId: pid ?? 'default',
        enabled: patch.enabled ?? false,
        blockAdultKeywords: patch.blockAdultKeywords ?? true,
        maxRatingAge: patch.maxRatingAge ?? null,
        unlockTimeoutMin: patch.unlockTimeoutMin ?? 30,
        updatedAt: 20,
      }),
    ),
    setParentalLock: jest.fn(async () => ok(undefined)),
    setParentalPin: jest.fn(async () => ok(undefined)),
    clearParentalPin: jest.fn(async () => ok(undefined)),
    ...overrides,
  } as unknown as CatalogService;
}

function FailClosedProbe({
  ctxRef,
}: {
  readonly ctxRef: { current: ProfileContextValue | undefined };
}) {
  const ctx = useProfile();
  ctxRef.current = ctx;
  return (
    <View>
      <Text testID="profiles-ready">{String(ctx.profilesReady)}</Text>
      <Text testID="load-error">{String(ctx.parentalLoadError)}</Text>
      <Text testID="parental-enabled">{String(ctx.parentalSettings.enabled)}</Text>
      <Text testID="adult-keywords">{String(ctx.parentalSettings.blockAdultKeywords)}</Text>
      <Text testID="max-age">{String(ctx.parentalSettings.maxRatingAge)}</Text>
      <Text testID="parental-unlocked">{String(ctx.parentalUnlocked)}</Text>
      <Text testID="picker-open">{String(ctx.profilePickerOpen)}</Text>
      <Pressable
        testID="retry-btn"
        onPress={() => {
          void ctx.retryParentalLoad();
        }}
      />
    </View>
  );
}

describe('ProfileProvider fail-closed hydration & mutation guards (Wave Q5-A)', () => {
  it.each([
    [
      'getParentalSettings',
      {
        getParentalSettings: jest.fn(async () => {
          throw new Error('db busy');
        }),
      },
    ],
    [
      'listParentalLocks',
      {
        listParentalLocks: jest.fn(async () => {
          throw new Error('worker crashed');
        }),
      },
    ],
    [
      'hasParentalPin',
      {
        hasParentalPin: jest.fn(async () => {
          throw new Error('ipc disconnected');
        }),
      },
    ],
    [
      'listProfiles',
      {
        listProfiles: jest.fn(async () => {
          throw new Error('sqlite unavailable');
        }),
      },
    ],
  ] as const)(
    'enters fail-closed state (enabled=true, blockAdultKeywords=true, maxRatingAge=0, parentalLoadError=true) when %s rejects',
    async (_methodName, override) => {
      const ctxRef: { current: ProfileContextValue | undefined } = { current: undefined };
      const catalog = createStubCatalog(override);
      const view = await render(
        <ProfileProvider catalog={catalog} suppressAutoProfilePicker={false}>
          <FailClosedProbe ctxRef={ctxRef} />
        </ProfileProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('profiles-ready')).toHaveTextContent('true');
        expect(screen.getByTestId('load-error')).toHaveTextContent('true');
      });

      expect(screen.getByTestId('parental-enabled')).toHaveTextContent('true');
      expect(screen.getByTestId('adult-keywords')).toHaveTextContent('true');
      expect(screen.getByTestId('max-age')).toHaveTextContent('0');
      expect(screen.getByTestId('parental-unlocked')).toHaveTextContent('false');
      expect(ctxRef.current?.parentalUnlockExpiresAt).toBeNull();
      // Never auto-open profile picker when hydration failed
      expect(screen.getByTestId('picker-open')).toHaveTextContent('false');

      // Mutating parental actions MUST fail closed with storage/parental-state-unavailable
      const ctx = ctxRef.current;
      if (!ctx) throw new Error('missing context');

      const updRes = await ctx.updateParentalSettings({ enabled: false });
      expect(updRes.ok).toBe(false);
      if (!updRes.ok) {
        expect(updRes.error.category).toBe('storage');
        expect(updRes.error.code).toBe('parental-state-unavailable');
      }
      expect(catalog.updateParentalSettings).not.toHaveBeenCalled();

      const lockRes = await ctx.setParentalLock(
        { sourceId: 's1', targetKind: 'category', itemKind: 'live', targetKey: 'adult' },
        false,
      );
      expect(lockRes.ok).toBe(false);
      if (!lockRes.ok) {
        expect(lockRes.error.code).toBe('parental-state-unavailable');
      }
      expect(catalog.setParentalLock).not.toHaveBeenCalled();

      const setPinRes = await ctx.setParentalPin('1234');
      expect(setPinRes.ok).toBe(false);
      if (!setPinRes.ok) {
        expect(setPinRes.error.code).toBe('parental-state-unavailable');
      }
      expect(catalog.setParentalPin).not.toHaveBeenCalled();

      const clearPinRes = await ctx.clearParentalPin('1234');
      expect(clearPinRes.ok).toBe(false);
      if (!clearPinRes.ok) {
        expect(clearPinRes.error.code).toBe('parental-state-unavailable');
      }
      expect(catalog.clearParentalPin).not.toHaveBeenCalled();

      // Unlocking MUST NOT succeed while parental state is unavailable
      const unlockRes = await ctx.unlockParental('1234');
      expect(unlockRes.ok).toBe(false);
      expect(ctxRef.current?.parentalUnlocked).toBe(false);

      await view.unmount();
    },
  );

  it('recovers cleanly via retryParentalLoad() once storage becomes readable again', async () => {
    let shouldFail = true;
    const catalog = createStubCatalog({
      getParentalSettings: jest.fn(async (pid?: string): Promise<ParentalSettings> => {
        if (shouldFail) throw new Error('transient disconnect');
        return {
          profileId: pid ?? 'default',
          enabled: false,
          blockAdultKeywords: true,
          maxRatingAge: null,
          unlockTimeoutMin: 30,
          updatedAt: 55,
        };
      }),
    });

    const ctxRef: { current: ProfileContextValue | undefined } = { current: undefined };
    const view = await render(
      <ProfileProvider catalog={catalog} suppressAutoProfilePicker>
        <FailClosedProbe ctxRef={ctxRef} />
      </ProfileProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('profiles-ready')).toHaveTextContent('true');
      expect(screen.getByTestId('load-error')).toHaveTextContent('true');
      expect(screen.getByTestId('parental-enabled')).toHaveTextContent('true');
    });

    shouldFail = false;
    await fireEvent.press(screen.getByTestId('retry-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('load-error')).toHaveTextContent('false');
      expect(screen.getByTestId('parental-enabled')).toHaveTextContent('false');
      expect(screen.getByTestId('max-age')).toHaveTextContent('null');
    });

    const updRes = await ctxRef.current?.updateParentalSettings({ enabled: true });
    expect(updRes?.ok).toBe(true);
    expect(catalog.updateParentalSettings).toHaveBeenCalledTimes(1);

    await view.unmount();
  });

  it('transitions an unlocked session into fail-closed locked state when refreshProfiles fails', async () => {
    let failRefresh = false;
    const catalog = createStubCatalog({
      hasParentalPin: jest.fn(async () => true),
      listProfiles: jest.fn(async () => {
        if (failRefresh) throw new Error('worker lost');
        return [...BASE_PROFILES];
      }),
    });

    const ctxRef: { current: ProfileContextValue | undefined } = { current: undefined };
    const view = await render(
      <ProfileProvider catalog={catalog} suppressAutoProfilePicker>
        <FailClosedProbe ctxRef={ctxRef} />
      </ProfileProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('profiles-ready')).toHaveTextContent('true'));

    await act(async () => {
      await ctxRef.current?.unlockParental('1234');
    });
    expect(screen.getByTestId('parental-unlocked')).toHaveTextContent('true');

    failRefresh = true;
    await act(async () => {
      await ctxRef.current?.refreshProfiles();
    });

    await waitFor(() => {
      expect(screen.getByTestId('load-error')).toHaveTextContent('true');
      expect(screen.getByTestId('parental-unlocked')).toHaveTextContent('false');
      expect(screen.getByTestId('parental-enabled')).toHaveTextContent('true');
      expect(screen.getByTestId('max-age')).toHaveTextContent('0');
    });

    await view.unmount();
  });

  it('starts fail-closed before async hydration resolves and enters fail-closed when loadActiveProfileId rejects', async () => {
    let resolveProfiles!: (list: ProfileRecord[]) => void;
    const catalog = createStubCatalog({
      listProfiles: jest.fn(
        () =>
          new Promise<ProfileRecord[]>((resolve) => {
            resolveProfiles = resolve;
          }),
      ),
    });
    const profilePreferences = {
      getActiveProfileId: jest.fn(() => 'default'),
      loadActiveProfileId: jest.fn(async () => {
        throw new Error('prefs read failed');
      }),
      saveActiveProfileId: jest.fn(async () => undefined),
      switchProfile: jest.fn(async () => undefined),
      deleteProfilePreferences: jest.fn(async () => undefined),
      load: jest.fn(),
      save: jest.fn(),
      subscribe: jest.fn(() => () => undefined),
      getCached: jest.fn(),
    } as unknown as Parameters<typeof ProfileProvider>[0]['profilePreferences'];

    const ctxRef: { current: ProfileContextValue | undefined } = { current: undefined };
    const view = await render(
      <ProfileProvider
        catalog={catalog}
        profilePreferences={profilePreferences}
        suppressAutoProfilePicker
      >
        <FailClosedProbe ctxRef={ctxRef} />
      </ProfileProvider>,
    );

    // Pre-hydration frame must already be fail-closed (never enabled: false before SQLite resolves)
    expect(screen.getByTestId('parental-enabled')).toHaveTextContent('true');
    expect(screen.getByTestId('max-age')).toHaveTextContent('0');

    await act(async () => {
      resolveProfiles([...BASE_PROFILES]);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByTestId('profiles-ready')).toHaveTextContent('true');
      expect(screen.getByTestId('load-error')).toHaveTextContent('true');
      expect(screen.getByTestId('parental-enabled')).toHaveTextContent('true');
    });

    await view.unmount();
  });

  it('guards refreshProfiles with switchSeqRef so a stale refresh cannot overwrite a newer switchProfile, and notifies on profile change even when already in fail-closed error', async () => {
    let resolveRefreshList!: (list: ProfileRecord[]) => void;
    let firstList = true;
    let failGetSettingsForAll = false;
    const catalog = createStubCatalog({
      listProfiles: jest.fn(() => {
        if (firstList) {
          firstList = false;
          return Promise.resolve([...BASE_PROFILES]);
        }
        return new Promise<ProfileRecord[]>((resolve) => {
          resolveRefreshList = resolve;
        });
      }),
      getParentalSettings: jest.fn(async (pid?: string): Promise<ParentalSettings> => {
        if (failGetSettingsForAll) throw new Error('sqlite read error');
        return {
          profileId: pid ?? 'default',
          enabled: pid === 'kids-1',
          blockAdultKeywords: true,
          maxRatingAge: pid === 'kids-1' ? 7 : null,
          unlockTimeoutMin: 30,
          updatedAt: 1,
        };
      }),
    });

    const onChange = jest.fn();
    const ctxRef: { current: ProfileContextValue | undefined } = { current: undefined };
    const view = await render(
      <ProfileProvider catalog={catalog} onProfileOrLockChange={onChange} suppressAutoProfilePicker>
        <FailClosedProbe ctxRef={ctxRef} />
      </ProfileProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('profiles-ready')).toHaveTextContent('true'));

    // Start a slow refreshProfiles(), then switch to kids-1 while refresh is in flight
    let refreshPromise!: Promise<void>;
    await act(async () => {
      refreshPromise = ctxRef.current?.refreshProfiles() ?? Promise.resolve();
      await ctxRef.current?.switchProfile('kids-1');
    });
    expect(ctxRef.current?.activeProfileId).toBe('kids-1');
    expect(ctxRef.current?.parentalSettings.maxRatingAge).toBe(7);

    // Stale refresh resolves late with a list that only has default — MUST be ignored by switchSeqRef
    await act(async () => {
      resolveRefreshList([BASE_PROFILES[0] as ProfileRecord]);
      await refreshPromise;
    });
    expect(ctxRef.current?.activeProfileId).toBe('kids-1');
    expect(ctxRef.current?.parentalSettings.maxRatingAge).toBe(7);

    // Already in fail-closed state on default -> switch to kids-1 while failing MUST still bump revision & notify
    failGetSettingsForAll = true;
    await act(async () => {
      await ctxRef.current?.switchProfile('default');
    });
    expect(ctxRef.current?.parentalLoadError).toBe(true);
    const revBefore = ctxRef.current?.profileRevision ?? 0;
    onChange.mockClear();

    await act(async () => {
      await ctxRef.current?.switchProfile('kids-1');
    });
    expect(ctxRef.current?.activeProfileId).toBe('kids-1');
    expect(ctxRef.current?.profileRevision).toBeGreaterThan(revBefore);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ activeProfileId: 'kids-1', parentalUnlocked: false }),
    );

    await view.unmount();
  });
});
