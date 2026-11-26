import type { ReactElement } from 'react';
import { StyleSheet, View } from 'react-native';
import type { SvgAdapterProps } from '../adapters';
import type { IconShape } from './paths';

interface Point {
  readonly x: number;
  readonly y: number;
}

const VIEWBOX_SIZE = 24;
const CUBIC_STEPS = 8;
const QUAD_STEPS = 6;
const MAX_CACHE_ENTRIES = 512;

const pathCache = new Map<string, readonly (readonly Point[])[]>();

function vectorAngle(ux: number, uy: number, vx: number, vy: number): number {
  const dot = ux * vx + uy * vy;
  const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
  if (len === 0) return 0;
  const cos = Math.max(-1, Math.min(1, dot / len));
  const sign = ux * vy - uy * vx < 0 ? -1 : 1;
  return sign * Math.acos(cos);
}

function sampleEllipticalArc(
  x1: number,
  y1: number,
  rxIn: number,
  ryIn: number,
  xAxisRotDeg: number,
  largeArc: boolean,
  sweep: boolean,
  x2: number,
  y2: number,
): Point[] {
  if (x1 === x2 && y1 === y2) return [];
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0) return [{ x: x2, y: y2 }];

  const phi = (xAxisRotDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx2 = (x1 - x2) / 2;
  const dy2 = (y1 - y2) / 2;
  const x1p = cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;

  const x1p2 = x1p * x1p;
  const y1p2 = y1p * y1p;
  let rx2 = rx * rx;
  let ry2 = ry * ry;

  const lambda = x1p2 / rx2 + y1p2 / ry2;
  if (lambda > 1) {
    const scale = Math.sqrt(lambda);
    rx *= scale;
    ry *= scale;
    rx2 = rx * rx;
    ry2 = ry * ry;
  }

  const num = Math.max(0, rx2 * ry2 - rx2 * y1p2 - ry2 * x1p2);
  const den = rx2 * y1p2 + ry2 * x1p2;
  const coef = (largeArc === sweep ? -1 : 1) * Math.sqrt(den > 0 ? num / den : 0);
  const cxp = coef * ((rx * y1p) / ry);
  const cyp = coef * (-(ry * x1p) / rx);

  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;

  const theta1 = vectorAngle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dTheta = vectorAngle(
    (x1p - cxp) / rx,
    (y1p - cyp) / ry,
    (-x1p - cxp) / rx,
    (-y1p - cyp) / ry,
  );
  if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
  if (sweep && dTheta < 0) dTheta += 2 * Math.PI;

  const steps = Math.max(4, Math.min(16, Math.ceil(Math.abs(dTheta) / (Math.PI / 6))));
  const pts: Point[] = [];
  for (let i = 1; i <= steps; i += 1) {
    const t = theta1 + (dTheta * i) / steps;
    const cosT = Math.cos(t);
    const sinT = Math.sin(t);
    pts.push({
      x: cosPhi * rx * cosT - sinPhi * ry * sinT + cx,
      y: sinPhi * rx * cosT + cosPhi * ry * sinT + cy,
    });
  }
  return pts;
}

class PathCursor {
  private pos = 0;
  private readonly src: string;

  constructor(d: string) {
    this.src = d;
  }

  private skipSeparators(): void {
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
        this.pos += 1;
      } else {
        break;
      }
    }
  }

  hasMore(): boolean {
    this.skipSeparators();
    return this.pos < this.src.length;
  }

  peekCommand(): string | null {
    this.skipSeparators();
    const ch = this.src[this.pos];
    if (ch !== undefined && /[A-Za-z]/.test(ch)) {
      return ch;
    }
    return null;
  }

  readCommand(): string {
    this.skipSeparators();
    const ch = this.src[this.pos] ?? '';
    this.pos += 1;
    return ch;
  }

  readFlag(): boolean | null {
    this.skipSeparators();
    const ch = this.src[this.pos];
    if (ch === '0' || ch === '1') {
      this.pos += 1;
      return ch === '1';
    }
    return null;
  }

  readNumber(): number | null {
    this.skipSeparators();
    const slice = this.src.slice(this.pos);
    const match = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(slice);
    if (!match) return null;
    this.pos += match[0].length;
    const parsed = Number(match[0]);
    return Number.isFinite(parsed) ? parsed : null;
  }
}

