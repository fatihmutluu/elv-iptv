import {
  DEFAULT_HOME_LAYOUT,
  type HomeLayoutSectionId,
  type HomeLayoutSectionPref,
  homeLayoutEquals,
  normalizeHomeLayout,
} from '@elv/domain';
import { createFocusStore, type FocusStore, findList, type KeyEvent } from '@elv/focus-core';
import type { THEME_PRESET_IDS } from '@elv/ui-kit';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

/** Navigable category sections inside {@link SettingsScreen}. */
export type SettingsSection =
  | 'appearance'
  | 'playback'
  | 'liveTv'
  | 'remote'
  | 'profiles'
  | 'sources'
  | 'account'
  | 'feedback'
  | 'licenses';

/** Preference sections navigated row-by-row directly via {@link useTvSettingsNavigation}. */
export type PreferenceSettingsSection = 'appearance' | 'playback' | 'liveTv';

/** Ordered Settings sidebar sections (on non-TV platforms, `'remote'` is filtered out at render time). */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  'appearance',
  'playback',
  'liveTv',
  'remote',
  'profiles',
  'sources',
  'account',
  'feedback',
  'licenses',
];

/** Focusable control identifiers inside the Appearance settings panel. */
export type AppearanceFocusId =
  | 'lang-dropdown'
  | `theme-${(typeof THEME_PRESET_IDS)[number]}`
  | `home-layout-${HomeLayoutSectionId}`
  | 'home-layout-reset'
  | 'font-90'
  | 'font-100'
  | 'font-110'
  | 'font-120'
  | 'ui-font-system'
  | 'ui-font-atkinson'
  | 'ui-font-opendyslexic'
  | 'sub-font-system'
  | 'sub-font-atkinson'
  | 'sub-font-opendyslexic'
  | 'toggle-reduce-motion'
  | 'toggle-confirm-exit'
  | 'overscan-x-dec'
  | 'overscan-x-inc'
  | 'overscan-y-dec'
  | 'overscan-y-inc'
  | 'tv-clock-always'
  | 'tv-clock-menus'
  | 'tv-clock-player'
  | 'tv-clock-never'
  | 'artwork-cache-dropdown'
  | 'artwork-cache-clear'
  | 'toggle-crash-reports-opt-in'
  | 'toggle-crash-reports-include-logs'
  | 'preview-diagnostic-report'
  | 'reset-preferences';

/** Focusable control identifiers inside the Playback settings panel. */
export type PlaybackFocusId =
  | 'seek-step-5'
  | 'seek-step-10'
  | 'seek-step-15'
  | 'seek-step-30'
  | 'aspect-fit'
  | 'aspect-fill'
  | 'aspect-stretch'
  | 'buffer-auto'
  | 'buffer-balanced'
  | 'buffer-large'
  | 'video-decoder-auto'
  | 'video-decoder-hardware'
  | 'video-decoder-software'
  | 'toggle-filter-sdh'
  | 'toggle-prefer-hevc-dv'
  | 'toggle-pitch-lock'
  | 'toggle-audio-normalization'
  | 'night-drc-off'
  | 'night-drc-light'
  | 'night-drc-night'
  | 'toggle-auto-enter-pip'
  | 'toggle-background-audio'
  | 'osd-time-total'
  | 'osd-time-remaining'
  | 'osd-time-endsAt'
  | 'toggle-auto-play-next'
  | 'external-player-off'
  | 'external-player-ask'
  | 'external-player-always';

/** Focusable control identifiers inside the Live TV & Guide settings panel. */
export type LiveTvFocusId =
  | 'live-mode-favorites'
  | 'live-mode-channels'
  | 'live-mode-epg'
  | 'epg-span-2'
  | 'epg-span-3'
  | 'epg-span-6'
  | 'epg-density-compact'
  | 'epg-density-comfortable'
  | 'epg-density-cinematic'
  | 'toggle-epg-show-clock'
  | 'catalog-refresh-dropdown'
  | 'catalog-refresh-now'
  | 'guide-refresh-dropdown'
  | 'guide-refresh-now'
  | 'channel-switch-instant'
  | 'channel-switch-preview';

