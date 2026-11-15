import type { SourceRow } from '@elv/data';
import type { AppI18n } from '@elv/i18n';
import { TvTextInput, type TvTextInputInstance } from '@elv/ui-kit';
import type { ReactElement } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  phaseMessageId,
  type SourceRuntimeStatus,
  type SourcesController,
} from './useSourcesController';

export function ActionButton({
  testID,
  label,
  onPress,
  tvFocused,
  active = false,
  danger = false,
  disabled = false,
}: {
  testID: string;
  label: string;
  onPress: () => void;
  tvFocused: boolean;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
}): ReactElement {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: tvFocused || active, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[
        sourcesStyles.button,
        active ? sourcesStyles.buttonActive : null,
        danger ? sourcesStyles.buttonDanger : null,
        tvFocused ? sourcesStyles.tvFocused : null,
        disabled ? sourcesStyles.buttonDisabled : null,
      ]}
    >
      <Text style={[sourcesStyles.buttonText, active ? sourcesStyles.buttonTextActive : null]}>
        {label}
      </Text>
    </Pressable>
  );
}

export function FieldInput({
  focusId,
  testID,
  label,
  placeholder,
  value,
  onChangeText,
  tvFocused,
  secureTextEntry = false,
  registerRef,
}: {
  focusId: string;
  testID: string;
  label: string;
  placeholder: string;
  value: string;
  onChangeText: (text: string) => void;
  tvFocused: boolean;
  secureTextEntry?: boolean;
  registerRef: (id: string, node: TvTextInputInstance | null) => void;
}): ReactElement {
  return (
    <View style={sourcesStyles.fieldGroup}>
      <Text style={sourcesStyles.fieldLabel}>{label}</Text>
      <View
        testID={`sources-focus-${focusId}`}
        accessibilityState={{ selected: tvFocused }}
        style={[sourcesStyles.inputFrame, tvFocused ? sourcesStyles.tvFocused : null]}
      >
        <TvTextInput
          ref={(node) => registerRef(focusId, node)}
          testID={testID}
          accessibilityLabel={label}
          placeholder={placeholder}
          placeholderTextColor="#6c6c78"
          value={value}
          onChangeText={onChangeText}
          secureTextEntry={secureTextEntry}
          autoCapitalize="none"
          autoCorrect={false}
          style={sourcesStyles.input}
        />
      </View>
    </View>
  );
}

type FocusItem =
  | { readonly id: string; readonly kind: 'action'; readonly run: () => void }
  | { readonly id: string; readonly kind: 'input' };

export function buildSourcesFocusItems(
  ctrl: SourcesController,
  onOpenMenu: (() => void) | undefined,
): readonly FocusItem[] {
  const items: FocusItem[] = [];
  if (onOpenMenu !== undefined) {
    items.push({ id: 'open-menu', kind: 'action', run: onOpenMenu });
  }
  items.push(
    { id: 'mode-xtream', kind: 'action', run: () => ctrl.setMode('xtream') },
    { id: 'mode-m3u', kind: 'action', run: () => ctrl.setMode('m3u') },
    { id: 'input-name', kind: 'input' },
  );
  if (ctrl.form.mode === 'xtream') {
    items.push(
      { id: 'input-server', kind: 'input' },
      { id: 'input-username', kind: 'input' },
      { id: 'input-password', kind: 'input' },
    );
  } else {
    items.push({ id: 'input-playlist-url', kind: 'input' });
    if (ctrl.detectedXtreamInM3u) {
      items.push({
        id: 'toggle-keep-m3u',
        kind: 'action',
        run: () => ctrl.updateField('keepAsM3u', !ctrl.form.keepAsM3u),
      });
    }
  }
  items.push({ id: 'toggle-advanced', kind: 'action', run: ctrl.toggleAdvanced });
  if (ctrl.showAdvanced) {
    items.push(
      { id: 'input-guide-url', kind: 'input' },
      { id: 'input-user-agent', kind: 'input' },
      { id: 'input-referer', kind: 'input' },
    );
    if (ctrl.form.mode === 'xtream') {
      items.push(
        {
          id: 'format-default',
          kind: 'action',
          run: () => ctrl.updateField('xtreamFormat', 'default'),
        },
        { id: 'format-ts', kind: 'action', run: () => ctrl.updateField('xtreamFormat', 'ts') },
        {
          id: 'format-m3u8',
          kind: 'action',
          run: () => ctrl.updateField('xtreamFormat', 'm3u8'),
        },
      );
    }
  }
  items.push({ id: 'submit', kind: 'action', run: () => void ctrl.submit() });
  for (const source of ctrl.sources) {
    const status = ctrl.statusById[source.id];
    if (status?.kind === 'importing') {
      items.push({
        id: `source-cancel-${source.id}`,
        kind: 'action',
        run: () => ctrl.cancelImport(source.id),
      });
    } else {
      items.push({
        id: `source-sync-${source.id}`,
        kind: 'action',
        run: () => void ctrl.runImport(source.id),
      });
    }
    items.push({
      id: `source-remove-${source.id}`,
      kind: 'action',
      run: () => void ctrl.remove(source.id),
    });
  }
  return items;
}