/**
 * Parses an SVG path `d` string into tessellated polylines in viewBox coordinates.
 * Supports `M/m`, `L/l`, `H/h`, `V/v`, `C/c`, `S/s`, `Q/q`, `T/t`, `A/a`, and `Z/z`.
 */
export function parseSvgPathPolylines(d: string): readonly (readonly Point[])[] {
  const cached = pathCache.get(d);
  if (cached !== undefined) return cached;

  const cursor = new PathCursor(d);
  const polylines: Point[][] = [];
  let current: Point[] | null = null;
  let cmd = '';
  let curX = 0;
  let curY = 0;
  let startX = 0;
  let startY = 0;
  let lastCubicCpX = 0;
  let lastCubicCpY = 0;
  let lastQuadCpX = 0;
  let lastQuadCpY = 0;
  let prevCmd = '';

  const pushPoint = (x: number, y: number) => {
    if (current === null) {
      current = [{ x: curX, y: curY }];
      polylines.push(current);
    }
    current.push({ x, y });
  };

  while (cursor.hasMore()) {
    const nextCmd = cursor.peekCommand();
    if (nextCmd !== null) {
      cmd = cursor.readCommand();
    } else if (cmd === '') {
      break;
    }

    const upper = cmd.toUpperCase();
    const rel = cmd !== upper;

    if (upper === 'Z') {
      if (current !== null && (curX !== startX || curY !== startY)) {
        current.push({ x: startX, y: startY });
      }
      curX = startX;
      curY = startY;
      prevCmd = upper;
      cmd = '';
      continue;
    }

    if (upper === 'M') {
      const x = cursor.readNumber();
      const y = cursor.readNumber();
      if (x === null || y === null) break;
      curX = rel ? curX + x : x;
      curY = rel ? curY + y : y;
      startX = curX;
      startY = curY;
      current = [{ x: curX, y: curY }];
      polylines.push(current);
      prevCmd = upper;
      cmd = rel ? 'l' : 'L';
      continue;
    }

    if (upper === 'L') {
      const x = cursor.readNumber();
      const y = cursor.readNumber();
      if (x === null || y === null) break;
      curX = rel ? curX + x : x;
      curY = rel ? curY + y : y;
      pushPoint(curX, curY);
      prevCmd = upper;
      continue;
    }

    if (upper === 'H') {
      const x = cursor.readNumber();
      if (x === null) break;
      curX = rel ? curX + x : x;
      pushPoint(curX, curY);
      prevCmd = upper;
      continue;
    }

    if (upper === 'V') {
      const y = cursor.readNumber();
      if (y === null) break;
      curY = rel ? curY + y : y;
      pushPoint(curX, curY);
      prevCmd = upper;
      continue;
    }

    if (upper === 'C') {
      const x1 = cursor.readNumber();
      const y1 = cursor.readNumber();
      const x2 = cursor.readNumber();
      const y2 = cursor.readNumber();
      const x = cursor.readNumber();
      const y = cursor.readNumber();
      if (x1 === null || y1 === null || x2 === null || y2 === null || x === null || y === null) {
        break;
      }
      const p0x = curX;
      const p0y = curY;
      const p1x = rel ? p0x + x1 : x1;
      const p1y = rel ? p0y + y1 : y1;
      const p2x = rel ? p0x + x2 : x2;
      const p2y = rel ? p0y + y2 : y2;
      const p3x = rel ? p0x + x : x;
      const p3y = rel ? p0y + y : y;
      for (let i = 1; i <= CUBIC_STEPS; i += 1) {
        const t = i / CUBIC_STEPS;
        const u = 1 - t;
        const px = u * u * u * p0x + 3 * u * u * t * p1x + 3 * u * t * t * p2x + t * t * t * p3x;
        const py = u * u * u * p0y + 3 * u * u * t * p1y + 3 * u * t * t * p2y + t * t * t * p3y;
        pushPoint(px, py);
      }
      lastCubicCpX = p2x;
      lastCubicCpY = p2y;
      curX = p3x;
      curY = p3y;
      prevCmd = upper;
      continue;
    }

    if (upper === 'S') {
      const x2 = cursor.readNumber();
      const y2 = cursor.readNumber();
      const x = cursor.readNumber();
      const y = cursor.readNumber();
      if (x2 === null || y2 === null || x === null || y === null) break;
      const p0x = curX;
      const p0y = curY;
      const p1x = prevCmd === 'C' || prevCmd === 'S' ? 2 * p0x - lastCubicCpX : p0x;
      const p1y = prevCmd === 'C' || prevCmd === 'S' ? 2 * p0y - lastCubicCpY : p0y;
      const p2x = rel ? p0x + x2 : x2;
      const p2y = rel ? p0y + y2 : y2;
      const p3x = rel ? p0x + x : x;
      const p3y = rel ? p0y + y : y;
      for (let i = 1; i <= CUBIC_STEPS; i += 1) {
        const t = i / CUBIC_STEPS;
        const u = 1 - t;
        const px = u * u * u * p0x + 3 * u * u * t * p1x + 3 * u * t * t * p2x + t * t * t * p3x;
        const py = u * u * u * p0y + 3 * u * u * t * p1y + 3 * u * t * t * p2y + t * t * t * p3y;
        pushPoint(px, py);
      }
      lastCubicCpX = p2x;
      lastCubicCpY = p2y;
      curX = p3x;
      curY = p3y;
      prevCmd = upper;
      continue;
    }

    if (upper === 'Q') {
      const x1 = cursor.readNumber();
      const y1 = cursor.readNumber();
      const x = cursor.readNumber();
      const y = cursor.readNumber();
      if (x1 === null || y1 === null || x === null || y === null) break;
      const p0x = curX;
      const p0y = curY;
      const p1x = rel ? p0x + x1 : x1;
      const p1y = rel ? p0y + y1 : y1;
      const p2x = rel ? p0x + x : x;
      const p2y = rel ? p0y + y : y;
      for (let i = 1; i <= QUAD_STEPS; i += 1) {
        const t = i / QUAD_STEPS;
        const u = 1 - t;
        pushPoint(
          u * u * p0x + 2 * u * t * p1x + t * t * p2x,
          u * u * p0y + 2 * u * t * p1y + t * t * p2y,
        );
      }
      lastQuadCpX = p1x;
      lastQuadCpY = p1y;
      curX = p2x;
      curY = p2y;
      prevCmd = upper;
      continue;
    }

    if (upper === 'T') {
      const x = cursor.readNumber();
      const y = cursor.readNumber();
      if (x === null || y === null) break;
      const p0x = curX;
      const p0y = curY;
      const p1x = prevCmd === 'Q' || prevCmd === 'T' ? 2 * p0x - lastQuadCpX : p0x;
      const p1y = prevCmd === 'Q' || prevCmd === 'T' ? 2 * p0y - lastQuadCpY : p0y;
      const p2x = rel ? p0x + x : x;
      const p2y = rel ? p0y + y : y;
      for (let i = 1; i <= QUAD_STEPS; i += 1) {
        const t = i / QUAD_STEPS;
        const u = 1 - t;
        pushPoint(
          u * u * p0x + 2 * u * t * p1x + t * t * p2x,
          u * u * p0y + 2 * u * t * p1y + t * t * p2y,
        );
      }
      lastQuadCpX = p1x;
      lastQuadCpY = p1y;
      curX = p2x;
      curY = p2y;
      prevCmd = upper;
      continue;
    }

    if (upper === 'A') {
      const rx = cursor.readNumber();
      const ry = cursor.readNumber();
      const rot = cursor.readNumber();
      const largeArc = cursor.readFlag();
      const sweep = cursor.readFlag();
      const x = cursor.readNumber();
      const y = cursor.readNumber();
      if (
        rx === null ||
        ry === null ||
        rot === null ||
        largeArc === null ||
        sweep === null ||
        x === null ||
        y === null
      ) {
        break;
      }
      const nextX = rel ? curX + x : x;
      const nextY = rel ? curY + y : y;
      const pts = sampleEllipticalArc(curX, curY, rx, ry, rot, largeArc, sweep, nextX, nextY);
      for (const pt of pts) pushPoint(pt.x, pt.y);
      curX = nextX;
      curY = nextY;
      prevCmd = upper;
      continue;
    }

    break;
  }

  if (pathCache.size >= MAX_CACHE_ENTRIES) {
    pathCache.clear();
  }
  pathCache.set(d, polylines);
  return polylines;
}

