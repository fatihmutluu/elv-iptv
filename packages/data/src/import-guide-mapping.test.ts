import { describe, expect, it } from 'vitest';
import {
  channelXml,
  HOUR,
  programmeXml,
  rows,
  run,
  setupGuide,
  stream,
  tv,
} from './import-guide-test-helpers';
import { extinf } from './import-test-helpers';
import { importCatalog } from './import-xtream';

async function guideFor(playlist: string, ...parts: string[]) {
  const e = await setupGuide(`#EXTM3U\n${playlist}`);
  expect((await importCatalog(e.sourceId, e.deps)).ok).toBe(true);
  e.server.body = tv(...parts);
  const r = await run(e);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return { e, summary: r.value };
}

const mapping = async (e: Awaited<ReturnType<typeof setupGuide>>) =>
  rows(
    e,
    'SELECT l.name AS name, g.guide_id AS guide_id FROM channel_guide g JOIN live l ON l.key = g.channel_key ORDER BY l.name',
  );
const programmes = async (e: Awaited<ReturnType<typeof setupGuide>>) =>
  rows(e, 'SELECT guide_id, title FROM programmes ORDER BY guide_id');

describe('guide id beats a name match', () => {
  const playlist = extinf('BBC One', stream(1), 'tvg-id="bbc1.uk"');
  const london = channelXml('bbcone.london', 'BBC One');
  const exact = channelXml('bbc1.uk', 'BBC 1');
  const shows = [
    programmeXml('bbcone.london', HOUR, 1, 'London news'),
    programmeXml('bbc1.uk', HOUR, 1, 'Right show'),
  ];

  it.each([
    ['name first', [london, exact]],
    ['id first', [exact, london]],
  ])('maps the channel by its guide id when the %s', async (_order, channels) => {
    const { e, summary } = await guideFor(playlist, ...channels, ...shows);
    expect(await mapping(e)).toEqual([{ name: 'BBC One', guide_id: 'bbc1.uk' }]);
    expect(await programmes(e)).toEqual([{ guide_id: 'bbc1.uk', title: 'Right show' }]);
    expect(summary.counts).toMatchObject({ mapped: 1, programmes: 1 });
  });

  it('maps no channel that several guide channels name', async () => {
    const { e } = await guideFor(
      extinf('Haber', stream(1)) + extinf('Spor', stream(2)),
      channelXml('haber.a', 'Haber'),
      channelXml('haber.b', 'HABER'),
      channelXml('spor', 'Spor'),
      programmeXml('haber.a', HOUR, 1, 'A'),
      programmeXml('haber.b', HOUR, 1, 'B'),
      programmeXml('spor', HOUR, 1, 'S'),
    );
    expect(await mapping(e)).toEqual([{ name: 'Spor', guide_id: 'spor' }]);
    expect(await programmes(e)).toEqual([{ guide_id: 'spor', title: 'S' }]);
  });

  it('still maps one guide channel to every live channel that shares its id', async () => {
    const { e } = await guideFor(
      extinf('Haber', stream(1), 'tvg-id="h"') + extinf('Haber HD', stream(2), 'tvg-id="h"'),
      channelXml('h', 'Haber'),
      programmeXml('h', HOUR, 1, 'News'),
    );
    expect(await mapping(e)).toEqual([
      { name: 'Haber', guide_id: 'h' },
      { name: 'Haber HD', guide_id: 'h' },
    ]);
  });
});
