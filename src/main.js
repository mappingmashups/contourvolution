import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import mlcontour from "maplibre-contour";
import GUI from "lil-gui";
import { WorkerPool } from "./worker-pool.js";

// Mapterhorn: global terrarium-encoded 512px WebP tiles (z12 everywhere, deeper in places).
const DEM_URL = "https://tiles.mapterhorn.com/{z}/{x}/{y}.webp";
const DEM_MAXZOOM = 12;
const DEM_TILE_SIZE = 512;
const BASEMAP = "https://tiles.openfreemap.org/styles/positron";

// --- Tunables. Anything in `tileParams` changes tile geometry, so editing it rebuilds tiles;
// --- `styleParams` only touch paint properties.
const tileParams = {
  contours: true,
  // "density":    shadow-density hatching (see src/shadow-density.js)
  // "minspacing": priority-ordered lines with a minimum screen-space buffer
  // "standard":   regular minor/major contours from `thresholds`
  contourMode: "density",
  denseInterval: 20, // metres between the densest lines at z12; doubles per zoom level out
  halfDensityFrom: 1, // every 2nd line appears from this shadow class (1-based shadowLevels)
  fullDensityFrom: 2, // every line appears from this shadow class
  minPieceLength: 3, // drop clipped line fragments shorter than this, grid px
  // --- Minimum-spacing params ---
  midpoint: 4000,       // reference elevation for binary subdivision priority (m)
  spacingBuffer: 5,     // exclusion buffer around each drawn line (screen px)
  showExcluded: false,  // debug: render excluded fragments in red
  // zoom -> [minor, major] interval in metres (same format as maplibre-contour)
  thresholds: { 6: [2000, 10000], 7: [1000, 5000], 8: [500, 2000], 9: [500, 2000], 10: [500, 2000], 11: [200, 1000], 12: [100, 500], 13: [50, 250], 14: [20, 100], 15: [10, 50] },
  multiplier: 1,
  contourBuffer: 2,

  hillshade: false, // shadow/highlight fill polygons (the shade field is computed either way)
  azimuth: 315,
  altitude: 45,
  exaggeration: 1.5,
  zoomBoost: 1.25, // extra exaggeration per zoom level below z12
  demBlur: 1, // px blur on elevation before shading (generalises landforms)
  shadeBlur: 2, // px blur on the shade raster before polygonising
  shadowLevels: [0.12, 0.3, 0.55],
  highlightLevels: [0.25],
  simplify: 0.75, // Douglas-Peucker tolerance, grid px
  smoothIterations: 2, // Chaikin rounds
  minArea: 12, // drop rings smaller than this, grid px²
  minGridSize: 256, // overzoomed tiles are resampled up to at least this resolution
};

const styleParams = {
  excludedColor: "#e02020",
  shadowColor: "#1f2a44",
  shadowOpacity: 0.14,
  highlightColor: "#fffbe8",
  highlightOpacity: 0.35,
  contourColor: "#8a6a4a",
  lineWidth: 0.6, // every line in density mode; minor lines in standard mode
  lineOpacity: 0.7,
  widthFactor: 1, // min-spacing only: dark-shadow width = spacingBuffer * widthFactor at z12
  outlines: false,
  rasterHillshade: false,
};

// MapLibre locates its worker relative to its own module, which breaks once bundled.
maplibregl.setWorkerUrl(maplibreWorkerUrl);

// --- DEM source: shared cache/decoder for both the raster comparison layer and our tiles.
const demSource = new mlcontour.DemSource({
  url: DEM_URL,
  encoding: "terrarium",
  maxzoom: DEM_MAXZOOM,
  worker: true,
});
demSource.setupMaplibre(maplibregl);

const pool = new WorkerPool(
  () => new Worker(new URL("./terrain-worker.js", import.meta.url), { type: "module" }),
  Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) >> 1)),
);

// Each settings change gets a version number baked into the tile URL, which busts
// MapLibre's tile cache and lets the protocol look up the matching params.
const paramVersions = new Map();
let version = 0;
const tileUrl = () => {
  paramVersions.set(++version, structuredClone(tileParams));
  return `vterrain://{z}/{x}/{y}?v=${version}`;
};

