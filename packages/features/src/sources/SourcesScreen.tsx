import type { CatalogService } from '@elv/data';
import { TextEntryBoundary, useFormFactor, useI18n } from '@elv/ui-kit';
import type { ReactElement } from 'react';
import { ScrollView, Text, View } from 'react-native';
import type { PlaybackGuard } from '../ports/playback-guard';
import {
  ActionButton,
  FieldInput,
  SavedSourcesPanel,
  sourcesStyles as styles,
} from './SourcesScreenParts';
import { useSourcesController } from './useSourcesController';
import { TvRemoteBridge, useTvSourcesNavigation } from './useTvSourcesNavigation';

/** Props of {@link SourcesScreen}. */
export interface SourcesScreenProps {
  catalog: CatalogService;
  playbackGuard?: PlaybackGuard;
  externalRefreshToken?: number;
  onOpenMenu?: () => void;
  onBack?: () => void;
}

function SourcesScreenBody(props: SourcesScreenProps): ReactElement {
  const formFactor = useFormFactor();
  const i18n = useI18n();
  const isTv = formFactor === 'tv';
  const twoColumn = formFactor !== 'phone';
  const ctrl = useSourcesController(props);
  const tv = useTvSourcesNavigation({
    isTv,
    ctrl,
    ...(props.onOpenMenu !== undefined ? { onOpenMenu: props.onOpenMenu } : {}),
    ...(props.onBack !== undefined ? { onBack: props.onBack } : {}),
  });

  return (
    <View style={styles.root}>
      {isTv ? (
        <>
          <View
            testID="sources-tv-focus-anchor"
            focusable
            hasTVPreferredFocus
            style={styles.tvFocusAnchor}
          />
          <TvRemoteBridge
            store={tv.focusStore}
            controls={tv.controls}
            onSelectIndex={tv.handleSelectIndex}
            onBackIntent={tv.handleBackIntent}
          />
        </>
      ) : null}
      <ScrollView
        ref={tv.scrollRef}
        testID="sources-screen"
        {...(isTv ? { focusable: false } : {})}
        accessibilityLabel={i18n.t('sources.title')}
        style={styles.root}
        contentContainerStyle={[styles.scrollContent, isTv ? styles.scrollContentTv : null]}
        onLayout={(e) => {
          tv.viewportHeightRef.current = e.nativeEvent.layout.height;
        }}
        onScroll={(e) => {
          tv.scrollYRef.current = e.nativeEvent.contentOffset.y;
        }}
        scrollEventThrottle={16}
      >
        <View
          ref={tv.contentRootRef}
          testID={`sources-layout-${formFactor}`}
          style={[styles.container, twoColumn ? styles.containerWide : null]}
        >
          <View style={styles.headerRow}>
            <View style={styles.headerTitles}>
              <Text style={styles.brand}>{i18n.t('app.title')}</Text>
              <Text style={[styles.title, isTv ? styles.titleTv : null]}>
                {i18n.t('sources.title')}
              </Text>
              <Text style={styles.subtitle}>{i18n.t('sources.subtitle')}</Text>
            </View>
            {props.onOpenMenu !== undefined ? (
              <ActionButton
                focusId="open-menu"
                testID="sources-open-menu"
                label={i18n.t('sources.openMenu')}
                onPress={props.onOpenMenu}
                tvFocused={tv.tvFocusId === 'open-menu'}
                recordLayout={tv.recordLayout}
              />
            ) : null}
          </View>

          <View style={twoColumn ? styles.columnsRow : styles.columnsStack}>
            <View style={[styles.panel, twoColumn ? styles.panelHalf : null]}>
              <Text style={styles.sectionTitle}>{i18n.t('sources.section.add')}</Text>
              <View style={styles.row}>
                <ActionButton
                  focusId="mode-xtream"
                  testID="sources-mode-xtream"
                  label={i18n.t('sources.mode.xtream')}
                  active={ctrl.form.mode === 'xtream'}
                  tvFocused={tv.tvFocusId === 'mode-xtream'}
                  onPress={() => ctrl.setMode('xtream')}
                  recordLayout={tv.recordLayout}
                />
                <ActionButton
                  focusId="mode-m3u"
                  testID="sources-mode-m3u"
                  label={i18n.t('sources.mode.m3u')}
                  active={ctrl.form.mode === 'm3u'}
                  tvFocused={tv.tvFocusId === 'mode-m3u'}
                  onPress={() => ctrl.setMode('m3u')}
                  recordLayout={tv.recordLayout}
                />
              </View>

              <FieldInput
                focusId="input-name"
                testID="sources-input-name"
                label={i18n.t('sources.field.name')}
                placeholder={i18n.t('sources.placeholder.name')}
                value={ctrl.form.name}
                onChangeText={(v) => ctrl.updateField('name', v)}
                tvFocused={tv.tvFocusId === 'input-name'}
                editingInputId={tv.editingInputId}
                onEndEditing={tv.handleEndEditing}
                registerRef={tv.registerRef}
                recordLayout={tv.recordLayout}
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
                    tvFocused={tv.tvFocusId === 'input-server'}
                    editingInputId={tv.editingInputId}
                    onEndEditing={tv.handleEndEditing}
                    registerRef={tv.registerRef}
                    recordLayout={tv.recordLayout}
                  />
                  <FieldInput
                    focusId="input-username"
                    testID="sources-input-username"
                    label={i18n.t('sources.field.username')}
                    placeholder={i18n.t('sources.placeholder.username')}
                    value={ctrl.form.username}
                    onChangeText={(v) => ctrl.updateField('username', v)}
                    tvFocused={tv.tvFocusId === 'input-username'}
                    editingInputId={tv.editingInputId}
                    onEndEditing={tv.handleEndEditing}
                    registerRef={tv.registerRef}
                    recordLayout={tv.recordLayout}
                  />
                  <FieldInput
                    focusId="input-password"
                    testID="sources-input-password"
                    label={i18n.t('sources.field.password')}
                    placeholder={i18n.t('sources.placeholder.password')}
                    value={ctrl.form.password}
                    onChangeText={(v) => ctrl.updateField('password', v)}
                    tvFocused={tv.tvFocusId === 'input-password'}
                    editingInputId={tv.editingInputId}
                    onEndEditing={tv.handleEndEditing}
                    secureTextEntry
                    registerRef={tv.registerRef}
                    recordLayout={tv.recordLayout}
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
                    tvFocused={tv.tvFocusId === 'input-playlist-url'}
                    editingInputId={tv.editingInputId}
                    onEndEditing={tv.handleEndEditing}
                    registerRef={tv.registerRef}
                    recordLayout={tv.recordLayout}
                  />
                  {ctrl.detectedXtreamInM3u ? (
                    <View style={styles.noticeBox}>
                      <Text testID="sources-xtream-detected-notice" style={styles.noticeText}>
                        {i18n.t('sources.notice.xtreamDetected')}
                      </Text>
                      <ActionButton
                        focusId="toggle-keep-m3u"
                        testID="sources-toggle-keep-m3u"
                        label={i18n.t('sources.field.keepAsM3u')}
                        active={ctrl.form.keepAsM3u}
                        tvFocused={tv.tvFocusId === 'toggle-keep-m3u'}
                        onPress={() => ctrl.updateField('keepAsM3u', !ctrl.form.keepAsM3u)}
                        recordLayout={tv.recordLayout}
                      />
                    </View>
                  ) : null}
                </>
              )}

              <ActionButton
                focusId="toggle-advanced"
                testID="sources-toggle-advanced"
                label={
                  ctrl.showAdvanced
                    ? i18n.t('sources.action.toggleAdvancedHide')
                    : i18n.t('sources.action.toggleAdvancedShow')
                }
                tvFocused={tv.tvFocusId === 'toggle-advanced'}
                onPress={ctrl.toggleAdvanced}
                recordLayout={tv.recordLayout}
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
                    tvFocused={tv.tvFocusId === 'input-guide-url'}
                    editingInputId={tv.editingInputId}
                    onEndEditing={tv.handleEndEditing}
                    registerRef={tv.registerRef}
                    recordLayout={tv.recordLayout}
                  />
                  <FieldInput
                    focusId="input-user-agent"
                    testID="sources-input-user-agent"
                    label={i18n.t('sources.field.userAgent')}
                    placeholder={i18n.t('sources.placeholder.userAgent')}
                    value={ctrl.form.userAgent}
                    onChangeText={(v) => ctrl.updateField('userAgent', v)}
                    tvFocused={tv.tvFocusId === 'input-user-agent'}
                    editingInputId={tv.editingInputId}
                    onEndEditing={tv.handleEndEditing}
                    registerRef={tv.registerRef}
                    recordLayout={tv.recordLayout}
                  />
                  <FieldInput
                    focusId="input-referer"
                    testID="sources-input-referer"
                    label={i18n.t('sources.field.referer')}
                    placeholder={i18n.t('sources.placeholder.referer')}
                    value={ctrl.form.referer}
                    onChangeText={(v) => ctrl.updateField('referer', v)}
                    tvFocused={tv.tvFocusId === 'input-referer'}
                    editingInputId={tv.editingInputId}
                    onEndEditing={tv.handleEndEditing}
                    registerRef={tv.registerRef}
                    recordLayout={tv.recordLayout}
                  />
                  {ctrl.form.mode === 'xtream' ? (
                    <View style={styles.fieldGroup}>
                      <Text style={styles.fieldLabel}>{i18n.t('sources.field.xtreamFormat')}</Text>
                      <View style={styles.row}>
                        <ActionButton
                          focusId="format-default"
                          testID="sources-format-default"
                          label={i18n.t('sources.format.default')}
                          active={ctrl.form.xtreamFormat === 'default'}
                          tvFocused={tv.tvFocusId === 'format-default'}
                          onPress={() => ctrl.updateField('xtreamFormat', 'default')}
                          recordLayout={tv.recordLayout}
                        />
                        <ActionButton
                          focusId="format-ts"
                          testID="sources-format-ts"
                          label={i18n.t('sources.format.ts')}
                          active={ctrl.form.xtreamFormat === 'ts'}
                          tvFocused={tv.tvFocusId === 'format-ts'}
                          onPress={() => ctrl.updateField('xtreamFormat', 'ts')}
                          recordLayout={tv.recordLayout}
                        />
                        <ActionButton
                          focusId="format-m3u8"
                          testID="sources-format-m3u8"
                          label={i18n.t('sources.format.m3u8')}
                          active={ctrl.form.xtreamFormat === 'm3u8'}
                          tvFocused={tv.tvFocusId === 'format-m3u8'}
                          onPress={() => ctrl.updateField('xtreamFormat', 'm3u8')}
                          recordLayout={tv.recordLayout}
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
                focusId="submit"
                testID="sources-submit"
                label={
                  ctrl.submitting ? i18n.t('sources.action.adding') : i18n.t('sources.action.add')
                }
                disabled={ctrl.submitting}
                active
                tvFocused={tv.tvFocusId === 'submit'}
                onPress={() => void ctrl.submit()}
                recordLayout={tv.recordLayout}
              />
            </View>

            <SavedSourcesPanel
              ctrl={ctrl}
              i18n={i18n}
              twoColumn={twoColumn}
              tvFocusId={tv.tvFocusId}
              recordLayout={tv.recordLayout}
            />
          </View>
        </View>
      </ScrollView>
    </View>
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
