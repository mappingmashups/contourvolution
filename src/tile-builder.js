// Turns a padded elevation grid into one vector tile with two layers: "contours" and
// "hillshade". Shared by the Mapterhorn worker and the standalone artifact.
import { encodeTile, POLYGON } from "./mvt.js";
import { computeShade, blur, toneFields, polygonize } from "./hillshade.js";
import { buildContours, levelsForZoom } from "./contours.js";
import { denseIntervalForZoom } from "./shadow-density.js";

const EXTENT = 4096;
const EARTH_CIRCUMFERENCE = 40075016.686;

/** Output grid resolution and padding for a tile that covers `span` DEM pixels. */
export function gridLayout(span, params) {
  const tileSize = Math.max(span, params.minGridSize);
  // Padding so blur, contour tracing and ring smoothing near the edge see real neighbouring
  // data; polygons close along the padded border, which MapLibre clips away.
  const buffer = Math.ceil(
    Math.max(params.shadeBlur * 3, params.demBlur * 3, params.contourBuffer, params.smoothIterations * 2) + 4,
  );
  return { tileSize, buffer, size: tileSize + 2 * buffer };
}

/** `raw` is a `size` x `size` grid of elevations sampled at pixel centres. */
export function buildVectorTile({ z, x, y, raw, size, buffer, tileSize, params }) {
  // Ground distance per grid pixel, in metres, at the tile's centre latitude.
  const n = Math.PI * (1 - (2 * (y + 0.5)) / (1 << z));
  const lat = Math.atan(Math.sinh(n));
  const cellSize = (EARTH_CIRCUMFERENCE * Math.cos(lat)) / (1 << z) / tileSize;

  const layers = {};
  const densityMode = params.contours && params.contourMode === "density";
  const minSpacingMode = params.contours && params.contourMode === "minspacing";

  // The shade field drives both the hillshade polygons and shadow-density contours.
  let shadow, highlight;
  if (params.hillshade || densityMode || minSpacingMode) {
    const elev = blur(raw, size, params.demBlur);
    // Low zooms look flat with true slopes, so boost exaggeration as we zoom out.
    const exaggeration = params.exaggeration * Math.pow(params.zoomBoost, Math.max(0, 12 - z));
    const shade = blur(
      computeShade(elev, size, cellSize, { ...params, exaggeration }),
      size,
      params.shadeBlur,
    );
    ({ shadow, highlight } = toneFields(shade, params.altitude));
  }

  if (params.contours) {
    layers.contours = {
      extent: EXTENT,
      features: buildContours(raw, size, buffer, tileSize, {
        z, x, y,
        extent: EXTENT,
        levels: densityMode ? [denseIntervalForZoom(params, z)]
              : minSpacingMode ? [denseIntervalForZoom({ denseInterval: params.minSpacingInterval }, z)]
              : levelsForZoom(params.thresholds, z),
        multiplier: params.multiplier,
        contourBuffer: params.contourBuffer,
        density: densityMode && {
          shadow,
          // Shadow classes are 1-based indices into shadowLevels.
          halfAt: params.shadowLevels[params.halfDensityFrom - 1],
          fullAt: params.shadowLevels[params.fullDensityFrom - 1],
          minPieceLength: params.minPieceLength,
        },
        minSpacing: minSpacingMode && {
          midpoint: params.midpoint,
          bufferPx: params.spacingBuffer,
          tileSize,
          contourBuffer: params.contourBuffer,
          minPieceLength: params.minPieceLength,
          showExcluded: params.showExcluded,
          shadow,
          highlight,
          size,
          buffer,
          shadowLevels: params.shadowLevels,
          highlightLevels: params.highlightLevels,
        },
        params,
      }),
    };
  }

  if (params.hillshade) {
    const polyOpts = {
      buffer,
      tileSize,
      extent: EXTENT,
      simplify: params.simplify,
      smoothIterations: params.smoothIterations,
      minArea: params.minArea,
    };
    const features = [];
    const addBands = (field, thresholds, kind) => {
      for (const band of polygonize(field, size, thresholds, polyOpts)) {
        for (const poly of band.rings) {
          features.push({
            type: POLYGON,
            properties: { kind, level: band.index + 1, threshold: band.threshold },
            geometry: [poly.exterior, ...poly.holes],
          });
        }
      }
    };
    addBands(shadow, params.shadowLevels, "shadow");
    addBands(highlight, params.highlightLevels, "highlight");
    layers.hillshade = { extent: EXTENT, features };
  }

  return encodeTile(layers);
}
