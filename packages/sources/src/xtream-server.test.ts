import { describe, expect, it } from 'vitest';
import { normalizeXtreamServer } from './xtream';

describe('normalizeXtreamServer', () => {
  it('prepends http when there is no scheme', () => {
    expect(normalizeXtreamServer('h.example:8080')).toBe('http://h.example:8080');
  });
  it('drops query, fragment, trailing slashes and the php endpoint', () => {
    expect(normalizeXtreamServer(' https://h.example/panel/get.php?x=1#f ')).toBe(
      'https://h.example/panel',
    );
    expect(normalizeXtreamServer('http://h.example///')).toBe('http://h.example');
    expect(normalizeXtreamServer('http://h.example/player_api.php')).toBe('http://h.example');
  });
});
