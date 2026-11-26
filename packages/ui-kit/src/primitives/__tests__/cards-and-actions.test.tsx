import { fireEvent, render, screen } from '@testing-library/react-native';
import { Platform, StyleSheet } from 'react-native';
import { buildTheme, TABULAR_NUMS_STYLE, ThemeProvider } from '../../theme';
import { ViewportProvider } from '../../viewport';
import { CtaButton } from '../CtaButton';
import { createDeadHostRegistry } from '../dead-host-registry';
import { FilterChip } from '../FilterChip';
import { IconButton } from '../IconButton';
import { MicroPill } from '../MicroPill';
import { PosterCard } from '../PosterCard';
import { WideCard } from '../WideCard';

const defaultTheme = buildTheme();
const hcTheme = buildTheme({ preset: 'highContrast' });
const flat = StyleSheet.flatten;

describe('CtaButton & IconButton', () => {
  it('styles primary, secondary, and ghost CtaButton without neon hover outlines on desktop', async () => {
    const onPress = jest.fn();
    await render(
      <ThemeProvider>
        <ViewportProvider value={{ formFactor: 'desktop', orientation: 'landscape' }}>
          <CtaButton label="Play" icon="play" onPress={onPress} testID="primary" />
          <CtaButton label="Details" variant="secondary" focused testID="secondary" />
          <CtaButton label="Skip" variant="ghost" disabled onPress={onPress} testID="ghost" />
        </ViewportProvider>
      </ThemeProvider>,
    );

    const primary = screen.getByTestId('primary');
    const pStyle = flat(primary.props.style);
    expect(pStyle.backgroundColor).toBe(defaultTheme.colors.ctaBg);
    expect(pStyle.borderRadius).toBe(defaultTheme.radius.button);
    expect(pStyle.minHeight).toBe(40);
    expect(pStyle.paddingHorizontal).toBe(20);
    expect(pStyle.paddingVertical).toBe(10);
    expect(flat(screen.getByText('Play').props.style).fontWeight).toBe('700');
    expect(screen.getByTestId('primary-icon')).toBeTruthy();
    await fireEvent(primary, 'hoverIn');
    expect(flat(screen.getByTestId('primary').props.style).borderWidth ?? 0).toBe(0);
    await fireEvent.press(primary);
    await fireEvent.press(screen.getByTestId('ghost'));
    expect(onPress).toHaveBeenCalledTimes(1);
    const sStyle = flat(screen.getByTestId('secondary').props.style);
    expect(sStyle.transform).toEqual([{ scale: defaultTheme.focus.buttonScale }]);
    expect(flat(screen.getByTestId('secondary-focus-ring').props.style).borderColor).toBe(
      defaultTheme.colors.focusRingColor,
    );
  });

  it('transitions secondary CtaButton and IconButton smoothly to actionGlassHoverBg on desktop hover', async () => {
    await render(
      <ThemeProvider>
        <ViewportProvider value={{ formFactor: 'desktop', orientation: 'landscape' }}>
          <CtaButton label="More info" variant="secondary" testID="sec-hover" />
          <IconButton icon="plus" accessibilityLabel="Add" testID="icon-hover" />
        </ViewportProvider>
      </ThemeProvider>,
    );
    const sec = screen.getByTestId('sec-hover');
    const icon = screen.getByTestId('icon-hover');
    expect(flat(sec.props.style).backgroundColor).toBe(defaultTheme.colors.actionGlassBg);
    expect(flat(icon.props.style).backgroundColor).toBe(defaultTheme.colors.actionGlassBg);
    await fireEvent(sec, 'hoverIn');
    await fireEvent(icon, 'hoverIn');
    expect(flat(screen.getByTestId('sec-hover').props.style).backgroundColor).toBe(
      defaultTheme.colors.actionGlassHoverBg,
    );
    expect(flat(screen.getByTestId('icon-hover').props.style).backgroundColor).toBe(
      defaultTheme.colors.actionGlassHoverBg,
    );
  });

  it('applies TV focus ring and respects highContrast + reduceMotion on CtaButton and IconButton', async () => {
    const onIconPress = jest.fn();
    await render(
      <ThemeProvider preset="highContrast" reduceMotion>
        <ViewportProvider value={{ formFactor: 'tv', width: 1920, height: 1080 }}>
          <CtaButton label="Resume" focused testID="cta-tv" />
          <IconButton icon="info" accessibilityLabel="Details" testID="icon-idle" />
          <IconButton
            icon="plus"
            accessibilityLabel="Add to My List"
            active
            focused
            size={44}
            onPress={onIconPress}
            testID="icon-btn"
          />
        </ViewportProvider>
      </ThemeProvider>,
    );

    const ctaStyle = flat(screen.getByTestId('cta-tv').props.style);
    expect(ctaStyle.borderWidth).toBe(0);
    expect(ctaStyle.transform).toEqual([{ scale: 1 }]);
    const ctaRing = flat(screen.getByTestId('cta-tv-focus-ring').props.style);
    expect(ctaRing.borderColor).toBe(hcTheme.colors.focusRingColor);
    expect(ctaRing.borderWidth).toBe(hcTheme.focus.ringWidth);
    expect(flat(screen.getByTestId('icon-idle').props.style).backgroundColor).toBe(
      hcTheme.colors.actionGlassBg,
    );

    const iconStyle = flat(screen.getByTestId('icon-btn').props.style);
    expect(iconStyle.borderRadius).toBe(hcTheme.radius.pill);
    expect(iconStyle.minWidth).toBe(40);
    expect(iconStyle.width).toBe(44);
    expect(iconStyle.backgroundColor).toBe(hcTheme.colors.accentTint);
    expect(iconStyle.borderColor).toBe(hcTheme.colors.accent);
    expect(flat(screen.getByTestId('icon-btn-focus-ring').props.style).borderColor).toBe(
      hcTheme.colors.focusRingColor,
    );
    await fireEvent.press(screen.getByTestId('icon-btn'));
    expect(onIconPress).toHaveBeenCalledTimes(1);
  });
});

