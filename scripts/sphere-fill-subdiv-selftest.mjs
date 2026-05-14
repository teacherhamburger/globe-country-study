/**
 * 自測：與 main.js 相同的球面三角形細分邏輯，確認大三角形經迭代後
 * max 邊角 <= FILL_SUBDIV_MAX_EDGE_RAD（或達三角形上限）。
 * 執行：node scripts/sphere-fill-subdiv-selftest.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DEG2RAD = Math.PI / 180;
const R = 100;
const MAX_EDGE_RAD = 0.82 * DEG2RAD;
const MAX_TRIANGLES = 125000;

function chordAngle(ax, ay, az, bx, by, bz) {
  const la = Math.hypot(ax, ay, az);
  const lb = Math.hypot(bx, by, bz);
  if (la < 1e-15 || lb < 1e-15) return 0;
  const d = (ax * bx + ay * by + az * bz) / (la * lb);
  return Math.acos(Math.max(-1, Math.min(1, d)));
}

function maxEdge(t) {
  return Math.max(
    chordAngle(t[0], t[1], t[2], t[3], t[4], t[5]),
    chordAngle(t[3], t[4], t[5], t[6], t[7], t[8]),
    chordAngle(t[6], t[7], t[8], t[0], t[1], t[2])
  );
}

function mid(out, o, ax, ay, az, bx, by, bz, r) {
  let x = ax + bx,
    y = ay + by,
    z = az + bz;
  const len = Math.hypot(x, y, z);
  const s = len > 1e-15 ? r / len : 0;
  out[o] = x * s;
  out[o + 1] = y * s;
  out[o + 2] = z * s;
}

function split(t, r) {
  const ax = t[0],
    ay = t[1],
    az = t[2],
    bx = t[3],
    by = t[4],
    bz = t[5],
    cx = t[6],
    cy = t[7],
    cz = t[8];
  const m = new Float32Array(9);
  mid(m, 0, ax, ay, az, bx, by, bz, r);
  mid(m, 3, bx, by, bz, cx, cy, cz, r);
  mid(m, 6, cx, cy, cz, ax, ay, az, r);
  const pack = (x0, y0, z0, x1, y1, z1, x2, y2, z2) =>
    new Float32Array([x0, y0, z0, x1, y1, z1, x2, y2, z2]);
  return [
    pack(ax, ay, az, m[0], m[1], m[2], m[6], m[7], m[8]),
    pack(m[0], m[1], m[2], bx, by, bz, m[3], m[4], m[5]),
    pack(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]),
    pack(m[6], m[7], m[8], m[3], m[4], m[5], cx, cy, cz),
  ];
}

function subdivide(pos, radius, maxEdgeRad, maxTriangles) {
  let tris = [];
  for (let i = 0; i < pos.length; i += 9) {
    tris.push(Float32Array.from(pos.subarray(i, i + 9)));
  }
  for (let iter = 0; iter < 24; iter++) {
    const next = [];
    let splitAny = false;
    for (const t of tris) {
      if (maxEdge(t) <= maxEdgeRad || next.length > maxTriangles - 4) {
        next.push(t);
        continue;
      }
      if (next.length + 4 > maxTriangles) {
        next.push(t);
        continue;
      }
      splitAny = true;
      for (const q of split(t, radius)) next.push(q);
    }
    tris = next;
    if (!splitAny || tris.length >= maxTriangles) break;
  }
  return tris;
}

function latLonToVec(lat, lon, radius) {
  const phi = (90 - lat) * DEG2RAD;
  const theta = (lon + 180) * DEG2RAD;
  const x = -radius * Math.sin(phi) * Math.cos(theta);
  const z = radius * Math.sin(phi) * Math.sin(theta);
  const y = radius * Math.cos(phi);
  return [x, y, z];
}

// 人造「超大」球面三角形（模擬 earcut 在大國產生的大弦面）
const A = latLonToVec(50, 90, R);
const B = latLonToVec(42, 120, R);
const C = latLonToVec(35, 95, R);
const big = new Float32Array([...A, ...B, ...C]);

let worstIso = "";
let worstAfter = 0;
let worstBefore = maxEdge(big);

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const gj = JSON.parse(
  readFileSync(join(root, "data/ne_50m_admin_0_countries.geojson"), "utf8")
);

function isoOf(f) {
  const p = f.properties;
  return (p.ISO_A2 || p.iso_a2 || "").toUpperCase();
}

for (const iso of ["MN", "US", "AU", "KZ", "CN"]) {
  const f = gj.features.find((x) => isoOf(x) === iso);
  if (!f) continue;
  const g = f.geometry;
  const rings =
    g.type === "Polygon"
      ? g.coordinates[0]
      : g.type === "MultiPolygon"
        ? g.coordinates[0][0]
        : null;
  if (!rings?.length) continue;
  let minLon = 180,
    maxLon = -180,
    minLat = 90,
    maxLat = -90;
  for (const [lon, lat] of rings) {
    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  }
  const tri = new Float32Array([
    ...latLonToVec(minLat, minLon, R),
    ...latLonToVec(minLat, maxLon, R),
    ...latLonToVec(maxLat, (minLon + maxLon) / 2, R),
  ]);
  const tris = subdivide(tri, R, MAX_EDGE_RAD, MAX_TRIANGLES);
  let mx = 0;
  for (const t of tris) mx = Math.max(mx, maxEdge(t));
  if (mx > worstAfter) {
    worstAfter = mx;
    worstIso = iso;
  }
}

const trisBig = subdivide(big, R, MAX_EDGE_RAD, MAX_TRIANGLES);
let mxBig = 0;
for (const t of trisBig) mxBig = Math.max(mxBig, maxEdge(t));

console.log("sphere-fill-subdiv selftest");
console.log("  synthetic tri max edge before:", (worstBefore / DEG2RAD).toFixed(3), "deg");
console.log("  synthetic tri max edge after: ", (mxBig / DEG2RAD).toFixed(3), "deg");
console.log("  worst bbox-corner tri after: ", worstIso, (worstAfter / DEG2RAD).toFixed(3), "deg");
console.log("  threshold:                    ", (MAX_EDGE_RAD / DEG2RAD).toFixed(3), "deg");
console.log("  triangle cap:                 ", MAX_TRIANGLES);

const ok = mxBig <= MAX_EDGE_RAD * 1.001 && worstAfter <= MAX_EDGE_RAD * 1.001;
if (!ok) {
  console.error("FAIL: max edge still above threshold");
  process.exit(1);
}
console.log("OK");
