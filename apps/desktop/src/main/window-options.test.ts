import { describe, expect, it } from 'vitest';
import { buildWindowOptions } from './window-options.ts';

describe('buildWindowOptions', () => {
  const options = buildWindowOptions('/app/dist/preload/preload.js');

  it('enables the renderer security baseline', () => {
    expect(options.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    });
  });

  it('loads the given preload script', () => {
    expect(options.webPreferences?.preload).toBe('/app/dist/preload/preload.js');
  });

  it('titles the window ELV IPTV', () => {
    expect(options.title).toBe('ELV IPTV');
  });
});
