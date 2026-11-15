import type { CatalogService } from '@elv/data';
import { createFocusStore, type FocusStore, findList } from '@elv/focus-core';
import {
  TextEntryBoundary,
  type TvTextInputInstance,
  useFormFactor,
  useI18n,
  useKeyInterpreter,
} from '@elv/ui-kit';
import {
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
import { ScrollView, Text, View } from 'react-native';
import type { PlaybackGuard } from '../ports/playback-guard';
import {
  ActionButton,
  buildSourcesFocusItems,
  FieldInput,
  SavedSourcesPanel,
  sourcesStyles as styles,
} from './SourcesScreenParts';
import { useSourcesController } from './useSourcesController';

/** Props of {@link SourcesScreen}. */
export interface SourcesScreenProps {
  catalog: CatalogService;
  playbackGuard?: PlaybackGuard;
  externalRefreshToken?: number;
  onOpenMenu?: () => void;
}

const CONTROLS_LIST_ID = 'sources-controls';

function TvRemoteBridge({
  store,
  onSelectIndex,
}: {
  store: FocusStore;
  onSelectIndex: (index: number) => void;
}): null {
  const selectRef = useRef(onSelectIndex);
  selectRef.current = onSelectIndex;

  useKeyInterpreter((event) => {
    const intents = store.dispatch(event);
    for (const intent of intents) {
      if (intent.kind === 'select' && intent.listId === CONTROLS_LIST_ID) {
        selectRef.current(intent.index);
      }
    }
  });

  return null;
}

function SourcesScreenBody(props: SourcesScreenProps): ReactElement {
  const formFactor = useFormFactor();
  const i18n = useI18n();
  const isTv = formFactor === 'tv';
  const twoColumn = formFactor !== 'phone';
  const ctrl = useSourcesController(props);
  const inputRefs = useRef<Map<string, TvTextInputInstance>>(new Map());

  const registerRef = useCallback((id: string, node: TvTextInputInstance | null) => {
    if (node === null) inputRefs.current.delete(id);
    else inputRefs.current.set(id, node);
  }, []);

  const controls = useMemo(
    () => buildSourcesFocusItems(ctrl, props.onOpenMenu),
    [ctrl, props.onOpenMenu],
  );

  const focusStore = useMemo(
    () =>
      createFocusStore({
        id: 'sources-scope',
        lists: [
          {
            id: CONTROLS_LIST_ID,
            count: 1,
            index: 0,
            orientation: 'vertical',
            pageSize: 5,
          },
        ],
        active: CONTROLS_LIST_ID,
      }),
    [],
  );

  useEffect(() => {
    focusStore.setCount(CONTROLS_LIST_ID, controls.length);
  }, [controls.length, focusStore]);

  const focusedIndex = useSyncExternalStore(
    focusStore.subscribe,
    () => findList(focusStore.getState().scopes, CONTROLS_LIST_ID)?.list.index ?? 0,
    () => 0,
  );

  const tvFocusId = isTv ? controls[focusedIndex]?.id : undefined;

  const handleSelectIndex = useCallback(
    (index: number) => {
      const target = controls[index];
      if (target === undefined) return;
      if (target.kind === 'action') {
        target.run();
      } else {
        inputRefs.current.get(target.id)?.focus();
      }
    },
    [controls],
  );

  return (
    <ScrollView
      testID="sources-screen"
      accessibilityLabel={i18n.t('sources.title')}
      style={styles.root}
      contentContainerStyle={[styles.scrollContent, isTv ? styles.scrollContentTv : null]}
    >
      {isTv ? <TvRemoteBridge store={focusStore} onSelectIndex={handleSelectIndex} /> : null}
      <View
        testID={`sources-layout-${formFactor}`}
        style={[styles.container, twoColumn ? styles.containerWide : null]}
      >
        <View style={styles.headerRow}>
          <View style={styles.headerTitles}>
            <Text style={[styles.title, isTv ? styles.titleTv : null]}>
              {i18n.t('sources.title')}
            </Text>
            <Text style={styles.subtitle}>{i18n.t('sources.subtitle')}</Text>
          </View>
          {props.onOpenMenu !== undefined ? (
            <ActionButton
              testID="sources-open-menu"
              label={i18n.t('sources.openMenu')}
              onPress={props.onOpenMenu}
              tvFocused={tvFocusId === 'open-menu'}
            />
          ) : null}
        </View>

        <View style={twoColumn ? styles.columnsRow : styles.columnsStack}>
          <View style={[styles.panel, twoColumn ? styles.panelHalf : null]}>
            <Text style={styles.sectionTitle}>{i18n.t('sources.section.add')}</Text>
            <View style={styles.row}>
              <ActionButton
                testID="sources-mode-xtream"
                label={i18n.t('sources.mode.xtream')}
                active={ctrl.form.mode === 'xtream'}
                tvFocused={tvFocusId === 'mode-xtream'}
                onPress={() => ctrl.setMode('xtream')}
              />
              <ActionButton
                testID="sources-mode-m3u"
                label={i18n.t('sources.mode.m3u')}
                active={ctrl.form.mode === 'm3u'}
                tvFocused={tvFocusId === 'mode-m3u'}
                onPress={() => ctrl.setMode('m3u')}
              />
            </View>

            <FieldInput
              focusId="input-name"
              testID="sources-input-name"
              label={i18n.t('sources.field.name')}
              placeholder={i18n.t('sources.placeholder.name')}
              value={ctrl.form.name}
              onChangeText={(v) => ctrl.updateField('name', v)}
              tvFocused={tvFocusId === 'input-name'}
              registerRef={registerRef}
            />

            {ctrl.form.mode === 'xtream' ? (
              <>
                <FieldInput
                  focusId="input-server"
                  testID="sources-input-server"
                  label={i18n.t('sources.field.server')}
                  placeholder={i18n.t('sources.placeholder.server')}
                  value={ctrl.form.server}
                  onChangeText={(v) => ctrl.updateField('server', v)}
                  tvFocused={tvFocusId === 'input-server'}
                  registerRef={registerRef}
                />
                <FieldInput
                  focusId="input-username"
                  testID="sources-input-username"
                  label={i18n.t('sources.field.username')}
                  placeholder={i18n.t('sources.placeholder.username')}
                  value={ctrl.form.username}
                  onChangeText={(v) => ctrl.updateField('username', v)}
                  tvFocused={tvFocusId === 'input-username'}
                  registerRef={registerRef}
                />
                <FieldInput
                  focusId="input-password"
                  testID="sources-input-password"
                  label={i18n.t('sources.field.password')}
                  placeholder={i18n.t('sources.placeholder.password')}
                  value={ctrl.form.password}
                  onChangeText={(v) => ctrl.updateField('password', v)}
                  tvFocused={tvFocusId === 'input-password'}
                  secureTextEntry
                  registerRef={registerRef}
                />
              </>
            ) : (
              <>
                <FieldInput
                  focusId="input-playlist-url"
                  testID="sources-input-playlist-url"
                  label={i18n.t('sources.field.playlistUrl')}
                  placeholder={i18n.t('sources.placeholder.playlistUrl')}
                  value={ctrl.form.playlistUrl}
                  onChangeText={(v) => ctrl.updateField('playlistUrl', v)}
                  tvFocused={tvFocusId === 'input-playlist-url'}
                  registerRef={registerRef}
                />
                {ctrl.detectedXtreamInM3u ? (
                  <View style={styles.noticeBox}>
                    <Text testID="sources-xtream-detected-notice" style={styles.noticeText}>
                      {i18n.t('sources.notice.xtreamDetected')}
                    </Text>
                    <ActionButton
                      testID="sources-toggle-keep-m3u"
                      label={i18n.t('sources.field.keepAsM3u')}
                      active={ctrl.form.keepAsM3u}
                      tvFocused={tvFocusId === 'toggle-keep-m3u'}
                      onPress={() => ctrl.updateField('keepAsM3u', !ctrl.form.keepAsM3u)}
                    />
                  </View>
                ) : null}
              </>
            )}

            <ActionButton
              testID="sources-toggle-advanced"
              label={
                ctrl.showAdvanced
                  ? i18n.t('sources.action.toggleAdvancedHide')
                  : i18n.t('sources.action.toggleAdvancedShow')
              }
              tvFocused={tvFocusId === 'toggle-advanced'}
              onPress={ctrl.toggleAdvanced}
            />

            {ctrl.showAdvanced ? (
              <View style={styles.advancedSection}>
                <FieldInput
                  focusId="input-guide-url"
                  testID="sources-input-guide-url"
                  label={i18n.t('sources.field.guideUrl')}
                  placeholder={i18n.t('sources.placeholder.guideUrl')}
                  value={ctrl.form.guideUrl}
                  onChangeText={(v) => ctrl.updateField('guideUrl', v)}
                  tvFocused={tvFocusId === 'input-guide-url'}
                  registerRef={registerRef}
                />
                <FieldInput
                  focusId="input-user-agent"
                  testID="sources-input-user-agent"
                  label={i18n.t('sources.field.userAgent')}
                  placeholder={i18n.t('sources.placeholder.userAgent')}
                  value={ctrl.form.userAgent}
                  onChangeText={(v) => ctrl.updateField('userAgent', v)}
                  tvFocused={tvFocusId === 'input-user-agent'}
                  registerRef={registerRef}
                />
                <FieldInput
                  focusId="input-referer"
                  testID="sources-input-referer"
                  label={i18n.t('sources.field.referer')}
                  placeholder={i18n.t('sources.placeholder.referer')}
                  value={ctrl.form.referer}
                  onChangeText={(v) => ctrl.updateField('referer', v)}
                  tvFocused={tvFocusId === 'input-referer'}
                  registerRef={registerRef}
                />
                {ctrl.form.mode === 'xtream' ? (
                  <View style={styles.fieldGroup}>
                    <Text style={styles.fieldLabel}>{i18n.t('sources.field.xtreamFormat')}</Text>
                    <View style={styles.row}>
                      <ActionButton
                        testID="sources-format-default"
                        label={i18n.t('sources.format.default')}
                        active={ctrl.form.xtreamFormat === 'default'}
                        tvFocused={tvFocusId === 'format-default'}
                        onPress={() => ctrl.updateField('xtreamFormat', 'default')}
                      />
                      <ActionButton
                        testID="sources-format-ts"
                        label={i18n.t('sources.format.ts')}
                        active={ctrl.form.xtreamFormat === 'ts'}
                        tvFocused={tvFocusId === 'format-ts'}
                        onPress={() => ctrl.updateField('xtreamFormat', 'ts')}
                      />
                      <ActionButton
                        testID="sources-format-m3u8"
                        label={i18n.t('sources.format.m3u8')}
                        active={ctrl.form.xtreamFormat === 'm3u8'}
                        tvFocused={tvFocusId === 'format-m3u8'}
                        onPress={() => ctrl.updateField('xtreamFormat', 'm3u8')}
                      />
                    </View>
                  </View>
                ) : null}
              </View>
            ) : null}

            {ctrl.formError !== null ? (
              <View style={styles.errorBox}>
                <Text testID="sources-form-error" style={styles.errorText}>
                  {i18n.t(ctrl.formError.messageId)}
                </Text>
                <Text testID="sources-form-hint" style={styles.hintText}>
                  {i18n.t(ctrl.formError.hintId)}
                </Text>
              </View>
            ) : null}

            <ActionButton
              testID="sources-submit"
              label={
                ctrl.submitting ? i18n.t('sources.action.adding') : i18n.t('sources.action.add')
              }
              disabled={ctrl.submitting}
              active
              tvFocused={tvFocusId === 'submit'}
              onPress={() => void ctrl.submit()}
            />
          </View>

          <SavedSourcesPanel ctrl={ctrl} i18n={i18n} twoColumn={twoColumn} tvFocusId={tvFocusId} />
        </View>
      </View>
    </ScrollView>
  );
}

/** Plain, zero-chrome cross-platform source management screen (#71). */
export function SourcesScreen(props: SourcesScreenProps): ReactElement {
  return (
    <TextEntryBoundary>
      <SourcesScreenBody {...props} />
    </TextEntryBoundary>
  );
}
