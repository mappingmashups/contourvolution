// Builds one vector tile from a 3x3 block of decoded DEM tiles.
import { gridLayout, buildVectorTile } from "./tile-builder.js";

self.onmessage = ({ data }) => {
  const { id } = data;
  try {
    const start = performance.now();
    const buffer = buildTile(data);
    self.postMessage({ id, buffer, ms: performance.now() - start }, [buffer]);
  } catch (error) {
    self.postMessage({ id, error: String(error?.stack || error) });
  }
};

function buildTile({ z, x, y, demZoom, neighbors, params }) {
  const demSize = neighbors[4].width;
  const div = 1 << (z - demZoom);
  const span = demSize / div; // DEM pixels covered by this tile
  const { tileSize, buffer, size } = gridLayout(span, params);
  const raw = sampleGrid(neighbors, demSize, (x % div) * span, (y % div) * span, span / tileSize, size, buffer);
  return buildVectorTile({ z, x, y, raw, size, buffer, tileSize, params });
}

/**
 * Resample the 3x3 DEM mosaic into a padded grid of `size` x `size` pixel-center samples.
 * (originX, originY) is where this tile starts inside the centre DEM tile, `step` is DEM
 * pixels per output pixel. Bilinear interpolation; missing neighbours fall back to the
 * nearest edge of the centre tile.
 */
function sampleGrid(neighbors, demSize, originX, originY, step, size, buffer) {
  const W = demSize;
  const get = (u, v) => {
    const tx = u < 0 ? 0 : u < W ? 1 : 2;
    const ty = v < 0 ? 0 : v < W ? 1 : 2;
    const tile = neighbors[ty * 3 + tx];
    if (!tile) {
      const cu = Math.min(W - 1, Math.max(0, u));
      const cv = Math.min(W - 1, Math.max(0, v));
      return neighbors[4].data[cv * W + cu];
    }
    return tile.data[(v - (ty - 1) * W) * W + (u - (tx - 1) * W)];
  };

  const out = new Float32Array(size * size);
  for (let j = 0; j < size; j++) {
    const v = originY + (j - buffer + 0.5) * step - 0.5;
    const v0 = Math.floor(v);
    const fy = v - v0;
    for (let i = 0; i < size; i++) {
      const u = originX + (i - buffer + 0.5) * step - 0.5;
      const u0 = Math.floor(u);
      const fx = u - u0;
      const top = get(u0, v0) * (1 - fx) + get(u0 + 1, v0) * fx;
      const bottom = get(u0, v0 + 1) * (1 - fx) + get(u0 + 1, v0 + 1) * fx;
      out[j * size + i] = top * (1 - fy) + bottom * fy;
    }
  }
  return out;
}
