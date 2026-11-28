import type { SourceRow } from '@elv/data';
import type { DnsFamilyPreference } from '@elv/domain';
import type { AppI18n } from '@elv/i18n';
import { MicroPill, type TvTextInputInstance, useTheme } from '@elv/ui-kit';
import type { ReactElement } from 'react';
import { Text, View } from 'react-native';
import { ActionButton, FieldInput } from './SourcesScreenParts';
import { sourcesStyles } from './sources-styles';
import type { SourceNetworkEditorState } from './useSourceNetworkEditor';
import type { ControlLayoutRecorder } from './useTvSourcesNavigation';

const DNS_FAMILIES: readonly DnsFamilyPreference[] = ['system', 'ipv4', 'ipv6'];

/** Shared text-input wiring props forwarded to {@link FieldInput}. */
export interface NetworkFieldSharedProps {
  readonly editingInputId: string | null;
  readonly onEndEditing: (focusId: string) => void;
  readonly onSubmit?: () => void;
  readonly registerRef: (id: string, node: TvTextInputInstance | null) => void;
  readonly recordLayout?: ControlLayoutRecorder;
}

/** 3-button segmented control for per-source DNS IP family preference (`#172`). */
function DnsFamilySelector({
  value,
  onChange,
  focusIdPrefix,
  testIdPrefix,
  focusIdSuffix = '',
  testIdSuffix = '',
  tvFocusId,
  recordLayout,
  i18n,
}: {
  value: DnsFamilyPreference;
  onChange: (family: DnsFamilyPreference) => void;
  focusIdPrefix: string;
  testIdPrefix: string;
  focusIdSuffix?: string;
  testIdSuffix?: string;
  tvFocusId: string | undefined;
  recordLayout?: ControlLayoutRecorder;
  i18n: AppI18n;
}): ReactElement {
  const theme = useTheme();
  return (
    <View style={sourcesStyles.fieldGroup}>
      <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
        {i18n.t('sources.network.dnsFamilyLabel')}
      </Text>
      <View
        style={[
          sourcesStyles.segmentedWrap,
          {
            backgroundColor: theme.colors.bgCard,
            borderColor: theme.colors.surfaceBorder,
          },
        ]}
      >
        {DNS_FAMILIES.map((family) => {
          const focusId = `${focusIdPrefix}-${family}${focusIdSuffix}`;
          const testID = `${testIdPrefix}-${family}${testIdSuffix}`;
          return (
            <ActionButton
              key={family}
              focusId={focusId}
              testID={testID}
              label={i18n.t(`sources.network.dnsFamily.${family}`)}
              segment
              active={value === family}
              tvFocused={tvFocusId === focusId}
              onPress={() => onChange(family)}
              recordLayout={recordLayout}
            />
          );
        })}
      </View>
    </View>
  );
}

/** Advanced network fields embedded in the Add-Source form (`#172`, `#317`). */
export function AddSourceNetworkFields({
  mode,
  dnsFamily,
  hostOverride,
  backupServers,
  onChangeDnsFamily,
  onChangeHostOverride,
  onChangeBackupServers,
  tvFocusId,
  fieldShared,
  i18n,
}: {
  mode: 'xtream' | 'm3u' | 'stalker';
  dnsFamily: DnsFamilyPreference;
  hostOverride: string;
  backupServers: string;
  onChangeDnsFamily: (family: DnsFamilyPreference) => void;
  onChangeHostOverride: (value: string) => void;
  onChangeBackupServers: (value: string) => void;
  tvFocusId: string | undefined;
  fieldShared: NetworkFieldSharedProps;
  i18n: AppI18n;
}): ReactElement {
  const theme = useTheme();
  return (
    <>
      <DnsFamilySelector
        value={dnsFamily}
        onChange={onChangeDnsFamily}
        focusIdPrefix="dns-family"
        testIdPrefix="sources-dns-family"
        tvFocusId={tvFocusId}
        recordLayout={fieldShared.recordLayout}
        i18n={i18n}
      />
      <FieldInput
        {...fieldShared}
        focusId="input-host-override"
        testID="sources-input-host-override"
        label={i18n.t('sources.network.hostOverrideLabel')}
        placeholder={i18n.t('sources.network.hostOverridePlaceholder')}
        value={hostOverride}
        onChangeText={onChangeHostOverride}
        tvFocused={tvFocusId === 'input-host-override'}
      />
      <Text style={[theme.typography.caption, { color: theme.colors.textMuted }]}>
        {i18n.t('sources.network.hostOverrideHint')}
      </Text>
      {mode === 'xtream' ? (
        <FieldInput
          editingInputId={fieldShared.editingInputId}
          onEndEditing={fieldShared.onEndEditing}
          registerRef={fieldShared.registerRef}
          recordLayout={fieldShared.recordLayout}
          focusId="input-backup-servers"
          testID="sources-input-backup-servers"
          label={i18n.t('sources.network.backupServersLabel')}
          placeholder={i18n.t('sources.network.backupServersPlaceholder')}
          value={backupServers}
          onChangeText={onChangeBackupServers}
          tvFocused={tvFocusId === 'input-backup-servers'}
          multiline
        />
      ) : null}
    </>
  );
}

