import type { CatalogService, ItemRow, SourceRow } from '@elv/data';
import type { KeyEvent } from '@elv/focus-core';
import type { AppI18n } from '@elv/i18n';
import {
  Icon,
  IconButton,
  MicroPill,
  useKeyInterpreter,
  useTheme,
  webBackdropBlur,
  webCursorPointer,
} from '@elv/ui-kit';
import { type ReactElement, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { PlayableEntry } from '../ports/play-target';

const MAX_PICKER_ITEMS = 80;

/** Props of {@link MultiViewChannelPicker}. */
export interface MultiViewChannelPickerProps {
  readonly visible: boolean;
  readonly title: string;
  readonly catalog: Pick<CatalogService, 'categories' | 'items' | 'allSourcesItems'>;
  readonly sources: readonly SourceRow[];
  readonly excludeItemKeys: ReadonlySet<string>;
  readonly isTv: boolean;
  readonly i18n: AppI18n;
  readonly onSelect: (entry: PlayableEntry) => void;
  readonly onClose: () => void;
}

function itemRowToEntry(row: ItemRow): PlayableEntry {
  return {
    itemKey: row.key,
    sourceId: row.sourceId,
    title: row.name,
    kind: 'live',
    itemKind: 'live',
    ...(row.logo !== null ? { logo: row.logo } : {}),
  };
}

/**
 * Inline Cinema Quietude channel picker overlay for Multi-View (`#34`, `#221`):
 * zero RN `<Modal>`, full 2D TV D-pad & Web Escape navigation, with source badges so users can
 * easily pick channels from another source when a provider's connection limit is reached.
 */
export function MultiViewChannelPicker({
  visible,
  title,
  catalog,
  sources,
  excludeItemKeys,
  isTv,
  i18n,
  onSelect,
  onClose,
}: MultiViewChannelPickerProps): ReactElement | null {
  const theme = useTheme();
  const [rows, setRows] = useState<readonly ItemRow[]>([]);
  const [cursor, setCursor] = useState(0);
  const pointer = !isTv ? webCursorPointer() : undefined;

  const sourceNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of sources) map.set(s.id, s.name);
    return map;
  }, [sources]);

  useEffect(() => {
    if (!visible) return;
    let active = true;
    const load = async (): Promise<void> => {
      try {
        if (catalog.allSourcesItems !== undefined) {
          const all = await catalog.allSourcesItems('live', 0, MAX_PICKER_ITEMS);
          if (active) setRows(all);
          return;
        }
        const collected: ItemRow[] = [];
        for (const source of sources) {
          const cats = await catalog.categories(source.id, 'live');
          for (const cat of cats) {
            if (collected.length >= MAX_PICKER_ITEMS) break;
            const page = await catalog.items(cat.id, 0, MAX_PICKER_ITEMS - collected.length);
            collected.push(...page);
          }
          if (collected.length >= MAX_PICKER_ITEMS) break;
        }
        if (active) setRows(collected);
      } catch {
        if (active) setRows([]);
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [catalog, sources, visible]);

  const candidates = useMemo(
    () => rows.filter((row) => !excludeItemKeys.has(row.key)),
    [excludeItemKeys, rows],
  );

  const clampedCursor = Math.max(0, Math.min(Math.max(0, candidates.length - 1), cursor));
  const candidatesRef = useRef(candidates);
  candidatesRef.current = candidates;
  const cursorRef = useRef(clampedCursor);
  cursorRef.current = clampedCursor;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!visible || (Platform.OS as string) !== 'web') return;
    const onKeyDown = (event: { key?: string; preventDefault?: () => void }) => {
      if (event.key === 'Escape') {
        event.preventDefault?.();
        onCloseRef.current();
      }
    };
    const win = globalThis as unknown as {
      addEventListener?: (type: string, fn: (e: unknown) => void) => void;
      removeEventListener?: (type: string, fn: (e: unknown) => void) => void;
    };
    win.addEventListener?.('keydown', onKeyDown as (e: unknown) => void);
    return () => {
      win.removeEventListener?.('keydown', onKeyDown as (e: unknown) => void);
    };
  }, [visible]);

  useKeyInterpreter((event: KeyEvent) => {
    if (!visible) return false;
    if (event.kind === 'press' && event.key === 'back') {
      onCloseRef.current();
      return true;
    }
    if (
      (event.kind === 'press' || event.kind === 'repeat') &&
      (event.key === 'up' || event.key === 'down')
    ) {
      const len = candidatesRef.current.length;
      if (len > 0) {
        const delta = event.key === 'down' ? 1 : -1;
        setCursor((prev) => Math.max(0, Math.min(len - 1, prev + delta)));
      }
      return true;
    }
    if (event.kind === 'press' && event.key === 'select') {
      const chosen = candidatesRef.current[cursorRef.current];
      if (chosen !== undefined) onSelectRef.current(itemRowToEntry(chosen));
      return true;
    }
    return true;
  });

  if (!visible) return null;

  const showSourceBadge = sources.length > 1;

  return (
    <View
      testID="multiview-channel-picker"
      style={[styles.backdrop, { backgroundColor: theme.colors.overlayBackdrop }]}
    >
      <View
        style={[
          styles.panel,
          {
            backgroundColor: theme.colors.bgElevated,
            borderColor: theme.colors.glassBorder,
            borderRadius: theme.radius.modal,
          },
          webBackdropBlur(20),
        ]}
      >
        <View style={[styles.header, { borderBottomColor: theme.colors.surfaceBorder }]}>
          <Text
            numberOfLines={1}
            style={[theme.typography.h2, styles.flex1, { color: theme.colors.textPrimary }]}
          >
            {title}
          </Text>
          <IconButton
            testID="multiview-picker-close"
            icon="close"
            size={36}
            accessibilityLabel={i18n.t('player.close')}
            focusable={!isTv}
            onPress={onClose}
          />
        </View>

        <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
          {candidates.map((row, idx) => {
            const focused = isTv && idx === clampedCursor;
            const srcName = sourceNameById.get(row.sourceId);
            return (
              <Pressable
                key={row.key}
                testID={`multiview-picker-item-${idx}`}
                accessibilityRole="button"
                accessibilityLabel={row.name}
                focusable={!isTv}
                onPress={() => onSelect(itemRowToEntry(row))}
                style={[
                  styles.row,
                  pointer,
                  {
                    backgroundColor: focused ? theme.colors.focusFill : 'transparent',
                    borderColor: focused ? theme.colors.focusRingColor : theme.colors.surfaceBorder,
                    borderWidth: focused ? theme.focus.ringWidth : 0,
                    borderBottomWidth: focused ? theme.focus.ringWidth : StyleSheet.hairlineWidth,
                    borderRadius: focused ? theme.radius.button : 0,
                  },
                ]}
              >
                <Icon name="tv" size={16} color={theme.colors.textSecondary} />
                <Text
                  numberOfLines={1}
                  style={[
                    theme.typography.title,
                    styles.flex1,
                    { color: theme.colors.textPrimary },
                  ]}
                >
                  {row.name}
                </Text>
                {showSourceBadge && srcName !== undefined ? (
                  <MicroPill label={srcName} tone="neutral" />
                ) : null}
              </Pressable>
            );
          })}
          {candidates.length === 0 ? (
            <Text
              testID="multiview-picker-empty"
              style={[theme.typography.caption, styles.empty, { color: theme.colors.textMuted }]}
            >
              {i18n.t('live.emptyTitle')}
            </Text>
          ) : null}
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    zIndex: 60,
  },
  panel: {
    width: '100%',
    maxWidth: 460,
    maxHeight: '80%',
    borderWidth: 1,
    padding: 16,
    gap: 12,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  flex1: { flex: 1 },
  list: { maxHeight: 380 },
  listContent: { gap: 4 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 42,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  empty: {
    paddingVertical: 16,
    textAlign: 'center',
  },
});
