import { describe, expect, it } from 'vitest';
import {
  buildChannelIndex,
  buildChannelIndexAsync,
  matchGuideChannel,
  normalizeGuideName,
  resolveMappings,
  stripFeedId,
} from './guide-match';

const rows = [
  { key: 'a', guide_id: 'haber1.tr', name_fold: 'haber bir', num: 1 },
  { key: 'b', guide_id: 'haber1.tr', name_fold: 'haber bir hd', num: 2 },
  { key: 'c', guide_id: null, name_fold: 'spor iki', num: 10 },
  { key: 'd', guide_id: '', name_fold: 'ikiz', num: 200 },
  { key: 'e', guide_id: null, name_fold: 'ikiz', num: 200 },
  { key: 'f', guide_id: null, name_fold: 'cagri tv', num: 30 },
  { key: 'g', guide_id: null, name_fold: '', num: 101 },
  { key: 'h', guide_id: null, name_fold: 'channel one oh two', num: 102 },
  { key: 'm', guide_id: null, name_fold: 'channel twenty four', num: 24 },
  { key: 'n', guide_id: null, name_fold: 'channel three sixty', num: 360 },
  { key: 'o', guide_id: null, name_fold: 'channel thousand one', num: 1001 },
  { key: 'i', guide_id: null, name_fold: 'bad nums', num: 0 },
  { key: 'j', guide_id: null, name_fold: 'neg num', num: -5 },
  { key: 'k', guide_id: null, name_fold: 'float num', num: 12.5 },
  { key: 'l', guide_id: null, name_fold: 'null num', num: null },
];
const index = buildChannelIndex(rows);
const keys = (id: string, names: string[]) => matchGuideChannel(index, { id, names }).keys;

