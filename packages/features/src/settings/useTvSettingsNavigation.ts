import { createFocusStore, type FocusStore, findList, type KeyEvent } from '@elv/focus-core';
import type { THEME_PRESET_IDS } from '@elv/ui-kit';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

/** Navigable category sections inside {@link SettingsScreen}. */
export type SettingsSection = 'appearance' | 'playback' | 'liveTv' | 'sources' | 'licenses';

/** Preference sections navigated row-by-row directly via {@link useTvSettingsNavigation}. */
export type PreferenceSettingsSection = 'appearance' | 'playback' | 'liveTv';

/** Ordered Settings sidebar sections. */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  'appearance',
  'playback',
  'liveTv',
  'sources',
  'licenses',
];

/** Focusable control identifiers inside the Appearance settings panel. */
export type AppearanceFocusId =
  | 'lang-system'
  | 'lang-tr'
  | 'lang-en'
  | `theme-${(typeof THEME_PRESET_IDS)[number]}`
  | 'font-90'
  | 'font-100'
  | 'font-110'
  | 'font-120'
  | 'toggle-reduce-motion'
  | 'toggle-confirm-exit'
  | 'artwork-cache-64'
  | 'artwork-cache-128'
  | 'artwork-cache-256'
  | 'artwork-cache-clear'
  | 'reset-preferences';

/** Focusable control identifiers inside the Playback settings panel. */
export type PlaybackFocusId =
  | 'audio-lang-auto'
  | 'audio-lang-tr'
  | 'audio-lang-en'
  | 'audio-lang-de'
  | 'audio-lang-fr'
  | 'audio-lang-es'
  | 'sub-lang-auto'
  | 'sub-lang-tr'
  | 'sub-lang-en'
  | 'sub-lang-de'
  | 'sub-lang-fr'
  | 'sub-lang-es'
  | 'sub-mode-default'
  | 'sub-mode-smart'
  | 'sub-mode-onlyForced'
  | 'sub-mode-always'
  | 'sub-mode-off'
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
  | 'toggle-prefer-default-audio'
  | 'toggle-filter-sdh'
  | 'toggle-prefer-hevc-dv'
  | 'osd-time-total'
  | 'osd-time-remaining'
  | 'osd-time-endsAt'
  | 'oled-0'
  | 'oled-5'
  | 'oled-10'
  | 'oled-15'
  | 'oled-30'
  | 'still-watching-0'
  | 'still-watching-60'
  | 'still-watching-120'
  | 'still-watching-180'
  | 'still-watching-240'
  | 'toggle-auto-play-next'
  | 'toggle-skip-back-subtitles'
  | 'toggle-group-vod-versions'
  | 'audio-device-auto';

/** Focusable control identifiers inside the Live TV & Guide settings panel. */
export type LiveTvFocusId =
  | 'live-mode-favorites'
  | 'live-mode-channels'
  | 'live-mode-epg'
  | 'epg-span-2'
  | 'epg-span-3'
  | 'epg-span-6'
  | 'toggle-epg-genre-tints'
  | 'toggle-epg-show-clock'
  | 'catalog-refresh-0'
  | 'catalog-refresh-6'
  | 'catalog-refresh-12'
  | 'catalog-refresh-24'
  | 'catalog-refresh-48'
  | 'guide-refresh-0'
  | 'guide-refresh-6'
  | 'guide-refresh-12'
  | 'guide-refresh-24'
  | 'channel-switch-instant'
  | 'channel-switch-preview'
  | 'logo-backdrop-plate'
  | 'logo-backdrop-invert'
  | 'logo-backdrop-off'
  | 'toggle-source-badges'
  | 'toggle-two-step-preview'
  | 'toggle-clean-titles'
  | 'toggle-collapse-variants';

const NAV_LIST_ID = 'settings-nav';

const APPEARANCE_ROWS: readonly (readonly AppearanceFocusId[])[] = [
  ['lang-system', 'lang-tr', 'lang-en'],
  ['theme-obsidianCrimson', 'theme-abyssalSapphire', 'theme-theaterAmber'],
  ['theme-velvetViolet', 'theme-pitchEmerald', 'theme-highContrast'],
  ['font-90', 'font-100', 'font-110', 'font-120'],
  ['toggle-reduce-motion'],
  ['toggle-confirm-exit'],
  ['artwork-cache-64', 'artwork-cache-128', 'artwork-cache-256'],
  ['artwork-cache-clear'],
  ['reset-preferences'],
];

const PLAYBACK_ROWS_HEAD: readonly (readonly PlaybackFocusId[])[] = [
  [
    'audio-lang-auto',
    'audio-lang-tr',
    'audio-lang-en',
    'audio-lang-de',
    'audio-lang-fr',
    'audio-lang-es',
  ],
  ['sub-lang-auto', 'sub-lang-tr', 'sub-lang-en', 'sub-lang-de', 'sub-lang-fr', 'sub-lang-es'],
  ['sub-mode-default', 'sub-mode-smart', 'sub-mode-onlyForced', 'sub-mode-always', 'sub-mode-off'],
  ['seek-step-5', 'seek-step-10', 'seek-step-15', 'seek-step-30'],
  ['aspect-fit', 'aspect-fill', 'aspect-stretch'],
  ['buffer-auto', 'buffer-balanced', 'buffer-large'],
];

