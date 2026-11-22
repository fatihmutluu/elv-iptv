import { describe, expect, it } from 'vitest';
import { cleanDisplayTitle } from './title-clean';

describe('cleanDisplayTitle (#194)', () => {
  it('preserves trailing (YYYY) release years and leading numeric titles', () => {
    expect(cleanDisplayTitle('Cosmic Drift (2024)')).toBe('Cosmic Drift (2024)');
    expect(cleanDisplayTitle('2001: A Space Odyssey')).toBe('2001: A Space Odyssey');
    expect(cleanDisplayTitle('2001. A Space Odyssey')).toBe('2001. A Space Odyssey');
    expect(cleanDisplayTitle('1917')).toBe('1917');
    expect(cleanDisplayTitle('1917 (2019)')).toBe('1917 (2019)');
    expect(cleanDisplayTitle('300 (2006)')).toBe('300 (2006)');
    expect(cleanDisplayTitle('12 Angry Men (1957)')).toBe('12 Angry Men (1957)');
  });

  it('strips leading curated prefix tags', () => {
    expect(cleanDisplayTitle('[TR] Cosmic Drift (2024)')).toBe('Cosmic Drift (2024)');
    expect(cleanDisplayTitle('TR | Cosmic Drift (2024)')).toBe('Cosmic Drift (2024)');
    expect(cleanDisplayTitle('UK: Harbor News')).toBe('Harbor News');
    expect(cleanDisplayTitle('FHD | Midnight Express')).toBe('Midnight Express');
    expect(cleanDisplayTitle('4K - Alpine Summit (2023)')).toBe('Alpine Summit (2023)');
    expect(cleanDisplayTitle('RAW | VIP | Grand Cinema')).toBe('Grand Cinema');
    expect(cleanDisplayTitle('[TR] FHD | 4K - Cosmic Drift (2024)')).toBe('Cosmic Drift (2024)');
    expect(cleanDisplayTitle('[US/UK] UHD: Wild Frontier')).toBe('Wild Frontier');
  });

  it('strips trailing 2-letter uppercase country codes while preserving release years', () => {
    expect(cleanDisplayTitle('Cosmic Drift (TR)')).toBe('Cosmic Drift');
    expect(cleanDisplayTitle('Cosmic Drift (US)')).toBe('Cosmic Drift');
    expect(cleanDisplayTitle('Harbor News [UK]')).toBe('Harbor News');
    expect(cleanDisplayTitle('Cosmic Drift (2024) (TR)')).toBe('Cosmic Drift (2024)');
    expect(cleanDisplayTitle('Cosmic Drift (TR) (2024)')).toBe('Cosmic Drift (2024)');
    expect(cleanDisplayTitle('[TR] 1917 (2019) [TR]')).toBe('1917 (2019)');
  });

  it('does not strip title-case words, non-curated brackets, or empty out a tag-only string', () => {
    expect(cleanDisplayTitle('It: Chapter Two (2019)')).toBe('It: Chapter Two (2019)');
    expect(cleanDisplayTitle('Us: Behind the Scenes')).toBe('Us: Behind the Scenes');
    expect(cleanDisplayTitle('Live: From New York')).toBe('Live: From New York');
    expect(cleanDisplayTitle('Top: Secret (1984)')).toBe('Top: Secret (1984)');
    expect(cleanDisplayTitle('New: Horizons')).toBe('New: Horizons');
    expect(cleanDisplayTitle('Raw: Footage')).toBe('Raw: Footage');
    expect(cleanDisplayTitle('Low: Tide')).toBe('Low: Tide');
    expect(cleanDisplayTitle('LIVE | Harbor News')).toBe('Harbor News');
    expect(cleanDisplayTitle('[RAW] Sports Channel')).toBe('Sports Channel');
    expect(cleanDisplayTitle('TOP: Movies')).toBe('Movies');
    expect(cleanDisplayTitle('[REC] (2007)')).toBe('[REC] (2007)');
    expect(cleanDisplayTitle('[TR]')).toBe('[TR]');
    expect(cleanDisplayTitle('   ')).toBe('');
    expect(cleanDisplayTitle('')).toBe('');
  });
});
