// Raster -> vector hillshade. Everything here operates on square Float32Array grids of
// size `size` x `size` stored row-major, where each value is sampled at a pixel center.
import { contours } from "d3-contour";

const DEG = Math.PI / 180;

/**
 * Classic Horn/ESRI hillshade. Returns illumination in [0, 1]; flat ground ends up at
 * cos(zenith), e.g. ~0.71 with a 45° sun.
 */
export function computeShade(elev, size, cellSize, { azimuth, altitude, exaggeration }) {
  const out = new Float32Array(size * size);
  const zenith = (90 - altitude) * DEG;
  const azimuthMath = ((360 - azimuth + 90) % 360) * DEG;
  const cosZ = Math.cos(zenith);
  const sinZ = Math.sin(zenith);
  const k = exaggeration / (8 * cellSize);
  const at = (x, y) =>
    elev[Math.min(size - 1, Math.max(0, y)) * size + Math.min(size - 1, Math.max(0, x))];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a = at(x - 1, y - 1), b = at(x, y - 1), c = at(x + 1, y - 1);
      const d = at(x - 1, y), f = at(x + 1, y);
      const g = at(x - 1, y + 1), h = at(x, y + 1), i = at(x + 1, y + 1);
      const dzdx = (c + 2 * f + i - (a + 2 * d + g)) * k;
      const dzdy = (g + 2 * h + i - (a + 2 * b + c)) * k;
      const slope = Math.atan(Math.hypot(dzdx, dzdy));
      const aspect = Math.atan2(dzdy, -dzdx);
      const shade = cosZ * Math.cos(slope) + sinZ * Math.sin(slope) * Math.cos(azimuthMath - aspect);
      out[y * size + x] = shade < 0 ? 0 : shade;
    }
  }
  return out;
}

/** Approximate gaussian blur: three passes of a separable box blur. Edges are clamped. */
export function blur(grid, size, radius) {
  radius = Math.round(radius);
  if (radius < 1) return grid;
  let a = Float32Array.from(grid);
  let b = new Float32Array(grid.length);
  for (let pass = 0; pass < 3; pass++) {
    boxPass(a, b, size, radius, 1, size); // horizontal
    boxPass(b, a, size, radius, size, 1); // vertical
  }
  return a;
}

function boxPass(src, dst, size, r, step, lineStride) {
  const norm = 1 / (2 * r + 1);
  for (let line = 0; line < size; line++) {
    const base = line * lineStride;
    const v = (i) => src[base + Math.min(size - 1, Math.max(0, i)) * step];
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += v(i);
    for (let i = 0; i < size; i++) {
      dst[base + i * step] = sum * norm;
      sum += v(i + r + 1) - v(i - r);
    }
  }
}

/**
 * Turn illumination into two "tone" fields, both 0 at flat-ground brightness:
 * `shadow` rises to 1 at full black, `highlight` rises to 1 at full white.
 */
export function toneFields(shade, altitude) {
  const flat = Math.cos((90 - altitude) * DEG);
  const shadow = new Float32Array(shade.length);
  const highlight = new Float32Array(shade.length);
  for (let i = 0; i < shade.length; i++) {
    const s = shade[i];
    shadow[i] = s < flat ? (flat - s) / flat : 0;
    highlight[i] = s > flat ? (s - flat) / (1 - flat) : 0;
  }
  return { shadow, highlight };
}

/**
 * Polygonize `values >= threshold` for each threshold, then simplify, smooth, drop small
 * rings, and project into tile coordinates.
 *
 * Returns `[{threshold, index, rings: [{exterior: number[], holes: number[][]}...]}]` where
 * each ring is flat `[x0, y0, ...]` in tile coordinates, already wound for MVT.
 */