const NAV_LIST_ID = 'settings-nav';

const APPEARANCE_ROWS_TOP: readonly (readonly AppearanceFocusId[])[] = [
  ['lang-dropdown'],
  ['theme-obsidianCrimson', 'theme-abyssalSapphire', 'theme-theaterAmber'],
  ['theme-velvetViolet', 'theme-pitchEmerald', 'theme-highContrast'],
];

const APPEARANCE_ROWS_TYPOGRAPHY: readonly (readonly AppearanceFocusId[])[] = [
  ['font-90', 'font-100', 'font-110', 'font-120'],
  ['ui-font-system', 'ui-font-atkinson', 'ui-font-opendyslexic'],
  ['sub-font-system', 'sub-font-atkinson', 'sub-font-opendyslexic'],
  ['toggle-reduce-motion'],
];

const APPEARANCE_TV_ROWS: readonly (readonly AppearanceFocusId[])[] = [
  ['overscan-x-dec', 'overscan-x-inc'],
  ['overscan-y-dec', 'overscan-y-inc'],
  ['tv-clock-always', 'tv-clock-menus', 'tv-clock-player', 'tv-clock-never'],
];

const APPEARANCE_ROWS_BOTTOM: readonly (readonly AppearanceFocusId[])[] = [
  ['artwork-cache-dropdown'],
  ['artwork-cache-clear'],
  ['toggle-crash-reports-opt-in'],
  ['toggle-crash-reports-include-logs'],
  ['preview-diagnostic-report'],
  ['reset-preferences'],
];

function buildAppearanceRows(
  includeTvDisplayRows: boolean,
  showConfirmExitOnBack: boolean,
  homeLayout?: readonly HomeLayoutSectionPref[],
): readonly (readonly AppearanceFocusId[])[] {
  const normalized = normalizeHomeLayout(homeLayout ?? DEFAULT_HOME_LAYOUT);
  const homeLayoutRows: (readonly AppearanceFocusId[])[] = normalized.map((entry) => [
    `home-layout-${entry.id}` as AppearanceFocusId,
  ]);
  if (!homeLayoutEquals(normalized, DEFAULT_HOME_LAYOUT)) {
    homeLayoutRows.push(['home-layout-reset']);
  }
  return [
    ...APPEARANCE_ROWS_TOP,
    ...homeLayoutRows,
    ...APPEARANCE_ROWS_TYPOGRAPHY,
    ...(showConfirmExitOnBack ? ([['toggle-confirm-exit']] as const) : []),
    ...(includeTvDisplayRows ? APPEARANCE_TV_ROWS : []),
    ...APPEARANCE_ROWS_BOTTOM,
  ];
}

const PLAYBACK_ROWS_HEAD: readonly (readonly PlaybackFocusId[])[] = [
  ['seek-step-5', 'seek-step-10', 'seek-step-15', 'seek-step-30'],
  ['aspect-fit', 'aspect-fill', 'aspect-stretch'],
  ['buffer-auto', 'buffer-balanced', 'buffer-large'],
];

const PLAYBACK_DECODER_ROW: readonly PlaybackFocusId[] = [
  'video-decoder-auto',
  'video-decoder-hardware',
  'video-decoder-software',
];

const PLAYBACK_ROWS_CORE: readonly (readonly PlaybackFocusId[])[] = [
  ['toggle-filter-sdh'],
  ['toggle-prefer-hevc-dv'],
  ['toggle-pitch-lock'],
  ['toggle-audio-normalization'],
];

const PLAYBACK_NIGHT_DRC_ROW: readonly PlaybackFocusId[] = [
  'night-drc-off',
  'night-drc-light',
  'night-drc-night',
];

