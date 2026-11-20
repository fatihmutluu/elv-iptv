import { createFocusStore, type FocusStore, findList, type KeyEvent } from '@elv/focus-core';
import type { THEME_PRESET_IDS } from '@elv/ui-kit';
import { useCallback, useEffect, useRef, useState } from 'react';

/** Navigable category sections inside {@link SettingsScreen}. */
export type SettingsSection = 'appearance' | 'sources' | 'licenses';

/** Ordered Settings sidebar sections. */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = ['appearance', 'sources', 'licenses'];

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
  | 'reset-preferences';

const NAV_LIST_ID = 'settings-nav';

const APPEARANCE_ROWS: readonly (readonly AppearanceFocusId[])[] = [
  ['lang-system', 'lang-tr', 'lang-en'],
  ['theme-obsidianCrimson', 'theme-abyssalSapphire', 'theme-theaterAmber'],
  ['theme-velvetViolet', 'theme-pitchEmerald', 'theme-highContrast'],
  ['font-90', 'font-100', 'font-110', 'font-120'],
  ['toggle-reduce-motion'],
  ['reset-preferences'],
];

const rowListId = (rowIndex: number): string => `appearance-row-${rowIndex}`;

function createSettingsFocusStore(initialSection: SettingsSection): FocusStore {
  const initialIdx = Math.max(0, SETTINGS_SECTIONS.indexOf(initialSection));
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
      ...APPEARANCE_ROWS.map((row, i) => ({
        id: rowListId(i),
        count: row.length,
        index: 0,
        orientation: 'horizontal' as const,
        pageSize: row.length,
      })),
    ],
    active: NAV_LIST_ID,
  });
}

/** Options for {@link useTvSettingsNavigation}. */
export interface UseTvSettingsNavigationOptions {
  readonly isTv: boolean;
  readonly isActiveScope: boolean;
  readonly section: SettingsSection;
  readonly onSectionChange: (next: SettingsSection) => void;
  readonly onActivateAppearanceControl: (id: AppearanceFocusId) => void;
  readonly onFocusTopNav?: () => void;
}

/** Return value of {@link useTvSettingsNavigation}. */
export interface TvSettingsNavigationState {
  readonly pane: 'nav' | 'content';
  readonly ownsTvRemote: boolean;
  readonly focusedSection: SettingsSection | null;
  readonly focusedAppearanceId: AppearanceFocusId | null;
  readonly handleTvKey: (event: KeyEvent) => void;
  readonly enterContentPane: () => void;
  readonly returnToSidebar: () => void;
}

/**
 * Manages 10-foot TV D-pad focus across the Settings sidebar (`pane === 'nav'`), Appearance
 * control rows (`pane === 'content'` on `'appearance'`), and embedded Sources / Notices panes.
 */