export function polygonize(values, size, thresholds, opts) {
  const { buffer, tileSize, extent, simplify, smoothIterations, minArea } = opts;
  const scale = extent / tileSize;
  const generator = contours().size([size, size]).smooth(true);

  return thresholds.map((threshold, index) => {
    const multipolygon = generator.contour(values, threshold);
    const polygons = [];
    for (const polygon of multipolygon.coordinates) {
      const [outer, ...inner] = polygon.map((ring) => cleanRing(ring, simplify, smoothIterations));
      if (!outer || Math.abs(signedArea(outer)) < minArea) continue;
      const holes = inner.filter((r) => r && Math.abs(signedArea(r)) >= minArea);
      const toTile = (ring, wantPositive) => {
        const flat = [];
        let px = NaN, py = NaN;
        for (const [gx, gy] of ring) {
          // d3-contour treats value i as covering [i, i+1], so pixel centers line up directly.
          const x = Math.round((gx - buffer) * scale);
          const y = Math.round((gy - buffer) * scale);
          if (x === px && y === py) continue;
          flat.push(x, y);
          px = x;
          py = y;
        }
        if (flat.length < 6) return null;
        if (flatSignedArea(flat) > 0 !== wantPositive) reverseFlat(flat);
        return flat;
      };
      const exterior = toTile(outer, true);
      if (!exterior) continue;
      polygons.push({ exterior, holes: holes.map((h) => toTile(h, false)).filter(Boolean) });
    }
    return { threshold, index, rings: polygons };
  });
}

/** Open the ring, simplify it, then round off its corners. Returns null if it degenerates. */
function cleanRing(ring, tolerance, iterations) {
  let pts = ring.slice(0, -1); // d3 closes rings by repeating the first point
  if (tolerance > 0) pts = simplifyClosed(pts, tolerance);
  if (pts.length < 3) return null;
  for (let i = 0; i < iterations; i++) pts = chaikinClosed(pts);
  return pts;
}

/** Douglas-Peucker for a closed ring, anchored at the first point and the point farthest from it. */
export function simplifyClosed(pts, tolerance) {
  if (pts.length < 4) return pts;
  let far = 0, farDist = -1;
  for (let i = 1; i < pts.length; i++) {
    const d = (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2;
    if (d > farDist) { farDist = d; far = i; }
  }
  const sq = tolerance * tolerance;
  const a = douglasPeucker(pts.slice(0, far + 1), sq);
  const b = douglasPeucker([...pts.slice(far), pts[0]], sq);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

function douglasPeucker(pts, sqTolerance) {
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let maxSq = 0, index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = segmentDistSq(pts[i], pts[first], pts[last]);
      if (d > maxSq) { maxSq = d; index = i; }
    }
    if (maxSq > sqTolerance) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

function segmentDistSq(p, a, b) {
  let [x, y] = a;
  let dx = b[0] - x, dy = b[1] - y;
  if (dx !== 0 || dy !== 0) {
    const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) { x = b[0]; y = b[1]; }
    else if (t > 0) { x += dx * t; y += dy * t; }
  }
  dx = p[0] - x;
  dy = p[1] - y;
  return dx * dx + dy * dy;
}

/**
 * One round of Chaikin corner cutting on a closed ring. Cuts are capped at `maxCut` grid px
 * so long straight runs (e.g. where a ring hugs the edge of the padded grid) don't get
 * chamfered back into the visible tile.
 */
export function chaikinClosed(pts, maxCut = 2) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    const t = Math.min(0.25, maxCut / Math.hypot(x1 - x0, y1 - y0));
    out.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t]);
    out.push([x1 + (x0 - x1) * t, y1 + (y0 - y1) * t]);
  }
  return out;
}

function signedArea(pts) {
  let sum = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    sum += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  }
  return sum / 2;
}

function flatSignedArea(flat) {
  let sum = 0;
  const n = flat.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    sum += flat[j] * flat[i + 1] - flat[i] * flat[j + 1];
  }
  return sum / 2;
}

function reverseFlat(flat) {
  for (let i = 0, j = flat.length - 2; i < j; i += 2, j -= 2) {
    [flat[i], flat[j]] = [flat[j], flat[i]];
    [flat[i + 1], flat[j + 1]] = [flat[j + 1], flat[i + 1]];
  }
}