maplibregl.addProtocol("vterrain", async ({ url }, abortController) => {
  const match = url.match(/^vterrain:\/\/(\d+)\/(\d+)\/(\d+)\?v=(\d+)/);
  const [z, x, y, v] = match.slice(1).map(Number);
  const params = paramVersions.get(v);

  const demZoom = Math.min(z, DEM_MAXZOOM);
  const dx = x >> (z - demZoom);
  const dy = y >> (z - demZoom);
  const max = 1 << demZoom;
  const neighbors = await Promise.all(
    [-1, 0, 1].flatMap((oy) =>
      [-1, 0, 1].map(async (ox) => {
        const ny = dy + oy;
        if (ny < 0 || ny >= max) return null;
        try {
          const t = await demSource.getDemTile(demZoom, (dx + ox + max) % max, ny, abortController);
          return { width: t.width, height: t.height, data: t.data };
        } catch (e) {
          if (ox === 0 && oy === 0) throw e;
          return null;
        }
      }),
    ),
  );

  const { buffer, ms } = await pool.run({ z, x, y, demZoom, neighbors, params }, abortController.signal);
  reportTiming(ms);
  return { data: buffer };
});

// --- URL hash: #zoom/lat/lng/bearing/pitch/mode (extends MapLibre's 5-field format)
const HASH_MODES = new Set(["density", "minspacing", "standard"]);

function parseHash() {
  const parts = window.location.hash.slice(1).split("/");
  if (parts.length < 5) return null;
  const [zoom, lat, lng, bearing, pitch] = parts.map(Number);
  if ([zoom, lat, lng, bearing, pitch].some(isNaN)) return null;
  return { zoom, lat, lng, bearing, pitch, mode: HASH_MODES.has(parts[5]) ? parts[5] : null };
}

function writeHash() {
  const { lat, lng } = map.getCenter();
  history.replaceState(null, "", [
    "#" + map.getZoom().toFixed(2),
    lat.toFixed(4),
    lng.toFixed(4),
    map.getBearing().toFixed(1),
    map.getPitch().toFixed(0),
    tileParams.contourMode,
  ].join("/"));
}

const initState = parseHash();
if (initState?.mode) tileParams.contourMode = initState.mode;

// --- Map
const map = new maplibregl.Map({
  container: "map",
  style: BASEMAP,
  center: initState ? [initState.lng, initState.lat] : [7.66, 45.98],
  zoom: initState?.zoom ?? 12,
  bearing: initState?.bearing ?? 0,
  pitch: initState?.pitch ?? 0,
  maxPitch: 75,
});
window.map = map;
window._tileParams = tileParams; // debug access
map.addControl(new maplibregl.NavigationControl());
map.addControl(new maplibregl.ScaleControl(), "bottom-left");

let hashTimer;
map.on("moveend", () => { clearTimeout(hashTimer); hashTimer = setTimeout(writeHash, 300); });

map.on("load", () => {
  const firstSymbol = map.getStyle().layers.find((l) => l.type === "symbol")?.id;

  // Strip everything except labels and water from the basemap.
  const KEEP_LAYERS = new Set(["water", "waterway"]);
  map.getStyle().layers.forEach((l) => {
    if (l.type !== "symbol" && !KEEP_LAYERS.has(l.id))
      map.setLayoutProperty(l.id, "visibility", "none");
  });
  // Mute the water fill and waterway lines so they read as subtle.
  map.setPaintProperty("water", "fill-color", "#c8d8e8");
  map.setPaintProperty("water", "fill-opacity", 0.5);
  map.setPaintProperty("waterway", "line-color", "#a0b8cc");
  map.setPaintProperty("waterway", "line-opacity", 0.5);

  map.addSource("dem", {
    type: "raster-dem",
    tiles: [demSource.sharedDemProtocolUrl],
    encoding: "terrarium",
    tileSize: DEM_TILE_SIZE,
    maxzoom: DEM_MAXZOOM,
    attribution: '<a href="https://mapterhorn.com/attribution">© Mapterhorn</a>',
  });
  map.addSource("terrain-vector", {
    type: "vector",
    tiles: [tileUrl()],
    maxzoom: 16,
  });

  map.addLayer(
    {
      id: "raster-hillshade",
      type: "hillshade",
      source: "dem",
      layout: { visibility: "none" },
      paint: { "hillshade-exaggeration": 0.5 },
    },
    firstSymbol,
  );
  map.addLayer(
    {
      id: "hillshade-highlight",
      type: "fill",
      source: "terrain-vector",
      "source-layer": "hillshade",
      filter: ["==", ["get", "kind"], "highlight"],
      paint: { "fill-color": styleParams.highlightColor, "fill-opacity": styleParams.highlightOpacity },
    },
    firstSymbol,
  );
  // Shadow bands are nested (level 2 sits inside level 1, etc.), so a constant opacity
  // stacks into progressively darker tones.
  map.addLayer(
    {
      id: "hillshade-shadow",
      type: "fill",
      source: "terrain-vector",
      "source-layer": "hillshade",
      filter: ["==", ["get", "kind"], "shadow"],
      paint: { "fill-color": styleParams.shadowColor, "fill-opacity": styleParams.shadowOpacity },
    },
    firstSymbol,
  );
  map.addLayer(
    {
      id: "hillshade-outline",
      type: "line",
      source: "terrain-vector",
      "source-layer": "hillshade",
      layout: { visibility: "none" },
      paint: {
        "line-color": ["match", ["get", "kind"], "shadow", "#c0306a", "#2a7fd4"],
        "line-width": 0.75,
      },
    },
    firstSymbol,
  );
  map.addLayer(
    {
      id: "contours-excluded",
      type: "line",
      source: "terrain-vector",
      "source-layer": "contours",
      filter: ["==", ["get", "excluded"], true],
      layout: { visibility: tileParams.showExcluded ? "visible" : "none" },
      paint: {
        "line-color": styleParams.excludedColor,
        "line-opacity": 0.7,
        "line-width": 1,
      },
    },
    firstSymbol,
  );
  map.addLayer(
    {
      id: "contours",
      type: "line",
      source: "terrain-vector",
      "source-layer": "contours",
      filter: ["!=", ["get", "excluded"], true],
      layout: { "line-cap": "round" },
      paint: {
        "line-color": styleParams.contourColor,
        "line-opacity": contourOpacity(),
        "line-width": contourWidth(),
      },
    },
    firstSymbol,
  );
  map.addLayer({
    id: "contour-labels",
    type: "symbol",
    source: "terrain-vector",
    "source-layer": "contours",
    filter: [">", ["get", "level"], 0],
    layout: {
      "symbol-placement": "line",
      "text-size": 10,
      "text-field": ["concat", ["number-format", ["get", "ele"], {}], " m"],
      "text-font": ["Noto Sans Regular"],
    },
    paint: {
      "text-color": styleParams.contourColor,
      "text-halo-color": "white",
      "text-halo-width": 1,
    },
  });

  buildGui();
});

