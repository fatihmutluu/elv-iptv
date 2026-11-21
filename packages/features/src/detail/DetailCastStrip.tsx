import { ArtworkImage, HorizontalRailScroll, useI18n, useTheme } from '@elv/ui-kit';
import { memo, type ReactElement } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { DetailCastMember } from '../shared';

/** Props of {@link DetailCastStrip}. */
export interface DetailCastStripProps {
  readonly cast: readonly DetailCastMember[];
  readonly padX: number;
  readonly isTv?: boolean;
}

function DetailCastStripInner({
  cast,
  padX,
  isTv = false,
}: DetailCastStripProps): ReactElement | null {
  const theme = useTheme();
  const i18n = useI18n();
  if (cast.length === 0) return null;

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
      <HorizontalRailScroll
        testID="detail-cast-strip"
        isTv={isTv}
        showArrows={!isTv}
        contentContainerStyle={[styles.strip, { paddingHorizontal: padX, gap: theme.spacing.md }]}
      >
        {cast.map((member) => (
          <View
            key={`${member.name}:${member.role ?? ''}:${member.avatarUri ?? ''}`}
            style={styles.card}
          >
            <ArtworkImage
              uri={member.avatarUri}
              label={member.name}
              aspectRatio={1}
              maxDecodePx={160}
              borderRadius={theme.radius.pill}
              style={styles.avatar}
            />
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
                style={[theme.typography.micro, { color: theme.colors.textMuted, marginTop: 2 }]}
              >
                {member.role}
              </Text>
            ) : null}
          </View>
        ))}
      </HorizontalRailScroll>
    </View>
  );
}

/** Optional horizontal Cast strip positioned directly below the Detail Hero (`#215` ready). */
export const DetailCastStrip = memo(DetailCastStripInner);
DetailCastStrip.displayName = 'DetailCastStrip';

const styles = StyleSheet.create({
  section: { width: '100%' },
  strip: { alignItems: 'flex-start' },
  card: { width: 84, alignItems: 'center' },
  avatar: { width: 68, height: 68 },
});