describe('guide matching', () => {
  it('maps every live channel that shares the guide id', () => {
    const match = matchGuideChannel(index, { id: 'haber1.tr', names: ['Other'] });
    expect(match.byId).toBe(true);
    expect(match.tier).toBe('id');
    expect(match.keys.sort()).toEqual(['a', 'b']);
  });

  it('falls back to a unique folded name', () => {
    expect(matchGuideChannel(index, { id: 'x', names: ['SPOR  İKİ'] })).toEqual({
      keys: ['c'],
      byId: false,
      tier: 'name',
    });
  });

  it('folds case and Turkish letters', () => {
    expect(keys('x', ['ÇAĞRI TV'])).toEqual(['f']);
  });

  it('ambiguous names are skipped', () => {
    expect(keys('x', ['Ikiz'])).toEqual([]);
  });

  it('skips an ambiguous name but accepts another unique one', () => {
    expect(keys('x', ['Ikiz', 'Spor Iki'])).toEqual(['c']);
  });

  it('refuses names that point at different channels without falling back to num', () => {
    expect(matchGuideChannel(index, { id: 'x', names: ['Spor Iki', 'Cagri TV', '101'] })).toEqual({
      keys: [],
      byId: false,
      tier: 'none',
    });
  });

  it('ignores empty names and unknown channels', () => {
    expect(matchGuideChannel(index, { id: 'x', names: ['', '!!!', 'Nope'] })).toEqual({
      keys: [],
      byId: false,
      tier: 'none',
    });
  });

  it('falls back to a unique channel number from exact, #-prefixed, or delimiter-separated display names', () => {
    expect(matchGuideChannel(index, { id: 'x', names: ['101'] })).toEqual({
      keys: ['g'],
      byId: false,
      tier: 'num',
    });
    expect(matchGuideChannel(index, { id: 'x', names: ['#101'] })).toEqual({
      keys: ['g'],
      byId: false,
      tier: 'num',
    });
    expect(matchGuideChannel(index, { id: 'x', names: ['#101 Sports'] })).toEqual({
      keys: ['g'],
      byId: false,
      tier: 'num',
    });
    expect(matchGuideChannel(index, { id: 'x', names: ['101 - Sports'] })).toEqual({
      keys: ['g'],
      byId: false,
      tier: 'num',
    });
    expect(matchGuideChannel(index, { id: 'x', names: ['#101 - Sports HD'] })).toEqual({
      keys: ['g'],
      byId: false,
      tier: 'num',
    });
    expect(matchGuideChannel(index, { id: 'x', names: ['101: News', '101'] })).toEqual({
      keys: ['g'],
      byId: false,
      tier: 'num',
    });
    expect(matchGuideChannel(index, { id: 'x', names: ['102 | Cinema'] })).toEqual({
      keys: ['h'],
      byId: false,
      tier: 'num',
    });
  });

  it('does not treat bare space-separated numeric brand names as channel numbers', () => {
    for (const brand of ['24 News', '360 TV', '1001 Nights', '101 Sports']) {
      expect(matchGuideChannel(index, { id: 'x', names: [brand] })).toEqual({
        keys: [],
        byId: false,
        tier: 'none',
      });
    }
  });

  it('prefers byId over byName and byName over byNum', () => {
    expect(matchGuideChannel(index, { id: 'haber1.tr', names: ['Spor Iki', '101'] })).toMatchObject(
      { byId: true, tier: 'id' },
    );
    expect(matchGuideChannel(index, { id: 'x', names: ['101', 'Spor Iki'] })).toEqual({
      keys: ['c'],
      byId: false,
      tier: 'name',
    });
  });

  it('rejects ambiguous live channel numbers, conflicting display-name numbers, and non-channel tokens', () => {
    // Two live channels share num = 200
    expect(matchGuideChannel(index, { id: 'x', names: ['200', '200 - Twin'] })).toEqual({
      keys: [],
      byId: false,
      tier: 'none',
    });
    // Conflicting numbers pointing to two different live channels (101 -> g, 102 -> h)
    expect(matchGuideChannel(index, { id: 'x', names: ['101', '102'] })).toEqual({
      keys: [],
      byId: false,
      tier: 'none',
    });
    // Conflicting extracted numbers where one is ambiguous (200) or absent (999) still refuse to guess
    expect(matchGuideChannel(index, { id: 'x', names: ['200', '101'] })).toEqual({
      keys: [],
      byId: false,
      tier: 'none',
    });
    expect(matchGuideChannel(index, { id: 'x', names: ['999', '101'] })).toEqual({
      keys: [],
      byId: false,
      tier: 'none',
    });
    // Non-positive, invalid, or non-channel-number prefixes never match
    expect(keys('x', ['0', '-5', '101:30 News', '101/7', '101p HD'])).toEqual([]);
    expect(index.byNum.has(0)).toBe(false);
    expect(index.byNum.has(-5)).toBe(false);
    // Positive finite decimal sub-channel numbers ARE supported (#431)
    expect(index.byNum.has(12.5)).toBe(true);
    expect(matchGuideChannel(index, { id: 'x', names: ['12.5'] })).toEqual({
      keys: ['k'],
      byId: false,
      tier: 'num',
    });
  });

  it('supports decimal sub-channel numbers (e.g. 4.1, 10.2) and rejects NaN/Infinity (#431)', () => {
    const decIndex = buildChannelIndex([
      { key: 'c41', guide_id: null, name_fold: 'local news', num: 4.1 },
      { key: 'c102', guide_id: null, name_fold: 'classic cinema', num: 10.2 },
      { key: 'cnan', guide_id: null, name_fold: 'nan ch', num: Number.NaN },
      { key: 'cinf', guide_id: null, name_fold: 'inf ch', num: Number.POSITIVE_INFINITY },
    ]);
    expect(matchGuideChannel(decIndex, { id: 'x', names: ['4.1'] })).toEqual({
      keys: ['c41'],
      byId: false,
      tier: 'num',
    });
    expect(matchGuideChannel(decIndex, { id: 'x', names: ['#4.1 Local'] })).toEqual({
      keys: ['c41'],
      byId: false,
      tier: 'num',
    });
    expect(matchGuideChannel(decIndex, { id: 'x', names: ['10.2 - Classic'] })).toEqual({
      keys: ['c102'],
      byId: false,
      tier: 'num',
    });
    expect(decIndex.byNum.size).toBe(2);
  });
});

describe('resolveMappings', () => {
  it('lets an id match win over a name match in either order', () => {
    expect(resolveMappings([['k', 'exact']], [['k', 'named']])).toEqual([['k', 'exact']]);
  });

  it('enforces strict 3-tier precedence: byId > byName > byNum', () => {
    expect(
      resolveMappings(
        [['k1', 'id-winner']],
        [
          ['k1', 'name-loser'],
          ['k2', 'name-winner'],
        ],
        [
          ['k1', 'num-loser-1'],
          ['k2', 'num-loser-2'],
          ['k3', 'num-winner'],
          ['k3', 'num-winner'],
        ],
      ),
    ).toEqual([
      ['k1', 'id-winner'],
      ['k2', 'name-winner'],
      ['k3', 'num-winner'],
    ]);
  });

  it('drops a channel that several guide channels claim by number', () => {
    expect(
      resolveMappings(
        [],
        [],
        [
          ['k', 'guide-a'],
          ['k', 'guide-b'],
          ['m', 'guide-c'],
        ],
      ),
    ).toEqual([['m', 'guide-c']]);
  });

  it('drops a channel that several guide channels name and keeps repeated names of one', () => {
    expect(
      resolveMappings(
        [],
        [
          ['k', 'one'],
          ['k', 'two'],
          ['m', 'same'],
          ['m', 'same'],
        ],
      ),
    ).toEqual([['m', 'same']]);
  });

  it('keeps the first id match of a channel', () => {
    expect(
      resolveMappings(
        [
          ['k', 'first'],
          ['k', 'second'],
        ],
        [],
      ),
    ).toEqual([['k', 'first']]);
  });
});