/** Subtle micro-pill displayed on a saved source card when custom network settings are active (`#172`). */
export function SourceNetworkBadge({
  source,
  i18n,
}: {
  source: SourceRow;
  i18n: AppI18n;
}): ReactElement | null {
  const hasDns = source.dnsFamily === 'ipv4' || source.dnsFamily === 'ipv6';
  const hasHost = source.hostOverride !== undefined && source.hostOverride.length > 0;
  if (!hasDns && !hasHost) return null;
  const label =
    source.dnsFamily === 'ipv4'
      ? i18n.t('sources.network.dnsFamily.ipv4')
      : source.dnsFamily === 'ipv6'
        ? i18n.t('sources.network.dnsFamily.ipv6')
        : i18n.t('sources.network.title');
  return (
    <MicroPill
      testID={`source-network-badge-${source.id}`}
      label={label}
      tone="accent"
      dot={false}
    />
  );
}

/** Inline Cinema Quietude per-source network settings editor inside a saved source card (`#172`). */
export function SourceNetworkEditor({
  source,
  editor,
  tvFocusId,
  fieldShared,
  i18n,
}: {
  source: SourceRow;
  editor: SourceNetworkEditorState;
  tvFocusId: string | undefined;
  fieldShared: NetworkFieldSharedProps;
  i18n: AppI18n;
}): ReactElement {
  const theme = useTheme();
  const hostFocusId = `source-network-host-${source.id}`;
  const userAgentFocusId = `source-network-user-agent-${source.id}`;
  const streamUserAgentFocusId = `source-network-stream-user-agent-${source.id}`;
  const saveFocusId = `source-network-save-${source.id}`;
  const isSaved = editor.savedSourceId === source.id;

  return (
    <View
      testID={`source-network-editor-${source.id}`}
      style={[
        sourcesStyles.networkEditorBox,
        {
          backgroundColor: theme.colors.bgCard,
          borderColor: theme.colors.surfaceBorder,
          borderRadius: theme.radius.card,
        },
      ]}
    >
      <DnsFamilySelector
        value={editor.dnsFamily}
        onChange={editor.setDnsFamily}
        focusIdPrefix="source-network-dns"
        testIdPrefix="source-network-dns"
        focusIdSuffix={`-${source.id}`}
        testIdSuffix={`-${source.id}`}
        tvFocusId={tvFocusId}
        recordLayout={fieldShared.recordLayout}
        i18n={i18n}
      />
      <FieldInput
        editingInputId={fieldShared.editingInputId}
        onEndEditing={fieldShared.onEndEditing}
        onSubmit={() => void editor.save(source)}
        registerRef={fieldShared.registerRef}
        recordLayout={fieldShared.recordLayout}
        focusId={hostFocusId}
        testID={`source-network-host-${source.id}`}
        label={i18n.t('sources.network.hostOverrideLabel')}
        placeholder={i18n.t('sources.network.hostOverridePlaceholder')}
        value={editor.hostOverride}
        onChangeText={editor.setHostOverride}
        tvFocused={tvFocusId === hostFocusId}
      />
      {editor.validationError !== null ? (
        <Text
          testID={`source-network-error-${source.id}`}
          style={[theme.typography.caption, { color: theme.colors.liveColor }]}
        >
          {i18n.t(editor.validationError)}
        </Text>
      ) : (
        <Text style={[theme.typography.caption, { color: theme.colors.textMuted }]}>
          {i18n.t('sources.network.hostOverrideHint')}
        </Text>
      )}
      <FieldInput
        editingInputId={fieldShared.editingInputId}
        onEndEditing={fieldShared.onEndEditing}
        onSubmit={() => void editor.save(source)}
        registerRef={fieldShared.registerRef}
        recordLayout={fieldShared.recordLayout}
        focusId={userAgentFocusId}
        testID={userAgentFocusId}
        label={i18n.t('sources.field.userAgent')}
        placeholder={i18n.t('sources.placeholder.userAgent')}
        value={editor.userAgent}
        onChangeText={editor.setUserAgent}
        tvFocused={tvFocusId === userAgentFocusId}
      />
      <FieldInput
        editingInputId={fieldShared.editingInputId}
        onEndEditing={fieldShared.onEndEditing}
        onSubmit={() => void editor.save(source)}
        registerRef={fieldShared.registerRef}
        recordLayout={fieldShared.recordLayout}
        focusId={streamUserAgentFocusId}
        testID={streamUserAgentFocusId}
        label={i18n.t('sources.field.streamUserAgent')}
        placeholder={i18n.t('sources.placeholder.streamUserAgent')}
        value={editor.streamUserAgent}
        onChangeText={editor.setStreamUserAgent}
        tvFocused={tvFocusId === streamUserAgentFocusId}
      />
      <Text
        testID={`source-network-stream-ua-hint-${source.id}`}
        style={[theme.typography.caption, { color: theme.colors.textMuted }]}
      >
        {i18n.t('sources.hint.streamUserAgent')}
      </Text>
      <View style={sourcesStyles.row}>
        <ActionButton
          focusId={saveFocusId}
          testID={`source-network-save-${source.id}`}
          label={i18n.t('sources.network.save')}
          primary
          disabled={editor.saving || editor.validationError !== null}
          tvFocused={tvFocusId === saveFocusId}
          onPress={() => void editor.save(source)}
          recordLayout={fieldShared.recordLayout}
        />
      </View>
      {isSaved ? (
        <Text
          testID={`source-network-saved-${source.id}`}
          style={[theme.typography.caption, { color: theme.colors.accent }]}
        >
          {i18n.t('sources.network.saved')}
        </Text>
      ) : null}
    </View>
  );
}
