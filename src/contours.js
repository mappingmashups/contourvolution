// Contour lines generated with maplibre-contour's isoline tracer, but run in our own
// worker so the line geometry can be post-processed before it is encoded into the tile.
import mlcontour from "maplibre-contour";
import { processContours } from "./contour-postprocess.js";
import { thinByShadow } from "./shadow-density.js";
import { applyMinSpacing } from "./min-spacing.js";

const { HeightTile, generateIsolines } = mlcontour;

/** Same semantics as maplibre-contour: the highest zoom key <= z wins. */
export function levelsForZoom(thresholds, z) {
  let best = -Infinity;
  let levels = [];
  for (const [key, value] of Object.entries(thresholds)) {
    const zoom = Number(key);
    if (zoom <= z && zoom > best) {
      best = zoom;
      levels = Array.isArray(value) ? value : [value];
    }
  }
  return levels;
}

/**
 * @param elev padded elevation grid (pixel-center samples), `size` = tileSize + 2 * buffer
 * @returns MVT features for the contour layer
 */
export function buildContours(elev, size, buffer, tileSize, ctx) {
  const { levels, multiplier, contourBuffer, extent } = ctx;
  if (!levels.length) return [];

  const tile = new HeightTile(tileSize, tileSize, (x, y) => elev[(y + buffer) * size + x + buffer])
    .averagePixelCentersToGrid()
    .scaleElevation(multiplier)
    .materialize(contourBuffer);

  const isolines = generateIsolines(levels[0], tile, extent, contourBuffer);

  let contours = Object.entries(isolines).map(([eleString, lines]) => {
    const ele = Number(eleString);
    return {
      ele,
      level: Math.max(...levels.map((l, i) => (ele % l === 0 ? i : 0))),
      lines,
    };
  });

  // Shadow-density mode: one tight interval, thinned outside the shadows.
  if (ctx.density) {
    contours = thinByShadow(contours, ctx.density.shadow, {
      ...ctx.density,
      interval: levels[0],
      size,
      buffer,
      tileSize,
      extent,
    });
  }

  // Minimum-spacing mode: priority ordering + rasterized exclusion buffer.
  if (ctx.minSpacing) {
    contours = applyMinSpacing(contours, { ...ctx.minSpacing, extent });
  }

  return processContours(contours, { ...ctx, elev, size, buffer, tileSize }).map((c) => ({
    type: 2,
    properties: { ele: c.ele, level: c.level, ...c.properties },
    geometry: c.lines,
  }));
}
