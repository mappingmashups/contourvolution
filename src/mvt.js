// Minimal Mapbox Vector Tile encoder.
// Geometry is an array of parts, each a flat [x0, y0, x1, y1, ...] array in tile coordinates.
// Polygon rings must NOT repeat their first point (ClosePath is emitted instead) and must
// already be wound per the MVT spec (exterior: positive shoelace area with y pointing down).
import { PbfWriter } from "pbf";

export const POINT = 1;
export const LINESTRING = 2;
export const POLYGON = 3;

/**
 * @param {{[layerName: string]: {extent?: number, features: {type: number, properties: object, geometry: number[][]}[]}}} layers
 * @returns {ArrayBuffer}
 */
export function encodeTile(layers) {
  const pbf = new PbfWriter();
  for (const [name, layer] of Object.entries(layers)) {
    pbf.writeMessage(3, writeLayer, { name, ...layer });
  }
  const bytes = pbf.finish();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function writeLayer(layer, pbf) {
  pbf.writeVarintField(15, 2);
  pbf.writeStringField(1, layer.name);
  const ctx = { keys: [], values: [], keyIndex: new Map(), valueIndex: new Map() };
  for (const feature of layer.features) {
    if (feature.geometry.length === 0) continue;
    ctx.feature = feature;
    pbf.writeMessage(2, writeFeature, ctx);
  }
  for (const key of ctx.keys) pbf.writeStringField(3, key);
  for (const value of ctx.values) pbf.writeMessage(4, writeValue, value);
  pbf.writeVarintField(5, layer.extent ?? 4096);
}

function writeFeature(ctx, pbf) {
  const { feature } = ctx;
  pbf.writeMessage(2, writeTags, ctx);
  pbf.writeVarintField(3, feature.type);
  pbf.writeMessage(4, writeGeometry, feature);
}

function writeTags(ctx, pbf) {
  for (const [key, value] of Object.entries(ctx.feature.properties)) {
    if (value === null || value === undefined) continue;
    let k = ctx.keyIndex.get(key);
    if (k === undefined) {
      k = ctx.keys.push(key) - 1;
      ctx.keyIndex.set(key, k);
    }
    const valueKey = `${typeof value}:${value}`;
    let v = ctx.valueIndex.get(valueKey);
    if (v === undefined) {
      v = ctx.values.push(value) - 1;
      ctx.valueIndex.set(valueKey, v);
    }
    pbf.writeVarint(k);
    pbf.writeVarint(v);
  }
}

const command = (cmd, length) => (length << 3) + (cmd & 0x7);
const zigzag = (n) => (n << 1) ^ (n >> 31);

function writeGeometry(feature, pbf) {
  const isPolygon = feature.type === POLYGON;
  let x = 0;
  let y = 0;
  for (const part of feature.geometry) {
    const count = part.length / 2;
    for (let i = 0; i < count; i++) {
      if (i === 0) pbf.writeVarint(command(1, 1)); // MoveTo
      else if (i === 1) pbf.writeVarint(command(2, count - 1)); // LineTo
      const px = Math.round(part[i * 2]);
      const py = Math.round(part[i * 2 + 1]);
      pbf.writeVarint(zigzag(px - x));
      pbf.writeVarint(zigzag(py - y));
      x = px;
      y = py;
    }
    if (isPolygon) pbf.writeVarint(command(7, 1)); // ClosePath
  }
}

function writeValue(value, pbf) {
  if (typeof value === "string") pbf.writeStringField(1, value);
  else if (typeof value === "boolean") pbf.writeBooleanField(7, value);
  else if (Number.isInteger(value)) {
    if (value < 0) pbf.writeSVarintField(6, value);
    else pbf.writeVarintField(5, value);
  } else pbf.writeDoubleField(3, value);
}
