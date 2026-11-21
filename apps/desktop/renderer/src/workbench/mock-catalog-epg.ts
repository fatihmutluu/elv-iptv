import {
  type ItemRow,
  MAX_EPG_WINDOW_KEYS,
  MAX_EPG_WINDOW_SPAN_MS,
  MAX_NOW_NEXT_KEYS,
  type NowNextEntry,
  type ProgrammeRow,
} from '@elv/data';
import { DEMO_SOURCE_ID, WORKBENCH_ITEMS_BY_KEY } from './mock-catalog-data.ts';
import { WORKBENCH_SCHEDULES, type WorkbenchChannelSchedule } from './mock-catalog-epg-data.ts';

const MIN_MS = 60_000;
const NOW_NEXT_LOOKAHEAD_MS = 12 * 3_600_000;

function generateWindowForChannel(
  channelKey: string,
  schedule: WorkbenchChannelSchedule,
  sourceId: string,
  fromMs: number,
  toMs: number,
): ProgrammeRow[] {
  const cycleMs = schedule.slots.reduce((sum, item) => sum + item.durationMin * MIN_MS, 0);
  const phaseMs = schedule.offsetMin * MIN_MS;
  const cycleIndex = Math.floor((fromMs - phaseMs) / cycleMs);
  let cursor = cycleIndex * cycleMs + phaseMs;
  const out: ProgrammeRow[] = [];

  while (cursor < toMs) {
    for (const tpl of schedule.slots) {
      const start = cursor;
      const stop = start + tpl.durationMin * MIN_MS;
      cursor = stop;
      if (stop <= fromMs) continue;
      if (start >= toMs) break;
      out.push({
        channelKey,
        sourceId,
        guideId: schedule.guideId,
        start,
        stop,
        title: tpl.title,
        subTitle: tpl.subTitle,
        description: tpl.description,
        episodeNum: tpl.episodeNum,
        icon: null,
      });
    }
  }
  return out;
}

/** Builds deterministic synthetic EPG programmes overlapping `[fromMs, toMs]` for workbench live channels. */
export function buildWorkbenchEpgWindow(
  channelKeys: readonly string[],
  fromMs: number,
  toMs: number,
  sourceId = DEMO_SOURCE_ID,
): Record<string, ProgrammeRow[]> {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs < 0 || toMs <= fromMs) {
    return {};
  }
  const clampedTo = Math.min(toMs, fromMs + MAX_EPG_WINDOW_SPAN_MS);
  const uniqueKeys = [...new Set(channelKeys)].slice(0, MAX_EPG_WINDOW_KEYS);
  const out: Record<string, ProgrammeRow[]> = {};
  for (const key of uniqueKeys) {
    const schedule = WORKBENCH_SCHEDULES[key];
    if (!schedule) continue;
    out[key] = generateWindowForChannel(key, schedule, sourceId, fromMs, clampedTo);
  }
  return out;
}

/** Builds deterministic synthetic Now & Next pairs for workbench live channels at `nowMs`. */
export function buildWorkbenchNowNext(
  channelKeys: readonly string[],
  nowMs: number,
  sourceId = DEMO_SOURCE_ID,
): NowNextEntry[] {
  if (!Number.isFinite(nowMs) || nowMs < 0) return [];
  const uniqueKeys = [...new Set(channelKeys)].slice(0, MAX_NOW_NEXT_KEYS);
  const out: NowNextEntry[] = [];
  for (const key of uniqueKeys) {
    const schedule = WORKBENCH_SCHEDULES[key];
    if (!schedule) continue;
    const list = generateWindowForChannel(
      key,
      schedule,
      sourceId,
      nowMs,
      nowMs + NOW_NEXT_LOOKAHEAD_MS,
    );
    const now = list.find((p) => p.start <= nowMs && p.stop > nowMs) ?? null;
    const nextFloor = now === null ? nowMs : now.stop;
    const next = list.find((p) => p.start >= nextFloor) ?? null;
    out.push({ channelKey: key, now, next });
  }
  return out;
}

/** Looks up a workbench live channel by channel number (`101`–`303`). */
export function findWorkbenchChannelByNumber(num: number, sourceId: string): ItemRow | null {
  if (!Number.isSafeInteger(num) || num < 0) return null;
  for (const row of WORKBENCH_ITEMS_BY_KEY.values()) {
    if (row.kind === 'live' && row.num === num) {
      return { ...row, sourceId };
    }
  }
  return null;
}