const PLAYBACK_ROWS_TAIL: readonly (readonly PlaybackFocusId[])[] = [
  ['osd-time-total', 'osd-time-remaining', 'osd-time-endsAt'],
  ['toggle-auto-play-next'],
];

const PLAYBACK_EXTERNAL_PLAYER_ROW: readonly PlaybackFocusId[] = [
  'external-player-off',
  'external-player-ask',
  'external-player-always',
];

const buildPlaybackRows = (
  showAndroidDecoder: boolean,
  showNightModeDrc: boolean,
  showExternalPlayer: boolean,
): readonly (readonly PlaybackFocusId[])[] => [
  ...PLAYBACK_ROWS_HEAD,
  ...(showAndroidDecoder ? [PLAYBACK_DECODER_ROW] : []),
  ...PLAYBACK_ROWS_CORE,
  ...(showNightModeDrc ? [PLAYBACK_NIGHT_DRC_ROW] : []),
  ...PLAYBACK_ROWS_TAIL,
  ...(showExternalPlayer ? [PLAYBACK_EXTERNAL_PLAYER_ROW] : []),
];

const PLAYBACK_ROWS_DEFAULT = buildPlaybackRows(false, false, false);

const PLAYBACK_ROWS_CACHE: Readonly<Record<string, readonly (readonly PlaybackFocusId[])[]>> = {
  '0:0:0': PLAYBACK_ROWS_DEFAULT,
  '0:0:1': buildPlaybackRows(false, false, true),
  '0:1:0': buildPlaybackRows(false, true, false),
  '0:1:1': buildPlaybackRows(false, true, true),
  '1:0:0': buildPlaybackRows(true, false, false),
  '1:0:1': buildPlaybackRows(true, false, true),
  '1:1:0': buildPlaybackRows(true, true, false),
  '1:1:1': buildPlaybackRows(true, true, true),
};

const LIVE_TV_ROWS: readonly (readonly LiveTvFocusId[])[] = [
  ['live-mode-favorites', 'live-mode-channels', 'live-mode-epg'],
  ['epg-span-2', 'epg-span-3', 'epg-span-6'],
  ['epg-density-compact', 'epg-density-comfortable', 'epg-density-cinematic'],
  ['toggle-epg-show-clock'],
  ['catalog-refresh-dropdown', 'catalog-refresh-now'],
  ['guide-refresh-dropdown', 'guide-refresh-now'],
  ['channel-switch-instant', 'channel-switch-preview'],
];

const PREFERENCE_SECTIONS: readonly PreferenceSettingsSection[] = [
  'appearance',
  'playback',
  'liveTv',
];

function getSectionRows(
  showAndroidDecoder: boolean,
  showNightModeDrc: boolean,
  showExternalPlayer: boolean,
  includeTvDisplayRows: boolean,
  showConfirmExitOnBack: boolean,
  homeLayout?: readonly HomeLayoutSectionPref[],
): Readonly<Record<PreferenceSettingsSection, readonly (readonly string[])[]>> {
  const playbackKey = `${showAndroidDecoder ? '1' : '0'}:${showNightModeDrc ? '1' : '0'}:${showExternalPlayer ? '1' : '0'}`;
  return {
    appearance: buildAppearanceRows(includeTvDisplayRows, showConfirmExitOnBack, homeLayout),
    playback: PLAYBACK_ROWS_CACHE[playbackKey] ?? PLAYBACK_ROWS_DEFAULT,
    liveTv: LIVE_TV_ROWS,
  };
}

/** Whether `section` uses generalized row-by-row preference D-pad traversal. */
function isPreferenceSection(section: SettingsSection): section is PreferenceSettingsSection {
  return section === 'appearance' || section === 'playback' || section === 'liveTv';
}

const rowListId = (section: PreferenceSettingsSection, rowIndex: number): string =>
  `${section}-row-${rowIndex}`;

