/**
 * Minimum-spacing contour filter.
 *
 * Contours are drawn in priority order determined by binary subdivision from `midpoint`:
 *   priority 0 → elevation nearest to midpoint (e.g. 4000 m)
 *   priority 1 → midpoints of [0, mid] and [mid, 2·mid] (e.g. 2000, 6000)
 *   priority 2 → 1000, 3000, 5000, 7000 …
 *   … halving the step each round until step < 0.5 m.
 *
 * Each drawn segment stamps a `bufferPx`-wide exclusion zone onto an occupancy grid (one
 * cell ≈ one screen pixel). Later segments are clipped wherever they fall inside that zone.
 *
 * Returns both included and excluded fragments (excluded flagged via `properties.excluded`).
 */

function buildPriorityMap(elevations, midpoint) {
  const priorities = new Map();
  let step = Math.abs(midpoint);
  let p = 0;
  while (step >= 0.5) {
    for (const ele of elevations) {
      if (!priorities.has(ele)) {
        const n = ele / step;
        if (Math.abs(n - Math.round(n)) < 1e-6) priorities.set(ele, p);
      }
    }
    step /= 2;
    p++;
  }
  for (const ele of elevations) {
    if (!priorities.has(ele)) priorities.set(ele, p);
  }
  return priorities;
}

/** Complement of a list of [0,1] fractions: gaps before, between, and after. */
function complement(fracs) {
  const out = [];
  let t = 0;
  for (const { t0, t1 } of fracs) {
    if (t0 - t > 1e-4) out.push({ t0: t, t1: t0 });
    t = t1;
  }
  if (1 - t > 1e-4) out.push({ t0: t, t1: 1 });
  return out;
}

