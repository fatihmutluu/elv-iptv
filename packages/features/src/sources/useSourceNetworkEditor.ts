import type { CatalogService, SourceRow } from '@elv/data';
import {
  type DnsFamilyPreference,
  sanitizeHeaderValue,
  type TransportSettings,
  validateHostOverride,
} from '@elv/domain';
import type { MessageId } from '@elv/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';

/** Reactive state and actions for the inline per-source network settings editor (`#172`). */
export interface SourceNetworkEditorState {
  readonly openSourceId: string | null;
  readonly dnsFamily: DnsFamilyPreference;
  readonly hostOverride: string;
  readonly userAgent: string;
  readonly streamUserAgent: string;
  readonly validationError: MessageId | null;
  readonly saving: boolean;
  readonly savedSourceId: string | null;
  toggleSource(source: SourceRow): void;
  openSource(source: SourceRow): void;
  setDnsFamily(family: DnsFamilyPreference): void;
  setHostOverride(raw: string): void;
  setUserAgent(raw: string): void;
  setStreamUserAgent(raw: string): void;
  save(source: SourceRow): Promise<void>;
  close(): void;
}

const SAVED_NOTICE_MS = 3_000;

/** Manages inline per-source DNS preference, host IP override, and User-Agent editing for {@link SavedSourcesPanel}. */
export function useSourceNetworkEditor({
  catalog,
  refreshSources,
}: {
  catalog: CatalogService;
  refreshSources: () => Promise<SourceRow[]>;
}): SourceNetworkEditorState {
  const [openSourceId, setOpenSourceId] = useState<string | null>(null);
  const [dnsFamily, setDnsFamilyState] = useState<DnsFamilyPreference>('system');
  const [hostOverride, setHostOverrideState] = useState('');
  const [userAgent, setUserAgentState] = useState('');
  const [streamUserAgent, setStreamUserAgentState] = useState('');
  const [validationError, setValidationError] = useState<MessageId | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedSourceId, setSavedSourceId] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const openSourceIdRef = useRef<string | null>(openSourceId);
  openSourceIdRef.current = openSourceId;
  const dnsFamilyRef = useRef<DnsFamilyPreference>(dnsFamily);
  dnsFamilyRef.current = dnsFamily;
  const hostOverrideRef = useRef(hostOverride);
  hostOverrideRef.current = hostOverride;
  const userAgentRef = useRef(userAgent);
  userAgentRef.current = userAgent;
  const streamUserAgentRef = useRef(streamUserAgent);
  streamUserAgentRef.current = streamUserAgent;
  const savingRef = useRef(false);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (savedTimerRef.current !== null) {
        clearTimeout(savedTimerRef.current);
        savedTimerRef.current = null;
      }
    };
  }, []);

  const clearSavedNotice = useCallback(() => {
    if (savedTimerRef.current !== null) {
      clearTimeout(savedTimerRef.current);
      savedTimerRef.current = null;
    }
    setSavedSourceId(null);
  }, []);

  const close = useCallback(() => {
    openSourceIdRef.current = null;
    setOpenSourceId(null);
    setValidationError(null);
    clearSavedNotice();
  }, [clearSavedNotice]);

  const openSource = useCallback(
    (source: SourceRow) => {
      clearSavedNotice();
      const initialDns = source.dnsFamily ?? 'system';
      const initialHost = source.hostOverride ?? '';
      const initialUa = source.userAgent ?? '';
      const initialStreamUa = source.streamUserAgent ?? '';
      openSourceIdRef.current = source.id;
      dnsFamilyRef.current = initialDns;
      hostOverrideRef.current = initialHost;
      userAgentRef.current = initialUa;
      streamUserAgentRef.current = initialStreamUa;
      setOpenSourceId(source.id);
      setDnsFamilyState(initialDns);
      setHostOverrideState(initialHost);
      setUserAgentState(initialUa);
      setStreamUserAgentState(initialStreamUa);
      setValidationError(null);
    },
    [clearSavedNotice],
  );

  const toggleSource = useCallback(
    (source: SourceRow) => {
      clearSavedNotice();
      if (openSourceIdRef.current === source.id) {
        openSourceIdRef.current = null;
        setOpenSourceId(null);
        setValidationError(null);
        return;
      }
      openSource(source);
    },
    [clearSavedNotice, openSource],
  );

  const setDnsFamily = useCallback(
    (family: DnsFamilyPreference) => {
      dnsFamilyRef.current = family;
      setDnsFamilyState(family);
      clearSavedNotice();
    },
    [clearSavedNotice],
  );

  const setHostOverride = useCallback(
    (raw: string) => {
      hostOverrideRef.current = raw;
      setHostOverrideState(raw);
      clearSavedNotice();
      const checked = validateHostOverride(raw);
      setValidationError(checked.ok ? null : 'sources.network.invalidHostOverride');
    },
    [clearSavedNotice],
  );

  const setUserAgent = useCallback(
    (raw: string) => {
      userAgentRef.current = raw;
      setUserAgentState(raw);
      clearSavedNotice();
    },
    [clearSavedNotice],
  );

  const setStreamUserAgent = useCallback(
    (raw: string) => {
      streamUserAgentRef.current = raw;
      setStreamUserAgentState(raw);
      clearSavedNotice();
    },
    [clearSavedNotice],
  );

  const save = useCallback(
    async (source: SourceRow): Promise<void> => {
      if (savingRef.current || catalog.updateSourceSettings === undefined) return;
      const checked = validateHostOverride(hostOverrideRef.current);
      if (!checked.ok) {
        setValidationError('sources.network.invalidHostOverride');
        return;
      }

      savingRef.current = true;
      setSaving(true);
      setValidationError(null);
      clearSavedNotice();
      try {
        const normalizedUa = sanitizeHeaderValue(userAgentRef.current);
        const normalizedStreamUa = sanitizeHeaderValue(streamUserAgentRef.current);
        const shouldSendUa = normalizedUa.length > 0 || (source.userAgent ?? '').length > 0;
        const shouldSendStreamUa =
          normalizedStreamUa.length > 0 || (source.streamUserAgent ?? '').length > 0;
        const transport: TransportSettings = {
          ...(source.allowLegacyTls !== undefined ? { allowLegacyTls: source.allowLegacyTls } : {}),
          dnsFamily: dnsFamilyRef.current,
          hostOverride: checked.value ?? '',
          ...(shouldSendUa ? { userAgent: normalizedUa } : {}),
          ...(shouldSendStreamUa ? { streamUserAgent: normalizedStreamUa } : {}),
        };
        const result = await catalog.updateSourceSettings(source.id, { transport });
        if (!mountedRef.current) return;
        if (result !== undefined && !result.ok) {
          setValidationError('sources.network.invalidHostOverride');
          return;
        }
        const normalizedHost = checked.value ?? '';
        hostOverrideRef.current = normalizedHost;
        setHostOverrideState(normalizedHost);
        userAgentRef.current = normalizedUa;
        setUserAgentState(normalizedUa);
        streamUserAgentRef.current = normalizedStreamUa;
        setStreamUserAgentState(normalizedStreamUa);
        await refreshSources();
        if (!mountedRef.current) return;
        setSavedSourceId(source.id);
        savedTimerRef.current = setTimeout(() => {
          savedTimerRef.current = null;
          if (mountedRef.current) setSavedSourceId(null);
        }, SAVED_NOTICE_MS);
      } finally {
        savingRef.current = false;
        if (mountedRef.current) setSaving(false);
      }
    },
    [catalog, clearSavedNotice, refreshSources],
  );

  return {
    openSourceId,
    dnsFamily,
    hostOverride,
    userAgent,
    streamUserAgent,
    validationError,
    saving,
    savedSourceId,
    toggleSource,
    openSource,
    setDnsFamily,
    setHostOverride,
    setUserAgent,
    setStreamUserAgent,
    save,
    close,
  };
}