function createSettingsFocusStore(
  initialSection: SettingsSection,
  showAndroidDecoder: boolean,
  showNightModeDrc: boolean,
  showExternalPlayer: boolean,
  includeTvDisplayRows: boolean,
  showConfirmExitOnBack: boolean,
  homeLayout?: readonly HomeLayoutSectionPref[],
): FocusStore {
  const initialIdx = Math.max(0, SETTINGS_SECTIONS.indexOf(initialSection));
  const sectionRows = getSectionRows(
    showAndroidDecoder,
    showNightModeDrc,
    showExternalPlayer,
    includeTvDisplayRows,
    showConfirmExitOnBack,
    homeLayout,
  );
  const sectionLists = PREFERENCE_SECTIONS.flatMap((sec) =>
    sectionRows[sec].map((row, i) => ({
      id: rowListId(sec, i),
      count: row.length,
      index: 0,
      orientation: 'horizontal' as const,
      pageSize: row.length,
    })),
  );
  return createFocusStore({
    id: 'settings-scope',
    lists: [
      {
        id: NAV_LIST_ID,
        count: SETTINGS_SECTIONS.length,
        index: initialIdx,
        orientation: 'vertical',
        pageSize: SETTINGS_SECTIONS.length,
      },
      ...sectionLists,
    ],
    active: NAV_LIST_ID,
  });
}

type SectionCoords = Readonly<Record<PreferenceSettingsSection, { row: number; col: number }>>;

const INITIAL_COORDS: SectionCoords = {
  appearance: { row: 0, col: 0 },
  playback: { row: 0, col: 0 },
  liveTv: { row: 0, col: 0 },
};

/** Options for {@link useTvSettingsNavigation}. */
export interface UseTvSettingsNavigationOptions {
  readonly isTv: boolean;
  readonly isActiveScope: boolean;
  readonly section: SettingsSection;
  readonly onSectionChange: (next: SettingsSection) => void;
  readonly onActivateControl?: (section: PreferenceSettingsSection, controlId: string) => void;
  /** Optional left/right D-pad adjustment handler (e.g. Home layout section reorder). */
  readonly onAdjustControl?: (
    section: PreferenceSettingsSection,
    controlId: string,
    delta: -1 | 1,
  ) => void;
  /** Backwards-compatible Appearance-only activation callback. */
  readonly onActivateAppearanceControl?: (id: AppearanceFocusId) => void;
  readonly onFocusTopNav?: () => void;
  /** Whether the Android-only Video decoder row is rendered in Playback settings (`#411`). */
  readonly showAndroidDecoder?: boolean;
  /** Whether the Android-only Night-Mode DRC row is rendered in Playback settings (`#115`). */
  readonly showNightModeDrc?: boolean;
  /** Whether the mobile External Player row is rendered in Playback settings (`#406`). */
  readonly showExternalPlayer?: boolean;
  /** Whether the Android-only Confirm Exit on Back row is rendered in Appearance settings. */
  readonly showConfirmExitOnBack?: boolean;
  /** When `true`, keeps the current Settings pane (`'nav'` | `'content'`) while `isActiveScope` temporarily blurs for a root overlay. */
  readonly preservePaneOnBlur?: boolean;
  /** Current Home screen section order/visibility so TV Appearance focus matches the rendered `HomeLayoutEditor` order. */
  readonly homeLayout?: readonly HomeLayoutSectionPref[];
}

/** Return value of {@link useTvSettingsNavigation}. */
export interface TvSettingsNavigationState {
  readonly pane: 'nav' | 'content';
  readonly ownsTvRemote: boolean;
  readonly focusedSection: SettingsSection | null;
  readonly focusedControlId: string | null;
  /** Backwards-compatible alias populated when `section === 'appearance'`. */
  readonly focusedAppearanceId: AppearanceFocusId | null;
  readonly handleTvKey: (event: KeyEvent) => boolean;
  readonly enterContentPane: () => void;
  readonly returnToSidebar: () => void;
}