describe('@feedId sub-feed matching (#181)', () => {
  it('strips @feedId suffixes without mangling ids lacking a base prefix', () => {
    expect(stripFeedId('Channel.uk@East')).toBe('Channel.uk');
    expect(stripFeedId('Channel.uk@East@HD')).toBe('Channel.uk');
    expect(stripFeedId('Channel.uk')).toBe('Channel.uk');
    expect(stripFeedId('@East')).toBe('@East');
    expect(stripFeedId('')).toBe('');
  });

  it('prefers exact guide_id over @feedId base fallback and falls back strictly above name/num', () => {
    const feedIndex = buildChannelIndex([
      { key: 'exact-east', guide_id: 'Channel.uk@East', name_fold: 'channel east', num: 10 },
      { key: 'base-only', guide_id: 'Channel.uk', name_fold: 'channel base', num: 11 },
      { key: 'west-live', guide_id: 'Metro.us@West', name_fold: 'metro west', num: 12 },
      { key: 'named-target', guide_id: null, name_fold: 'metro feed', num: 13 },
    ]);

    // Exact match wins strictly and does not pull in base-only
    expect(matchGuideChannel(feedIndex, { id: 'Channel.uk@East', names: ['Metro Feed'] })).toEqual({
      keys: ['exact-east'],
      byId: true,
      tier: 'id',
    });

    // Exact base match wins strictly and does not pull in exact-east
    expect(matchGuideChannel(feedIndex, { id: 'Channel.uk', names: [] })).toEqual({
      keys: ['base-only'],
      byId: true,
      tier: 'id',
    });

    // Missing exact @feedId falls back to base guide id (matches all sharing base)
    const fallback = matchGuideChannel(feedIndex, {
      id: 'Channel.uk@West',
      names: ['Metro Feed', '13'],
    });
    expect(fallback.byId).toBe(true);
    expect(fallback.tier).toBe('id');
    expect(fallback.keys.sort()).toEqual(['base-only', 'exact-east']);

    // Bare guide id in XMLTV matches live channel whose guide_id carries @feedId
    expect(matchGuideChannel(feedIndex, { id: 'Metro.us', names: ['Metro Feed', '13'] })).toEqual({
      keys: ['west-live'],
      byId: true,
      tier: 'id',
    });
  });

  it('matches case-insensitive guide_id strictly below exact guide_id and above @feedId base fallback (#121, #431)', () => {
    const ciIndex = buildChannelIndex([
      { key: 'live-ci', guide_id: 'BBC1.UK', name: 'BBC One', name_fold: 'bbc one', num: 1 },
      { key: 'live-base', guide_id: 'CHAN.US', name: 'Chan East', name_fold: 'chan east', num: 2 },
    ]);
    expect(matchGuideChannel(ciIndex, { id: 'bbc1.uk', names: ['Other'] })).toEqual({
      keys: ['live-ci'],
      byId: true,
      tier: 'id',
    });
    expect(matchGuideChannel(ciIndex, { id: 'chan.us@East', names: ['Other'] })).toEqual({
      keys: ['live-base'],
      byId: true,
      tier: 'id',
    });
  });

  it('disambiguates regional @feedId feeds by live channel name token and lexicographical tie-break (#431)', () => {
    const channelNameFolds = new Map([
      ['k-east', 'chan east hd'],
      ['k-west', 'chan west hd'],
      ['k-plain', 'chan main'],
    ]);
    // Regardless of XMLTV arrival order (West before East vs East before West), results are deterministic
    for (const order of [
      [
        ['k-east', 'Chan.us@West'],
        ['k-west', 'Chan.us@West'],
        ['k-plain', 'Chan.us@West'],
        ['k-east', 'Chan.us@East'],
        ['k-west', 'Chan.us@East'],
        ['k-plain', 'Chan.us@East'],
      ],
      [
        ['k-east', 'Chan.us@East'],
        ['k-west', 'Chan.us@East'],
        ['k-plain', 'Chan.us@East'],
        ['k-east', 'Chan.us@West'],
        ['k-west', 'Chan.us@West'],
        ['k-plain', 'Chan.us@West'],
      ],
    ] as const) {
      const resolved = resolveMappings([], [], [], [], {
        byBaseId: order,
        channelNameFolds,
      });
      expect(new Map(resolved)).toEqual(
        new Map([
          ['k-east', 'Chan.us@East'],
          ['k-west', 'Chan.us@West'],
          ['k-plain', 'Chan.us@East'],
        ]),
      );
    }

    // Precedence: exact byId > case-insensitive byCiId > byBaseId > byName > byNormalizedName > byNum
    expect(
      resolveMappings(
        [['k1', 'Exact.ID']],
        [['k4', 'Name.ID']],
        [['k6', 'Num.ID']],
        [['k5', 'Norm.ID']],
        {
          byCiId: [
            ['k1', 'exact.id'],
            ['k2', 'ci.id'],
          ],
          byBaseId: [
            ['k2', 'ci.id@East'],
            ['k3', 'base.id@West'],
            ['k3', 'base.id@East'],
          ],
          channelNameFolds: new Map([['k3', 'base main']]),
        },
      ),
    ).toEqual([
      ['k1', 'Exact.ID'],
      ['k2', 'ci.id'],
      ['k3', 'base.id@East'],
      ['k4', 'Name.ID'],
      ['k5', 'Norm.ID'],
      ['k6', 'Num.ID'],
    ]);
  });
});