function renderSourceStatusText(
  source: SourceRow,
  runtime: SourceRuntimeStatus | undefined,
  i18n: AppI18n,
): string {
  if (runtime?.kind === 'importing') {
    if (runtime.progress === null) {
      return i18n.t('sources.status.importing', {
        phase: i18n.t('sources.phase.categories'),
        done: 0,
      });
    }
    const phase = i18n.t(phaseMessageId(runtime.progress.phase));
    if (runtime.progress.total !== undefined) {
      return i18n.t('sources.status.importingTotal', {
        phase,
        done: runtime.progress.done,
        total: runtime.progress.total,
      });
    }
    return i18n.t('sources.status.importing', { phase, done: runtime.progress.done });
  }
  if (runtime?.kind === 'ready') {
    return i18n.t('sources.status.readyCounts', {
      live: runtime.summary.counts.live ?? 0,
      movies: runtime.summary.counts.movies ?? 0,
      series: runtime.summary.counts.series ?? 0,
    });
  }
  return source.needsImport ? i18n.t('sources.status.needsImport') : i18n.t('sources.status.ready');
}

export function SavedSourcesPanel({
  ctrl,
  i18n,
  twoColumn,
  tvFocusId,
}: {
  ctrl: SourcesController;
  i18n: AppI18n;
  twoColumn: boolean;
  tvFocusId: string | undefined;
}): ReactElement {
  return (
    <View style={[sourcesStyles.panel, twoColumn ? sourcesStyles.panelHalf : null]}>
      <Text style={sourcesStyles.sectionTitle}>{i18n.t('sources.section.saved')}</Text>
      {ctrl.sources.length === 0 ? (
        <Text testID="sources-empty" style={sourcesStyles.emptyText}>
          {i18n.t('sources.emptyList')}
        </Text>
      ) : (
        ctrl.sources.map((source) => {
          const runtime = ctrl.statusById[source.id];
          const isImporting = runtime?.kind === 'importing';
          const syncTestId = source.needsImport
            ? `source-import-${source.id}`
            : `source-refresh-${source.id}`;
          const syncLabel = source.needsImport
            ? i18n.t('sources.action.import')
            : i18n.t('sources.action.refresh');
          const kindLabel =
            source.kind === 'xtream' ? i18n.t('sources.kind.xtream') : i18n.t('sources.kind.m3u');

          return (
            <View
              key={source.id}
              testID={`source-row-${source.id}`}
              style={sourcesStyles.sourceRow}
            >
              <View style={sourcesStyles.sourceHeader}>
                <Text style={sourcesStyles.sourceName}>{source.name}</Text>
                <Text style={sourcesStyles.sourceKind}>{kindLabel}</Text>
              </View>
              <Text testID={`source-status-${source.id}`} style={sourcesStyles.sourceStatus}>
                {renderSourceStatusText(source, runtime, i18n)}
              </Text>
              {runtime?.kind === 'error' ? (
                <View style={sourcesStyles.errorBox}>
                  <Text testID={`source-error-${source.id}`} style={sourcesStyles.errorText}>
                    {i18n.t(runtime.failure.messageId)}
                  </Text>
                  <Text testID={`source-hint-${source.id}`} style={sourcesStyles.hintText}>
                    {i18n.t(runtime.failure.hintId)}
                  </Text>
                </View>
              ) : null}
              <View style={sourcesStyles.row}>
                {isImporting ? (
                  <ActionButton
                    testID={`source-cancel-${source.id}`}
                    label={`${i18n.t('sources.action.cancel')} ${source.name}`}
                    tvFocused={tvFocusId === `source-cancel-${source.id}`}
                    onPress={() => ctrl.cancelImport(source.id)}
                  />
                ) : (
                  <ActionButton
                    testID={syncTestId}
                    label={`${syncLabel} ${source.name}`}
                    tvFocused={tvFocusId === `source-sync-${source.id}`}
                    onPress={() => void ctrl.runImport(source.id)}
                  />
                )}
                <ActionButton
                  testID={`source-remove-${source.id}`}
                  label={`${i18n.t('sources.action.remove')} ${source.name}`}
                  danger
                  tvFocused={tvFocusId === `source-remove-${source.id}`}
                  onPress={() => void ctrl.remove(source.id)}
                />
              </View>
            </View>
          );
        })
      )}
    </View>
  );
}