/**
 * Manages 10-foot TV D-pad focus across the Settings sidebar (`pane === 'nav'`), generalized
 * preference rows (`appearance`, `playback`, `liveTv`), and embedded Sources / Notices panes.
 */
export function useTvSettingsNavigation({
  isTv,
  isActiveScope,
  section,
  onSectionChange,
  onActivateControl,
  onAdjustControl,
  onActivateAppearanceControl,
  onFocusTopNav,
  showAndroidDecoder = Platform.OS === 'android',
  showNightModeDrc = Platform.OS === 'android',
  showExternalPlayer = Platform.OS === 'android' || (Platform.OS === 'ios' && !Platform.isTV),
  showConfirmExitOnBack = Platform.OS === 'android',
  preservePaneOnBlur = false,
  homeLayout,
}: UseTvSettingsNavigationOptions): TvSettingsNavigationState {
  const [pane, setPane] = useState<'nav' | 'content'>(() =>
    isActiveScope && section === 'sources' ? 'content' : 'nav',
  );
  const [coords, setCoords] = useState<SectionCoords>(INITIAL_COORDS);

  const normalizedHomeLayout = normalizeHomeLayout(homeLayout ?? DEFAULT_HOME_LAYOUT);
  const isHomeLayoutCustomized = !homeLayoutEquals(normalizedHomeLayout, DEFAULT_HOME_LAYOUT);
  const sectionRows = getSectionRows(
    showAndroidDecoder,
    showNightModeDrc,
    showExternalPlayer,
    isTv,
    showConfirmExitOnBack,
    normalizedHomeLayout,
  );
  const sectionRowsRef = useRef(sectionRows);
  sectionRowsRef.current = sectionRows;
  const storeRef = useRef<FocusStore | null>(null);
  const storeConfigKey = `${showAndroidDecoder ? '1' : '0'}:${showNightModeDrc ? '1' : '0'}:${showExternalPlayer ? '1' : '0'}:${isTv ? '1' : '0'}:${showConfirmExitOnBack ? '1' : '0'}:${isHomeLayoutCustomized ? '1' : '0'}`;
  const storeConfigKeyRef = useRef(storeConfigKey);
  if (storeRef.current === null || storeConfigKeyRef.current !== storeConfigKey) {
    storeConfigKeyRef.current = storeConfigKey;
    storeRef.current = createSettingsFocusStore(
      section,
      showAndroidDecoder,
      showNightModeDrc,
      showExternalPlayer,
      isTv,
      showConfirmExitOnBack,
      normalizedHomeLayout,
    );
  }
  const store = storeRef.current;

  const appearanceRowCount = sectionRows.appearance.length;
  useEffect(() => {
    setCoords((prev) => {
      const maxRow = Math.max(0, appearanceRowCount - 1);
      if (prev.appearance.row <= maxRow) return prev;
      return { ...prev, appearance: { row: maxRow, col: 0 } };
    });
  }, [appearanceRowCount]);

  const paneRef = useRef(pane);
  paneRef.current = pane;
  const sectionRef = useRef(section);
  sectionRef.current = section;
  const coordsRef = useRef(coords);
  coordsRef.current = coords;
  const onSectionChangeRef = useRef(onSectionChange);
  onSectionChangeRef.current = onSectionChange;
  const onActivateControlRef = useRef(onActivateControl);
  onActivateControlRef.current = onActivateControl;
  const onAdjustControlRef = useRef(onAdjustControl);
  onAdjustControlRef.current = onAdjustControl;
  const onActivateAppearanceRef = useRef(onActivateAppearanceControl);
  onActivateAppearanceRef.current = onActivateAppearanceControl;
  const onFocusTopNavRef = useRef(onFocusTopNav);
  onFocusTopNavRef.current = onFocusTopNav;

  useEffect(() => {
    const idx = SETTINGS_SECTIONS.indexOf(section);
    if (idx >= 0 && paneRef.current === 'nav') {
      store.focus(NAV_LIST_ID, idx);
    }
  }, [section, store]);

  const preservePaneOnBlurRef = useRef(preservePaneOnBlur);
  preservePaneOnBlurRef.current = preservePaneOnBlur;

  useEffect(() => {
    if (!isActiveScope && !preservePaneOnBlurRef.current) {
      setPane('nav');
      store.activate(NAV_LIST_ID);
    }
  }, [isActiveScope, store]);

  const enterContentPane = useCallback(() => {
    setPane('content');
    const curSection = sectionRef.current;
    if (isPreferenceSection(curSection)) {
      const rows = sectionRowsRef.current[curSection];
      const targetRow = Math.min(coordsRef.current[curSection].row, Math.max(0, rows.length - 1));
      const listId = rowListId(curSection, targetRow);
      store.activate(listId);
      const found = findList(store.getState().scopes, listId);
      const rowLen = rows[targetRow]?.length ?? 0;
      const col = Math.min(found?.list.index ?? 0, Math.max(0, rowLen - 1));
      setCoords((prev) => ({ ...prev, [curSection]: { row: targetRow, col } }));
    }
  }, [store]);

  const returnToSidebar = useCallback(() => {
    setPane('nav');
    const idx = SETTINGS_SECTIONS.indexOf(sectionRef.current);
    store.focus(NAV_LIST_ID, Math.max(0, idx));
  }, [store]);

  const handleTvKey = useCallback(
    (event: KeyEvent): boolean => {
      if (paneRef.current === 'nav') {
        const idx = SETTINGS_SECTIONS.indexOf(sectionRef.current);
        store.focus(NAV_LIST_ID, Math.max(0, idx));
        if (event.kind === 'press' && event.key === 'right') {
          enterContentPane();
          return true;
        }
        const intents = store.dispatch(event);
        const navList = findList(store.getState().scopes, NAV_LIST_ID)?.list;
        if (navList) {
          const nextSection = SETTINGS_SECTIONS[navList.index];
          if (nextSection && nextSection !== sectionRef.current) {
            onSectionChangeRef.current(nextSection);
          }
        }
        for (const intent of intents) {
          if (intent.kind === 'edge' && intent.side === 'start' && event.key === 'up') {
            onFocusTopNavRef.current?.();
            return true;
          }
          if (intent.kind === 'back') {
            onFocusTopNavRef.current?.();
            return true;
          }
          if (intent.kind === 'select') {
            enterContentPane();
            return true;
          }
        }
        return event.key === 'up' || event.key === 'down';
      }

      const activeSection = sectionRef.current;
      if (!isPreferenceSection(activeSection)) {
        return false;
      }

      const rows = sectionRowsRef.current[activeSection];
      const currentRow = Math.min(
        coordsRef.current[activeSection].row,
        Math.max(0, rows.length - 1),
      );
      const activeListId = rowListId(activeSection, currentRow);
      store.activate(activeListId);

      if ((event.kind === 'press' || event.kind === 'repeat') && event.key === 'up') {
        if (currentRow === 0) {
          onFocusTopNavRef.current?.();
          return true;
        }
        const nextRow = currentRow - 1;
        const currentList = findList(store.getState().scopes, activeListId)?.list;
        const targetItems = rows[nextRow] ?? [];
        const nextCol = Math.min(currentList?.index ?? 0, Math.max(0, targetItems.length - 1));
        const nextListId = rowListId(activeSection, nextRow);
        store.focus(nextListId, nextCol);
        setCoords((prev) => ({ ...prev, [activeSection]: { row: nextRow, col: nextCol } }));
        return true;
      }

      if ((event.kind === 'press' || event.kind === 'repeat') && event.key === 'down') {
        if (currentRow >= rows.length - 1) return false;
        const nextRow = currentRow + 1;
        const currentList = findList(store.getState().scopes, activeListId)?.list;
        const targetItems = rows[nextRow] ?? [];
        const nextCol = Math.min(currentList?.index ?? 0, Math.max(0, targetItems.length - 1));
        const nextListId = rowListId(activeSection, nextRow);
        store.focus(nextListId, nextCol);
        setCoords((prev) => ({ ...prev, [activeSection]: { row: nextRow, col: nextCol } }));
        return true;
      }

      const currentRowItems = rows[currentRow] ?? [];
      const currentCol = Math.min(
        coordsRef.current[activeSection].col,
        Math.max(0, currentRowItems.length - 1),
      );
      const activeControlId = currentRowItems[currentCol];
      if (
        activeSection === 'appearance' &&
        activeControlId !== undefined &&
        activeControlId.startsWith('home-layout-') &&
        activeControlId !== 'home-layout-reset' &&
        (event.kind === 'press' || event.kind === 'repeat') &&
        (event.key === 'left' || event.key === 'right')
      ) {
        const delta: -1 | 1 = event.key === 'right' ? 1 : -1;
        const firstHomeRowIdx = rows.findIndex(
          (row) => row[0]?.startsWith('home-layout-') && row[0] !== 'home-layout-reset',
        );
        const sectionIdx = firstHomeRowIdx >= 0 ? currentRow - firstHomeRowIdx : -1;
        const targetSectionIdx = sectionIdx + delta;
        if (
          firstHomeRowIdx >= 0 &&
          targetSectionIdx >= 0 &&
          targetSectionIdx < DEFAULT_HOME_LAYOUT.length
        ) {
          onAdjustControlRef.current?.(activeSection, activeControlId, delta);
          const nextRow = firstHomeRowIdx + targetSectionIdx;
          store.focus(rowListId(activeSection, nextRow), 0);
          setCoords((prev) => ({ ...prev, [activeSection]: { row: nextRow, col: 0 } }));
        }
        return true;
      }

      const intents = store.dispatch(event);
      const updated = findList(store.getState().scopes, activeListId)?.list;
      const col = updated?.index ?? 0;
      setCoords((prev) => ({ ...prev, [activeSection]: { row: currentRow, col } }));

      for (const intent of intents) {
        if (intent.kind === 'back') {
          returnToSidebar();
          return true;
        }
        if (intent.kind === 'edge' && intent.side === 'start' && event.key === 'left') {
          returnToSidebar();
          return true;
        }
        if (intent.kind === 'select') {
          const id = rows[currentRow]?.[col];
          if (id) {
            onActivateControlRef.current?.(activeSection, id);
            if (activeSection === 'appearance') {
              onActivateAppearanceRef.current?.(id as AppearanceFocusId);
            }
          }
          return true;
        }
      }
      return event.key === 'left' || event.key === 'right';
    },
    [enterContentPane, returnToSidebar, store],
  );

  const ownsTvRemote = isTv && isActiveScope && (pane === 'nav' || isPreferenceSection(section));
  const focusedSection = isTv && isActiveScope && pane === 'nav' ? section : null;
  let focusedControlId: string | null = null;
  if (isTv && isActiveScope && pane === 'content' && isPreferenceSection(section)) {
    const rows = sectionRows[section];
    const rowIdx = Math.min(coords[section].row, Math.max(0, rows.length - 1));
    const row = rows[rowIdx];
    const colIdx = Math.min(coords[section].col, Math.max(0, (row?.length ?? 0) - 1));
    focusedControlId = row?.[colIdx] ?? null;
  }
  const focusedAppearanceId =
    section === 'appearance' ? (focusedControlId as AppearanceFocusId | null) : null;

  return {
    pane,
    ownsTvRemote,
    focusedSection,
    focusedControlId,
    focusedAppearanceId,
    handleTvKey,
    enterContentPane,
    returnToSidebar,
  };
}
