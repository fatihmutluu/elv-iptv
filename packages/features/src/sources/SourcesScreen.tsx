import type { CatalogService } from '@elv/data';
import {
  hexToRgba,
  Surface,
  TABULAR_NUMS_STYLE,
  TextEntryBoundary,
  TvFocusAnchor,
  useFormFactor,
  useI18n,
  useTheme,
  useViewport,
} from '@elv/ui-kit';
import type { ReactElement } from 'react';
import { ScrollView, Text, View } from 'react-native';
import type { PlaybackGuard } from '../ports/playback-guard';
import type { PickedPlaylistFile, SourceImportHost } from '../ports/source-import-host';
import { useRouteActive } from '../shared';
import { CategoryPickerPanel } from './CategoryPickerPanel';
import { SavedSourcesPanel } from './SavedSourcesPanel';
import { ActionButton, FieldInput } from './SourcesScreenParts';
import { sourcesStyles as styles } from './sources-styles';
import { useSourcesController } from './useSourcesController';
import { TvRemoteBridge, useTvSourcesNavigation } from './useTvSourcesNavigation';

/** Props of {@link SourcesScreen}. */
export interface SourcesScreenProps {
  catalog: CatalogService;
  playbackGuard?: PlaybackGuard;
  sourceImportHost?: SourceImportHost;
  externalRefreshToken?: number;
  onOpenMenu?: () => void;
  onBack?: () => void;
  onFocusTopNav?: () => void;
  isActiveScope?: boolean;
  /** When true, omits outer canvas background, duplicate brand header, and outer scroll padding for Settings embedding. */
  embedded?: boolean;
  /** Optional OS-launched local playlist file to stage into the M3U form (`#259`). */
  incomingLocalPlaylist?: PickedPlaylistFile | null;
  /** Called after {@link incomingLocalPlaylist} has been staged into the form (`#259`). */
  onConsumeIncomingLocalPlaylist?: () => void;
  /** Clock returning epoch milliseconds for deterministic expiry badges (defaults to `Date.now`). */
  now?: () => number;
}