describe('MicroPill & FilterChip', () => {
  it('renders MicroPill tones, tabular numerals, and tone-aware indicator dots', async () => {
    await render(
      <ThemeProvider>
        <MicroPill label="4K HDR" testID="neutral" />
        <MicroPill label="LIVE" tone="live" testID="live" />
        <MicroPill label="98%" tone="success" dot testID="dot-pill" />
        <MicroPill label="NEW" tone="accent" dot testID="accent" />
      </ThemeProvider>,
    );

    const neutralStyle = flat(screen.getByTestId('neutral').props.style);
    expect(neutralStyle.borderRadius).toBe(defaultTheme.radius.button);
    expect(neutralStyle.backgroundColor).toBe(defaultTheme.colors.glassBg);
    expect(neutralStyle.borderColor).toBe(defaultTheme.colors.glassBorder);
    expect(screen.queryByTestId('neutral-dot')).toBeNull();
    const livePillStyle = flat(screen.getByTestId('live').props.style);
    expect(livePillStyle.borderRadius).toBe(defaultTheme.radius.pill);
    expect(livePillStyle.backgroundColor).toBe(defaultTheme.colors.scrimStrong);
    expect(livePillStyle.borderColor).toBe(defaultTheme.colors.liveColor);
    expect(flat(screen.getByTestId('live-dot').props.style).backgroundColor).toBe(
      defaultTheme.colors.liveColor,
    );
    expect(flat(screen.getByText('LIVE').props.style).color).toBe(defaultTheme.colors.textPrimary);
    expect(flat(screen.getByTestId('dot-pill-dot').props.style).backgroundColor).toBe(
      defaultTheme.colors.successColor,
    );
    expect(flat(screen.getByTestId('accent-dot').props.style).backgroundColor).toBe(
      defaultTheme.colors.accent,
    );
    expect(flat(screen.getByText('98%').props.style).fontVariant).toEqual(
      TABULAR_NUMS_STYLE.fontVariant,
    );
  });

  it('maintains AAA scrimStrong fill and liveColor border/dot on live MicroPill in highContrast mode', async () => {
    await render(
      <ThemeProvider preset="highContrast">
        <MicroPill label="LIVE" tone="live" testID="hc-live" />
        <MicroPill label="4K HDR" testID="hc-neutral" />
      </ThemeProvider>,
    );
    const liveStyle = flat(screen.getByTestId('hc-live').props.style);
    expect(liveStyle.backgroundColor).toBe(hcTheme.colors.scrimStrong);
    expect(liveStyle.borderColor).toBe(hcTheme.colors.liveColor);
    expect(flat(screen.getByTestId('hc-live-dot').props.style).backgroundColor).toBe(
      hcTheme.colors.liveColor,
    );
    expect(flat(screen.getByText('LIVE').props.style).color).toBe(hcTheme.colors.textPrimary);
    expect(flat(screen.getByTestId('hc-neutral').props.style).backgroundColor).toBe(
      hcTheme.colors.glassBg,
    );
  });

  it('adapts FilterChip touch target height across Portrait touch vs Landscape pointer/TV', async () => {
    const onSelect = jest.fn();
    const touchView = await render(
      <ThemeProvider>
        <ViewportProvider value={{ formFactor: 'phone', orientation: 'portrait' }}>
          <FilterChip label="Drama" selected onPress={onSelect} testID="chip-sel" />
          <FilterChip label="Sci-Fi" testID="chip-unsel" />
        </ViewportProvider>
      </ThemeProvider>,
    );

    const selStyle = flat(screen.getByTestId('chip-sel').props.style);
    expect(selStyle.minHeight).toBe(40);
    expect(selStyle.paddingHorizontal).toBe(14);
    expect(selStyle.borderRadius).toBe(defaultTheme.radius.pill);
    expect(selStyle.backgroundColor).toBe(defaultTheme.colors.ctaBg);
    expect(flat(screen.getByText('Drama').props.style).fontWeight).toBe('700');
    await fireEvent.press(screen.getByTestId('chip-sel'));
    expect(onSelect).toHaveBeenCalledTimes(1);
    const unselStyle = flat(screen.getByTestId('chip-unsel').props.style);
    expect(unselStyle.backgroundColor).toBe(defaultTheme.colors.chipBg);
    expect(unselStyle.borderColor).toBe(defaultTheme.colors.chipBorder);
    await touchView.unmount();

    await render(
      <ThemeProvider>
        <ViewportProvider value={{ formFactor: 'desktop', orientation: 'landscape' }}>
          <FilterChip label="All" focused testID="chip-desk" />
          <FilterChip label="Action" testID="chip-hover" />
        </ViewportProvider>
      </ThemeProvider>,
    );
    const deskStyle = flat(screen.getByTestId('chip-desk').props.style);
    expect(deskStyle.minHeight).toBe(32);
    expect(flat(screen.getByTestId('chip-desk-focus-ring').props.style).borderColor).toBe(
      defaultTheme.colors.focusRingColor,
    );
    await fireEvent(screen.getByTestId('chip-hover'), 'hoverIn');
    expect(flat(screen.getByTestId('chip-hover').props.style).backgroundColor).toBe(
      defaultTheme.colors.chipHoverBg,
    );
  });
});

