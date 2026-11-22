import type { XmltvProgramme } from '@elv/sources';
import { type RunCtx, warn } from './import-run';

/** Length given to a programme with no `stop` when no later programme of its channel closes it. */
const OPEN_END_MS = 30 * 60_000;

/** Parameter row staged into `programmes_next`. */
export type ProgrammeStageRow = (string | number | null)[];

function programmeRow(
  sourceId: string,
  runId: number,
  p: XmltvProgramme,
  stop: number,
): ProgrammeStageRow {
  return [
    sourceId,
    p.channel,
    p.start,
    stop,
    p.title,
    p.subTitle ?? null,
    p.desc ?? null,
    p.categories.length === 0 ? null : JSON.stringify(p.categories),
    p.episodeNum ?? null,
    p.icon ?? null,
    runId,
  ];
}

/** Staged batch rows plus how many entries re-upsert a row from an earlier batch. */
export interface ClampedBatch {
  rows: ProgrammeStageRow[];
  reupserts: number;
}

function emitClampedRow(
  rows: ProgrammeStageRow[],
  inBatchIndex: Map<string, number>,
  inBatchByChannel: Map<string, ProgrammeStageRow[]>,
  lastByChannel: Map<string, ProgrammeStageRow>,
  row: ProgrammeStageRow,
): number {
  const ch = row[1] as string;
  const start = row[2] as number;
  const stop = row[3] as number;
  const prev = lastByChannel.get(ch);
  const track = (r: ProgrammeStageRow) => {
    let list = inBatchByChannel.get(ch);
    if (list === undefined) {
      list = [];
      inBatchByChannel.set(ch, list);
    }
    list.push(r);
  };
  if (prev === undefined) {
    inBatchIndex.set(ch, rows.length);
    rows.push(row);
    track(row);
    lastByChannel.set(ch, row);
    return 0;
  }
  const prevStart = prev[2] as number;
  const prevStop = prev[3] as number;
  if (start === prevStart) {
    const idx = inBatchIndex.get(ch);
    if (idx !== undefined) {
      rows[idx] = row;
      const list = inBatchByChannel.get(ch);
      if (list !== undefined && list.length > 0) list[list.length - 1] = row;
      lastByChannel.set(ch, row);
      return 0;
    }
    inBatchIndex.set(ch, rows.length);
    rows.push(row);
    track(row);
    lastByChannel.set(ch, row);
    return 1;
  }
  if (start > prevStart) {
    let reupserts = 0;
    if (prevStop > start) {
      prev[3] = start;
      if (!inBatchIndex.has(ch)) {
        rows.push(prev);
        track(prev);
        reupserts = 1;
      }
    }
    inBatchIndex.set(ch, rows.length);
    rows.push(row);
    track(row);
    lastByChannel.set(ch, row);
    return reupserts;
  }
  // Out-of-order earlier start: clamp against nearest following start (including prevStart) and clamp any earlier overlapping in-batch row.
  let nextStart = prevStart;
  let dupIdx = -1;
  const list = inBatchByChannel.get(ch);
  if (list !== undefined) {
    for (let i = 0; i < list.length; i += 1) {
      const existing = list[i] as ProgrammeStageRow;
      const eStart = existing[2] as number;
      if (eStart === start) {
        dupIdx = i;
        continue;
      }
      if (eStart > start && eStart < nextStart) nextStart = eStart;
      if (eStart < start && (existing[3] as number) > start) existing[3] = start;
    }
  }
  if (stop > nextStart) row[3] = nextStart;
  if (dupIdx >= 0 && list !== undefined) {
    const existing = list[dupIdx] as ProgrammeStageRow;
    const rowPos = rows.indexOf(existing);
    if (rowPos >= 0) rows[rowPos] = row;
    list[dupIdx] = row;
    return 0;
  }
  rows.push(row);
  track(row);
  return 0;
}

