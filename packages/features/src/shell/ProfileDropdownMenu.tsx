import type { ProfileRecord } from '@elv/data';
import type { KeyEvent } from '@elv/focus-core';
import {
  AdaptiveSheet,
  Icon,
  MicroPill,
  type SafeHoverEventProps,
  TvFocusAnchor,
  useI18n,
  useKeyInterpreter,
  useTheme,
  useViewport,
  webBackdropBlur,
  webCursorPointer,
  webShadow,
  webTransition,
} from '@elv/ui-kit';
import {
  type ComponentRef,
  type ReactElement,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useDesktopDialogTrap } from '../shared/desktop-dialog-trap';

/** Props of {@link ProfileDropdownMenu}. */
export interface ProfileDropdownMenuProps {
  readonly visible: boolean;
  readonly profiles: readonly ProfileRecord[];
  readonly activeProfileId: string;
  readonly hasGuardPin?: boolean;
  readonly parentalControlsEnabled?: boolean;
  readonly parentalUnlocked?: boolean;
  /** Reserved for cloud account status awareness cleanly exposed to menu actions. */
  readonly syncAccountSignedIn?: boolean;
  /** Set `true` when explicitly opened by click so desktop Backdrop + modal focus trap are active. */
  readonly pinnedOpen?: boolean;
  readonly panelProps?: SafeHoverEventProps;
  readonly panelRef?: RefObject<unknown>;
  readonly triggerRef?: RefObject<unknown>;
  readonly renderProfileAvatar?: (profile: ProfileRecord, active: boolean) => ReactElement;
  readonly onSelectProfile: (profileId: string) => void;
  readonly onAddProfile: () => void;
  readonly onEditProfiles: () => void;
  readonly onOpenSettings: () => void;
  readonly onSignOut: () => void;
  readonly onClose: () => void;
}

type MenuActionItem =
  | { readonly kind: 'profile'; readonly profile: ProfileRecord }
  | { readonly kind: 'addNew' }
  | { readonly kind: 'editProfiles' }
  | { readonly kind: 'settings' }
  | { readonly kind: 'signOut' };

function isNodeInsideRef(target: unknown, ref: RefObject<unknown> | undefined): boolean {
  const el = ref?.current as { contains?: (node: unknown) => boolean } | null | undefined;
  if (!el || target == null) return false;
  if (el === target) return true;
  return typeof el.contains === 'function' ? el.contains(target) : false;
}

function ProfileTvKeyBridge({
  onEvent,
}: {
  readonly onEvent: Parameters<typeof useKeyInterpreter>[0];
}): ReactElement {
  useKeyInterpreter(onEvent);
  return <TvFocusAnchor testID="profile-dropdown-tv-anchor" hasTVPreferredFocus />;
}

/**
 * Frosted Profile utility dropdown (`UI_UX_PHILOSOPHY.md` §2.1, Wave R1):
 * - **Desktop/Pointer:** opens on hover (with Safe-Hover Aim Triangle) OR click, plus click-outside & Escape dismiss.
 * - **Portrait Mobile/Tablet:** renders inside `AdaptiveSheet` bottom sheet with grab handle.
 * - **TV (10-ft):** non-`Modal` D-pad navigable overlay (`Up`/`Down` move highlight, `Select` activates, `Back` closes).
 */