// Shade-class features (min-spacing mode) are always fully opaque; other modes respect lineOpacity.
function contourOpacity() {
  return ["case", ["has", "shadeClass"], 1, styleParams.lineOpacity];
}

// Index lines (level 1) are drawn thicker; density mode emits only level 0, so all lines match.
// In min-spacing mode, line width is derived from spacingBuffer * widthFactor (at z12) and grows
// exponentially as 2^(zoom-12) to track tile scale between integer zooms.
// shadeClass multipliers: 3 (dark-shadow)=1×, 2 (shadow)=½, 1 (neutral)=¼, 0 (highlight)=⅛.
function contourWidth() {
  const w = styleParams.lineWidth;
  const darkW = tileParams.spacingBuffer * styleParams.widthFactor;
  const zoomWidth = ["interpolate", ["exponential", 2], ["zoom"],
    6,  darkW * Math.pow(2, 6 - 12),
    16, darkW * Math.pow(2, 16 - 12),
  ];
  return [
    "case",
    ["has", "shadeClass"],
    ["*", ["match", ["get", "shadeClass"], 0, 0.125, 1, 0.25, 2, 0.5, 1], zoomWidth],
    ["match", ["get", "level"], 1, w * 1.8, w],
  ];
}

// --- Controls
function buildGui() {
  const gui = new GUI({ title: "Terrain" });
  let timer;
  const rebuild = () => {
    clearTimeout(timer);
    timer = setTimeout(() => map.getSource("terrain-vector").setTiles([tileUrl()]), 250);
  };
  const paint = (layer, prop) => (value) => map.setPaintProperty(layer, prop, value);

  const c = gui.addFolder("Contours");
  c.add(tileParams, "contours").name("generate").onChange(rebuild);
  const modeCtrl = c.add(tileParams, "contourMode", {
    "Shadow Density": "density",
    "Minimum Spacing": "minspacing",
    "Standard": "standard",
  }).name("mode").onChange(() => { updateModeControls(); rebuild(); writeHash(); });

  // Shadow-density controls
  const classes = Object.fromEntries(tileParams.shadowLevels.map((_, i) => [`shadow ${i + 1}`, i + 1]));
  const densityControls = [
    c.add(tileParams, "denseInterval", 2, 100, 1).name("dense interval @z12 (m)").onChange(rebuild),
    c.add(tileParams, "halfDensityFrom", classes).name("every 2nd line from").onChange(rebuild),
    c.add(tileParams, "fullDensityFrom", classes).name("every line from").onChange(rebuild),
  ];

  // Minimum-spacing controls
  const msControls = [
    c.add(tileParams, "midpoint", 0, 8000, 100).name("midpoint (m)").onChange(rebuild),
    c.add(tileParams, "spacingBuffer", 1, 20, 0.5).name("spacing buffer (px)").onChange(() => {
      map.setPaintProperty("contours", "line-width", contourWidth());
      rebuild();
    }),
    c.add(styleParams, "widthFactor", 0, 3, 0.05).name("width factor").onChange(() =>
      map.setPaintProperty("contours", "line-width", contourWidth())
    ),
    c.add(tileParams, "showExcluded").name("show excluded (red)").onChange((v) => {
      map.setLayoutProperty("contours-excluded", "visibility", v ? "visible" : "none");
      rebuild();
    }),
  ];

  c.add(tileParams, "minPieceLength", 0, 20, 0.5).name("min fragment (px)").onChange(rebuild);
  c.add(styleParams, "lineWidth", 0.1, 3, 0.05).name("line width").onChange(() =>
    map.setPaintProperty("contours", "line-width", contourWidth()),
  );
  c.add(styleParams, "lineOpacity", 0.05, 1, 0.05).name("line opacity").onChange(() =>
    map.setPaintProperty("contours", "line-opacity", contourOpacity()),
  );
  c.addColor(styleParams, "contourColor").name("color").onChange((v) => {
    map.setPaintProperty("contours", "line-color", v);
    map.setPaintProperty("contour-labels", "text-color", v);
  });

  function updateModeControls() {
    const mode = tileParams.contourMode;
    densityControls.forEach(ctrl => mode === "density" ? ctrl.show() : ctrl.hide());
    msControls.forEach(ctrl => mode === "minspacing" ? ctrl.show() : ctrl.hide());
  }
  updateModeControls();

  const light = gui.addFolder("Hillshade · light");
  light.add(tileParams, "hillshade").name("generate").onChange(rebuild);
  light.add(tileParams, "azimuth", 0, 360, 1).onChange(rebuild);
  light.add(tileParams, "altitude", 10, 80, 1).onChange(rebuild);
  light.add(tileParams, "exaggeration", 0.25, 5, 0.05).onChange(rebuild);
  light.add(tileParams, "zoomBoost", 1, 2, 0.05).name("low-zoom boost").onChange(rebuild);

  const bands = gui.addFolder("Hillshade · bands");
  tileParams.shadowLevels.forEach((_, i) =>
    bands.add(tileParams.shadowLevels, i, 0.01, 0.95, 0.01).name(`shadow ${i + 1}`).onChange(rebuild),
  );
  bands.add(tileParams.highlightLevels, 0, 0.01, 0.95, 0.01).name("highlight").onChange(rebuild);

  const gen = gui.addFolder("Hillshade · generalisation");
  gen.add(tileParams, "demBlur", 0, 8, 0.5).name("DEM blur (px)").onChange(rebuild);
  gen.add(tileParams, "shadeBlur", 0, 8, 0.5).name("shade blur (px)").onChange(rebuild);
  gen.add(tileParams, "simplify", 0, 4, 0.05).name("simplify (px)").onChange(rebuild);
  gen.add(tileParams, "smoothIterations", 0, 5, 1).name("smooth passes").onChange(rebuild);
  gen.add(tileParams, "minArea", 0, 200, 1).name("min area (px²)").onChange(rebuild);

  const st = gui.addFolder("Hillshade · style");
  st.addColor(styleParams, "shadowColor").onChange(paint("hillshade-shadow", "fill-color"));
  st.add(styleParams, "shadowOpacity", 0, 0.6, 0.01).onChange(paint("hillshade-shadow", "fill-opacity"));
  st.addColor(styleParams, "highlightColor").onChange(paint("hillshade-highlight", "fill-color"));
  st.add(styleParams, "highlightOpacity", 0, 1, 0.01).onChange(paint("hillshade-highlight", "fill-opacity"));
  st.add(styleParams, "outlines").name("show outlines").onChange((v) =>
    map.setLayoutProperty("hillshade-outline", "visibility", v ? "visible" : "none"),
  );
  st.add(styleParams, "rasterHillshade").name("compare raster").onChange((v) =>
    map.setLayoutProperty("raster-hillshade", "visibility", v ? "visible" : "none"),
  );
}

const statusEl = document.getElementById("status");
let tiles = 0, total = 0;
function reportTiming(ms) {
  tiles++;
  total += ms;
  statusEl.textContent = `z${map.getZoom().toFixed(1)} · ${tiles} tiles · avg ${(total / tiles).toFixed(0)} ms/tile in worker`;
}