/** Turns a batch into non-overlapping staged rows while tracking cross-batch re-upsert count. */
export function closeOpenProgrammesBatch(
  c: Pick<RunCtx, 'sourceId' | 'runId' | 'warnings' | 'warningCodes'>,
  open: Map<string, XmltvProgramme>,
  programmes: readonly XmltvProgramme[],
  lastByChannel: Map<string, ProgrammeStageRow> = new Map(),
): ClampedBatch {
  const rows: ProgrammeStageRow[] = [];
  const inBatchIndex = new Map<string, number>();
  const inBatchByChannel = new Map<string, ProgrammeStageRow[]>();
  let reupserts = 0;
  for (const p of programmes) {
    if (
      !Number.isFinite(p.start) ||
      (p.stop !== undefined && (!Number.isFinite(p.stop) || p.stop <= p.start))
    ) {
      warn(c, 'programme-bad-time');
      continue;
    }
    const prev = open.get(p.channel);
    if (prev !== undefined) {
      if (p.start > prev.start) {
        open.delete(p.channel);
        reupserts += emitClampedRow(
          rows,
          inBatchIndex,
          inBatchByChannel,
          lastByChannel,
          programmeRow(c.sourceId, c.runId, prev, p.start),
        );
      } else if (p.start === prev.start) {
        open.delete(p.channel);
      } else if (p.stop === undefined) {
        reupserts += emitClampedRow(
          rows,
          inBatchIndex,
          inBatchByChannel,
          lastByChannel,
          programmeRow(c.sourceId, c.runId, p, prev.start),
        );
        continue;
      } else {
        const clampedStop = Math.min(p.stop, prev.start);
        reupserts += emitClampedRow(
          rows,
          inBatchIndex,
          inBatchByChannel,
          lastByChannel,
          programmeRow(c.sourceId, c.runId, p, clampedStop),
        );
        continue;
      }
    }
    if (p.stop === undefined) open.set(p.channel, p);
    else {
      reupserts += emitClampedRow(
        rows,
        inBatchIndex,
        inBatchByChannel,
        lastByChannel,
        programmeRow(c.sourceId, c.runId, p, p.stop),
      );
    }
  }
  return { rows, reupserts };
}

/**
 * Turns a batch into non-overlapping staged rows while guaranteeing `stop > start` for every row.
 * Programmes without `stop` end where the next strictly later programme of their channel starts;
 * overlapping earlier blocks are clamped (`prev.stop = next.start`) and duplicate `(channel, start)`
 * blocks deterministically keep the latest entry; malformed rows with `stop <= start` are skipped
 * with warning `programme-bad-time`.
 */
export function closeOpenProgrammes(
  c: Pick<RunCtx, 'sourceId' | 'runId' | 'warnings' | 'warningCodes'>,
  open: Map<string, XmltvProgramme>,
  programmes: readonly XmltvProgramme[],
  lastByChannel: Map<string, ProgrammeStageRow> = new Map(),
): ProgrammeStageRow[] {
  return closeOpenProgrammesBatch(c, open, programmes, lastByChannel).rows;
}

/** At the end of the scan the programmes still open get a fixed length, clamped against any prior row. */
export function flushOpenProgrammes(
  c: Pick<RunCtx, 'sourceId' | 'runId'>,
  open: Map<string, XmltvProgramme>,
  lastByChannel: Map<string, ProgrammeStageRow>,
): ClampedBatch {
  const rows: ProgrammeStageRow[] = [];
  const inBatchIndex = new Map<string, number>();
  const inBatchByChannel = new Map<string, ProgrammeStageRow[]>();
  let reupserts = 0;
  for (const p of open.values()) {
    reupserts += emitClampedRow(
      rows,
      inBatchIndex,
      inBatchByChannel,
      lastByChannel,
      programmeRow(c.sourceId, c.runId, p, p.start + OPEN_END_MS),
    );
  }
  open.clear();
  return { rows, reupserts };
}
