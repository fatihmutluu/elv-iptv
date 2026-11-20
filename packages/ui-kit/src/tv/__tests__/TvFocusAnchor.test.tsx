import { render, screen } from '@testing-library/react-native';
import { TvFocusAnchor } from '../index';

describe('TvFocusAnchor (#186)', () => {
  it('renders a 1x1 transparent focusable anchor with safe defaults for empty/loading TV screens', async () => {
    await render(<TvFocusAnchor />);
    const anchor = screen.getByTestId('tv-focus-anchor', { includeHiddenElements: true });
    expect(anchor.props.focusable).toBe(true);
    expect(anchor.props.hasTVPreferredFocus).toBe(true);
    expect(anchor.props.accessible).toBe(false);
    expect(anchor.props.accessibilityElementsHidden).toBe(true);
    expect(anchor.props.pointerEvents).toBe('none');
    expect(anchor.props.style).toEqual(
      expect.objectContaining({
        width: 1,
        height: 1,
        backgroundColor: 'transparent',
      }),
    );
    expect(anchor.props.style.opacity).not.toBe(0);
  });

  it('allows overriding hasTVPreferredFocus and testID', async () => {
    await render(<TvFocusAnchor hasTVPreferredFocus={false} testID="loading-anchor" />);
    const anchor = screen.getByTestId('loading-anchor', { includeHiddenElements: true });
    expect(anchor.props.hasTVPreferredFocus).toBe(false);
    expect(anchor.props.focusable).toBe(true);
  });
});
