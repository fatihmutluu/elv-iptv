import { createAppI18n } from '@elv/i18n';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { I18nProvider } from '../i18n';
import { buildTheme, ThemeProvider } from '../theme';
import { ViewportProvider } from '../viewport';
import {
  ALPHABET_JUMP_LETTERS,
  type AlphabetJumpBucket,
  AlphabetJumpRail,
} from './AlphabetJumpRail';

const SAMPLE_BUCKETS: readonly AlphabetJumpBucket[] = [
  { letter: '#', offset: 0, count: 4 },
  { letter: 'A', offset: 4, count: 12 },
  { letter: 'B', offset: 16, count: 0 },
  { letter: 'C', offset: 16, count: 8 },
  { letter: 'M', offset: 24, count: 19 },
  { letter: 'Z', offset: 43, count: 3 },
];

describe('AlphabetJumpRail (#407)', () => {
  it('renders all 27 canonical slots (#, A..Z), dims unavailable letters (opacity 0.28), and invokes onSelectLetter only for available buckets', async () => {
    const theme = buildTheme();
    const onSelectLetter = jest.fn();

    await render(
      <ThemeProvider>
        <ViewportProvider
          value={{ formFactor: 'desktop', inputModality: 'pointer', width: 1440, height: 900 }}
        >
          <AlphabetJumpRail
            buckets={SAMPLE_BUCKETS}
            activeLetter="A"
            onSelectLetter={onSelectLetter}
            testID="az-rail"
          />
        </ViewportProvider>
      </ThemeProvider>,
    );

    expect(ALPHABET_JUMP_LETTERS).toHaveLength(27);
    const rail = screen.getByTestId('az-rail');
    expect(rail.props.accessibilityLabel).toBe('Jump to letter');

    for (const letter of ALPHABET_JUMP_LETTERS) {
      expect(screen.getByTestId(`az-rail-letter-${letter}`)).toBeTruthy();
    }

    // Available letter A is active and interactive
    const slotA = screen.getByTestId('az-rail-letter-A');
    const styleA = StyleSheet.flatten(slotA.props.style);
    expect(styleA.opacity).toBe(1);
    expect(styleA.backgroundColor).toBe(theme.colors.accentTint);
    expect(slotA.props.accessibilityState).toEqual({ disabled: false, selected: true });
    expect(slotA.props.accessibilityLabel).toBe('Jump to A');
    expect(screen.getByTestId('az-rail-letter-A-active-dot')).toBeTruthy();

    // Unavailable letter B (count === 0) and D (omitted) are dimmed at opacity 0.28 and disabled
    const slotB = screen.getByTestId('az-rail-letter-B');
    const styleB = StyleSheet.flatten(slotB.props.style);
    expect(styleB.opacity).toBe(0.28);
    expect(slotB.props.accessibilityState).toEqual({ disabled: true, selected: false });

    const slotD = screen.getByTestId('az-rail-letter-D');
    expect(StyleSheet.flatten(slotD.props.style).opacity).toBe(0.28);

    // Pressing disabled letter B does not trigger callback
    await fireEvent.press(slotB);
    expect(onSelectLetter).not.toHaveBeenCalled();

    // Pressing available letter M jumps to offset 24
    await fireEvent.press(screen.getByTestId('az-rail-letter-M'));
    expect(onSelectLetter).toHaveBeenCalledTimes(1);
    expect(onSelectLetter).toHaveBeenCalledWith('M', 24);
  });

  it('supports vertical touch/pointer drag-scrubbing across the rail, snaps to the nearest available letter, and shows the floating preview badge', async () => {
    const onSelectLetter = jest.fn();

    await render(
      <ThemeProvider>
        <ViewportProvider
          value={{ formFactor: 'phone', inputModality: 'touch', width: 393, height: 852 }}
        >
          <AlphabetJumpRail
            buckets={SAMPLE_BUCKETS}
            onSelectLetter={onSelectLetter}
            testID="scrub-rail"
          />
        </ViewportProvider>
      </ThemeProvider>,
    );

    const rail = screen.getByTestId('scrub-rail');
    await fireEvent(rail, 'layout', {
      nativeEvent: { layout: { x: 0, y: 0, width: 24, height: 270 } },
    });

    expect(screen.queryByTestId('scrub-rail-scrub-preview')).toBeNull();

    // Grant at y = 5 -> index 0 ('#', available at offset 0)
    await fireEvent(rail, 'responderGrant', {
      nativeEvent: { locationY: 5 },
    });
    expect(onSelectLetter).toHaveBeenLastCalledWith('#', 0);
    expect(screen.getByTestId('scrub-rail-scrub-preview')).toBeTruthy();
    expect(screen.getByTestId('scrub-rail-scrub-preview-text').props.children).toBe('#');

    // Move to y = 25 -> index 2 ('B', count 0) -> snaps to nearest available ('A' at index 1, offset 4)
    await fireEvent(rail, 'responderMove', {
      nativeEvent: { locationY: 25 },
    });
    expect(onSelectLetter).toHaveBeenLastCalledWith('A', 4);
    expect(screen.getByTestId('scrub-rail-scrub-preview-text').props.children).toBe('A');

    // Move within same snapped bucket does not duplicate callback
    await fireEvent(rail, 'responderMove', {
      nativeEvent: { locationY: 14 },
    });
    expect(onSelectLetter).toHaveBeenCalledTimes(2);

    // Move to y = 135 -> index 13 ('M', offset 24)
    await fireEvent(rail, 'responderMove', {
      nativeEvent: { locationY: 135 },
    });
    expect(onSelectLetter).toHaveBeenLastCalledWith('M', 24);
    expect(screen.getByTestId('scrub-rail-scrub-preview-text').props.children).toBe('M');

    // Release clears floating scrub preview badge
    await fireEvent(rail, 'responderRelease');
    expect(screen.queryByTestId('scrub-rail-scrub-preview')).toBeNull();
  });

  it('captures child vertical drags via onMoveShouldSetResponderCapture and computes scrub offset from pageY minus rail window origin', async () => {
    const onSelectLetter = jest.fn();

    await render(
      <ThemeProvider>
        <ViewportProvider
          value={{ formFactor: 'phone', inputModality: 'touch', width: 393, height: 852 }}
        >
          <AlphabetJumpRail
            buckets={SAMPLE_BUCKETS}
            onSelectLetter={onSelectLetter}
            testID="pagey-rail"
          />
        </ViewportProvider>
      </ThemeProvider>,
    );

    const rail = screen.getByTestId('pagey-rail');
    // Vertical drag capture steals responder from child Pressable slots on touch/pointer
    expect(rail.props.onMoveShouldSetResponderCapture()).toBe(true);

    // Rail starts at window y = 200 with height = 270 (10px per slot)
    await fireEvent(rail, 'layout', {
      nativeEvent: { layout: { x: 360, y: 200, width: 24, height: 270 } },
    });

    // Touch starting on disabled slot 'X' near bottom has child-relative locationY = 7, but window pageY = 447 (247px into rail -> index 24 'X' -> snaps to 'Z' at offset 43, NEVER '#'!)
    await fireEvent(rail, 'responderGrant', {
      nativeEvent: { pageY: 447, locationY: 7 },
    });
    expect(onSelectLetter).toHaveBeenLastCalledWith('Z', 43);
    expect(screen.getByTestId('pagey-rail-scrub-preview-text').props.children).toBe('Z');

    // Drag up to window pageY = 335 (135px into rail -> index 13 'M', offset 24)
    await fireEvent(rail, 'responderMove', {
      nativeEvent: { pageY: 335, locationY: 4 },
    });
    expect(onSelectLetter).toHaveBeenLastCalledWith('M', 24);
    expect(screen.getByTestId('pagey-rail-scrub-preview-text').props.children).toBe('M');

    await fireEvent(rail, 'responderRelease');
    expect(screen.queryByTestId('pagey-rail-scrub-preview')).toBeNull();
  });

  it('disables drag capture on TV mode', async () => {
    await render(
      <ThemeProvider>
        <ViewportProvider
          value={{ formFactor: 'tv', inputModality: 'tv', width: 1920, height: 1080 }}
        >
          <AlphabetJumpRail
            buckets={SAMPLE_BUCKETS}
            onSelectLetter={jest.fn()}
            isTv
            testID="tv-capture-rail"
          />
        </ViewportProvider>
      </ThemeProvider>,
    );

    const rail = screen.getByTestId('tv-capture-rail');
    expect(rail.props.onMoveShouldSetResponderCapture()).toBe(false);
    expect(rail.props.onStartShouldSetResponder()).toBe(false);
  });

  it('renders non-focusable Pressables on TV (`focusable={false}`), highlights focusedLetter with theme focus ring, and localizes in Turkish', async () => {
    const hcTheme = buildTheme({ preset: 'highContrast' });
    const tr = createAppI18n('tr');

    await render(
      <I18nProvider i18n={tr}>
        <ThemeProvider preset="highContrast">
          <ViewportProvider
            value={{ formFactor: 'tv', inputModality: 'tv', width: 1920, height: 1080 }}
          >
            <AlphabetJumpRail
              buckets={SAMPLE_BUCKETS}
              activeLetter="A"
              focusedLetter="C"
              onSelectLetter={jest.fn()}
              isTv
              testID="tv-az"
            />
          </ViewportProvider>
        </ThemeProvider>
      </I18nProvider>,
    );

    const rail = screen.getByTestId('tv-az');
    expect(rail.props.accessibilityLabel).toBe('Harfe git');

    const slotC = screen.getByTestId('tv-az-letter-C');
    expect(slotC.props.focusable).toBe(false);
    expect(slotC.props.accessibilityLabel).toBe('C harfine git');
    expect(StyleSheet.flatten(slotC.props.style).backgroundColor).toBe(hcTheme.colors.focusFill);

    const focusRing = screen.getByTestId('tv-az-letter-C-focus-ring');
    const ringStyle = StyleSheet.flatten(focusRing.props.style);
    expect(ringStyle.borderColor).toBe(hcTheme.colors.focusRingColor);
    expect(ringStyle.borderWidth).toBe(hcTheme.focus.ringWidth);
    expect(screen.queryByTestId('tv-az-letter-A-focus-ring')).toBeNull();
  });
});
