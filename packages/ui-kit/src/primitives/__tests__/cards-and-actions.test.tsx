import { fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
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

    expect(flat(screen.getByTestId('neutral').props.style).borderRadius).toBe(
      defaultTheme.radius.button,
    );
    expect(screen.queryByTestId('neutral-dot')).toBeNull();
    expect(flat(screen.getByTestId('live').props.style).borderRadius).toBe(
      defaultTheme.radius.pill,
    );
    expect(flat(screen.getByTestId('live-dot').props.style).backgroundColor).toBe(
      defaultTheme.colors.liveColor,
    );
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
    expect(selStyle.borderRadius).toBe(defaultTheme.radius.pill);
    expect(selStyle.backgroundColor).toBe(defaultTheme.colors.ctaBg);
    await fireEvent.press(screen.getByTestId('chip-sel'));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(flat(screen.getByTestId('chip-unsel').props.style).backgroundColor).toBe(
      defaultTheme.colors.bgSurface,
    );
    await touchView.unmount();

    await render(
      <ThemeProvider>
        <ViewportProvider value={{ formFactor: 'desktop', orientation: 'landscape' }}>
          <FilterChip label="All" focused testID="chip-desk" />
        </ViewportProvider>
      </ThemeProvider>,
    );
    const deskStyle = flat(screen.getByTestId('chip-desk').props.style);
    expect(deskStyle.minHeight).toBe(36);
    expect(flat(screen.getByTestId('chip-desk-focus-ring').props.style).borderColor).toBe(
      defaultTheme.colors.focusRingColor,
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
    expect(flat(screen.getByTestId('poster-progress-fill').props.style).width).toBe('100%');
    await fireEvent(card, 'focus');
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(flat(screen.getByTestId('poster').props.style).transform).toEqual([
      { scale: defaultTheme.focus.cardScale },
    ]);
    expect(flat(screen.getByTestId('poster-focus-ring').props.style).borderColor).toBe(
      defaultTheme.colors.focusRingColor,
    );
    await fireEvent.press(card);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('renders 16:9 WideCard with LIVE pill, clamped negative/fractional progress, and reduceMotion', async () => {
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
        </ViewportProvider>
      </ThemeProvider>,
    );
    expect(screen.getAllByText('Evening Broadcast')).toHaveLength(1);
    expect(screen.getByText('ON AIR')).toBeTruthy();
    expect(screen.getByText('HD')).toBeTruthy();
    const wideStyle = flat(screen.getByTestId('wide').props.style);
    expect(wideStyle.backgroundColor).toBeUndefined();
    expect(wideStyle.width).toBe(320);
    expect(wideStyle.transform).toEqual([{ scale: 1 }]);
    expect(flat(screen.getByTestId('wide-progress-fill').props.style).width).toBe('0%');
    expect(flat(screen.getByTestId('vod-progress-fill').props.style).width).toBe('45%');
  });
});
