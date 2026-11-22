import { describe, expect, it } from 'vitest';
import {
  buildSourceBadgeMap,
  formatChannelDisplayName,
  resolveEpgGenreTint,
  resolveSourceBadge,
  type SourceBadgeTheme,
} from './source-badge';

const MOCK_THEME: SourceBadgeTheme = {
  colors: {
    accent: '#E11D48',
    liveColor: '#EF4444',
    successColor: '#22C55E',
    textSecondary: '#94A3B8',
    focusRingColor: '#FFFFFF',
  },
};

describe('resolveSourceBadge, formatChannelDisplayName & resolveEpgGenreTint (#126, #145, #401)', () => {
  it('returns null for single-source catalogs or when showSourceBadges is false', () => {
    const one = [{ id: 's1', name: 'Primary IPTV' }];
    const two = [
      { id: 's1', name: 'Primary' },
      { id: 's2', name: 'Backup' },
    ];
    expect(resolveSourceBadge('s1', [], MOCK_THEME)).toBeNull();
    expect(resolveSourceBadge('s1', one, MOCK_THEME)).toBeNull();
    expect(resolveSourceBadge('s1', two, MOCK_THEME, false)).toBeNull();
    expect(resolveSourceBadge('unknown', two, MOCK_THEME, true)).toBeNull();
    expect(buildSourceBadgeMap(one, MOCK_THEME, true).size).toBe(0);
    expect(buildSourceBadgeMap(two, MOCK_THEME, false).size).toBe(0);
  });

  it('assigns deterministic theme-derived semantic colors and compact <=10-char labels across multiple sources', () => {
    const sources = [
      { id: 's1', name: 'Main' },
      { id: 's2', name: 'SuperLongProviderName' },
      { id: 's3', name: '   ' },
      { id: 's4', name: 'Sports Hub' },
      { id: 's5', name: 'Cinema' },
    ];
    const b1 = resolveSourceBadge('s1', sources, MOCK_THEME);
    const b2 = resolveSourceBadge('s2', sources, MOCK_THEME);
    const b3 = resolveSourceBadge('s3', sources, MOCK_THEME);
    const b4 = resolveSourceBadge('s4', sources, MOCK_THEME);
    const b5 = resolveSourceBadge('s5', sources, MOCK_THEME);

    expect(b1).toEqual({ sourceId: 's1', label: 'Main', color: MOCK_THEME.colors.accent });
    expect(b2?.color).toBe(MOCK_THEME.colors.successColor);
    expect(b2?.label.length).toBeLessThanOrEqual(10);
    expect(b3).toEqual({ sourceId: 's3', label: 's3', color: MOCK_THEME.colors.liveColor });
    expect(b4?.color).toBe(MOCK_THEME.colors.focusRingColor);
    expect(b5?.color).toBe(MOCK_THEME.colors.textSecondary);

    const map = buildSourceBadgeMap(sources, MOCK_THEME, true);
    expect(map.size).toBe(5);
    expect(map.get('s2')).toEqual(b2);
  });

  it('cleans provider prefix/suffix tags non-destructively only when cleanChannelTitles is enabled', () => {
    expect(formatChannelDisplayName('[TR] FHD | Sports One (TR)', false)).toBe(
      '[TR] FHD | Sports One (TR)',
    );
    expect(formatChannelDisplayName('[TR] FHD | Sports One (TR)', true)).toBe('Sports One');
    expect(formatChannelDisplayName('4K | Cinema Prime', true)).toBe('Cinema Prime');
    expect(formatChannelDisplayName('   ', true)).toBe('   ');
  });

  it('resolves theme-derived EPG genre accent colors for sports, news, movies, and kids/documentary', () => {
    expect(
      resolveEpgGenreTint(
        { title: 'Premier League Football', subTitle: null, description: null },
        MOCK_THEME,
      ),
    ).toEqual({ genre: 'sports', accentColor: MOCK_THEME.colors.successColor });
    expect(
      resolveEpgGenreTint(
        { title: 'Evening News Bulletin', subTitle: null, description: null },
        MOCK_THEME,
      ),
    ).toEqual({ genre: 'news', accentColor: MOCK_THEME.colors.liveColor });
    expect(
      resolveEpgGenreTint(
        { title: 'Late Night Cinema', subTitle: 'Action Film', description: null },
        MOCK_THEME,
      ),
    ).toEqual({ genre: 'movies', accentColor: MOCK_THEME.colors.accent });
    expect(
      resolveEpgGenreTint(
        { title: 'Nature Documentary', subTitle: null, description: null },
        MOCK_THEME,
      ),
    ).toEqual({ genre: 'kids-doc', accentColor: MOCK_THEME.colors.focusRingColor });
    expect(
      resolveEpgGenreTint(
        { title: 'General Broadcast', subTitle: null, description: null },
        MOCK_THEME,
      ),
    ).toBeNull();
  });
});
