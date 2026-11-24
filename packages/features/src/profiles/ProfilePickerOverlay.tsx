import type { ProfileRecord } from '@elv/data';
import type { KeyEvent, KeyInput } from '@elv/focus-core';
import {
  CtaButton,
  MicroPill,
  TvFocusAnchor,
  useFormFactor,
  useI18n,
  useKeyInterpreter,
  useTheme,
  useTvKeyInterceptor,
  useTvKeySource,
  useViewport,
  webBackdropBlur,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { ProfileAvatarBadge } from './ProfileAvatarBadge';

/** Props of {@link ProfilePickerOverlay}. */
export interface ProfilePickerOverlayProps {
  readonly profiles: readonly ProfileRecord[];
  readonly activeProfileId: string;
  readonly onSelectProfile: (profileId: string) => void;
  readonly onManageInSettings: () => void;
  readonly onClose: () => void;
  readonly testID?: string;
}

const NOOP_TV_SUBSCRIBER = (): boolean => false;

function useExclusiveTvKeySource(
  onInput: ((input: KeyInput) => boolean | undefined) | ((input: KeyInput) => void),
): void {
  // Keep TvRemoteProvider's lazy platform listener attached even if no screen underneath subscribes.
  useTvKeySource(NOOP_TV_SUBSCRIBER);
  useTvKeyInterceptor((input) => {
    onInput(input);
    return true;
  });
}

function PickerTvKeyBridge({
  onEvent,
}: {
  readonly onEvent: (event: KeyEvent) => boolean;
}): ReactElement {
  useKeyInterpreter(onEvent, { keySource: useExclusiveTvKeySource });
  return <TvFocusAnchor testID="profile-picker-tv-focus-anchor" hasTVPreferredFocus />;
}

/**
 * In-tree Cinema Quietude v2 viewer profile switcher overlay (`#15`).
 * Renders over the shell without React Native `<Modal>` so 10-foot TV D-pad focus and Back
 * dismissal stay predictable across TV, desktop, and touch devices.
 */
export function ProfilePickerOverlay({
  profiles,
  activeProfileId,
  onSelectProfile,
  onManageInSettings,
  onClose,
  testID = 'profile-picker-overlay',
}: ProfilePickerOverlayProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const formFactor = useFormFactor();
  const viewport = useViewport();
  const isTv = formFactor === 'tv';

  const initialIdx = Math.max(
    0,
    profiles.findIndex((p) => p.id === activeProfileId),
  );
  // Zone 'profiles': index 0..profiles.length-1; Zone 'footer': col 0 = Manage, col 1 = Cancel
  const [zone, setZone] = useState<'profiles' | 'footer'>('profiles');
  const [profileIdx, setProfileIdx] = useState(initialIdx);
  const [footerIdx, setFooterIdx] = useState(0);

  const stateRef = useRef({ zone, profileIdx, footerIdx, count: profiles.length });
  stateRef.current = { zone, profileIdx, footerIdx, count: profiles.length };

  useEffect(() => {
    if ((Platform.OS as string) !== 'web') return undefined;
    type WebKeyEvent = {
      key?: string;
      preventDefault?: () => void;
      stopPropagation?: () => void;
      stopImmediatePropagation?: () => void;
    };
    const host = globalThis as unknown as {
      addEventListener?: (
        type: string,
        listener: (e: WebKeyEvent) => void,
        capture?: boolean,
      ) => void;
      removeEventListener?: (
        type: string,
        listener: (e: WebKeyEvent) => void,
        capture?: boolean,
      ) => void;
    };
    if (
      typeof host.addEventListener !== 'function' ||
      typeof host.removeEventListener !== 'function'
    ) {
      return undefined;
    }
    const onKeyDown = (event: WebKeyEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault?.();
        event.stopPropagation?.();
        event.stopImmediatePropagation?.();
        onClose();
      }
    };
    host.addEventListener('keydown', onKeyDown, true);
    return () => host.removeEventListener?.('keydown', onKeyDown, true);
  }, [onClose]);

  const handleTvKey = useCallback(
    (event: KeyEvent): boolean => {
      if (event.kind === 'press' && event.key === 'back') {
        onClose();
        return true;
      }
      if (event.kind !== 'press' && event.kind !== 'repeat') return false;
      const cur = stateRef.current;

      if (cur.zone === 'profiles') {
        if (event.key === 'left') {
          setProfileIdx(Math.max(0, cur.profileIdx - 1));
          return true;
        }
        if (event.key === 'right') {
          setProfileIdx(Math.min(Math.max(0, cur.count - 1), cur.profileIdx + 1));
          return true;
        }
        if (event.key === 'down') {
          setZone('footer');
          return true;
        }
        if (event.kind === 'press' && event.key === 'select') {
          const picked = profiles[cur.profileIdx];
          if (picked) onSelectProfile(picked.id);
          return true;
        }
        return false;
      }

      if (event.key === 'up') {
        setZone('profiles');
        return true;
      }
      if (event.key === 'left') {
        setFooterIdx(0);
        return true;
      }
      if (event.key === 'right') {
        setFooterIdx(1);
        return true;
      }
      if (event.kind === 'press' && event.key === 'select') {
        if (cur.footerIdx === 0) onManageInSettings();
        else onClose();
        return true;
      }
      return false;
    },
    [onClose, onManageInSettings, onSelectProfile, profiles],
  );

  const cardTransition = webTransition(theme, 'transform, background-color, border-color');
  const cursorPointer = webCursorPointer();

  return (
    <View
      testID={testID}
      style={[
        styles.backdrop,
        {
          backgroundColor: theme.colors.overlayBackdrop,
          paddingHorizontal: 20 + viewport.overscan.x,
          paddingVertical: 20 + viewport.overscan.y,
        },
      ]}
    >
      {isTv ? <PickerTvKeyBridge onEvent={handleTvKey} /> : null}

      <View
        testID="profile-picker-panel"
        style={[
          styles.panel,
          isTv ? styles.panelTv : null,
          {
            backgroundColor: theme.colors.glassBg,
            borderColor: theme.colors.glassBorder,
            borderRadius: theme.radius.modal,
          },
          webBackdropBlur(20),
        ]}
      >
        <View style={styles.header}>
          <Text
            testID="profile-picker-title"
            style={[theme.typography.h1, { color: theme.colors.textPrimary }]}
          >
            {i18n.t('profiles.switchTitle')}
          </Text>
          <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
            {i18n.t('profiles.subtitle')}
          </Text>
        </View>

        <View style={styles.grid}>
          {profiles.map((profile, idx) => {
            const active = profile.id === activeProfileId;
            const focused = isTv && zone === 'profiles' && profileIdx === idx;
            return (
              <Pressable
                key={profile.id}
                testID={`profile-picker-card-${profile.id}`}
                accessibilityRole="button"
                accessibilityLabel={profile.name}
                accessibilityState={{ selected: active }}
                {...(isTv ? { focusable: false } : {})}
                onPress={() => onSelectProfile(profile.id)}
                style={[
                  styles.card,
                  cardTransition,
                  cursorPointer,
                  {
                    borderRadius: theme.radius.card,
                    backgroundColor: focused
                      ? theme.colors.focusFill
                      : active
                        ? theme.colors.subtleHighlight
                        : theme.colors.bgSurface,
                    borderWidth: focused ? theme.focus.ringWidth : 1,
                    borderColor: focused
                      ? theme.colors.focusRingColor
                      : active
                        ? theme.colors.accent
                        : theme.colors.surfaceBorder,
                  },
                ]}
              >
                <ProfileAvatarBadge
                  name={profile.name}
                  avatarToken={profile.avatarToken}
                  size="lg"
                  isKids={profile.isKids}
                  showKidsPill={profile.isKids}
                  active={active}
                />
                <Text
                  numberOfLines={1}
                  style={[
                    theme.typography.title,
                    styles.cardName,
                    { color: theme.colors.textPrimary },
                  ]}
                >
                  {profile.name}
                </Text>
                {active ? (
                  <MicroPill
                    testID={`profile-picker-active-${profile.id}`}
                    label={i18n.t('profiles.activeBadge')}
                    tone="accent"
                  />
                ) : null}
              </Pressable>
            );
          })}
        </View>

        <View style={styles.footer}>
          <CtaButton
            testID="profile-picker-manage"
            variant="secondary"
            label={i18n.t('profiles.manageInSettings')}
            focused={isTv && zone === 'footer' && footerIdx === 0}
            focusable={!isTv}
            onPress={onManageInSettings}
            style={styles.footerBtn}
          />
          <CtaButton
            testID="profile-picker-close"
            variant="secondary"
            label={i18n.t('profiles.cancel')}
            focused={isTv && zone === 'footer' && footerIdx === 1}
            focusable={!isTv}
            onPress={onClose}
            style={styles.footerBtn}
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 50,
  },
  panel: {
    width: '100%',
    maxWidth: 620,
    borderWidth: 1,
    padding: 24,
    gap: 20,
  },
  panelTv: {
    maxWidth: 740,
    padding: 32,
    gap: 24,
  },
  header: {
    gap: 4,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  card: {
    minWidth: 132,
    flexGrow: 1,
    flexBasis: 132,
    maxWidth: 180,
    paddingVertical: 16,
    paddingHorizontal: 12,
    alignItems: 'center',
    gap: 8,
  },
  cardName: {
    textAlign: 'center',
  },
  footer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: 10,
  },
  footerBtn: {
    minHeight: 42,
  },
});