export const sourcesStyles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0a0a0c' },
  scrollContent: { padding: 16 },
  scrollContentTv: { paddingHorizontal: 48, paddingVertical: 32 },
  container: { gap: 16, width: '100%' },
  containerWide: { maxWidth: 1120, alignSelf: 'center' },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
  },
  headerTitles: { flex: 1, gap: 4 },
  title: { color: '#f4f4f6', fontSize: 22, fontWeight: '700' },
  titleTv: { fontSize: 28 },
  subtitle: { color: '#a0a0ab', fontSize: 15 },
  columnsRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 16 },
  columnsStack: { flexDirection: 'column', gap: 16 },
  panel: {
    backgroundColor: '#141418',
    borderColor: '#2a2a32',
    borderWidth: 1,
    borderRadius: 8,
    padding: 16,
    gap: 12,
  },
  panelHalf: { flex: 1 },
  sectionTitle: { color: '#f4f4f6', fontSize: 18, fontWeight: '600' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  fieldGroup: { gap: 6 },
  fieldLabel: { color: '#d4d4dc', fontSize: 14 },
  inputFrame: {
    backgroundColor: '#0e0e12',
    borderColor: '#34343e',
    borderWidth: 2,
    borderRadius: 6,
  },
  input: { color: '#f4f4f6', fontSize: 16, paddingHorizontal: 12, paddingVertical: 10 },
  button: {
    backgroundColor: '#1e1e26',
    borderColor: '#34343e',
    borderWidth: 2,
    borderRadius: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  buttonActive: { backgroundColor: '#2c2c38', borderColor: '#6e6e82' },
  buttonDanger: { borderColor: '#703030' },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#e4e4ec', fontSize: 15, fontWeight: '500' },
  buttonTextActive: { color: '#ffffff', fontWeight: '700' },
  tvFocused: { borderColor: '#ffffff' },
  advancedSection: { gap: 12 },
  noticeBox: {
    backgroundColor: '#181c24',
    borderColor: '#3a4a66',
    borderWidth: 1,
    borderRadius: 6,
    padding: 12,
    gap: 8,
  },
  noticeText: { color: '#d4e2ff', fontSize: 14 },
  errorBox: {
    backgroundColor: '#241416',
    borderColor: '#6e2c32',
    borderWidth: 1,
    borderRadius: 6,
    padding: 10,
    gap: 4,
  },
  errorText: { color: '#ff8a8a', fontSize: 14, fontWeight: '600' },
  hintText: { color: '#e0b8b8', fontSize: 13 },
  emptyText: { color: '#8c8c98', fontSize: 15 },
  sourceRow: {
    backgroundColor: '#0f0f14',
    borderColor: '#2a2a32',
    borderWidth: 1,
    borderRadius: 6,
    padding: 12,
    gap: 8,
  },
  sourceHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sourceName: { color: '#f4f4f6', fontSize: 16, fontWeight: '600' },
  sourceKind: { color: '#a0a0ab', fontSize: 13 },
  sourceStatus: { color: '#c8c8d4', fontSize: 14 },
});
