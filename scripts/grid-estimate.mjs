/**
 * 粗估大國格點填色三角形量（與 main.js 常數同步時可手動更新）。
 */
import fs from "node:fs";

const GRID_MAX_CELL_DEG = 0.48;
const GRID_MAX_CELLS_PER_AXIS = 300;
const GRID_SUBCELLS = 4;

function ringVertexCount(ring) {
  const n = ring.length;
  if (n < 3) return 0;
  const closed =
    n > 2 && ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1];
  return closed ? n - 1 : n;
}

function bboxExterior(geom) {
  const ring =
    geom.type === "Polygon"
      ? geom.coordinates[0]
      : geom.coordinates[0]?.[0] ?? [];
  let minLon = 180;
  let maxLon = -180;
  let minLat = 90;
  let maxLat = -90;
  const useN = ringVertexCount(ring);
  for (let i = 0; i < useN; i++) {
    const [lon, lat] = ring[i];
    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  }
  return { minLon, maxLon, minLat, maxLat, ringPts: useN };
}

const raw = fs.readFileSync(
  new URL("../data/ne_50m_admin_0_countries.geojson", import.meta.url),
  "utf8"
);
const geo = JSON.parse(raw);
const iso2 = (f) => f.properties?.ISO_A2;
const samples = ["AU", "US", "RU", "CN", "BR"];
const rows = [];
for (const code of samples) {
  const f = geo.features.find((x) => iso2(x) === code);
  if (!f) continue;
  const b = bboxExterior(f.geometry);
  const spanLon = Math.max(0.01, b.maxLon - b.minLon);
  const spanLat = Math.max(0.01, b.maxLat - b.minLat);
  let nx = Math.min(
    GRID_MAX_CELLS_PER_AXIS,
    Math.max(8, Math.ceil(spanLon / GRID_MAX_CELL_DEG))
  );
  let ny = Math.min(
    GRID_MAX_CELLS_PER_AXIS,
    Math.max(8, Math.ceil(spanLat / GRID_MAX_CELL_DEG))
  );
  const worstTris = nx * ny * GRID_SUBCELLS * GRID_SUBCELLS * 2;
  rows.push({
    iso: code,
    ringPts: b.ringPts,
    nx,
    ny,
    worstTris,
  });
}
console.log(JSON.stringify({ gridDeg: GRID_MAX_CELL_DEG, rows }, null, 2));
