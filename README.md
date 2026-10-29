# Vector contours + vector hillshade (Mapterhorn DEM)

Contour line experiments.

Based on the maplibre-contour demo (makewithmaplibre.com/plugins/maplibre-contour). Both
contour lines and the hillshade are produced in the browser, per tile, as vector
geometry. Nothing is pre-rendered.

    npm install
    npm run dev

## How it works

- `maplibre-contour`'s `DemSource` fetches and decodes Mapterhorn terrarium tiles and caches
  them. It also feeds the optional raster `hillshade` layer used for comparison.
- A custom `vterrain://` protocol (`src/main.js`) collects the 3×3 block of DEM tiles around
  each requested tile and passes it to a worker pool.
- `src/terrain-worker.js` resamples the DEM into a padded grid (overzoomed tiles are resampled
  to at least 256 px), then builds one vector tile with two layers:
  - `contours`: maplibre-contour's isoline tracer (`src/contours.js`), then
    `src/contour-postprocess.js`, which is where the proximity-based line edits go.
  - `hillshade`: Horn hillshade → blur → split into "shadow" and "highlight" tone fields →
    marching-squares polygons per threshold (d3-contour) → Douglas-Peucker → Chaikin → drop
    tiny rings (`src/hillshade.js`). Features have `kind` (`shadow`|`highlight`) and `level`.
    Shadow bands are nested, so a constant fill opacity stacks into darker tones.
- Shadow-density contours (`contourMode: "density"`, the default) draw shadows with line
  density instead of fills (`src/shadow-density.js`). Contours are traced at a tight interval
  (`denseInterval` metres at z12, doubling per zoom level out). Every 4th line is kept
  everywhere. Every 2nd line is cut to areas at or above shadow class `halfDensityFrom`, and
  the remaining lines to class `fullDensityFrom`. The cut uses the same smoothed shadow
  field as the fill polygons.
- `src/mvt.js` is a small MVT encoder.

`tileParams` in `src/main.js` holds every setting that changes geometry. Editing one through
the GUI bumps a version number in the tile URL, so MapLibre reloads the tiles. `styleParams`
only change paint properties.

## Notes from testing against real Mapterhorn tiles

- Tile URL, terrarium encoding and 512px tiles confirmed via
  https://tiles.mapterhorn.com/tilejson.json (which gives no maxzoom).
- Global coverage ends at z12. Some regions (Alps, Colorado) have tiles to z16+, but
  elsewhere z13+ returns 404, so `DEM_MAXZOOM = 12`. Using the deeper tiles would need a 404
  fallback to the z12 parent.
- Shadow density at the default `denseInterval: 20` looks good around z12. By z14, steep
  Alpine faces collapse into solid bands because the lines are less than 1px apart. Try
  40–60 m, or handle it in `src/contour-postprocess.js` (proximity thinning).