function renderFilledPolygonSlices(
  polyline: readonly Point[],
  scale: number,
  color: string,
  keyPrefix: string,
): ReactElement[] {
  if (polyline.length < 3) return [];
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const pt of polyline) {
    if (pt.y < minY) minY = pt.y;
    if (pt.y > maxY) maxY = pt.y;
  }
  const heightPx = (maxY - minY) * scale;
  if (heightPx <= 0.5) return [];
  const rows = Math.max(3, Math.min(24, Math.ceil(heightPx / 1.25)));
  const stepY = (maxY - minY) / rows;
  const bandHeight = Math.max(1.2, stepY * scale + 0.5);
  const nodes: ReactElement[] = [];

  for (let row = 0; row < rows; row += 1) {
    const sampleY = minY + (row + 0.5) * stepY;
    const intersections: number[] = [];
    for (let i = 0; i < polyline.length; i += 1) {
      const a = polyline[i];
      const b = polyline[(i + 1) % polyline.length];
      if (!a || !b) continue;
      if ((a.y <= sampleY && b.y > sampleY) || (b.y <= sampleY && a.y > sampleY)) {
        const ratio = (sampleY - a.y) / (b.y - a.y);
        intersections.push(a.x + ratio * (b.x - a.x));
      }
    }
    intersections.sort((a, b) => a - b);
    for (let i = 0; i + 1 < intersections.length; i += 2) {
      const xStart = intersections[i];
      const xEnd = intersections[i + 1];
      if (xStart === undefined || xEnd === undefined) continue;
      const spanW = (xEnd - xStart) * scale;
      if (spanW <= 0.25) continue;
      nodes.push(
        <View
          key={`${keyPrefix}-f-${row}-${i}`}
          pointerEvents="none"
          style={[
            styles.abs,
            {
              left: xStart * scale,
              top: (sampleY - stepY / 2) * scale,
              width: spanW,
              height: bandHeight,
              backgroundColor: color,
            },
          ]}
        />,
      );
    }
  }
  return nodes;
}

