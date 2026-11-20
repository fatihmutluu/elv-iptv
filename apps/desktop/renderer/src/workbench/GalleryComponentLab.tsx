import {
  AdaptiveSheet,
  CtaButton,
  ErrorBoundary,
  ICON_NAMES,
  Icon,
  MicroPill,
  Surface,
  TABULAR_NUMS_STYLE,
  useTheme,
  useViewport,
} from '@elv/ui-kit';
import { type ReactElement, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

/** Localized Cinema Quietude showcase copy for TR and EN locales. */
export function getGalleryCopy(locale: string) {
  const isTr = locale === 'tr';
  return {
    isTr,
    home: isTr ? 'Ana Sayfa' : 'Home',
    search: isTr ? 'Ara' : 'Search',
    settings: isTr ? 'Ayarlar' : 'Settings',
    moreInfo: isTr ? 'Detaylar' : 'More Info',
    seeAll: isTr ? 'Tümü ›' : 'See All ›',
    continueWatching: isTr ? 'İzlemeye Devam Et' : 'Continue Watching',
    featured: isTr ? 'Öne Çıkanlar' : 'Featured',
    myList: isTr ? 'Listem' : 'My List',
    close: isTr ? 'Kapat' : 'Close',
  };
}

function CrashTrigger({ explode }: { explode: boolean }): ReactElement {
  const theme = useTheme();
  if (explode) throw new Error('Simulated Workbench error');
  return (
    <Text style={[theme.typography.body, { color: theme.colors.textPrimary }]}>
      Healthy child subtree
    </Text>
  );
}

/** Preview sheet exercising {@link AdaptiveSheet} across Portrait bottom-sheet and Landscape popover modes. */
export function GalleryPreviewSheet({
  visible,
  title,
  closeLabel,
  onDismiss,
}: {
  visible: boolean;
  title: string;
  closeLabel: string;
  onDismiss: () => void;
}): ReactElement {
  const theme = useTheme();
  const viewport = useViewport();
  return (
    <AdaptiveSheet visible={visible} title={title} onDismiss={onDismiss}>
      <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>
        {viewport.orientation === 'portrait'
          ? 'Portrait viewport: inset bottom sheet with grab handle.'
          : 'Landscape viewport: right-anchored 300px frosted popover.'}
      </Text>
      <Text
        style={[
          theme.typography.caption,
          TABULAR_NUMS_STYLE,
          { color: theme.colors.textMuted, marginTop: theme.spacing.xs },
        ]}
      >
        {`${viewport.formFactor.toUpperCase()} · ${viewport.orientation} · ${viewport.inputModality} · ${viewport.width}×${viewport.height}`}
      </Text>
      <View style={{ marginTop: theme.spacing.md }}>
        <CtaButton label={closeLabel} variant="secondary" onPress={onDismiss} />
      </View>
    </AdaptiveSheet>
  );
}

/** Quiet Cinema Quietude rail heading with optional right-aligned `"See All ›"` action. */
export function GallerySectionHeader({
  title,
  actionLabel,
  onAction,
}: {
  title: string;
  actionLabel?: string;
  onAction?: () => void;
}): ReactElement {
  const theme = useTheme();
  return (
    <View style={styles.sectionHeader}>
      <Text numberOfLines={1} style={[theme.typography.h2, { color: theme.colors.textPrimary }]}>
        {title}
      </Text>
      {actionLabel ? (
        <Pressable onPress={onAction} style={styles.sectionLink}>
          <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
            {actionLabel}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * Collapsible Component Lab footer tucked below the Cinema Quietude showcase rails.
 * Houses the full `@elv/ui-kit` Icon Registry and interactive `ErrorBoundary` recovery demo.
 */
export function GalleryComponentLab(): ReactElement {
  const theme = useTheme();
  const [labOpen, setLabOpen] = useState(false);
  const [explode, setExplode] = useState(false);

  return (
    <Surface tone="surface" bordered rounded="modal" style={styles.labCard}>
      <Pressable onPress={() => setLabOpen((v) => !v)} style={styles.labToggle}>
        <View style={styles.labHeaderLeft}>
          <Icon name="layers" size={16} color={theme.colors.accent} />
          <Text style={[theme.typography.title, { color: theme.colors.textPrimary }]}>
            Component Lab
          </Text>
          <MicroPill label={`${ICON_NAMES.length} Icons · ErrorBoundary`} />
        </View>
        <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
          {labOpen ? 'Hide ▴' : 'Inspect ▾'}
        </Text>
      </Pressable>

      {labOpen ? (
        <View style={[styles.labBody, { borderTopColor: theme.colors.surfaceBorder }]}>
          <View style={styles.iconGrid}>
            {ICON_NAMES.map((name) => (
              <View key={name} style={styles.iconCell}>
                <Icon name={name} size={18} color={theme.colors.textPrimary} />
                <Text
                  numberOfLines={1}
                  style={[theme.typography.micro, { color: theme.colors.textMuted }]}
                >
                  {name}
                </Text>
              </View>
            ))}
          </View>

          <Surface tone="card" bordered rounded="card" style={{ padding: theme.spacing.sm }}>
            <ErrorBoundary onReset={() => setExplode(false)}>
              <View style={styles.crashRow}>
                <CrashTrigger explode={explode} />
                <CtaButton
                  label="Simulate Crash"
                  variant="secondary"
                  onPress={() => setExplode(true)}
                />
              </View>
            </ErrorBoundary>
          </Surface>
        </View>
      ) : null}
    </Surface>
  );
}

const styles = StyleSheet.create({
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  sectionLink: { paddingHorizontal: 6, paddingVertical: 4 },
  labCard: { overflow: 'hidden' },
  labToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 10,
  },
  labHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  labBody: {
    borderTopWidth: StyleSheet.hairlineWidth,
    padding: 12,
    gap: 12,
  },
  iconGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  iconCell: { width: 68, alignItems: 'center', gap: 4, paddingVertical: 6 },
  crashRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
});
