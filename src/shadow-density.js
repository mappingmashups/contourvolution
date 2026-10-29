// Shadow-density contours: shadows are expressed by how many contour lines are drawn, not by
// a fill. Contours are traced at a tight interval and each line is assigned a class by
// its index along the elevation axis:
//   class 0: every 4th line, drawn everywhere
//   class 1: every 2nd line (the rest of them), drawn only in light shadow and darker
//   class 2: every remaining line, drawn only in dark shadow
// Lines in class 1 and 2 are cut against the smoothed shadow field so they stop where the
// terrain leaves their shadow class.

/** Dense interval in metres for zoom `z`; `denseInterval` is the spacing at z12. */
export function denseIntervalForZoom(params, z) {
  return Math.max(1, params.denseInterval * Math.pow(2, 12 - z));
}

/**
 * @param contours `[{ele, level, lines}]` traced at `interval`
 * @param shadow padded shadow-strength grid (0 = flat-ground brightness, 1 = black)
 * @param ctx `{ interval, halfAt, fullAt, size, buffer, tileSize, extent, minPieceLength }`
 *   `halfAt` / `fullAt` are shadow strengths; `minPieceLength` is in grid px.
 */
export function thinByShadow(contours, shadow, ctx) {
  const { interval, halfAt, fullAt, size, buffer, tileSize, extent, minPieceLength } = ctx;
  const k = tileSize / extent; // tile units -> grid px

  // Bilinear lookup of the shadow field at a tile coordinate.
  const shadowAt = (tx, ty) => {
    const gx = Math.min(size - 1.001, Math.max(0, tx * k + buffer - 0.5));
    const gy = Math.min(size - 1.001, Math.max(0, ty * k + buffer - 0.5));
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    const fx = gx - x0, fy = gy - y0;
    const i = y0 * size + x0;
    const top = shadow[i] * (1 - fx) + shadow[i + 1] * fx;
    const bottom = shadow[i + size] * (1 - fx) + shadow[i + size + 1] * fx;
    return top * (1 - fy) + bottom * fy;
  };

  const step = 0.5 / k; // sample every half grid pixel along each segment
  const minLength = minPieceLength / k;
  const out = [];
  for (const contour of contours) {
    const n = Math.round(contour.ele / interval);
    const density = mod(n, 8) === 0 ? 0 : mod(n, 4) === 0 ? 1 : mod(n, 2) === 0 ? 2 : 3;
    let lines = contour.lines;
    if (density > 0) {
      const threshold = density === 1 ? halfAt : fullAt;
      lines = lines.flatMap((line) =>
        clipLine(line, (x, y) => shadowAt(x, y) - threshold, step).filter((p) => length(p) >= minLength),
      );
    }
    if (lines.length) out.push({ ...contour, lines, properties: { ...contour.properties, density } });
  }
  return out;
}

const mod = (a, b) => ((a % b) + b) % b;

/** Keep the parts of a flat polyline where `f(x, y) >= 0`, splitting at interpolated crossings. */
function clipLine(line, f, step) {
  const pieces = [];
  let px = line[0], py = line[1];
  let pv = f(px, py);
  let current = pv >= 0 ? [px, py] : null;
  for (let i = 2; i < line.length; i += 2) {
    const x1 = line[i], y1 = line[i + 1];
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - px, y1 - py) / step));
    const sx = px, sy = py;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const qx = sx + (x1 - sx) * t, qy = sy + (y1 - sy) * t;
      const qv = f(qx, qy);
      if (pv >= 0 !== qv >= 0) {
        const a = pv / (pv - qv);
        const cx = px + (qx - px) * a, cy = py + (qy - py) * a;
        if (current) {
          current.push(cx, cy);
          pieces.push(current);
          current = null;
        } else {
          current = [cx, cy];
        }
      }
      px = qx; py = qy; pv = qv;
    }
    if (current) current.push(x1, y1);
  }
  if (current && current.length >= 4) pieces.push(current);
  return pieces;
}

function length(line) {
  let sum = 0;
  for (let i = 2; i < line.length; i += 2) sum += Math.hypot(line[i] - line[i - 2], line[i + 1] - line[i - 1]);
  return sum;
}