export function applyMinSpacing(contours, ctx) {
  const {
    midpoint, bufferPx, tileSize, extent, contourBuffer = 2, minPieceLength = 2, showExcluded = false,
    shadow, highlight, size, buffer: gridBuffer,
    shadowLevels = [0.12, 0.3, 0.55], highlightLevels = [0.25],
  } = ctx;
  const scale = tileSize / extent;
  const r = Math.max(1, bufferPx);
  const r2 = r * r;
  const border = Math.ceil(r) + Math.ceil(contourBuffer);
  const W = tileSize + 2 * border;
  const occupied = new Uint8Array(W * W);

  function stamp(sx, sy) {
    const cx = sx + border, cy = sy + border;
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(W - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(W - 1, Math.ceil(cy + r));
    for (let gy = y0; gy <= y1; gy++) {
      const row = gy * W;
      for (let gx = x0; gx <= x1; gx++) {
        if ((gx - cx) ** 2 + (gy - cy) ** 2 <= r2) occupied[row + gx] = 1;
      }
    }
  }

  function isBlocked(sx, sy) {
    const gx = Math.round(sx + border), gy = Math.round(sy + border);
    if (gx < 0 || gx >= W || gy < 0 || gy >= W) return false;
    return occupied[gy * W + gx] !== 0;
  }

  const STAMP_STEP = Math.max(0.25, r / 6);
  function stampSegment(sx0, sy0, sx1, sy1) {
    const dx = sx1 - sx0, dy = sy1 - sy0;
    const n = Math.max(1, Math.ceil(Math.hypot(dx, dy) / STAMP_STEP));
    for (let s = 0; s <= n; s++) {
      const t = s / n;
      stamp(sx0 + dx * t, sy0 + dy * t);
    }
  }

  const SAMPLE_STEP = Math.max(0.25, r / 6);
  /** Returns [{t0,t1}] fractions of the segment that are unblocked. */
  function clipSegment(sx0, sy0, sx1, sy1) {
    const dx = sx1 - sx0, dy = sy1 - sy0;
    const len = Math.hypot(dx, dy);
    if (len === 0) return [];
    const n = Math.max(1, Math.ceil(len / SAMPLE_STEP));
    const fracs = [];
    let start = null;
    for (let s = 0; s <= n; s++) {
      const t = s / n;
      const blocked = isBlocked(sx0 + dx * t, sy0 + dy * t);
      if (!blocked && start === null) start = t;
      if (blocked && start !== null) { fracs.push({ t0: start, t1: (s - 1) / n }); start = null; }
    }
    if (start !== null) fracs.push({ t0: start, t1: 1 });
    return fracs;
  }

  /** Build tile-coord pieces from a list of fractions along a segment. */
  function fracsToPieces(fracs, tx0, ty0, tx1, ty1) {
    const tdx = tx1 - tx0, tdy = ty1 - ty0;
    return fracs.map(({ t0, t1 }) => [
      tx0 + tdx * t0, ty0 + tdy * t0,
      t1 >= 1 - 1e-6 ? tx1 : tx0 + tdx * t1,
      t1 >= 1 - 1e-6 ? ty1 : ty0 + tdy * t1,
    ]);
  }

  /**
   * Stitch segment-level [tx0,ty0,tx1,ty1] pieces into continuous polylines.
   * Pieces that are continuations of each other (share an endpoint) are merged.
   */
  function stitch(segPieces, minLenPx) {
    const lines = [];
    let cur = null;
    for (const [ax, ay, bx, by] of segPieces) {
      if (!cur) {
        cur = [ax, ay, bx, by];
      } else {
        const lx = cur[cur.length - 2], ly = cur[cur.length - 1];
        if (Math.hypot((ax - lx) * scale, (ay - ly) * scale) < 0.5) {
          cur.push(bx, by);
        } else {
          pushIfLong(cur, lines, minLenPx);
          cur = [ax, ay, bx, by];
        }
      }
    }
    pushIfLong(cur, lines, minLenPx);
    return lines;
  }

  function pushIfLong(cur, lines, minLenPx) {
    if (!cur || cur.length < 4) return;
    let len = 0;
    for (let k = 2; k < cur.length; k += 2)
      len += Math.hypot((cur[k] - cur[k - 2]) * scale, (cur[k + 1] - cur[k - 1]) * scale);
    if (len >= minLenPx) lines.push(cur);
  }

  // Bilinear sample of a padded grid field at a tile coordinate.
  function fieldAt(field, tx, ty) {
    if (!field) return 0;
    const k = tileSize / extent;
    const gx = Math.min(size - 1.001, Math.max(0, tx * k + gridBuffer - 0.5));
    const gy = Math.min(size - 1.001, Math.max(0, ty * k + gridBuffer - 0.5));
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    const fx = gx - x0, fy = gy - y0;
    const i = y0 * size + x0;
    const top = field[i] * (1 - fx) + field[i + 1] * fx;
    const bot = field[i + size] * (1 - fx) + field[i + size + 1] * fx;
    return top * (1 - fy) + bot * fy;
  }

  // Returns 0=highlight, 1=neutral, 2=shadow, 3=dark-shadow
  function shadeClassAt(tx, ty) {
    if (highlight && fieldAt(highlight, tx, ty) >= highlightLevels[0]) return 0;
    if (!shadow) return 1;
    const s = fieldAt(shadow, tx, ty);
    if (s >= shadowLevels[2]) return 3;
    if (s >= shadowLevels[0]) return 2;
    return 1;
  }

  const SHADE_SAMPLE_PX = 4; // resample every ~4 screen pixels when splitting by shade
  /** Split a flat tile-coord polyline into segments of uniform shade class. */
  function splitByShade(line) {
    if (!shadow && !highlight) return [{ cls: 1, coords: line }];
    const k = tileSize / extent;

    const pieces = [];
    let curCls = shadeClassAt(line[0], line[1]);
    let cur = [line[0], line[1]];

    for (let i = 2; i < line.length; i += 2) {
      const ax = line[i - 2], ay = line[i - 1], bx = line[i], by = line[i + 1];
      const segLen = Math.hypot((bx - ax) * k, (by - ay) * k); // in screen px
      const n = Math.max(1, Math.ceil(segLen / SHADE_SAMPLE_PX));
      for (let s = 1; s <= n; s++) {
        const t = s / n;
        const px = ax + (bx - ax) * t, py = ay + (by - ay) * t;
        const cls = shadeClassAt(px, py);
        if (cls !== curCls) {
          // interpolate the crossing to the midpoint between samples
          const prevT = (s - 1) / n;
          const midT = (prevT + t) / 2;
          const mx = ax + (bx - ax) * midT, my = ay + (by - ay) * midT;
          cur.push(mx, my);
          if (cur.length >= 4) pieces.push({ cls: curCls, coords: cur });
          curCls = cls;
          cur = [mx, my];
        }
        cur.push(px, py);
      }
    }
    if (cur.length >= 4) pieces.push({ cls: curCls, coords: cur });
    return pieces;
  }

  const elevations = contours.map(c => c.ele);
  const priorityMap = buildPriorityMap(elevations, midpoint);
  const sorted = [...contours].sort((a, b) => {
    const pa = priorityMap.get(a.ele) ?? 9999;
    const pb = priorityMap.get(b.ele) ?? 9999;
    return pa !== pb ? pa - pb : Math.abs(a.ele - midpoint) - Math.abs(b.ele - midpoint);
  });

  const out = [];

  for (const contour of sorted) {
    const priority = priorityMap.get(contour.ele) ?? 9999;
    const inclSegPieces = [];
    const exclSegPieces = [];

    for (const line of contour.lines) {
      for (let i = 0; i + 2 < line.length; i += 2) {
        const tx0 = line[i], ty0 = line[i + 1], tx1 = line[i + 2], ty1 = line[i + 3];
        const sx0 = tx0 * scale, sy0 = ty0 * scale, sx1 = tx1 * scale, sy1 = ty1 * scale;
        const fracs = clipSegment(sx0, sy0, sx1, sy1);
        inclSegPieces.push(...fracsToPieces(fracs, tx0, ty0, tx1, ty1));
        if (showExcluded) {
          exclSegPieces.push(...fracsToPieces(complement(fracs), tx0, ty0, tx1, ty1));
        }
      }
    }

    const inclLines = stitch(inclSegPieces, minPieceLength);
    // Stamp AFTER stitching so excluded segments don't block included ones on the same contour.
    for (const tl of inclLines) {
      for (let i = 0; i + 2 < tl.length; i += 2)
        stampSegment(tl[i] * scale, tl[i + 1] * scale, tl[i + 2] * scale, tl[i + 3] * scale);
    }

    // Split each included line by shade class and emit a separate feature per class.
    if (inclLines.length > 0) {
      const byClass = new Map(); // shadeClass -> [line, ...]
      for (const tl of inclLines) {
        for (const { cls, coords } of splitByShade(tl)) {
          if (!byClass.has(cls)) byClass.set(cls, []);
          byClass.get(cls).push(coords);
        }
      }
      for (const [cls, lines] of byClass) {
        out.push({ ...contour, lines, properties: { priority, excluded: false, shadeClass: cls } });
      }
    }

    if (showExcluded) {
      const exclLines = stitch(exclSegPieces, minPieceLength);
      if (exclLines.length > 0)
        out.push({ ...contour, lines: exclLines, properties: { priority, excluded: true, shadeClass: 1 } });
    }
  }

  return out;
}
