import {
  ArtworkImage,
  HorizontalRailScroll,
  useI18n,
  useTheme,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { memo, type ReactElement } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { DetailCastMember } from '../shared';

/** Props of {@link DetailCastStrip}. */
export interface DetailCastStripProps {
  readonly cast: readonly DetailCastMember[];
  readonly director?: string | null;
  readonly padX: number;
  readonly isTv?: boolean;
  readonly focusedIndex?: number | null;
  readonly onSearchPerson?: (name: string) => void;
}

function DetailCastStripInner({
  cast,
  director,
  padX,
  isTv = false,
  focusedIndex = null,
  onSearchPerson,
}: DetailCastStripProps): ReactElement | null {
  const theme = useTheme();
  const i18n = useI18n();
  const trimmedDirector = director?.trim() ?? '';
  const hasDirector = trimmedDirector.length > 0;
  if (cast.length === 0 && !hasDirector) return null;

  const cursor = webCursorPointer();
  const transition = webTransition(theme, 'transform, opacity, background-color');
  const directorFocused = isTv && hasDirector && focusedIndex === 0;
  const castOffset = hasDirector ? 1 : 0;

  return (
    <View testID="detail-cast" style={[styles.section, { marginTop: theme.spacing.lg }]}>
      <Text
        numberOfLines={1}
        style={[
          theme.typography.h2,
          {
            color: theme.colors.textPrimary,
            paddingHorizontal: padX,
            marginBottom: theme.spacing.sm,
          },
        ]}
      >
        {i18n.t('detail.cast')}
      </Text>

      {hasDirector ? (
        <View
          testID="detail-director-row"
          style={[styles.directorRow, { paddingHorizontal: padX, marginBottom: theme.spacing.sm }]}
        >
          <Text style={[theme.typography.caption, { color: theme.colors.textMuted }]}>
            {`${i18n.t('detail.director')}:`}
          </Text>
          <Pressable
            testID="detail-director-link"
            accessibilityRole="button"
            accessibilityLabel={i18n.t('detail.searchPerson', { name: trimmedDirector })}
            focusable={!isTv}
            onPress={() => onSearchPerson?.(trimmedDirector)}
            style={({ pressed }) => [
              styles.directorLink,
              cursor,
              transition,
              {
                borderRadius: theme.radius.button,
                backgroundColor: directorFocused ? theme.colors.focusFill : 'transparent',
                opacity: pressed ? 0.75 : 1,
              },
            ]}
          >
            <Text
              numberOfLines={1}
              style={[
                theme.typography.caption,
                { color: theme.colors.textPrimary, fontWeight: '600' },
              ]}
            >
              {trimmedDirector}
            </Text>
            {directorFocused ? (
              <View
                pointerEvents="none"
                testID="detail-director-link-focus-ring"
                style={[
                  styles.inlineFocusRing,
                  {
                    borderRadius: theme.radius.button,
                    borderWidth: theme.focus.ringWidth,
                    borderColor: theme.colors.focusRingColor,
                  },
                ]}
              />
            ) : null}
          </Pressable>
        </View>
      ) : null}

      {cast.length > 0 ? (
        <HorizontalRailScroll
          testID="detail-cast-strip"
          isTv={isTv}
          showArrows={!isTv}
          contentContainerStyle={[
            styles.strip,
            {
              paddingHorizontal: padX,
              paddingVertical: isTv ? 6 : 2,
              gap: theme.spacing.md,
            },
          ]}
        >
          {cast.map((member, idx) => {
            const focused = isTv && focusedIndex === castOffset + idx;
            return (
              <Pressable
                key={`${member.name}:${member.role ?? ''}:${member.avatarUri ?? ''}`}
                testID={`detail-cast-item-${idx}`}
                accessibilityRole="button"
                accessibilityLabel={i18n.t('detail.searchPerson', { name: member.name })}
                focusable={!isTv}
                onPress={() => onSearchPerson?.(member.name)}
                style={({ pressed }) => [
                  styles.card,
                  cursor,
                  transition,
                  {
                    opacity: pressed ? 0.78 : 1,
                    transform: [{ scale: focused ? theme.focus.buttonScale : 1 }],
                  },
                ]}
              >
                <View style={styles.avatarWrap}>
                  <ArtworkImage
                    uri={member.avatarUri}
                    label={member.name}
                    aspectRatio={1}
                    maxDecodePx={160}
                    borderRadius={theme.radius.pill}
                    style={styles.avatar}
                  />
                  {focused ? (
                    <View
                      pointerEvents="none"
                      testID={`detail-cast-item-${idx}-focus-ring`}
                      style={[
                        styles.avatarFocusRing,
                        {
                          borderRadius: theme.radius.pill,
                          borderWidth: theme.focus.ringWidth,
                          borderColor: theme.colors.focusRingColor,
                        },
                      ]}
                    />
                  ) : null}
                </View>
                <Text
                  numberOfLines={1}
                  style={[
                    theme.typography.caption,
                    { color: theme.colors.textPrimary, fontWeight: '600', marginTop: 6 },
                  ]}
                >
                  {member.name}
                </Text>
                {member.role ? (
                  <Text
                    numberOfLines={1}
                    style={[
                      theme.typography.micro,
                      { color: theme.colors.textMuted, marginTop: 2 },
                    ]}
                  >
                    {member.role}
                  </Text>
                ) : null}
              </Pressable>
            );
          })}
        </HorizontalRailScroll>
      ) : null}
    </View>
  );
}

/** Optional horizontal Cast & Director strip positioned directly below the Detail Hero (`#215`, `#398`). */
export const DetailCastStrip = memo(DetailCastStripInner);
DetailCastStrip.displayName = 'DetailCastStrip';

const styles = StyleSheet.create({
  section: { width: '100%' },
  directorRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  directorLink: { position: 'relative', paddingHorizontal: 6, paddingVertical: 2 },
  inlineFocusRing: { position: 'absolute', top: -2, bottom: -2, left: -2, right: -2 },
  strip: { alignItems: 'flex-start' },
  card: { width: 84, alignItems: 'center' },
  avatarWrap: { position: 'relative', width: 68, height: 68 },
  avatar: { width: 68, height: 68 },
  avatarFocusRing: { position: 'absolute', top: -3, bottom: -3, left: -3, right: -3 },
});