function renderNativeShape(
  shape: IconShape,
  shapeIndex: number,
  scale: number,
  color: string,
  specFilled: boolean,
  defaultStrokeWidth: number,
): ReactElement[] {
  const isFilled = shape.fill === 'currentColor' || (shape.fill === undefined && specFilled);
  const swPx = Math.max(1, (shape.strokeWidth ?? defaultStrokeWidth) * scale);

  if (shape.kind === 'circle') {
    if (isFilled) {
      const rPx = Math.max(0.8, shape.r * scale);
      return [
        <View
          key={`c-${shapeIndex}`}
          pointerEvents="none"
          style={[
            styles.abs,
            {
              left: shape.cx * scale - rPx,
              top: shape.cy * scale - rPx,
              width: rPx * 2,
              height: rPx * 2,
              borderRadius: rPx,
              backgroundColor: color,
            },
          ]}
        />,
      ];
    }
    const outerR = shape.r * scale + swPx / 2;
    return [
      <View
        key={`c-${shapeIndex}`}
        pointerEvents="none"
        style={[
          styles.abs,
          {
            left: shape.cx * scale - outerR,
            top: shape.cy * scale - outerR,
            width: outerR * 2,
            height: outerR * 2,
            borderRadius: outerR,
            borderWidth: swPx,
            borderColor: color,
          },
        ]}
      />,
    ];
  }

  if (shape.kind === 'rect') {
    if (isFilled) {
      return [
        <View
          key={`r-${shapeIndex}`}
          pointerEvents="none"
          style={[
            styles.abs,
            {
              left: shape.x * scale,
              top: shape.y * scale,
              width: Math.max(1, shape.width * scale),
              height: Math.max(1, shape.height * scale),
              borderRadius: (shape.rx ?? 0) * scale,
              backgroundColor: color,
            },
          ]}
        />,
      ];
    }
    const half = swPx / 2;
    const rxPx = shape.rx !== undefined ? shape.rx * scale + half : half;
    return [
      <View
        key={`r-${shapeIndex}`}
        pointerEvents="none"
        style={[
          styles.abs,
          {
            left: shape.x * scale - half,
            top: shape.y * scale - half,
            width: shape.width * scale + swPx,
            height: shape.height * scale + swPx,
            borderRadius: rxPx,
            borderWidth: swPx,
            borderColor: color,
          },
        ]}
      />,
    ];
  }

  const polylines = parseSvgPathPolylines(shape.d);
  const out: ReactElement[] = [];

  for (let pIdx = 0; pIdx < polylines.length; pIdx += 1) {
    const line = polylines[pIdx];
    if (!line || line.length === 0) continue;

    if (isFilled && line.length >= 3) {
      out.push(...renderFilledPolygonSlices(line, scale, color, `p-${shapeIndex}-${pIdx}`));
      continue;
    }

    if (line.length === 1) {
      const pt = line[0];
      if (!pt) continue;
      out.push(
        <View
          key={`p-${shapeIndex}-${pIdx}-dot`}
          pointerEvents="none"
          style={[
            styles.abs,
            {
              left: pt.x * scale - swPx / 2,
              top: pt.y * scale - swPx / 2,
              width: swPx,
              height: swPx,
              borderRadius: swPx / 2,
              backgroundColor: color,
            },
          ]}
        />,
      );
      continue;
    }

    for (let sIdx = 0; sIdx + 1 < line.length; sIdx += 1) {
      const a = line[sIdx];
      const b = line[sIdx + 1];
      if (!a || !b) continue;
      const dx = (b.x - a.x) * scale;
      const dy = (b.y - a.y) * scale;
      const dist = Math.hypot(dx, dy);
      const segLen = dist + swPx;
      const midX = ((a.x + b.x) / 2) * scale;
      const midY = ((a.y + b.y) / 2) * scale;
      const angle = dist > 0.001 ? Math.atan2(dy, dx) : 0;

      out.push(
        <View
          key={`p-${shapeIndex}-${pIdx}-${sIdx}`}
          pointerEvents="none"
          style={[
            styles.abs,
            {
              left: midX - segLen / 2,
              top: midY - swPx / 2,
              width: segLen,
              height: swPx,
              borderRadius: swPx / 2,
              backgroundColor: color,
              transform: angle !== 0 ? [{ rotate: `${angle}rad` }] : undefined,
            },
          ]}
        />,
      );
    }
  }

  return out;
}

/**
 * Zero-dependency React Native vector renderer for 24×24 {@link IconSpec} graphics.
 * Renders crisp native `<View>` circles, rounded rects, and tessellated SVG path geometry across
 * iOS, iPadOS, tvOS, Android, Android TV, and Fire OS without requiring extra native modules.
 */
export function renderNativeVectorSpec({
  spec,
  size,
  color,
  strokeWidth,
}: SvgAdapterProps): ReactElement {
  const scale = size / VIEWBOX_SIZE;
  const specFilled = Boolean(spec.filled);
  const elements: ReactElement[] = [];

  for (let idx = 0; idx < spec.shapes.length; idx += 1) {
    const shape = spec.shapes[idx];
    if (!shape) continue;
    elements.push(...renderNativeShape(shape, idx, scale, color, specFilled, strokeWidth));
  }

  return (
    <View pointerEvents="none" style={[styles.canvas, { width: size, height: size }]}>
      {elements}
    </View>
  );
}

const styles = StyleSheet.create({
  canvas: {
    position: 'relative',
  },
  abs: {
    position: 'absolute',
  },
});