const PLAYBACK_DECODER_ROW: readonly PlaybackFocusId[] = [
  'video-decoder-auto',
  'video-decoder-hardware',
  'video-decoder-software',
];

const PLAYBACK_ROWS_TAIL: readonly (readonly PlaybackFocusId[])[] = [
  ['toggle-prefer-default-audio'],
  ['toggle-filter-sdh'],
  ['toggle-prefer-hevc-dv'],
  ['osd-time-total', 'osd-time-remaining', 'osd-time-endsAt'],
  ['oled-0', 'oled-5', 'oled-10', 'oled-15', 'oled-30'],
  [
    'still-watching-0',
    'still-watching-60',
    'still-watching-120',
    'still-watching-180',
    'still-watching-240',
  ],
  ['toggle-auto-play-next'],
  ['toggle-skip-back-subtitles'],
  ['toggle-group-vod-versions'],
  ['audio-device-auto'],
];

const PLAYBACK_ROWS_DEFAULT: readonly (readonly PlaybackFocusId[])[] = [
  ...PLAYBACK_ROWS_HEAD,
  ...PLAYBACK_ROWS_TAIL,
];

const PLAYBACK_ROWS_WITH_DECODER: readonly (readonly PlaybackFocusId[])[] = [
  ...PLAYBACK_ROWS_HEAD,
  PLAYBACK_DECODER_ROW,
  ...PLAYBACK_ROWS_TAIL,
];

const LIVE_TV_ROWS: readonly (readonly LiveTvFocusId[])[] = [
  ['live-mode-favorites', 'live-mode-channels', 'live-mode-epg'],
  ['epg-span-2', 'epg-span-3', 'epg-span-6'],
  ['toggle-epg-genre-tints'],
  ['toggle-epg-show-clock'],
  [
    'catalog-refresh-0',
    'catalog-refresh-6',
    'catalog-refresh-12',
    'catalog-refresh-24',
    'catalog-refresh-48',
  ],
  ['guide-refresh-0', 'guide-refresh-6', 'guide-refresh-12', 'guide-refresh-24'],
  ['channel-switch-instant', 'channel-switch-preview'],
  ['logo-backdrop-plate', 'logo-backdrop-invert', 'logo-backdrop-off'],
  ['toggle-source-badges'],
  ['toggle-two-step-preview'],
  ['toggle-clean-titles'],
  ['toggle-collapse-variants'],
];

const PREFERENCE_SECTIONS: readonly PreferenceSettingsSection[] = [
  'appearance',
  'playback',
  'liveTv',
];

function getSectionRows(
  showAndroidDecoder: boolean,
): Readonly<Record<PreferenceSettingsSection, readonly (readonly string[])[]>> {
  return {
    appearance: APPEARANCE_ROWS,
    playback: showAndroidDecoder ? PLAYBACK_ROWS_WITH_DECODER : PLAYBACK_ROWS_DEFAULT,
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
): FocusStore {
  const initialIdx = Math.max(0, SETTINGS_SECTIONS.indexOf(initialSection));
  const sectionRows = getSectionRows(showAndroidDecoder);
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
  /** Backwards-compatible Appearance-only activation callback. */
  readonly onActivateAppearanceControl?: (id: AppearanceFocusId) => void;
  readonly onFocusTopNav?: () => void;
  /** Whether the Android-only Video decoder row is rendered in Playback settings (`#411`). */
  readonly showAndroidDecoder?: boolean;
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
  onActivateAppearanceControl,
  onFocusTopNav,
  showAndroidDecoder = Platform.OS === 'android',
}: UseTvSettingsNavigationOptions): TvSettingsNavigationState {
  const [pane, setPane] = useState<'nav' | 'content'>(() =>
    isActiveScope && section === 'sources' ? 'content' : 'nav',
  );
  const [coords, setCoords] = useState<SectionCoords>(INITIAL_COORDS);

  const sectionRows = getSectionRows(showAndroidDecoder);
  const sectionRowsRef = useRef(sectionRows);
  sectionRowsRef.current = sectionRows;
  const storeRef = useRef<FocusStore | null>(null);
  const storeDecoderFlagRef = useRef(showAndroidDecoder);
  if (storeRef.current === null || storeDecoderFlagRef.current !== showAndroidDecoder) {
    storeDecoderFlagRef.current = showAndroidDecoder;
    storeRef.current = createSettingsFocusStore(section, showAndroidDecoder);
  }
  const store = storeRef.current;

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

  useEffect(() => {
    if (!isActiveScope) {
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