export function ProfileDropdownMenu({
  visible,
  profiles,
  activeProfileId,
  hasGuardPin = false,
  parentalControlsEnabled = false,
  parentalUnlocked = false,
  pinnedOpen = false,
  panelProps,
  panelRef,
  triggerRef,
  renderProfileAvatar,
  onSelectProfile,
  onAddProfile,
  onEditProfiles,
  onOpenSettings,
  onSignOut,
  onClose,
}: ProfileDropdownMenuProps): ReactElement | null {
  const theme = useTheme();
  const viewport = useViewport();
  const i18n = useI18n();
  const isTv = viewport.formFactor === 'tv';
  const isPortrait = !isTv && viewport.orientation === 'portrait';
  const isTouch = viewport.inputModality === 'touch';

  const dialogRef = useRef<ComponentRef<typeof View> | null>(null);
  const internalPanelRef = useRef<ComponentRef<typeof View> | null>(null);

  const setMergedPanelRef = useCallback(
    (node: ComponentRef<typeof View> | null) => {
      internalPanelRef.current = node;
      if (panelRef) {
        (panelRef as { current: unknown }).current = node;
      }
    },
    [panelRef],
  );

  const items = useMemo<readonly MenuActionItem[]>(
    () => [
      ...profiles.map((profile): MenuActionItem => ({ kind: 'profile', profile })),
      { kind: 'addNew' },
      { kind: 'editProfiles' },
      { kind: 'settings' },
      { kind: 'signOut' },
    ],
    [profiles],
  );

  const initialFocusIdx = Math.max(
    0,
    profiles.findIndex((p) => p.id === activeProfileId),
  );
  const [tvFocusedIndex, setTvFocusedIndex] = useState(initialFocusIdx);
  const tvFocusedIndexRef = useRef(tvFocusedIndex);
  tvFocusedIndexRef.current = tvFocusedIndex;

  useEffect(() => {
    if (!visible) return;
    const activeIdx = profiles.findIndex((p) => p.id === activeProfileId);
    const nextIdx = Math.max(activeIdx, 0);
    tvFocusedIndexRef.current = nextIdx;
    setTvFocusedIndex(nextIdx);
  }, [activeProfileId, profiles, visible]);

  useDesktopDialogTrap(dialogRef, visible && !isTv && !isPortrait, onClose, {
    modal: Boolean(pinnedOpen),
    ...(pinnedOpen
      ? { initialFocus: 'first' as const }
      : { initialFocus: 'none' as const, restoreFocus: false }),
  });

  // Fallback Escape listener when host node is a non-DOM stub (e.g. Jest RN test environment).
  useEffect(() => {
    if (!visible || isTv || isPortrait || (Platform.OS as string) !== 'web') return undefined;
    const node = dialogRef.current as { querySelectorAll?: unknown } | null;
    if (node && typeof node.querySelectorAll === 'function') return undefined;
    const win = (
      globalThis as {
        window?: {
          addEventListener?: (
            type: string,
            fn: (e: { key?: unknown; preventDefault?: () => void }) => void,
          ) => void;
          removeEventListener?: (
            type: string,
            fn: (e: { key?: unknown; preventDefault?: () => void }) => void,
          ) => void;
        };
      }
    ).window;
    if (!win?.addEventListener || !win.removeEventListener) return undefined;
    const onKeyDown = (event: { key?: unknown; preventDefault?: () => void }) => {
      if (event.key !== 'Escape') return;
      event.preventDefault?.();
      onCloseRef.current();
    };
    win.addEventListener('keydown', onKeyDown);
    return () => {
      win.removeEventListener?.('keydown', onKeyDown);
    };
  }, [isPortrait, isTv, visible]);

  // Dismiss hover-open desktop menus cleanly on any pointerdown outside both panel and trigger.
  useEffect(() => {
    if (!visible || pinnedOpen || isTv || isPortrait) return undefined;
    if ((Platform.OS as string) !== 'web') return undefined;
    const doc = (
      globalThis as {
        document?: {
          addEventListener?: (type: string, fn: (e: { target?: unknown }) => void) => void;
          removeEventListener?: (type: string, fn: (e: { target?: unknown }) => void) => void;
        };
      }
    ).document;
    if (!doc?.addEventListener || !doc.removeEventListener) return undefined;

    const handlePointerDown = (event: { target?: unknown }) => {
      if (
        isNodeInsideRef(event.target, internalPanelRef) ||
        isNodeInsideRef(event.target, triggerRef)
      ) {
        return;
      }
      onClose();
    };
    doc.addEventListener('pointerdown', handlePointerDown);
    return () => {
      doc.removeEventListener?.('pointerdown', handlePointerDown);
    };
  }, [isPortrait, isTv, onClose, pinnedOpen, triggerRef, visible]);

  const activateItem = useCallback(
    (item: MenuActionItem) => {
      onClose();
      switch (item.kind) {
        case 'profile':
          onSelectProfile(item.profile.id);
          return;
        case 'addNew':
          onAddProfile();
          return;
        case 'editProfiles':
          onEditProfiles();
          return;
        case 'settings':
          onOpenSettings();
          return;
        case 'signOut':
          onSignOut();
          return;
      }
    },
    [onAddProfile, onClose, onEditProfiles, onOpenSettings, onSelectProfile, onSignOut],
  );

  const itemsRef = useRef(items);
  itemsRef.current = items;
  const activateItemRef = useRef(activateItem);
  activateItemRef.current = activateItem;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const handleTvKey = useCallback((event: KeyEvent): boolean => {
    if (event.kind === 'press' && event.key === 'back') {
      onCloseRef.current();
      return true;
    }
    if (event.kind === 'press' && event.key === 'select') {
      const picked = itemsRef.current[tvFocusedIndexRef.current];
      if (picked) activateItemRef.current(picked);
      return true;
    }
    if (event.kind !== 'press' && event.kind !== 'repeat') return false;
    if (event.key === 'up' || event.key === 'down') {
      const list = itemsRef.current;
      if (list.length === 0) return true;
      const delta = event.key === 'down' ? 1 : -1;
      const next = (tvFocusedIndexRef.current + delta + list.length) % list.length;
      tvFocusedIndexRef.current = next;
      setTvFocusedIndex(next);
      return true;
    }
    if (event.key === 'left' || event.key === 'right') {
      return true;
    }
    return false;
  }, []);

  if (!visible) return null;

  const rowTransition = webTransition(theme, 'background-color, border-color');
  const cursor = webCursorPointer();
  const minRowHeight = isTouch || isPortrait ? 44 : 38;
  const activeProfile = profiles.find((p) => p.id === activeProfileId);
  const isSiblingLockRequired = Boolean(
    (activeProfile?.isKids || parentalControlsEnabled) && hasGuardPin && !parentalUnlocked,
  );

  const renderMenuBody = (includeSectionTitle: boolean): ReactElement => (
    <ScrollView
      showsVerticalScrollIndicator={false}
      style={styles.menuScroll}
      contentContainerStyle={styles.menuScrollContent}
    >
      {includeSectionTitle ? (
        <Text
          testID="profile-dropdown-section-profiles"
          numberOfLines={1}
          style={[
            theme.typography.caption,
            styles.sectionHeader,
            { color: theme.colors.textMuted },
          ]}
        >
          {i18n.t('profile.menu.profiles')}
        </Text>
      ) : null}

      {profiles.map((profile, idx) => {
        const isActive = profile.id === activeProfileId;
        const tvFocused = isTv && tvFocusedIndex === idx;
        const showLock = !isActive && isSiblingLockRequired;
        const itemDef: MenuActionItem = { kind: 'profile', profile };
        return (
          <Pressable
            key={profile.id}
            testID={`profile-menu-item-${profile.id}`}
            accessibilityRole="menuitem"
            accessibilityLabel={profile.name}
            accessibilityState={{ selected: isActive }}
            focusable={!isTv}
            onPress={() => activateItem(itemDef)}
            style={(state) => {
              const hovered = Boolean((state as { hovered?: boolean }).hovered);
              return [
                styles.row,
                cursor,
                rowTransition,
                {
                  minHeight: minRowHeight,
                  borderRadius: theme.radius.button,
                  borderWidth: tvFocused ? theme.focus.ringWidth : 1,
                  borderColor: tvFocused ? theme.colors.focusRingColor : 'transparent',
                  backgroundColor: tvFocused
                    ? theme.colors.focusFill
                    : hovered || isActive
                      ? theme.colors.subtleHighlight
                      : 'transparent',
                },
              ];
            }}
          >
            <View style={styles.rowLeft}>
              {renderProfileAvatar ? (
                renderProfileAvatar(profile, isActive)
              ) : (
                <View
                  style={[
                    styles.fallbackAvatar,
                    {
                      backgroundColor: theme.colors.bgCard,
                      borderColor: isActive ? theme.colors.accent : theme.colors.surfaceBorder,
                    },
                  ]}
                >
                  <Text style={[theme.typography.caption, { color: theme.colors.textPrimary }]}>
                    {profile.name.trim().slice(0, 1).toUpperCase() || '?'}
                  </Text>
                </View>
              )}
              <Text
                numberOfLines={1}
                style={[
                  theme.typography.body,
                  styles.rowLabel,
                  {
                    color: theme.colors.textPrimary,
                    fontWeight: isActive ? '700' : '500',
                  },
                ]}
              >
                {profile.name}
              </Text>
              {profile.isKids ? (
                <MicroPill label={i18n.t('profiles.kidsBadge')} tone="accent" />
              ) : null}
            </View>

            <View style={styles.rowRight}>
              {isActive ? (
                <Icon
                  name="check"
                  size={16}
                  color={theme.colors.accent}
                  testID={`profile-menu-check-${profile.id}`}
                />
              ) : showLock ? (
                <Icon
                  name="lock"
                  size={14}
                  color={theme.colors.textMuted}
                  testID={`profile-menu-lock-${profile.id}`}
                />
              ) : null}
            </View>
          </Pressable>
        );
      })}

      <Pressable
        testID="profile-menu-add-new"
        accessibilityRole="menuitem"
        accessibilityLabel={i18n.t('profile.menu.addNew')}
        focusable={!isTv}
        onPress={() => activateItem({ kind: 'addNew' })}
        style={(state) => {
          const tvFocused = isTv && tvFocusedIndex === profiles.length;
          const hovered = Boolean((state as { hovered?: boolean }).hovered);
          return [
            styles.row,
            cursor,
            rowTransition,
            {
              minHeight: minRowHeight,
              borderRadius: theme.radius.button,
              borderWidth: tvFocused ? theme.focus.ringWidth : 1,
              borderColor: tvFocused ? theme.colors.focusRingColor : 'transparent',
              backgroundColor: tvFocused
                ? theme.colors.focusFill
                : hovered
                  ? theme.colors.subtleHighlight
                  : 'transparent',
            },
          ];
        }}
      >
        <View style={styles.rowLeft}>
          <Icon name="plus" size={16} color={theme.colors.textSecondary} />
          <Text
            numberOfLines={1}
            style={[theme.typography.body, styles.rowLabel, { color: theme.colors.textSecondary }]}
          >
            {i18n.t('profile.menu.addNew')}
          </Text>
        </View>
      </Pressable>

      <View
        testID="profile-menu-divider"
        style={[styles.divider, { backgroundColor: theme.colors.surfaceBorder }]}
      />

      <Pressable
        testID="profile-menu-edit-profiles"
        accessibilityRole="menuitem"
        accessibilityLabel={i18n.t('profile.menu.editProfiles')}
        focusable={!isTv}
        onPress={() => activateItem({ kind: 'editProfiles' })}
        style={(state) => {
          const tvFocused = isTv && tvFocusedIndex === profiles.length + 1;
          const hovered = Boolean((state as { hovered?: boolean }).hovered);
          return [
            styles.row,
            cursor,
            rowTransition,
            {
              minHeight: minRowHeight,
              borderRadius: theme.radius.button,
              borderWidth: tvFocused ? theme.focus.ringWidth : 1,
              borderColor: tvFocused ? theme.colors.focusRingColor : 'transparent',
              backgroundColor: tvFocused
                ? theme.colors.focusFill
                : hovered
                  ? theme.colors.subtleHighlight
                  : 'transparent',
            },
          ];
        }}
      >
        <View style={styles.rowLeft}>
          <Icon name="profile" size={16} color={theme.colors.textSecondary} />
          <Text
            numberOfLines={1}
            style={[theme.typography.body, styles.rowLabel, { color: theme.colors.textPrimary }]}
          >
            {i18n.t('profile.menu.editProfiles')}
          </Text>
        </View>
      </Pressable>

      <Pressable
        testID="profile-menu-settings"
        accessibilityRole="menuitem"
        accessibilityLabel={i18n.t('nav.settings')}
        focusable={!isTv}
        onPress={() => activateItem({ kind: 'settings' })}
        style={(state) => {
          const tvFocused = isTv && tvFocusedIndex === profiles.length + 2;
          const hovered = Boolean((state as { hovered?: boolean }).hovered);
          return [
            styles.row,
            cursor,
            rowTransition,
            {
              minHeight: minRowHeight,
              borderRadius: theme.radius.button,
              borderWidth: tvFocused ? theme.focus.ringWidth : 1,
              borderColor: tvFocused ? theme.colors.focusRingColor : 'transparent',
              backgroundColor: tvFocused
                ? theme.colors.focusFill
                : hovered
                  ? theme.colors.subtleHighlight
                  : 'transparent',
            },
          ];
        }}
      >
        <View style={styles.rowLeft}>
          <Icon name="settings" size={16} color={theme.colors.textSecondary} />
          <Text
            numberOfLines={1}
            style={[theme.typography.body, styles.rowLabel, { color: theme.colors.textPrimary }]}
          >
            {i18n.t('nav.settings')}
          </Text>
        </View>
      </Pressable>

      <Pressable
        testID="profile-menu-sign-out"
        accessibilityRole="menuitem"
        accessibilityLabel={i18n.t('profile.menu.signOut')}
        focusable={!isTv}
        onPress={() => activateItem({ kind: 'signOut' })}
        style={(state) => {
          const tvFocused = isTv && tvFocusedIndex === profiles.length + 3;
          const hovered = Boolean((state as { hovered?: boolean }).hovered);
          return [
            styles.row,
            cursor,
            rowTransition,
            {
              minHeight: minRowHeight,
              borderRadius: theme.radius.button,
              borderWidth: tvFocused ? theme.focus.ringWidth : 1,
              borderColor: tvFocused ? theme.colors.focusRingColor : 'transparent',
              backgroundColor: tvFocused
                ? theme.colors.focusFill
                : hovered
                  ? theme.colors.subtleHighlight
                  : 'transparent',
            },
          ];
        }}
      >
        <View style={styles.rowLeft}>
          <Text
            testID="profile-menu-sign-out-label"
            numberOfLines={1}
            style={[
              theme.typography.body,
              styles.rowLabel,
              { color: theme.colors.liveColor, fontWeight: '600' },
            ]}
          >
            {i18n.t('profile.menu.signOut')}
          </Text>
        </View>
      </Pressable>
    </ScrollView>
  );

  if (isPortrait) {
    return (
      <AdaptiveSheet
        visible={visible}
        title={i18n.t('profile.menu.profiles')}
        onDismiss={onClose}
        testID="profile-dropdown-menu"
      >
        {renderMenuBody(false)}
      </AdaptiveSheet>
    );
  }

  const panelTop = (isTv ? 64 : 54) + viewport.safeArea.top + (isTv ? viewport.overscan.y : 0);
  const panelRight =
    (isTv ? Math.max(theme.spacing.xl, viewport.overscan.x) : theme.spacing.md) +
    viewport.safeArea.right;
  const backdropWebProps =
    (Platform.OS as string) === 'web' ? ({ tabIndex: -1 } as Record<string, unknown>) : undefined;

  return (
    <View
      ref={dialogRef}
      testID="profile-dropdown-menu"
      accessibilityViewIsModal={isTv || pinnedOpen}
      pointerEvents={isTv || pinnedOpen ? 'auto' : 'box-none'}
      style={[StyleSheet.absoluteFill, styles.desktopRoot]}
    >
      {isTv ? <ProfileTvKeyBridge onEvent={handleTvKey} /> : null}

      <Pressable
        testID="profile-dropdown-menu-backdrop"
        accessible={false}
        aria-hidden
        focusable={false}
        {...backdropWebProps}
        pointerEvents={isTv || pinnedOpen ? 'auto' : 'none'}
        onPress={onClose}
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: isTv ? theme.colors.overlayBackdrop : 'transparent' },
        ]}
      />

      <View
        ref={setMergedPanelRef}
        testID="profile-dropdown-menu-panel"
        role="menu"
        aria-label={i18n.t('profile.menu.profiles')}
        {...panelProps}
        style={[
          styles.panel,
          {
            top: panelTop,
            right: panelRight,
            backgroundColor: theme.colors.glassBg,
            borderColor: theme.colors.glassBorder,
            borderRadius: theme.radius.modal,
            padding: theme.spacing.sm,
          },
          webBackdropBlur(24),
          webShadow('0 20px 56px rgba(0, 0, 0, 0.78)'),
        ]}
      >
        {renderMenuBody(true)}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  desktopRoot: {
    zIndex: 48,
  },
  panel: {
    position: 'absolute',
    width: 272,
    maxHeight: '78%',
    borderWidth: 1,
    shadowColor: 'rgba(0, 0, 0, 1)',
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.56,
    shadowRadius: 28,
    elevation: 18,
  },
  menuScroll: {
    flexGrow: 0,
  },
  menuScrollContent: {
    gap: 2,
  },
  sectionHeader: {
    paddingHorizontal: 10,
    paddingTop: 4,
    paddingBottom: 6,
    fontWeight: '600',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
    paddingVertical: 7,
    gap: 10,
  },
  rowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1,
    minWidth: 0,
  },
  rowRight: {
    width: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowLabel: {
    flexShrink: 1,
  },
  fallbackAvatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginVertical: 6,
    marginHorizontal: 8,
  },
});