describe('call-sign preserving normalized name matching (#267)', () => {
  it('preserves 3-5 uppercase ASCII call signs while stripping bracket tags, non-callsign parens, and broadcast noise', () => {
    expect(normalizeGuideName('Metro One [HD] (XELV) East')).toBe('metro one xelv');
    expect(normalizeGuideName('Metro One [US] [Backup] (ZTVA) 1080p 24/7')).toBe('metro one ztva');
    expect(normalizeGuideName('Harbor News (ZELVX) (Backup) West 720p UHD FHD HD SD 480p')).toBe(
      'harbor news zelvx',
    );
    expect(normalizeGuideName('Metro One (East) (HD) (US) (xelv) (AB) (ABCDEF) (Q123)')).toBe(
      'metro one',
    );
    expect(normalizeGuideName('Metro One (EAST) (UHD) (FHD)')).toBe('metro one');
    expect(normalizeGuideName('[HD] East West 24/7 1080p')).toBe('');
    expect(normalizeGuideName('Çağrı TV [FHD]')).toBe('cagri tv');
  });

  it('checks exact byFold first, then unambiguous normalized name before num fallback', () => {
    const callIndex = buildChannelIndex([
      {
        key: 'xelv',
        guide_id: null,
        name: 'Metro One [HD] (XELV) East',
        name_fold: 'metro one hd xelv east',
        num: 4,
      },
      {
        key: 'ztva',
        guide_id: null,
        name: 'Metro One [HD] (ZTVA) West',
        name_fold: 'metro one hd ztva west',
        num: 5,
      },
      {
        key: 'exact-hd',
        guide_id: null,
        name: 'Harbor News HD',
        name_fold: 'harbor news hd',
        num: 6,
      },
      {
        key: 'exact-sd',
        guide_id: null,
        name: 'Harbor News',
        name_fold: 'harbor news',
        num: 7,
      },
      {
        key: 'num-only',
        guide_id: null,
        name: 'Number Fallback',
        name_fold: 'number fallback',
        num: 99,
      },
    ]);

    // Call sign preserved: distinguishes XELV vs ZTVA and beats num fallback
    expect(matchGuideChannel(callIndex, { id: 'x1', names: ['Metro One (XELV)', '99'] })).toEqual({
      keys: ['xelv'],
      byId: false,
      tier: 'normalized-name',
    });
    expect(
      matchGuideChannel(callIndex, { id: 'x2', names: ['Metro One (ZTVA) [FHD] 1080p'] }),
    ).toEqual({
      keys: ['ztva'],
      byId: false,
      tier: 'normalized-name',
    });

    // Exact byFold still wins cleanly even when two live channels share a normalized name
    expect(matchGuideChannel(callIndex, { id: 'x3', names: ['Harbor News HD'] })).toEqual({
      keys: ['exact-hd'],
      byId: false,
      tier: 'name',
    });
    expect(matchGuideChannel(callIndex, { id: 'x4', names: ['Harbor News'] })).toEqual({
      keys: ['exact-sd'],
      byId: false,
      tier: 'name',
    });

    // Ambiguous normalized name (matches both exact-hd and exact-sd) does not guess
    expect(matchGuideChannel(callIndex, { id: 'x5', names: ['Harbor News [FHD]'] })).toEqual({
      keys: [],
      byId: false,
      tier: 'none',
    });

    // Conflicting normalized names pointing at different live channels do not fall back to num
    expect(
      matchGuideChannel(callIndex, {
        id: 'x6',
        names: ['Metro One (XELV)', 'Metro One (ZTVA)', '99'],
      }),
    ).toEqual({
      keys: [],
      byId: false,
      tier: 'none',
    });
  });

  it('orders resolveMappings strictly as byId > byName > byNormalizedName > byNum', () => {
    expect(
      resolveMappings(
        [['k1', 'id-winner']],
        [['k2', 'exact-name-winner']],
        [
          ['k2', 'num-loser'],
          ['k3', 'num-loser'],
          ['k4', 'num-winner'],
        ],
        [
          ['k1', 'norm-loser-id'],
          ['k2', 'norm-loser-exact'],
          ['k3', 'norm-winner'],
        ],
      ),
    ).toEqual([
      ['k1', 'id-winner'],
      ['k2', 'exact-name-winner'],
      ['k3', 'norm-winner'],
      ['k4', 'num-winner'],
    ]);
  });
});