export function useTvSettingsNavigation({
  isTv,
  isActiveScope,
  section,
  onSectionChange,
  onActivateAppearanceControl,
  onFocusTopNav,
}: UseTvSettingsNavigationOptions): TvSettingsNavigationState {
  const [pane, setPane] = useState<'nav' | 'content'>(() =>
    isActiveScope && section === 'sources' ? 'content' : 'nav',
  );
  const [appearanceRow, setAppearanceRow] = useState(0);
  const [appearanceCol, setAppearanceCol] = useState(0);

  const storeRef = useRef<FocusStore | null>(null);
  if (storeRef.current === null) {
    storeRef.current = createSettingsFocusStore(section);
  }
  const store = storeRef.current;

  const paneRef = useRef(pane);
  paneRef.current = pane;
  const sectionRef = useRef(section);
  sectionRef.current = section;
  const rowRef = useRef(appearanceRow);
  rowRef.current = appearanceRow;
  const onSectionChangeRef = useRef(onSectionChange);
  onSectionChangeRef.current = onSectionChange;
  const onActivateRef = useRef(onActivateAppearanceControl);
  onActivateRef.current = onActivateAppearanceControl;
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
    if (sectionRef.current === 'appearance') {
      const targetRow = rowRef.current;
      const listId = rowListId(targetRow);
      store.activate(listId);
      const found = findList(store.getState().scopes, listId);
      setAppearanceCol(found?.list.index ?? 0);
    }
  }, [store]);

  const returnToSidebar = useCallback(() => {
    setPane('nav');
    const idx = SETTINGS_SECTIONS.indexOf(sectionRef.current);
    store.focus(NAV_LIST_ID, Math.max(0, idx));
  }, [store]);

  const handleTvKey = useCallback(
    (event: KeyEvent) => {
      if (paneRef.current === 'nav') {
        const idx = SETTINGS_SECTIONS.indexOf(sectionRef.current);
        store.focus(NAV_LIST_ID, Math.max(0, idx));
        if (event.kind === 'press' && event.key === 'right') {
          enterContentPane();
          return;
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
          } else if (intent.kind === 'back') {
            onFocusTopNavRef.current?.();
          } else if (intent.kind === 'select') {
            enterContentPane();
          }
        }
        return;
      }

      if (sectionRef.current !== 'appearance') {
        return;
      }

      const currentRow = rowRef.current;
      const activeListId = rowListId(currentRow);
      store.activate(activeListId);

      if ((event.kind === 'press' || event.kind === 'repeat') && event.key === 'up') {
        if (currentRow === 0) {
          onFocusTopNavRef.current?.();
          return;
        }
        const nextRow = currentRow - 1;
        const currentList = findList(store.getState().scopes, activeListId)?.list;
        const targetItems = APPEARANCE_ROWS[nextRow] ?? [];
        const nextCol = Math.min(currentList?.index ?? 0, Math.max(0, targetItems.length - 1));
        const nextListId = rowListId(nextRow);
        store.focus(nextListId, nextCol);
        setAppearanceRow(nextRow);
        setAppearanceCol(nextCol);
        return;
      }

      if ((event.kind === 'press' || event.kind === 'repeat') && event.key === 'down') {
        if (currentRow >= APPEARANCE_ROWS.length - 1) return;
        const nextRow = currentRow + 1;
        const currentList = findList(store.getState().scopes, activeListId)?.list;
        const targetItems = APPEARANCE_ROWS[nextRow] ?? [];
        const nextCol = Math.min(currentList?.index ?? 0, Math.max(0, targetItems.length - 1));
        const nextListId = rowListId(nextRow);
        store.focus(nextListId, nextCol);
        setAppearanceRow(nextRow);
        setAppearanceCol(nextCol);
        return;
      }

      const intents = store.dispatch(event);
      const updated = findList(store.getState().scopes, activeListId)?.list;
      const col = updated?.index ?? 0;
      setAppearanceCol(col);

      for (const intent of intents) {
        if (intent.kind === 'back') {
          returnToSidebar();
        } else if (intent.kind === 'edge' && intent.side === 'start' && event.key === 'left') {
          returnToSidebar();
        } else if (intent.kind === 'select') {
          const id = APPEARANCE_ROWS[currentRow]?.[col];
          if (id) onActivateRef.current(id);
        }
      }
    },
    [enterContentPane, returnToSidebar, store],
  );

  const ownsTvRemote = isTv && isActiveScope && (pane === 'nav' || section === 'appearance');
  const focusedSection = isTv && isActiveScope && pane === 'nav' ? section : null;
  const focusedAppearanceId =
    isTv && isActiveScope && pane === 'content' && section === 'appearance'
      ? (APPEARANCE_ROWS[appearanceRow]?.[appearanceCol] ?? null)
      : null;

  return {
    pane,
    ownsTvRemote,
    focusedSection,
    focusedAppearanceId,
    handleTvKey,
    enterContentPane,
    returnToSidebar,
  };
}