describe('PosterCard & WideCard (Cinema Quietude compliance)', () => {
  it('renders pure-artwork PosterCard with zero outer box, zero duplicate titles, and clamped progress', async () => {
    const onPress = jest.fn();
    const onFocus = jest.fn();
    await render(
      <ThemeProvider>
        <ViewportProvider value={{ formFactor: 'tv', width: 1920, height: 1080 }}>
          <PosterCard
            title="Silent Horizon"
            meta="2026 · 8.4"
            badge="4K"
            progress={1.4}
            onPress={onPress}
            onFocus={onFocus}
            deadHosts={createDeadHostRegistry()}
            testID="poster"
          />
        </ViewportProvider>
      </ThemeProvider>,
    );

    const card = screen.getByTestId('poster');
    expect(flat(card.props.style).backgroundColor).toBeUndefined();
    expect(flat(card.props.style).borderWidth).toBeUndefined();
    expect(screen.getAllByText('Silent Horizon')).toHaveLength(1);
    const titleStyle = flat(screen.getByText('Silent Horizon').props.style);
    expect(titleStyle.fontSize).toBe(12.5);
    expect(titleStyle.fontWeight).toBe('600');
    const metaStyle = flat(screen.getByTestId('poster-meta').props.style);
    expect(metaStyle.fontSize).toBe(11);
    expect(metaStyle.color).toBe(defaultTheme.colors.textMuted);
    const artworkFrameStyle = flat(screen.getByTestId('poster-artwork-frame').props.style);
    expect(artworkFrameStyle.backgroundColor).toBe(defaultTheme.colors.bgCard);
    expect(flat(screen.getByTestId('poster-progress-fill').props.style).width).toBe('100%');
    await fireEvent(card, 'focus');
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(flat(screen.getByTestId('poster').props.style).transform).toEqual([
      { scale: defaultTheme.focus.cardScale },
    ]);
    const focusRingStyle = flat(screen.getByTestId('poster-focus-ring').props.style);
    expect(focusRingStyle.borderColor).toBe(defaultTheme.colors.focusRingColor);
    expect(focusRingStyle.bottom).toBe(-3);
    expect(focusRingStyle.borderRadius).toBe(defaultTheme.radius.card + 3);
    await fireEvent.press(card);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('zooms inner artwork with quiet outer hoverRingBorder on desktop pointer hover without scaling outer card', async () => {
    await render(
      <ThemeProvider>
        <ViewportProvider value={{ formFactor: 'desktop', orientation: 'landscape' }}>
          <PosterCard
            title="Orbit"
            imageUri="https://e.co/orbit.jpg"
            deadHosts={createDeadHostRegistry()}
            testID="desk-poster"
          />
        </ViewportProvider>
      </ThemeProvider>,
    );

    const card = screen.getByTestId('desk-poster');
    await fireEvent(card, 'hoverIn');
    expect(flat(screen.getByTestId('desk-poster').props.style).transform).toEqual([{ scale: 1 }]);
    expect(flat(screen.getByTestId('desk-poster-image-zoom').props.style).transform).toEqual([
      { scale: 1.05 },
    ]);
    const hoverRingStyle = flat(screen.getByTestId('desk-poster-focus-ring').props.style);
    expect(hoverRingStyle.borderColor).toBe(defaultTheme.colors.hoverRingBorder);
    expect(hoverRingStyle.bottom).toBe(-1.5);
  });

  it('renders watched checkmark badge when allWatched is true and never renders a numeric unplayed pill (#409, #502)', async () => {
    await render(
      <ThemeProvider>
        <ViewportProvider value={{ formFactor: 'phone', orientation: 'portrait' }}>
          <PosterCard title="Show B" allWatched testID="series-watched" />
          <PosterCard title="Show C" testID="series-none" />
        </ViewportProvider>
      </ThemeProvider>,
    );

    const watched = screen.getByTestId('series-watched-watched-badge');
    expect(flat(watched.props.style).borderColor).toBe(defaultTheme.colors.successColor);
    expect(screen.queryByTestId('series-watched-unplayed')).toBeNull();

    expect(screen.queryByTestId('series-none-unplayed')).toBeNull();
    expect(screen.queryByTestId('series-none-watched-badge')).toBeNull();
  });

  it('renders pointer-only hover quick-actions that stop propagation and never render on touch or TV (#409)', async () => {
    const onPress = jest.fn();
    const onPlay = jest.fn();
    const onToggleFavorite = jest.fn();
    const onToggleWatched = jest.fn();

    const desktopView = await render(
      <ThemeProvider>
        <ViewportProvider value={{ formFactor: 'desktop', orientation: 'landscape' }}>
          <PosterCard
            title="Dune"
            onPress={onPress}
            quickActions={{
              onPlay,
              playLabel: 'Play Dune',
              isFavorite: false,
              onToggleFavorite,
              favoriteLabel: 'Add to My list',
              isWatched: true,
              onToggleWatched,
              watchedLabel: 'Mark unwatched',
            }}
            testID="qa-poster"
          />
        </ViewportProvider>
      </ThemeProvider>,
    );

    expect(screen.queryByTestId('qa-poster-quick-play')).toBeNull();
    expect(screen.queryByTestId('qa-poster-quick-favorite')).toBeNull();
    expect(screen.queryByTestId('qa-poster-quick-watched')).toBeNull();

    await fireEvent(screen.getByTestId('qa-poster'), 'hoverIn');
    const playBtn = screen.getByTestId('qa-poster-quick-play');
    const favBtn = screen.getByTestId('qa-poster-quick-favorite');
    const watchedBtn = screen.getByTestId('qa-poster-quick-watched');

    const playEvt = { stopPropagation: jest.fn(), preventDefault: jest.fn() };
    await fireEvent.press(playBtn, playEvt);
    expect(playEvt.stopPropagation).toHaveBeenCalledTimes(1);
    expect(playEvt.preventDefault).toHaveBeenCalledTimes(1);
    expect(onPlay).toHaveBeenCalledTimes(1);
    expect(onPress).not.toHaveBeenCalled();

    const favEvt = { stopPropagation: jest.fn(), preventDefault: jest.fn() };
    await fireEvent.press(favBtn, favEvt);
    expect(favEvt.stopPropagation).toHaveBeenCalledTimes(1);
    expect(onToggleFavorite).toHaveBeenCalledTimes(1);
    expect(onPress).not.toHaveBeenCalled();

    const watchedEvt = { stopPropagation: jest.fn(), preventDefault: jest.fn() };
    await fireEvent.press(watchedBtn, watchedEvt);
    expect(watchedEvt.stopPropagation).toHaveBeenCalledTimes(1);
    expect(onToggleWatched).toHaveBeenCalledTimes(1);
    expect(onPress).not.toHaveBeenCalled();

    await fireEvent(screen.getByTestId('qa-poster'), 'hoverOut');
    expect(screen.queryByTestId('qa-poster-quick-play')).toBeNull();
    await desktopView.unmount();

    // Regression: entering nested quick-action Pressables triggers parent Pressable hoverOut on web
    // (react-gui:hover:lock), which must NOT collapse the quick-actions overlay while pointer stays
    // inside the outer hover container.
    const nestedHoverView = await render(
      <ThemeProvider>
        <ViewportProvider value={{ formFactor: 'desktop', orientation: 'landscape' }}>
          <PosterCard
            title="Arrival"
            quickActions={{
              onPlay,
              playLabel: 'Play Arrival',
              isFavorite: false,
              onToggleFavorite,
              favoriteLabel: 'Add to My list',
              isWatched: false,
              onToggleWatched,
              watchedLabel: 'Mark watched',
            }}
            testID="nested-poster"
          />
        </ViewportProvider>
      </ThemeProvider>,
    );
    await fireEvent(screen.getByTestId('nested-poster-hover-container'), 'pointerEnter');
    expect(screen.getByTestId('nested-poster-quick-favorite')).toBeTruthy();

    // Simulated react-native-web nested Pressable hover lock cancelling parent Pressable hover
    await fireEvent(screen.getByTestId('nested-poster'), 'hoverOut');
    expect(screen.getByTestId('nested-poster-quick-favorite')).toBeTruthy();
    expect(screen.getByTestId('nested-poster-quick-play')).toBeTruthy();
    expect(screen.getByTestId('nested-poster-quick-watched')).toBeTruthy();

    // Leaving the outer hover container cleanly unmounts the overlay
    await fireEvent(screen.getByTestId('nested-poster-hover-container'), 'pointerLeave');
    expect(screen.queryByTestId('nested-poster-quick-favorite')).toBeNull();
    await nestedHoverView.unmount();

    // Never renders on touch or TV even if hoverIn fires.
    for (const vp of [
      { formFactor: 'phone' as const, orientation: 'portrait' as const },
      { formFactor: 'tv' as const, width: 1920, height: 1080 },
    ]) {
      const view = await render(
        <ThemeProvider>
          <ViewportProvider value={vp}>
            <PosterCard
              title="Dune"
              quickActions={{ onPlay, onToggleFavorite, onToggleWatched }}
              testID="non-pointer-poster"
            />
          </ViewportProvider>
        </ThemeProvider>,
      );
      await fireEvent(screen.getByTestId('non-pointer-poster'), 'hoverIn');
      expect(screen.queryByTestId('non-pointer-poster-quick-play')).toBeNull();
      expect(screen.queryByTestId('non-pointer-poster-quick-favorite')).toBeNull();
      expect(screen.queryByTestId('non-pointer-poster-quick-watched')).toBeNull();
      await view.unmount();
    }
  });

  it('renders 16:9 WideCard with LIVE pill, scrim, optional circular play badge, and reduceMotion', async () => {
    await render(
      <ThemeProvider preset="highContrast" reduceMotion>
        <ViewportProvider value={{ formFactor: 'tv', width: 1920, height: 1080 }}>
          <WideCard
            title="Evening Broadcast"
            subtitle="Ch 101 · 21:00"
            live
            liveLabel="ON AIR"
            badge="HD"
            logoBackdrop
            progress={-0.3}
            focused
            width={320}
            testID="wide"
          />
          <WideCard title="Ep 4" imageUri="https://e.co/s.jpg" progress={0.45} testID="vod" />
          <WideCard
            title="Ep 5"
            imageUri="https://e.co/s2.jpg"
            progress={0.2}
            showPlayBadge={false}
            testID="vod-nobadge"
          />
        </ViewportProvider>
      </ThemeProvider>,
    );
    expect(screen.getAllByText('Evening Broadcast')).toHaveLength(1);
    const wideTitleStyle = flat(screen.getByText('Evening Broadcast').props.style);
    expect(wideTitleStyle.fontSize).toBe(13);
    expect(wideTitleStyle.fontWeight).toBe('600');
    const wideSubStyle = flat(screen.getByTestId('wide-subtitle').props.style);
    expect(wideSubStyle.fontSize).toBe(11);
    expect(wideSubStyle.color).toBe(hcTheme.colors.textSecondary);
    expect(screen.getByText('ON AIR')).toBeTruthy();
    expect(screen.getByText('HD')).toBeTruthy();
    const wideStyle = flat(screen.getByTestId('wide').props.style);
    expect(wideStyle.backgroundColor).toBeUndefined();
    expect(wideStyle.width).toBe(320);
    expect(wideStyle.transform).toEqual([{ scale: 1 }]);
    expect(flat(screen.getByTestId('wide-progress-fill').props.style).width).toBe('0%');
    // Live logoBackdrop cards keep a single clipped surface (no outer bgCard bleed + inner borderRadius=0)
    expect(flat(screen.getByTestId('wide-artwork-frame').props.style).backgroundColor).toBe(
      'transparent',
    );
    expect(flat(screen.getByTestId('wide-image').props.style).borderRadius).toBe(0);
    expect(flat(screen.getByTestId('vod-artwork-frame').props.style).backgroundColor).toBe(
      hcTheme.colors.bgCard,
    );
    expect(flat(screen.getByTestId('vod-image').props.style).borderRadius).toBe(0);
    const wideFocusRing = flat(screen.getByTestId('wide-focus-ring').props.style);
    expect(wideFocusRing.bottom).toBe(-3);
    expect(wideFocusRing.borderRadius).toBe(hcTheme.radius.card + 3);
    expect(screen.getByTestId('wide-scrim')).toBeTruthy();
    expect(screen.queryByTestId('wide-play-badge')).toBeNull();
    expect(flat(screen.getByTestId('vod-progress-fill').props.style).width).toBe('45%');
    expect(screen.getByTestId('vod-scrim')).toBeTruthy();
    const playBadgeStyle = flat(screen.getByTestId('vod-play-badge').props.style);
    expect(playBadgeStyle.width).toBe(28);
    expect(playBadgeStyle.height).toBe(28);
    expect(playBadgeStyle.backgroundColor).toBe(hcTheme.colors.ctaBg);
    expect(screen.queryByTestId('vod-nobadge-play-badge')).toBeNull();
  });

  it('invokes onContextMenu with pointer anchor on web right-click and without anchor on long-press for PosterCard and WideCard without triggering onPress', async () => {
    try {
      jest.replaceProperty(Platform, 'OS', 'web');
      const onPosterPress = jest.fn();
      const onPosterCtx = jest.fn();
      const onWidePress = jest.fn();
      const onWideCtx = jest.fn();

      const view = await render(
        <ThemeProvider>
          <ViewportProvider value={{ formFactor: 'desktop', orientation: 'landscape' }}>
            <PosterCard
              title="Arrival"
              onPress={onPosterPress}
              onContextMenu={onPosterCtx}
              testID="ctx-poster"
            />
            <WideCard
              title="News 24"
              live
              onPress={onWidePress}
              onContextMenu={onWideCtx}
              testID="ctx-wide"
            />
          </ViewportProvider>
        </ThemeProvider>,
      );

      const posterPrevent = jest.fn();
      const posterStop = jest.fn();
      await fireEvent(screen.getByTestId('ctx-poster'), 'contextMenu', {
        preventDefault: posterPrevent,
        stopPropagation: posterStop,
        nativeEvent: { clientX: 310, clientY: 220 },
      });
      expect(posterPrevent).toHaveBeenCalledTimes(1);
      expect(posterStop).toHaveBeenCalledTimes(1);
      expect(onPosterCtx).toHaveBeenCalledWith({ x: 310, y: 220 });
      expect(onPosterPress).not.toHaveBeenCalled();

      const widePrevent = jest.fn();
      const wideStop = jest.fn();
      await fireEvent(screen.getByTestId('ctx-wide'), 'contextMenu', {
        preventDefault: widePrevent,
        stopPropagation: wideStop,
        clientX: 420,
        clientY: 180,
      });
      expect(widePrevent).toHaveBeenCalledTimes(1);
      expect(wideStop).toHaveBeenCalledTimes(1);
      expect(onWideCtx).toHaveBeenCalledWith({ x: 420, y: 180 });
      expect(onWidePress).not.toHaveBeenCalled();

      // Long-press invokes onContextMenu with no anchor and does not trigger onPress
      await fireEvent(screen.getByTestId('ctx-poster'), 'longPress');
      expect(onPosterCtx).toHaveBeenLastCalledWith();
      expect(onPosterPress).not.toHaveBeenCalled();

      await fireEvent(screen.getByTestId('ctx-wide'), 'longPress');
      expect(onWideCtx).toHaveBeenLastCalledWith();
      expect(onWidePress).not.toHaveBeenCalled();

      await view.unmount();
    } finally {
      jest.restoreAllMocks();
    }
  });
});