function SourcesScreenBody(props: SourcesScreenProps): ReactElement {
  const formFactor = useFormFactor();
  const i18n = useI18n();
  const theme = useTheme();
  const viewport = useViewport();
  const isTv = formFactor === 'tv';
  const routeActive = useRouteActive();
  const isActiveScope = props.isActiveScope ?? true;
  const embedded = props.embedded ?? false;
  const twoColumn = formFactor !== 'phone';
  const ctrl = useSourcesController({
    ...props,
    defaultLocalPlaylistName: i18n.t('sources.localFileBadge'),
  });
  const tv = useTvSourcesNavigation({
    isTv: isTv && isActiveScope,
    ctrl,
    ...(props.onOpenMenu !== undefined ? { onOpenMenu: props.onOpenMenu } : {}),
    ...(props.onBack !== undefined ? { onBack: props.onBack } : {}),
    ...(props.onFocusTopNav !== undefined ? { onFocusTopNav: props.onFocusTopNav } : {}),
  });

  const rootBackground = embedded ? 'transparent' : theme.colors.bgCanvas;
  const padX = Math.max(isTv ? 48 : 16, viewport.overscan.x);
  const padY = Math.max(isTv ? 32 : 16, viewport.overscan.y);
  const standaloneScrollPadding = {
    paddingTop: Math.max(padY, viewport.safeArea.top),
    paddingBottom: Math.max(padY, viewport.safeArea.bottom),
    paddingLeft: Math.max(padX, viewport.safeArea.left),
    paddingRight: Math.max(padX, viewport.safeArea.right),
  };

  const fieldShared = {
    editingInputId: tv.editingInputId,
    onEndEditing: tv.handleEndEditing,
    onSubmit: () => !ctrl.submitting && void ctrl.submit(),
    registerRef: tv.registerRef,
    recordLayout: tv.recordLayout,
  };

  const errorBannerStyle = [
    styles.errorBox,
    {
      backgroundColor: hexToRgba(theme.colors.liveColor, 0.14),
      borderColor: theme.colors.liveColor,
      borderRadius: theme.radius.card,
    },
  ];

  return (
    <View style={[styles.root, { backgroundColor: rootBackground }]}>
      {isTv && isActiveScope ? (
        <>
          <TvFocusAnchor
            testID="sources-tv-focus-anchor"
            hasTVPreferredFocus={routeActive && isActiveScope}
          />
          <TvRemoteBridge
            store={tv.focusStore}
            controls={tv.controls}
            onSelectIndex={tv.handleSelectIndex}
            onBackIntent={tv.handleBackIntent}
            suppressTopNav={ctrl.categoryPicker !== null}
            {...(tv.onFocusTopNav !== undefined ? { onFocusTopNav: tv.onFocusTopNav } : {})}
          />
        </>
      ) : null}
      <ScrollView
        ref={tv.scrollRef}
        testID="sources-screen"
        {...(isTv ? { focusable: false } : {})}
        accessibilityLabel={i18n.t('sources.title')}
        style={[styles.root, { backgroundColor: rootBackground }]}
        contentContainerStyle={embedded ? styles.scrollContentEmbedded : standaloneScrollPadding}
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
          style={[styles.container, twoColumn && !embedded ? styles.containerWide : null]}
        >
          <View style={styles.headerRow}>
            <View style={styles.headerTitles}>
              {!embedded ? (
                <Text style={[theme.typography.caption, { color: theme.colors.textMuted }]}>
                  {i18n.t('app.title')}
                </Text>
              ) : null}
              <Text
                style={[
                  isTv ? theme.typography.display : theme.typography.h1,
                  { color: theme.colors.textPrimary },
                ]}
              >
                {i18n.t('sources.title')}
              </Text>
              <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>
                {i18n.t('sources.subtitle')}
              </Text>
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

          {ctrl.categoryPicker !== null ? (
            <CategoryPickerPanel
              sourceId={ctrl.categoryPicker.sourceId}
              sourceName={ctrl.categoryPicker.sourceName}
              categories={ctrl.categoryPicker.categories}
              selectedKeys={ctrl.categoryPicker.selectedKeys}
              loading={ctrl.categoryPicker.loading}
              saving={ctrl.categoryPicker.saving}
              error={ctrl.categoryPicker.error}
              i18n={i18n}
              tvFocusId={tv.tvFocusId}
              recordLayout={tv.recordLayout}
              onToggle={ctrl.toggleCategorySelection}
              onSelectAll={ctrl.selectAllCategories}
              onClearAll={ctrl.clearAllCategories}
              onConfirm={() => void ctrl.confirmCategorySelection()}
              onCancel={ctrl.closeCategoryPicker}
            />
          ) : (
            <View style={twoColumn ? styles.columnsRow : styles.columnsStack}>
              <Surface
                tone="surface"
                bordered
                rounded="modal"
                style={[styles.panel, twoColumn ? styles.panelHalf : null]}
              >
                <View style={styles.panelHeader}>
                  <Text style={[theme.typography.h2, { color: theme.colors.textPrimary }]}>
                    {i18n.t('sources.section.add')}
                  </Text>
                  <View
                    style={[
                      styles.segmentedWrap,
                      {
                        backgroundColor: theme.colors.bgCard,
                        borderColor: theme.colors.surfaceBorder,
                      },
                    ]}
                  >
                    <ActionButton
                      focusId="mode-xtream"
                      testID="sources-mode-xtream"
                      label={i18n.t('sources.mode.xtream')}
                      segment
                      active={ctrl.form.mode === 'xtream'}
                      tvFocused={tv.tvFocusId === 'mode-xtream'}
                      onPress={() => ctrl.setMode('xtream')}
                      recordLayout={tv.recordLayout}
                    />
                    <ActionButton
                      focusId="mode-m3u"
                      testID="sources-mode-m3u"
                      label={i18n.t('sources.mode.m3u')}
                      segment
                      active={ctrl.form.mode === 'm3u'}
                      tvFocused={tv.tvFocusId === 'mode-m3u'}
                      onPress={() => ctrl.setMode('m3u')}
                      recordLayout={tv.recordLayout}
                    />
                  </View>
                </View>

                <FieldInput
                  {...fieldShared}
                  focusId="input-name"
                  testID="sources-input-name"
                  label={i18n.t('sources.field.name')}
                  placeholder={i18n.t('sources.placeholder.name')}
                  value={ctrl.form.name}
                  onChangeText={(v) => ctrl.updateField('name', v)}
                  tvFocused={tv.tvFocusId === 'input-name'}
                />

                {ctrl.form.mode === 'xtream' ? (
                  <>
                    <FieldInput
                      {...fieldShared}
                      focusId="input-server"
                      testID="sources-input-server"
                      label={i18n.t('sources.field.server')}
                      placeholder={i18n.t('sources.placeholder.server')}
                      value={ctrl.form.server}
                      onChangeText={(v) => ctrl.updateField('server', v)}
                      tvFocused={tv.tvFocusId === 'input-server'}
                    />
                    <FieldInput
                      {...fieldShared}
                      focusId="input-username"
                      testID="sources-input-username"
                      label={i18n.t('sources.field.username')}
                      placeholder={i18n.t('sources.placeholder.username')}
                      value={ctrl.form.username}
                      onChangeText={(v) => ctrl.updateField('username', v)}
                      tvFocused={tv.tvFocusId === 'input-username'}
                    />
                    <FieldInput
                      {...fieldShared}
                      focusId="input-password"
                      testID="sources-input-password"
                      label={i18n.t('sources.field.password')}
                      placeholder={i18n.t('sources.placeholder.password')}
                      value={ctrl.form.password}
                      onChangeText={(v) => ctrl.updateField('password', v)}
                      tvFocused={tv.tvFocusId === 'input-password'}
                      secureTextEntry
                    />
                  </>
                ) : (
                  <>
                    <FieldInput
                      {...fieldShared}
                      focusId="input-playlist-url"
                      testID="sources-input-playlist-url"
                      label={i18n.t('sources.field.playlistUrl')}
                      placeholder={i18n.t('sources.placeholder.playlistUrl')}
                      value={ctrl.form.playlistUrl}
                      onChangeText={(v) => ctrl.updateField('playlistUrl', v)}
                      tvFocused={tv.tvFocusId === 'input-playlist-url'}
                    />
                    {ctrl.canPasteClipboard || ctrl.canPickLocalFile ? (
                      <View style={styles.row}>
                        {ctrl.canPasteClipboard ? (
                          <ActionButton
                            focusId="paste-clipboard"
                            testID="sources-paste-clipboard"
                            label={i18n.t('sources.pasteClipboard')}
                            tvFocused={tv.tvFocusId === 'paste-clipboard'}
                            onPress={() => void ctrl.pasteFromClipboard()}
                            recordLayout={tv.recordLayout}
                          />
                        ) : null}
                        {ctrl.canPickLocalFile ? (
                          <ActionButton
                            focusId="choose-local-file"
                            testID="sources-choose-local-file"
                            label={i18n.t('sources.chooseLocalFile')}
                            tvFocused={tv.tvFocusId === 'choose-local-file'}
                            onPress={() => void ctrl.pickLocalFile()}
                            recordLayout={tv.recordLayout}
                          />
                        ) : null}
                      </View>
                    ) : null}
                    {ctrl.clipboardNotice !== null ? (
                      <Text
                        testID="sources-clipboard-empty"
                        style={[theme.typography.caption, { color: theme.colors.textSecondary }]}
                      >
                        {i18n.t(ctrl.clipboardNotice)}
                      </Text>
                    ) : null}
                    {ctrl.form.localFile != null ? (
                      <View
                        style={[
                          styles.noticeBox,
                          {
                            backgroundColor: theme.colors.bgCard,
                            borderColor: theme.colors.surfaceBorder,
                            borderRadius: theme.radius.card,
                          },
                        ]}
                      >
                        <Text
                          testID="sources-local-file-selected"
                          style={[theme.typography.caption, { color: theme.colors.textPrimary }]}
                        >
                          {i18n.t('sources.localFileSelected', { name: ctrl.form.localFile.name })}
                        </Text>
                        <ActionButton
                          focusId="clear-local-file"
                          testID="sources-clear-local-file"
                          label={i18n.t('sources.clearLocalFile')}
                          tvFocused={tv.tvFocusId === 'clear-local-file'}
                          onPress={ctrl.clearLocalFile}
                          recordLayout={tv.recordLayout}
                        />
                      </View>
                    ) : null}
                    {ctrl.detectedXtreamInM3u ? (
                      <View
                        style={[
                          styles.noticeBox,
                          {
                            backgroundColor: theme.colors.accentTint,
                            borderColor: theme.colors.accent,
                            borderRadius: theme.radius.card,
                          },
                        ]}
                      >
                        <Text
                          testID="sources-xtream-detected-notice"
                          style={[theme.typography.body, { color: theme.colors.textPrimary }]}
                        >
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
                    {(
                      [
                        ['guideUrl', 'guide-url', 'guideUrl'],
                        ['userAgent', 'user-agent', 'userAgent'],
                        ['referer', 'referer', 'referer'],
                      ] as const
                    ).map(([field, slug, key]) => (
                      <FieldInput
                        key={field}
                        {...fieldShared}
                        focusId={`input-${slug}`}
                        testID={`sources-input-${slug}`}
                        label={i18n.t(`sources.field.${key}`)}
                        placeholder={i18n.t(`sources.placeholder.${key}`)}
                        value={ctrl.form[field]}
                        onChangeText={(v) => ctrl.updateField(field, v)}
                        tvFocused={tv.tvFocusId === `input-${slug}`}
                      />
                    ))}
                    <FieldInput
                      {...fieldShared}
                      focusId="input-xmltv-timezone"
                      testID="sources-input-xmltv-timezone"
                      label={i18n.t('sources.xmltvTimezoneLabel')}
                      placeholder={i18n.t('sources.xmltvTimezonePlaceholder')}
                      value={ctrl.form.xmltvTimezone ?? ''}
                      onChangeText={(v) => ctrl.updateField('xmltvTimezone', v)}
                      tvFocused={tv.tvFocusId === 'input-xmltv-timezone'}
                    />
                    <Text style={[theme.typography.caption, { color: theme.colors.textMuted }]}>
                      {i18n.t('sources.xmltvTimezoneHint')}
                    </Text>
                    <View style={styles.fieldGroup}>
                      <ActionButton
                        focusId="toggle-legacy-tls"
                        testID="sources-toggle-legacy-tls"
                        label={i18n.t('sources.allowLegacyTls')}
                        active={ctrl.form.allowLegacyTls === true}
                        tvFocused={tv.tvFocusId === 'toggle-legacy-tls'}
                        onPress={() =>
                          ctrl.updateField('allowLegacyTls', !(ctrl.form.allowLegacyTls === true))
                        }
                        recordLayout={tv.recordLayout}
                      />
                      <Text style={[theme.typography.caption, { color: theme.colors.textMuted }]}>
                        {i18n.t('sources.allowLegacyTlsDesc')}
                      </Text>
                    </View>
                    {ctrl.form.mode === 'xtream' ? (
                      <View style={styles.fieldGroup}>
                        <Text
                          style={[theme.typography.caption, { color: theme.colors.textSecondary }]}
                        >
                          {i18n.t('sources.field.xtreamFormat')}
                        </Text>
                        <View style={styles.row}>
                          {(['default', 'ts', 'm3u8'] as const).map((fmt) => (
                            <ActionButton
                              key={fmt}
                              focusId={`format-${fmt}`}
                              testID={`sources-format-${fmt}`}
                              label={i18n.t(`sources.format.${fmt}`)}
                              active={ctrl.form.xtreamFormat === fmt}
                              tvFocused={tv.tvFocusId === `format-${fmt}`}
                              onPress={() => ctrl.updateField('xtreamFormat', fmt)}
                              recordLayout={tv.recordLayout}
                            />
                          ))}
                        </View>
                      </View>
                    ) : null}
                  </View>
                ) : null}

                {ctrl.formError !== null ? (
                  <View style={errorBannerStyle}>
                    <Text
                      testID="sources-form-error"
                      style={[
                        theme.typography.caption,
                        styles.errorText,
                        { color: theme.colors.textPrimary },
                      ]}
                    >
                      {i18n.t(ctrl.formError.messageId)}
                    </Text>
                    {ctrl.formError.httpStatus !== undefined ? (
                      <Text
                        testID="sources-form-http-status"
                        style={[
                          theme.typography.caption,
                          TABULAR_NUMS_STYLE,
                          { color: theme.colors.textSecondary },
                        ]}
                      >
                        {i18n.t('source.error.httpStatus', { status: ctrl.formError.httpStatus })}
                      </Text>
                    ) : null}
                    <Text
                      testID="sources-form-hint"
                      style={[theme.typography.caption, { color: theme.colors.textSecondary }]}
                    >
                      {i18n.t(ctrl.formError.hintId)}
                    </Text>
                  </View>
                ) : null}

                <View style={styles.row}>
                  <ActionButton
                    focusId="submit"
                    testID="sources-submit"
                    label={
                      ctrl.submitting
                        ? i18n.t('sources.action.adding')
                        : i18n.t('sources.action.add')
                    }
                    disabled={ctrl.submitting}
                    primary
                    tvFocused={tv.tvFocusId === 'submit'}
                    onPress={() => void ctrl.submit()}
                    recordLayout={tv.recordLayout}
                  />
                  {ctrl.canChooseCategories ? (
                    <ActionButton
                      focusId="submit-choose-categories"
                      testID="sources-submit-choose-categories"
                      label={i18n.t('sources.chooseCategories')}
                      disabled={ctrl.submitting}
                      tvFocused={tv.tvFocusId === 'submit-choose-categories'}
                      onPress={() => void ctrl.submit({ chooseCategories: true })}
                      recordLayout={tv.recordLayout}
                    />
                  ) : null}
                </View>
              </Surface>

              <SavedSourcesPanel
                ctrl={ctrl}
                i18n={i18n}
                twoColumn={twoColumn}
                tvFocusId={tv.tvFocusId}
                recordLayout={tv.recordLayout}
                nowMs={(props.now ?? Date.now)()}
              />
            </View>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

/** Cinema Quietude cross-platform source management screen (#71). */
export function SourcesScreen(props: SourcesScreenProps): ReactElement {
  return (
    <TextEntryBoundary>
      <SourcesScreenBody {...props} />
    </TextEntryBoundary>
  );
}