describe('CamelCase and English number-word EPG matching (#194)', () => {
  it('matches CamelCase and English number-word channel names against spaced numeric guide names', () => {
    const idx = buildChannelIndex([
      { key: 'news1', guide_id: null, name: 'NewsOne HD', name_fold: 'newsone hd', num: 1 },
      {
        key: 'sports2',
        guide_id: null,
        name: 'SportsTV2 [FHD]',
        name_fold: 'sportstv2 fhd',
        num: 2,
      },
      { key: 'tr3', guide_id: null, name: 'ÇağrıTV Three', name_fold: 'cagritv three', num: 3 },
      { key: 'num-only', guide_id: null, name: 'Unrelated', name_fold: 'unrelated', num: 50 },
    ]);

    expect(matchGuideChannel(idx, { id: 'g1', names: ['News 1'] })).toEqual({
      keys: ['news1'],
      byId: false,
      tier: 'normalized-name',
    });
    expect(matchGuideChannel(idx, { id: 'g2', names: ['Sports TV Two'] })).toEqual({
      keys: ['sports2'],
      byId: false,
      tier: 'normalized-name',
    });
    expect(matchGuideChannel(idx, { id: 'g3', names: ['Cagri TV 3'] })).toEqual({
      keys: ['tr3'],
      byId: false,
      tier: 'normalized-name',
    });
  });

  it('refuses ambiguous CamelCase/number-word matches without falling back to num', () => {
    const idx = buildChannelIndex([
      { key: 'n1a', guide_id: null, name: 'NewsOne HD', name_fold: 'newsone hd', num: 10 },
      { key: 'n1b', guide_id: null, name: 'News 1 SD', name_fold: 'news 1 sd', num: 11 },
      { key: 'other', guide_id: null, name: 'Other', name_fold: 'other', num: 77 },
    ]);
    expect(matchGuideChannel(idx, { id: 'g', names: ['News One', '77'] })).toEqual({
      keys: ['other'],
      byId: false,
      tier: 'num',
    });
    expect(matchGuideChannel(idx, { id: 'g', names: ['News One'] })).toEqual({
      keys: [],
      byId: false,
      tier: 'none',
    });
  });

  it('buildChannelIndexAsync yields between chunks and matches sync buildChannelIndex (#478)', async () => {
    const sample = [
      { key: 'c1', guide_id: 'g1', name: 'NewsOne 1080p', name_fold: 'newsone 1080p', num: 1 },
      {
        key: 'c2',
        guide_id: null,
        name: 'SportsTV2 [HD] (24/7)',
        name_fold: 'sportstv2 hd 24 7',
        num: 2,
      },
      { key: 'c3', guide_id: 'g3@East', name: 'ÇağrıTV3', name_fold: 'cagritv3', num: 3 },
      { key: 'c4', guide_id: 'g4', name: 'CinemaFour', name_fold: 'cinemafour', num: 4 },
      { key: 'c5', guide_id: 'g5', name: 'DocFive', name_fold: 'docfive', num: 5 },
    ];
    let yields = 0;
    const asyncIdx = await buildChannelIndexAsync(
      sample,
      {
        yieldNow: async () => {
          yields += 1;
        },
      },
      2,
    );
    expect(yields).toBe(2);
    expect(asyncIdx).toEqual(buildChannelIndex(sample));
  });
});
