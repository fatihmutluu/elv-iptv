import type { AppI18n } from '@elv/i18n';
import type { ReactElement } from 'react';
import type { NetworkFieldSharedProps } from './SourceNetworkEditor';
import { FieldInput } from './SourcesScreenParts';

/** Stalker / Ministra MAC portal form fields for `SourcesScreen` (`#29`). */
export function StalkerFormFields({
  portalUrl,
  macAddress,
  serialNumber,
  onChangePortalUrl,
  onChangeMacAddress,
  onChangeSerialNumber,
  tvFocusId,
  fieldShared,
  i18n,
}: {
  portalUrl: string;
  macAddress: string;
  serialNumber: string;
  onChangePortalUrl: (value: string) => void;
  onChangeMacAddress: (value: string) => void;
  onChangeSerialNumber: (value: string) => void;
  tvFocusId: string | undefined;
  fieldShared: NetworkFieldSharedProps;
  i18n: AppI18n;
}): ReactElement {
  return (
    <>
      <FieldInput
        {...fieldShared}
        focusId="input-portal-url"
        testID="sources-input-portal-url"
        label={i18n.t('sources.stalker.portalUrlLabel')}
        placeholder={i18n.t('sources.stalker.portalUrlPlaceholder')}
        value={portalUrl}
        onChangeText={onChangePortalUrl}
        tvFocused={tvFocusId === 'input-portal-url'}
      />
      <FieldInput
        {...fieldShared}
        focusId="input-mac-address"
        testID="sources-input-mac-address"
        label={i18n.t('sources.stalker.macLabel')}
        placeholder={i18n.t('sources.stalker.macPlaceholder')}
        value={macAddress}
        onChangeText={onChangeMacAddress}
        tvFocused={tvFocusId === 'input-mac-address'}
      />
      <FieldInput
        {...fieldShared}
        focusId="input-serial-number"
        testID="sources-input-serial-number"
        label={i18n.t('sources.stalker.serialLabel')}
        placeholder={i18n.t('sources.stalker.serialPlaceholder')}
        value={serialNumber}
        onChangeText={onChangeSerialNumber}
        tvFocused={tvFocusId === 'input-serial-number'}
      />
    </>
  );
}
