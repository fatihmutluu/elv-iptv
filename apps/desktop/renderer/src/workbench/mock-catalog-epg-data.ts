interface WorkbenchSlotTemplate {
  readonly title: string;
  readonly subTitle: string | null;
  readonly description: string;
  readonly episodeNum: string | null;
  readonly durationMin: number;
}

export interface WorkbenchChannelSchedule {
  readonly guideId: string;
  readonly offsetMin: number;
  readonly slots: readonly WorkbenchSlotTemplate[];
}

const s = (
  title: string,
  durationMin: number,
  description: string,
  subTitle: string | null = null,
  episodeNum: string | null = null,
): WorkbenchSlotTemplate => ({ title, subTitle, description, episodeNum, durationMin });

/** Synthetic rotating 45–60 min EPG schedules for all 10 UI Workbench live channels (zero third-party brands). */
export const WORKBENCH_SCHEDULES: Readonly<Record<string, WorkbenchChannelSchedule>> = {
  'wb:live:101': {
    guideId: 'wb-guide-101',
    offsetMin: 0,
    slots: [
      s(
        'Silent Horizon: Showcase',
        60,
        'Widescreen restoration with commentary on coastal cinematography.',
        '4K Restoration',
      ),
      s(
        'Amber Courtyard',
        55,
        'Two architects survey a hillside pavilion across an autumn evening.',
        'Festival Pick',
      ),
      s(
        'Signal at Dusk',
        60,
        'A sound recordist tracks echoing harbour foghorns along a northern coast.',
      ),
      s(
        'Glass Meridian',
        50,
        'Courier dispatch across sun-bleached desert relay towers before twilight.',
      ),
      s(
        'Cinema Notes Live',
        45,
        'Curators discuss lighting palettes, film grain, and acoustic scoring.',
        'Studio Talk',
        'S2E04',
      ),
      s(
        'Velvet Late Feature',
        60,
        'Nocturnal anthology set inside an alpine mountain observatory.',
      ),
    ],
  },
  'wb:live:102': {
    guideId: 'wb-guide-102',
    offsetMin: 15,
    slots: [
      s(
        'Harbour Telegraph',
        60,
        'Classic monochrome rail drama restored from studio archival prints.',
        '1954 Archive',
      ),
      s('The Brass Compass', 50, 'Voyage aboard a survey schooner charting remote fjord channels.'),
      s(
        'Matinee Spotlight',
        45,
        'Historical notes on optical lenses and hand-painted backdrops.',
        'Archive Hour',
      ),
      s(
        'Winter Overpass',
        60,
        'Station masters coordinate a midnight freight passage in heavy snow.',
      ),
      s(
        'Clockwork Promenade',
        55,
        'Quiet urban comedy following three watchmakers over a holiday weekend.',
      ),
      s(
        'Silver Reel Encore',
        60,
        'Curated double-feature prelude featuring restored orchestral overtures.',
      ),
    ],
  },
  'wb:live:103': {
    guideId: 'wb-guide-103',
    offsetMin: 30,
    slots: [
      s(
        'Rain on Fourth Pier',
        55,
        'A night watchman deciphers an unmarked shipping ledger on the dock.',
        'Noir Anthology',
        'S1E07',
      ),
      s(
        'Shadow Over Canal Street',
        60,
        'Rain-slicked mystery tracing a missing concert violinist through town.',
      ),
      s(
        'Midnight Dispatch',
        45,
        'Late-night radio drama exploring urban folklore and quiet coastal towns.',
      ),
      s(
        'Fogbound Express',
        60,
        'Strangers share a sleeper car on an unscheduled mountain border crossing.',
      ),
      s(
        'Low Tide Evidence',
        50,
        'An archivist reopens a lighthouse logbook during a winter coastal gale.',
      ),
      s('After Hours Vinyl', 60, 'Slow-burn acoustic sessions captured live in a rehearsal hall.'),
    ],
  },
  'wb:live:104': {
    guideId: 'wb-guide-104',
    offsetMin: 45,
    slots: [
      s(
        'Solstice Chamber Concert',
        60,
        'String quartet performs contemporary suites from the courtyard hall.',
        'Live Stage',
      ),
      s(
        'Backstage Craft',
        45,
        'Lighting designers walk through cue sheets for a touring production.',
        'Behind Stage',
        'S3E02',
      ),
      s(
        'Paper Lanterns: Act One',
        55,
        'Theatrical premiere celebrating local craftspeople and set painters.',
      ),
      s(
        'Chorus in Residence',
        50,
        'Vocal ensemble rehearses maritime folk harmonies under vaulted stone.',
      ),
      s(
        'Playwright Roundtable',
        45,
        'Writers discuss pacing, dialogue rhythm, and minimalist stage blocking.',
      ),
      s(
        'Evening Overture',
        60,
        'Full symphony performance broadcast in uncompressed studio acoustics.',
      ),
    ],
  },
  'wb:live:201': {
    guideId: 'wb-guide-201',
    offsetMin: 10,
    slots: [
      s(
        'Matchday Tactical Preview',
        45,
        'Analysts break down pressing lines, midfield shape, and set pieces.',
        'Pre-Match',
      ),
      s(
        'Northern Cup: First Half',
        60,
        'Live stadium coverage from the coastal arena under evening lights.',
        'Live Fixture',
      ),
      s(
        'Pitch Side Analysis',
        45,
        'Touchline reporters review heatmaps, shot quality, and bench rotations.',
      ),
      s(
        'Continental Highlights',
        55,
        'Extended goal packages and defensive masterclasses across the league.',
      ),
      s(
        'Keeper Lab',
        45,
        'Goalkeeping coaches study positioning angles and distribution accuracy.',
        'Tactics Desk',
        'S4E11',
      ),
      s('Full-Time Replay', 60, 'Complete second-half rerun with multi-angle camera telemetry.'),
    ],
  },
  'wb:live:202': {
    guideId: 'wb-guide-202',
    offsetMin: 25,
    slots: [
      s(
        'Grid Walk & Telemetry',
        45,
        'Engineers examine aero setups, brake cooling, and track surface grip.',
        'Paddock Live',
      ),
      s(
        'Endurance Circuit: Stint 1',
        60,
        'Touring prototypes tackle sweeping elevation changes at dusk.',
        'Live Race',
      ),
      s('Pit Wall Debrief', 50, 'Strategy specialists model undercut windows and compound wear.'),
      s(
        'Alpine Rally Stage',
        55,
        'Onboard cameras follow precision gravel runs along switchback passes.',
      ),
      s(
        'Chassis & Wind Tunnel',
        45,
        'Technical look at suspension geometry and hybrid energy recovery.',
        'Engineering',
        'S2E09',
      ),
      s(
        'Classic Grand Circuit',
        60,
        'Archival motorsport highlights from rain-soaked endurance finales.',
      ),
    ],
  },
  'wb:live:203': {
    guideId: 'wb-guide-203',
    offsetMin: 40,
    slots: [
      s(
        'Center Court Warmup',
        45,
        'Serve speed telemetry and return positioning ahead of first serve.',
        'Court Live',
      ),
      s(
        'Harbour Open: Quarterfinal',
        60,
        'Baseline rallies and net approaches from the outdoor hardcourt arena.',
        'Live Match',
      ),
      s(
        'Fast Break Studio',
        50,
        'Half-court spacing analysis and transition defense highlights tonight.',
      ),
      s(
        'Indoor Arena Showcase',
        60,
        'Full match coverage featuring decisive fifth-set tiebreak tension.',
      ),
      s(
        'Footwork & Rhythm',
        45,
        'Coaches dissect split-step timing and endurance conditioning routines.',
        'Training',
      ),
      s(
        'Tournament Nightcap',
        55,
        'Complete bracket recap, press quotes, and tomorrow order of play.',
      ),
    ],
  },
  'wb:live:301': {
    guideId: 'wb-guide-301',
    offsetMin: 5,
    slots: [
      s(
        'World Desk Briefing',
        60,
        'Top international headlines, maritime logistics, and field dispatches.',
        'Live Desk',
      ),
      s(
        'Civic & Science Hour',
        50,
        'Correspondents report on rail electrification and ocean observatories.',
      ),
      s(
        'Midday Global Forum',
        55,
        'Panel discussion with regional correspondents from four time zones.',
      ),
      s(
        'Cultural Capitals',
        45,
        'Architecture, municipal libraries, and public transit projects worldwide.',
        'Feature',
      ),
      s(
        'Evening Headline Edition',
        60,
        'Comprehensive news summary with live field updates and data graphics.',
      ),
      s(
        'Overnight Wire',
        60,
        'Continuous international bulletins and archival documentary segments.',
      ),
    ],
  },
  'wb:live:302': {
    guideId: 'wb-guide-302',
    offsetMin: 20,
    slots: [
      s(
        'Opening Bell Ledger',
        60,
        'Equities, sovereign yields, and shipping freight indices at market open.',
        'Markets',
      ),
      s(
        'Supply Chain Pulse',
        45,
        'Port throughput metrics, chip fabs, and cold-chain logistics capacity.',
      ),
      s(
        'Energy & Grid Report',
        50,
        'Storage deployments, turbine output, and wholesale power pricing.',
      ),
      s(
        'Closing Desk Summary',
        60,
        'End-of-session sector leaders, currency moves, and earnings calendars.',
      ),
      s(
        'Founders & Makers',
        45,
        'Interviews with industrial designers and cooperative workshop leads.',
        'Enterprise',
        'S5E03',
      ),
      s(
        'Pacific Pre-Market',
        55,
        'Early futures pricing and commodity flows ahead of overseas trading.',
      ),
    ],
  },
  'wb:live:303': {
    guideId: 'wb-guide-303',
    offsetMin: 35,
    slots: [
      s(
        'Continental Radar Loop',
        45,
        'High-resolution precipitation bands, jet stream ridges, and fronts.',
        'Live Radar',
      ),
      s(
        'Coastal & Marine Forecast',
        50,
        'Swell heights, barometric trends, and harbour visibility advisories.',
      ),
      s(
        'Alpine & Valley Outlook',
        45,
        'Freezing level telemetry, mountain pass winds, and snow projections.',
      ),
      s(
        'Climate & Atmosphere Lab',
        60,
        'Meteorologists explain sea-surface anomalies and rainfall patterns.',
        'Science',
      ),
      s(
        'Regional Commuter Weather',
        45,
        'Hour-by-hour temperature curves, wind gusts, and clearing skies.',
      ),
      s(
        'Night Sky & Aurora Watch',
        60,
        'Cloud-cover forecasts paired with geomagnetic visibility bulletins.',
      ),
    ],
  },
};
