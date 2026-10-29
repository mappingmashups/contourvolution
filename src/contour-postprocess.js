// Hook for modifying contour geometry before it is encoded into the vector tile.
// Runs inside the terrain worker, once per tile.
//
// `contours` is an array of `{ ele, level, lines }`, where `lines` is an array of flat
// `[x0, y0, x1, y1, ...]` polylines in tile coordinates (0..extent; lines extend
// `contourBuffer` DEM pixels past the tile edge so neighbouring tiles agree).
//
// `ctx` carries { z, x, y, extent, levels, multiplier, elev, size, buffer, tileSize, params }
// where `elev` is the padded elevation grid used to trace the lines. Grid pixel (gx, gy)
// maps to tile coordinate ((gx - buffer + 0.5) * extent / tileSize, ...).
//
// In shadow-density mode the lines have already been thinned by shadow class: each entry
// has `properties.density` (0 = every 4th line, 1 = every 2nd, 2 = the rest), and
// `ctx.density.shadow` is the padded shadow-strength grid that drove the thinning.
//
// Return the (possibly modified) array; you can also set `properties` on an entry to add
// extra vector tile attributes (e.g. a proximity score to drive styling).
export function processContours(contours, ctx) {
  return contours;
}
