import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  CSS2DObject,
  CSS2DRenderer,
} from "three/addons/renderers/CSS2DRenderer.js";
import earcut from "earcut";

const EARTH_RADIUS = 100;
const BORDER_RADIUS = EARTH_RADIUS * 1.0011;
const SOLVED_FILL_RADIUS = EARTH_RADIUS * 1.0009;
const FILL_SHELL_RADIUS = EARTH_RADIUS * 1.0032;
const LARGE_POLYGON_ANGLE = THREE.MathUtils.degToRad(18);
const GRID_MAX_CELL_DEG = 0.48;
const GRID_MAX_CELLS_PER_AXIS = 300;
const GRID_SUBCELLS = 4;
const FILL_MATERIAL_REV = 5;
const FILL_SUBDIV_MAX_EDGE_RAD = THREE.MathUtils.degToRad(0.82);
const FILL_SUBDIV_MAX_TRIANGLES = 125000;
const TEXTURE =
  "https://threejs.org/examples/textures/planets/earth_atmos_2048.jpg";
const LABEL_BACKFACE_DOT = 0.12;
const TAP_SLOP_PX = 10;
const TAP_MAX_MS = 450;
/** 台灣：題庫第 196 題，抽到即自動綠色答對（送分題）。 */
const TW_FREEBIE_ISO2 = "TW";
const UN_QUIZ_BODY_COUNT = 195;

function latLonToVector3(lat, lon, radius) {
  const phi = THREE.MathUtils.degToRad(90 - lat);
  const theta = THREE.MathUtils.degToRad(lon + 180);
  const x = -radius * Math.sin(phi) * Math.cos(theta);
  const z = radius * Math.sin(phi) * Math.sin(theta);
  const y = radius * Math.cos(phi);
  return new THREE.Vector3(x, y, z);
}

function vector3ToLatLon(v) {
  const n = v.clone().normalize();
  const lat = THREE.MathUtils.radToDeg(
    Math.asin(THREE.MathUtils.clamp(n.y, -1, 1))
  );
  let lon = THREE.MathUtils.radToDeg(Math.atan2(n.z, -n.x)) - 180;
  while (lon > 180) lon -= 360;
  while (lon < -180) lon += 360;
  return { lat, lon };
}

function featureToIso2(f) {
  const p = f.properties;
  if (p.ADM0_A3 === "NOR") return "NO";
  if (p.ADM0_A3 === "TWN") return "TW";
  if (p.ADM0_A3 === "KOS") return "XK";
  const a2 = p.ISO_A2;
  if (a2 === "CN-TW" || a2 === "TW") return "TW";
  if (a2 && a2 !== "-99" && /^[A-Z]{2}$/.test(a2)) return a2;
  const wb = p.WB_A2;
  if (wb && wb !== "-99" && /^[A-Z]{2}$/.test(wb)) return wb === "KV" ? "XK" : wb;
  return null;
}

function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const dy = yj - yi || 1e-15;
    const intersect =
      (yi > lat) !== (yj > lat) &&
      lon < ((xj - xi) * (lat - yi)) / dy + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInPolygonRings(lon, lat, rings) {
  if (!rings?.length) return false;
  if (!pointInRing(lon, lat, rings[0])) return false;
  for (let h = 1; h < rings.length; h++) {
    if (pointInRing(lon, lat, rings[h])) return false;
  }
  return true;
}

function pointInFeatureGeometry(lon, lat, geom) {
  if (!geom) return false;
  if (geom.type === "Polygon") {
    return pointInPolygonRings(lon, lat, geom.coordinates);
  }
  if (geom.type === "MultiPolygon") {
    for (const poly of geom.coordinates) {
      if (pointInPolygonRings(lon, lat, poly)) return true;
    }
  }
  return false;
}

function featureBBoxArea(f) {
  let minX = 180;
  let maxX = -180;
  let minY = 90;
  let maxY = -90;
  const eatRing = (ring) => {
    for (const [x, y] of ring) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  };
  const walk = (geom) => {
    if (geom.type === "Polygon") {
      for (const ring of geom.coordinates) eatRing(ring);
    } else if (geom.type === "MultiPolygon") {
      for (const poly of geom.coordinates) {
        for (const ring of poly) eatRing(ring);
      }
    }
  };
  walk(f.geometry);
  return Math.max(0, maxX - minX) * Math.max(0, maxY - minY);
}

const wrap = document.getElementById("canvas-wrap");
const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(
  45,
  window.innerWidth / window.innerHeight,
  0.1,
  2000
);
camera.position.set(0, 40, 320);

function rendererPixelRatio() {
  return Math.min(window.devicePixelRatio || 1, 2.75);
}

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  alpha: true,
  logarithmicDepthBuffer: true,
});
renderer.setPixelRatio(rendererPixelRatio());
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x02040a, 1);
renderer.dithering = true;
wrap.appendChild(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(window.innerWidth, window.innerHeight);
labelRenderer.domElement.style.position = "absolute";
labelRenderer.domElement.style.inset = "0";
labelRenderer.domElement.style.pointerEvents = "none";
wrap.appendChild(labelRenderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.minDistance = 150;
controls.maxDistance = 900;
controls.rotateSpeed = 0.65;
controls.zoomSpeed = 0.9;

let earthSpinTween = null;
controls.addEventListener("start", () => {
  earthSpinTween = null;
});

const ambient = new THREE.AmbientLight(0xffffff, 0.35);
scene.add(ambient);
const sun = new THREE.DirectionalLight(0xffffff, 1.25);
sun.position.set(80, 120, 180);
scene.add(sun);

const starsGeo = new THREE.BufferGeometry();
const starCount = 2000;
const positions = new Float32Array(starCount * 3);
for (let i = 0; i < starCount; i++) {
  const r = 800 + Math.random() * 400;
  const th = Math.random() * Math.PI * 2;
  const ph = Math.acos(2 * Math.random() - 1);
  positions[i * 3] = r * Math.sin(ph) * Math.cos(th);
  positions[i * 3 + 1] = r * Math.cos(ph);
  positions[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
}
starsGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
scene.add(
  new THREE.Points(
    starsGeo,
    new THREE.PointsMaterial({
      color: 0x8899bb,
      size: 1.2,
      transparent: true,
      opacity: 0.7,
    })
  )
);

const texLoader = new THREE.TextureLoader();
texLoader.setCrossOrigin("anonymous");
const earthTex = texLoader.load(TEXTURE);
earthTex.colorSpace = THREE.SRGBColorSpace;

const earth = new THREE.Mesh(
  new THREE.SphereGeometry(EARTH_RADIUS, 96, 96),
  new THREE.MeshPhongMaterial({
    map: earthTex,
    specular: new THREE.Color(0x222233),
    shininess: 8,
  })
);
scene.add(earth);

let bordersLines = null;
let solvedFillGroup = null;
let solvedFillMatCorrect = null;
let solvedFillMatWrong = null;
let solvedFillShellMatCorrect = null;
let solvedFillShellMatWrong = null;
const solvedFillMeshByIso = new Map();

const labelsGroup = new THREE.Group();
earth.add(labelsGroup);

let adminGeoJSON = null;
const featureByIso2 = new Map();
let countries = [];
const countryByIso = new Map();
const labelByIso = new Map();

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const _hit = new THREE.Vector3();
const _e0 = new THREE.Vector3();
const _e1 = new THREE.Vector3();
const _nTri = new THREE.Vector3();
const _p00 = new THREE.Vector3();
const _p10 = new THREE.Vector3();
const _p01 = new THREE.Vector3();
const _p11 = new THREE.Vector3();

const quiz = {
  running: false,
  question: null,
  pool: [],
  correct: 0,
  wrong: 0,
  published: new Map(),
};

/** ISO 3166-1 alpha-2：聯合國會員國 + 觀察員國（梵蒂岡 VA、巴勒斯坦 PS） */
let unMemberObserverIso2 = null;

function makeLabelEl(c) {
  const div = document.createElement("div");
  div.className = "country-label";
  div.dataset.iso2 = c.iso2;
  div.innerHTML = `<div class="zh"></div><div class="cap"></div>`;
  div.querySelector(".zh").textContent = c.nameZh;
  div.querySelector(".cap").textContent = c.capitalEn
    ? `首都 ${c.capitalEn}`
    : "首都（無）";
  return div;
}

function buildBorderGeometryFromGeoJSON(geojson, geometry) {
  const verts = [];
  const pushRing = (ring) => {
    if (!ring || ring.length < 2) return;
    for (let i = 0; i < ring.length - 1; i++) {
      const [lon0, lat0] = ring[i];
      const [lon1, lat1] = ring[i + 1];
      const a = latLonToVector3(lat0, lon0, BORDER_RADIUS);
      const b = latLonToVector3(lat1, lon1, BORDER_RADIUS);
      verts.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
  };
  const walkGeom = (geom) => {
    if (!geom?.type) return;
    if (geom.type === "Polygon") {
      for (const ring of geom.coordinates) pushRing(ring);
    } else if (geom.type === "MultiPolygon") {
      for (const poly of geom.coordinates) {
        for (const ring of poly) pushRing(ring);
      }
    }
  };
  for (const f of geojson.features ?? []) walkGeom(f.geometry);
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
}

function featureRepresentativeLatLon(feature) {
  const polys =
    feature.geometry.type === "Polygon"
      ? [feature.geometry.coordinates]
      : feature.geometry.coordinates;
  let bestRing = polys[0]?.[0];
  let bestArea = -1;
  for (const poly of polys) {
    const ring = poly?.[0];
    if (!ring?.length) continue;
    let minLon = 180;
    let maxLon = -180;
    let minLat = 90;
    let maxLat = -90;
    for (const [lon, lat] of ring) {
      minLon = Math.min(minLon, lon);
      maxLon = Math.max(maxLon, lon);
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
    }
    const area = (maxLon - minLon) * (maxLat - minLat);
    if (area > bestArea) {
      bestArea = area;
      bestRing = ring;
    }
  }
  if (!bestRing?.length) return null;
  let n = 0;
  let sumLat = 0;
  let sumLon = 0;
  const len = bestRing.length;
  const closed =
    len > 2 &&
    bestRing[0][0] === bestRing[len - 1][0] &&
    bestRing[0][1] === bestRing[len - 1][1];
  const useN = closed ? len - 1 : len;
  for (let i = 0; i < useN; i++) {
    sumLon += bestRing[i][0];
    sumLat += bestRing[i][1];
    n++;
  }
  if (!n) return null;
  return { lat: sumLat / n, lon: sumLon / n };
}

function syncLabelPositionsFromFeatures() {
  for (const c of countries) {
    const feat = featureByIso2.get(c.iso2);
    if (!feat) continue;
    const rep = featureRepresentativeLatLon(feat);
    if (!rep) continue;
    const obj = labelByIso.get(c.iso2);
    if (obj) {
      obj.position.copy(
        latLonToVector3(rep.lat, rep.lon, EARTH_RADIUS * 1.0025)
      );
    }
  }
}

function buildTangentBasis(normal) {
  const north = new THREE.Vector3(0, 1, 0);
  let tangent = new THREE.Vector3().crossVectors(north, normal);
  if (tangent.lengthSq() < 1e-8) {
    tangent = new THREE.Vector3(1, 0, 0).cross(normal);
  }
  tangent.normalize();
  const bitangent = new THREE.Vector3().crossVectors(normal, tangent).normalize();
  return { tangent, bitangent };
}

function ringVertexCount(ring) {
  const n = ring.length;
  if (n < 3) return 0;
  const closed =
    n > 2 && ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1];
  return closed ? n - 1 : n;
}

function ringSphericalCentroid(ring) {
  const useN = ringVertexCount(ring);
  if (useN < 1) return new THREE.Vector3(0, 1, 0);
  const sum = new THREE.Vector3();
  for (let i = 0; i < useN; i++) {
    const [lon, lat] = ring[i];
    sum.add(latLonToVector3(lat, lon, 1));
  }
  return sum.lengthSq() > 1e-16 ? sum.normalize() : new THREE.Vector3(0, 1, 0);
}

function largestAngleFromCentroid(ring, centroid) {
  const useN = ringVertexCount(ring);
  if (useN < 1) return 0;
  let minDot = 1;
  for (let i = 0; i < useN; i++) {
    const [lon, lat] = ring[i];
    const v = latLonToVector3(lat, lon, 1).normalize();
    minDot = Math.min(minDot, v.dot(centroid));
  }
  return Math.acos(THREE.MathUtils.clamp(minDot, -1, 1));
}

function densifyRingLatLon(ring, segmentsPerEdge = 3) {
  const n = ring.length;
  if (n < 2) return ring;
  const closed =
    n > 2 && ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1];
  const len = closed ? n - 1 : n;
  if (len < 2) return ring;
  const out = [];
  for (let i = 0; i < len; i++) {
    const j = (i + 1) % len;
    const [lonA, latA] = ring[i];
    const [lonB, latB] = ring[j];
    out.push([lonA, latA]);
    const va = latLonToVector3(latA, lonA, 1);
    const vb = latLonToVector3(latB, lonB, 1);
    for (let s = 1; s < segmentsPerEdge; s++) {
      const t = s / segmentsPerEdge;
      const v = va.clone().lerp(vb, t).normalize();
      const ll = vector3ToLatLon(v);
      out.push([ll.lon, ll.lat]);
    }
  }
  return out;
}

function cellTouchesPolygon(lon0, lon1, lat0, lat1, rings) {
  const lonC = (lon0 + lon1) * 0.5;
  const latC = (lat0 + lat1) * 0.5;
  if (pointInPolygonRings(lonC, latC, rings)) return true;
  if (pointInPolygonRings(lon0, lat0, rings)) return true;
  if (pointInPolygonRings(lon1, lat0, rings)) return true;
  if (pointInPolygonRings(lon0, lat1, rings)) return true;
  if (pointInPolygonRings(lon1, lat1, rings)) return true;
  const midLon01 = (lon0 + lon1) * 0.5;
  if (pointInPolygonRings(midLon01, lat0, rings)) return true;
  if (pointInPolygonRings(midLon01, lat1, rings)) return true;
  const midLat01 = (lat0 + lat1) * 0.5;
  if (pointInPolygonRings(lon0, midLat01, rings)) return true;
  if (pointInPolygonRings(lon1, midLat01, rings)) return true;
  return false;
}

function pushTriOutward(out, a, b, c) {
  _e0.subVectors(b, a);
  _e1.subVectors(c, a);
  _nTri.crossVectors(_e0, _e1);
  if (_nTri.dot(a) < 0) {
    out.push(a.x, a.y, a.z, c.x, c.y, c.z, b.x, b.y, b.z);
  } else {
    out.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  }
}

function pushSphericalCellTris(out, lat0, lon0, lat1, lon1, radius) {
  _p00.copy(latLonToVector3(lat0, lon0, radius));
  _p10.copy(latLonToVector3(lat0, lon1, radius));
  _p01.copy(latLonToVector3(lat1, lon0, radius));
  _p11.copy(latLonToVector3(lat1, lon1, radius));
  pushTriOutward(out, _p00, _p01, _p11);
  pushTriOutward(out, _p00, _p11, _p10);
}

function cornersAllInside(lon0, lon1, lat0, lat1, rings) {
  if (!pointInPolygonRings(lon0, lat0, rings)) return false;
  if (!pointInPolygonRings(lon1, lat0, rings)) return false;
  if (!pointInPolygonRings(lon0, lat1, rings)) return false;
  if (!pointInPolygonRings(lon1, lat1, rings)) return false;
  return true;
}

function fillPolygonByGrid(rings, radius) {
  const exterior = rings[0];
  if (!exterior?.length) return new Float32Array(0);
  let minLon = 180;
  let maxLon = -180;
  let minLat = 90;
  let maxLat = -90;
  const useN = ringVertexCount(exterior);
  for (let i = 0; i < useN; i++) {
    const [lon, lat] = exterior[i];
    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  }
  const spanLon = Math.max(0.01, maxLon - minLon);
  const spanLat = Math.max(0.01, maxLat - minLat);
  let nx = Math.ceil(spanLon / GRID_MAX_CELL_DEG);
  let ny = Math.ceil(spanLat / GRID_MAX_CELL_DEG);
  nx = Math.min(GRID_MAX_CELLS_PER_AXIS, Math.max(8, nx));
  ny = Math.min(GRID_MAX_CELLS_PER_AXIS, Math.max(8, ny));
  const stepLon = spanLon / nx;
  const stepLat = spanLat / ny;
  const out = [];
  for (let iy = 0; iy < ny; iy++) {
    const lat0 = minLat + iy * stepLat;
    const lat1 = minLat + (iy + 1) * stepLat;
    for (let ix = 0; ix < nx; ix++) {
      const lon0 = minLon + ix * stepLon;
      const lon1 = minLon + (ix + 1) * stepLon;
      if (!cellTouchesPolygon(lon0, lon1, lat0, lat1, rings)) continue;

      if (cornersAllInside(lon0, lon1, lat0, lat1, rings)) {
        pushSphericalCellTris(out, lat0, lon0, lat1, lon1, radius);
        continue;
      }

      const subLon = (lon1 - lon0) / GRID_SUBCELLS;
      const subLat = (lat1 - lat0) / GRID_SUBCELLS;
      for (let sy = 0; sy < GRID_SUBCELLS; sy++) {
        const sl0 = lat0 + sy * subLat;
        const sl1 = lat0 + (sy + 1) * subLat;
        for (let sx = 0; sx < GRID_SUBCELLS; sx++) {
          const sw0 = lon0 + sx * subLon;
          const sw1 = lon0 + (sx + 1) * subLon;
          const cLon = (sw0 + sw1) * 0.5;
          const cLat = (sl0 + sl1) * 0.5;
          if (!pointInPolygonRings(cLon, cLat, rings)) continue;
          pushSphericalCellTris(out, sl0, sw0, sl1, sw1, radius);
        }
      }
    }
  }
  return new Float32Array(out);
}

function triangulateRingsToPositions(rings, radius) {
  if (!rings?.length) return new Float32Array(0);
  const centroid = ringSphericalCentroid(rings[0]);
  const span = largestAngleFromCentroid(rings[0], centroid);
  if (span > LARGE_POLYGON_ANGLE) {
    return fillPolygonByGrid(rings, radius);
  }

  const densifySegments = span > THREE.MathUtils.degToRad(18) ? 2 : 4;
  const workRings = rings.map((ring, ri) =>
    densifyRingLatLon(ring, ri === 0 ? densifySegments : Math.max(2, densifySegments - 1))
  );
  const { tangent, bitangent } = buildTangentBasis(centroid);
  const flat = [];
  const holeIdx = [];
  const latLonVerts = [];
  let vtxCount = 0;
  let exteriorCount = 0;
  for (let r = 0; r < workRings.length; r++) {
    const ring = workRings[r];
    const useN = ringVertexCount(ring);
    if (useN < 3) {
      if (r === 0) return new Float32Array(0);
      continue;
    }
    if (r > 0) holeIdx.push(vtxCount);
    for (let i = 0; i < useN; i++) {
      const [lon, lat] = ring[i];
      const p = latLonToVector3(lat, lon, 1).normalize();
      flat.push(p.dot(tangent), p.dot(bitangent));
      latLonVerts.push([lat, lon]);
      vtxCount++;
    }
    if (r === 0) exteriorCount = vtxCount;
  }
  if (exteriorCount < 3) return new Float32Array(0);

  let area = 0;
  for (let i = 0; i < exteriorCount; i++) {
    const x0 = flat[i * 2];
    const y0 = flat[i * 2 + 1];
    const j = (i + 1) % exteriorCount;
    const x1 = flat[j * 2];
    const y1 = flat[j * 2 + 1];
    area += x0 * y1 - x1 * y0;
  }
  if (area < 0) {
    for (let i = 0, j = exteriorCount - 1; i < j; i++, j--) {
      const ti = i * 2;
      const tj = j * 2;
      const x = flat[ti];
      const y = flat[ti + 1];
      flat[ti] = flat[tj];
      flat[ti + 1] = flat[tj + 1];
      flat[tj] = x;
      flat[tj + 1] = y;
      const ll = latLonVerts[i];
      latLonVerts[i] = latLonVerts[j];
      latLonVerts[j] = ll;
    }
  }

  let indices;
  try {
    indices = earcut(flat, holeIdx.length ? holeIdx : undefined, 2);
  } catch {
    return fillPolygonByGrid(rings, radius);
  }
  if (!indices?.length) return fillPolygonByGrid(rings, radius);

  const triFlat = [];
  for (let i = 0; i < indices.length; i += 3) {
    const [la0, lo0] = latLonVerts[indices[i]];
    const [la1, lo1] = latLonVerts[indices[i + 1]];
    const [la2, lo2] = latLonVerts[indices[i + 2]];
    const va = latLonToVector3(la0, lo0, radius);
    const vb = latLonToVector3(la1, lo1, radius);
    const vc = latLonToVector3(la2, lo2, radius);
    pushTriOutward(triFlat, va, vb, vc);
  }
  return new Float32Array(triFlat);
}

function positionsForFeatureGeometry(geom) {
  const parts = [];
  if (geom.type === "Polygon") {
    const p = triangulateRingsToPositions(geom.coordinates, SOLVED_FILL_RADIUS);
    if (p.length) parts.push(p);
  } else if (geom.type === "MultiPolygon") {
    for (const poly of geom.coordinates) {
      const p = triangulateRingsToPositions(poly, SOLVED_FILL_RADIUS);
      if (p.length) parts.push(p);
    }
  }
  let total = 0;
  for (const c of parts) total += c.length;
  const out = new Float32Array(total);
  let o = 0;
  for (const c of parts) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function chordAngleBetweenPoints(ax, ay, az, bx, by, bz) {
  const la = Math.hypot(ax, ay, az);
  const lb = Math.hypot(bx, by, bz);
  if (la < 1e-15 || lb < 1e-15) return 0;
  return Math.acos(
    THREE.MathUtils.clamp((ax * bx + ay * by + az * bz) / (la * lb), -1, 1)
  );
}

function maxPackedTriEdgeAngle(t) {
  return Math.max(
    chordAngleBetweenPoints(t[0], t[1], t[2], t[3], t[4], t[5]),
    chordAngleBetweenPoints(t[3], t[4], t[5], t[6], t[7], t[8]),
    chordAngleBetweenPoints(t[6], t[7], t[8], t[0], t[1], t[2])
  );
}

function sphericalMidpointTo(out3, o, ax, ay, az, bx, by, bz, r) {
  let x = ax + bx;
  let y = ay + by;
  let z = az + bz;
  const len = Math.hypot(x, y, z);
  if (len < 1e-15) {
    out3[o] = ax;
    out3[o + 1] = ay;
    out3[o + 2] = az;
    return;
  }
  const s = r / len;
  out3[o] = x * s;
  out3[o + 1] = y * s;
  out3[o + 2] = z * s;
}

/** Midpoint splits on the sphere: shrink max edge angle so large tris are not depth-clipped by the globe. */
function splitOneTriangleOnSphere(t, r) {
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
  sphericalMidpointTo(m, 0, ax, ay, az, bx, by, bz, r);
  sphericalMidpointTo(m, 3, bx, by, bz, cx, cy, cz, r);
  sphericalMidpointTo(m, 6, cx, cy, cz, ax, ay, az, r);
  const mabx = m[0],
    maby = m[1],
    mabz = m[2];
  const mbcx = m[3],
    mbcy = m[4],
    mbcz = m[5];
  const mcax = m[6],
    mcay = m[7],
    mcaz = m[8];

  const pack = (x0, y0, z0, x1, y1, z1, x2, y2, z2) => {
    const o = new Float32Array(9);
    o[0] = x0;
    o[1] = y0;
    o[2] = z0;
    o[3] = x1;
    o[4] = y1;
    o[5] = z1;
    o[6] = x2;
    o[7] = y2;
    o[8] = z2;
    return o;
  };

  return [
    pack(ax, ay, az, mabx, maby, mabz, mcax, mcay, mcaz),
    pack(mabx, maby, mabz, bx, by, bz, mbcx, mbcy, mbcz),
    pack(mabx, maby, mabz, mbcx, mbcy, mbcz, mcax, mcay, mcaz),
    pack(mcax, mcay, mcaz, mbcx, mbcy, mbcz, cx, cy, cz),
  ];
}

function subdivideLargeSphericalTriangles(pos, radius, maxEdgeRad, maxTriangles) {
  const triCount = Math.floor(pos.length / 9);
  if (triCount < 1) return pos;
  let tris = [];
  for (let i = 0; i < pos.length; i += 9) {
    tris.push(Float32Array.from(pos.subarray(i, i + 9)));
  }
  for (let iter = 0; iter < 24; iter++) {
    const next = [];
    let splitAny = false;
    for (const t of tris) {
      if (
        maxPackedTriEdgeAngle(t) <= maxEdgeRad ||
        next.length > maxTriangles - 4
      ) {
        next.push(t);
        continue;
      }
      if (next.length + 4 > maxTriangles) {
        next.push(t);
        continue;
      }
      splitAny = true;
      for (const q of splitOneTriangleOnSphere(t, radius)) next.push(q);
    }
    tris = next;
    if (!splitAny || tris.length >= maxTriangles) break;
  }
  const out = new Float32Array(tris.length * 9);
  for (let i = 0; i < tris.length; i++) {
    out.set(tris[i], i * 9);
  }
  return out;
}

function duplicatePositionsAtRadius(pos, targetR) {
  const out = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i];
    const y = pos[i + 1];
    const z = pos[i + 2];
    const len = Math.hypot(x, y, z);
    const s = len > 1e-15 ? targetR / len : 0;
    out[i] = x * s;
    out[i + 1] = y * s;
    out[i + 2] = z * s;
  }
  return out;
}

function getSolvedFillMaterial(kind) {
  if (kind === "correct") {
    if (!solvedFillMatCorrect || solvedFillMatCorrect.userData.rev !== FILL_MATERIAL_REV) {
      solvedFillMatCorrect?.dispose();
      solvedFillMatCorrect = new THREE.MeshBasicMaterial({
        color: 0x48d6b0,
        transparent: true,
        opacity: 0.4,
        depthWrite: false,
        depthTest: true,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -4,
        side: THREE.FrontSide,
        toneMapped: false,
      });
      solvedFillMatCorrect.userData.rev = FILL_MATERIAL_REV;
    }
    return solvedFillMatCorrect;
  }
  if (!solvedFillMatWrong || solvedFillMatWrong.userData.rev !== FILL_MATERIAL_REV) {
    solvedFillMatWrong?.dispose();
    solvedFillMatWrong = new THREE.MeshBasicMaterial({
      color: 0xff8fa3,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      depthTest: true,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -4,
      side: THREE.FrontSide,
      toneMapped: false,
    });
    solvedFillMatWrong.userData.rev = FILL_MATERIAL_REV;
  }
  return solvedFillMatWrong;
}

function getFillShellMaterial(kind) {
  if (kind === "correct") {
    if (
      !solvedFillShellMatCorrect ||
      solvedFillShellMatCorrect.userData.rev !== FILL_MATERIAL_REV
    ) {
      solvedFillShellMatCorrect?.dispose();
      solvedFillShellMatCorrect = new THREE.MeshBasicMaterial({
        color: 0x48d6b0,
        transparent: true,
        opacity: 0.18,
        depthWrite: false,
        depthTest: true,
        polygonOffset: true,
        polygonOffsetFactor: -0.5,
        polygonOffsetUnits: -2,
        side: THREE.FrontSide,
        toneMapped: false,
      });
      solvedFillShellMatCorrect.userData.rev = FILL_MATERIAL_REV;
    }
    return solvedFillShellMatCorrect;
  }
  if (
    !solvedFillShellMatWrong ||
    solvedFillShellMatWrong.userData.rev !== FILL_MATERIAL_REV
  ) {
    solvedFillShellMatWrong?.dispose();
    solvedFillShellMatWrong = new THREE.MeshBasicMaterial({
      color: 0xff8fa3,
      transparent: true,
      opacity: 0.2,
      depthWrite: false,
      depthTest: true,
      polygonOffset: true,
      polygonOffsetFactor: -0.5,
      polygonOffsetUnits: -2,
      side: THREE.FrontSide,
      toneMapped: false,
    });
    solvedFillShellMatWrong.userData.rev = FILL_MATERIAL_REV;
  }
  return solvedFillShellMatWrong;
}

function ensureSolvedFillGroup() {
  if (solvedFillGroup) return;
  solvedFillGroup = new THREE.Group();
  solvedFillGroup.renderOrder = 3;
  earth.add(solvedFillGroup);
}

function removeCountryFill(iso2) {
  const group = solvedFillMeshByIso.get(iso2);
  if (!group || !solvedFillGroup) return;
  solvedFillGroup.remove(group);
  group.traverse((obj) => {
    if (!obj.isMesh) return;
    obj.geometry?.dispose();
    if (obj.userData?.disposeOwnMaterial) obj.material?.dispose();
  });
  solvedFillMeshByIso.delete(iso2);
}

function clearSolvedFillMeshes() {
  for (const iso of [...solvedFillMeshByIso.keys()]) removeCountryFill(iso);
}

function addCountryFill(feature, kind, iso2) {
  ensureSolvedFillGroup();
  removeCountryFill(iso2);
  let pos = positionsForFeatureGeometry(feature.geometry);
  if (pos.length < 9) return;
  pos = subdivideLargeSphericalTriangles(
    pos,
    SOLVED_FILL_RADIUS,
    FILL_SUBDIV_MAX_EDGE_RAD,
    FILL_SUBDIV_MAX_TRIANGLES
  );

  const group = new THREE.Group();
  const twCorrect =
    iso2 === TW_FREEBIE_ISO2 && kind === "correct";
  const shellMat = twCorrect
    ? getFillShellMaterial(kind).clone()
    : getFillShellMaterial(kind);
  if (twCorrect) shellMat.opacity = 0.26;
  const mainMat = twCorrect
    ? getSolvedFillMaterial(kind).clone()
    : getSolvedFillMaterial(kind);
  if (twCorrect) mainMat.opacity = 0.52;

  const shellPos = duplicatePositionsAtRadius(pos, FILL_SHELL_RADIUS);
  const shellGeo = new THREE.BufferGeometry();
  shellGeo.setAttribute("position", new THREE.BufferAttribute(shellPos, 3));
  shellGeo.computeVertexNormals();
  const shellMesh = new THREE.Mesh(shellGeo, shellMat);
  shellMesh.renderOrder = 2;
  if (twCorrect) shellMesh.userData.disposeOwnMaterial = true;
  group.add(shellMesh);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, mainMat);
  mesh.renderOrder = 3;
  if (twCorrect) mesh.userData.disposeOwnMaterial = true;
  group.add(mesh);

  solvedFillGroup.add(group);
  solvedFillMeshByIso.set(iso2, group);
}

function findFeatureAtLonLat(lon, lat) {
  if (!adminGeoJSON?.features) return null;
  const matches = [];
  for (const f of adminGeoJSON.features) {
    if (pointInFeatureGeometry(lon, lat, f.geometry)) matches.push(f);
  }
  if (!matches.length) return null;
  return matches.reduce((a, b) =>
    featureBBoxArea(a) <= featureBBoxArea(b) ? a : b
  );
}

function latLonForIso2(iso2) {
  const feat = featureByIso2.get(iso2);
  const rep = feat ? featureRepresentativeLatLon(feat) : null;
  if (rep) return rep;
  const c = countryByIso.get(iso2);
  return c ? { lat: c.lat, lon: c.lon } : null;
}

function pickIsoAtClient(clientX, clientY) {
  const rect = renderer.domElement.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);
  const pickTargets = [earth];
  if (solvedFillGroup) pickTargets.push(solvedFillGroup);
  const hits = raycaster.intersectObjects(pickTargets, true);
  if (!hits.length) return null;
  earth.updateMatrixWorld(true);
  _hit.copy(hits[0].point);
  earth.worldToLocal(_hit);
  const { lat, lon } = vector3ToLatLon(_hit);
  const feat = findFeatureAtLonLat(lon, lat);
  return feat ? featureToIso2(feat) : null;
}

function setQuizFeedback(msg, cls = "") {
  const el = document.getElementById("quiz-feedback");
  if (!el) return;
  el.textContent = msg;
  el.className = cls;
}

function refreshQuizLabels() {
  labelsGroup.visible = quiz.published.size > 0;
  for (const [iso, obj] of labelByIso) {
    const kind = quiz.published.get(iso);
    const show = kind === "correct" || kind === "wrong";
    obj.visible = show;
    obj.element.style.visibility = show ? "visible" : "hidden";
    obj.element.classList.toggle("highlight", kind === "correct");
    obj.element.classList.toggle("revealed-wrong", kind === "wrong");
  }
}

function hideAllLabels() {
  labelsGroup.visible = false;
  for (const [, obj] of labelByIso) {
    obj.visible = false;
    obj.element.style.visibility = "hidden";
    obj.element.classList.remove("highlight", "revealed-wrong");
  }
}

function syncQuizUI() {
  const statsEl = document.getElementById("quiz-stats");
  const qEl = document.getElementById("quiz-question");
  const qCard = document.getElementById("quiz-question-card");
  const qLabel = qCard?.querySelector(".quiz-question-label");
  const startBtn = document.getElementById("btn-quiz-start");
  const finished = quiz.published.size;
  const remain = quiz.pool.length - finished;
  const attempts = quiz.correct + quiz.wrong;
  const rate =
    attempts > 0 ? Math.round((quiz.correct / attempts) * 100) : null;

  if (statsEl) {
    const twFreebie = quiz.pool.includes(TW_FREEBIE_ISO2);
    const poolLabel = twFreebie
      ? `共 ${quiz.pool.length} 國（${UN_QUIZ_BODY_COUNT} 聯合國＋台灣送分）`
      : `聯合國體系 ${quiz.pool.length} 國`;
    statsEl.textContent = `${poolLabel} · 剩餘 ${remain} · 答對 ${quiz.correct} · 答錯 ${quiz.wrong} · 答對率 ${
      rate === null ? "—" : `${rate}%`
    }`;
  }

  if (qEl) {
    if (quiz.running && quiz.question) {
      qCard?.classList.add("is-active");
      qCard?.classList.remove("is-idle");
      if (qLabel)
        qLabel.textContent =
          quiz.question.iso2 === TW_FREEBIE_ISO2 ? "送分題" : "請點選";
      qEl.innerHTML = `<span class="quiz-country-zh">${quiz.question.nameZh}</span><span class="quiz-country-en">${quiz.question.nameEn}</span>`;
    } else {
      qCard?.classList.remove("is-active");
      qCard?.classList.add("is-idle");
      if (qLabel) qLabel.textContent = "題目";
      if (!quiz.running) {
        if (quiz.pool.length > 0 && finished >= quiz.pool.length) {
          qEl.textContent = "全部出題完畢！";
        } else if (!quiz.pool.length) {
          qEl.textContent = "無可測驗題庫";
        } else {
          qEl.textContent = "尚未開始";
        }
      } else {
        qEl.textContent = "沒有剩餘題目";
      }
    }
  }

  if (startBtn) startBtn.disabled = quiz.running;
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function updateEarthSpin(now) {
  if (!earthSpinTween) return;
  const t = Math.min(1, (now - earthSpinTween.start) / earthSpinTween.duration);
  const k = easeInOutCubic(t);
  earth.quaternion.copy(earthSpinTween.fromQ).slerp(earthSpinTween.toQ, k);
  if (t >= 1) {
    earth.quaternion.copy(earthSpinTween.toQ);
    earthSpinTween = null;
  }
}

function earthQuaternionForLatLonNorthUp(lat, lon) {
  const localN = latLonToVector3(lat, lon, 1).normalize();
  const viewDir = camera.position.clone().normalize();
  const qAlign = new THREE.Quaternion().setFromUnitVectors(localN, viewDir);
  const northWorld = new THREE.Vector3(0, 1, 0).applyQuaternion(qAlign);
  const northTan = northWorld.sub(
    viewDir.clone().multiplyScalar(northWorld.dot(viewDir))
  );
  if (northTan.lengthSq() < 1e-10) return qAlign;
  northTan.normalize();
  const upTan = camera.up
    .clone()
    .sub(viewDir.clone().multiplyScalar(camera.up.dot(viewDir)));
  if (upTan.lengthSq() < 1e-10) return qAlign;
  upTan.normalize();
  const sin = new THREE.Vector3().crossVectors(northTan, upTan).dot(viewDir);
  const cos = northTan.dot(upTan);
  const qTwist = new THREE.Quaternion().setFromAxisAngle(
    viewDir,
    Math.atan2(sin, cos)
  );
  return qTwist.multiply(qAlign);
}

function spinEarthToLatLon(lat, lon, options = {}) {
  const targetQ = earthQuaternionForLatLonNorthUp(lat, lon);
  if (!options.animate) {
    earthSpinTween = null;
    earth.quaternion.copy(targetQ);
    return;
  }
  earthSpinTween = {
    fromQ: earth.quaternion.clone(),
    toQ: targetQ,
    start: performance.now(),
    duration: options.duration ?? 1000,
  };
}

function pickNextQuestion() {
  const remain = quiz.pool.filter((iso) => !quiz.published.has(iso));
  if (!remain.length) return null;
  const iso = remain[Math.floor(Math.random() * remain.length)];
  const c = countryByIso.get(iso);
  if (!c) return null;
  return { iso2: c.iso2, nameZh: c.nameZh, nameEn: c.nameEn };
}

function endQuiz(message, feedbackClass = "ok") {
  quiz.running = false;
  quiz.question = null;
  setQuizFeedback(message, feedbackClass);
  refreshQuizLabels();
  syncQuizUI();
}

function applyQuizCountryFill(iso2, kind) {
  quiz.published.set(iso2, kind);
  const feat = featureByIso2.get(iso2);
  if (feat) addCountryFill(feat, kind, iso2);
  refreshQuizLabels();
}

function focusPublishedCountry(iso2) {
  const ll = latLonForIso2(iso2);
  if (ll) spinEarthToLatLon(ll.lat, ll.lon, { animate: true });
}

/** 抽出下一題；若為台灣送分題則立即計答對、塗綠並繼續，直到非台灣或測驗結束。 */
function setNextQuestionOrEnd() {
  while (true) {
    if (quiz.published.size >= quiz.pool.length) {
      endQuiz("全部題目已出完！");
      return false;
    }
    quiz.question = pickNextQuestion();
    if (!quiz.question) {
      endQuiz("沒有剩餘題目。", "err");
      return false;
    }
    if (quiz.question.iso2 !== TW_FREEBIE_ISO2) {
      syncQuizUI();
      return true;
    }
    const answer = quiz.question;
    quiz.correct++;
    applyQuizCountryFill(answer.iso2, "correct");
    setQuizFeedback(`送分題：${answer.nameZh}（已標示為答對）`, "ok");
    focusPublishedCountry(answer.iso2);
    syncQuizUI();
  }
}

function answerQuestion(clickedIso) {
  if (!quiz.running || !quiz.question) return;
  const answer = quiz.question;
  if (answer.iso2 === TW_FREEBIE_ISO2) return;
  const correct = clickedIso === answer.iso2;
  const resultKind = correct ? "correct" : "wrong";

  if (correct) quiz.correct++;
  else quiz.wrong++;

  applyQuizCountryFill(answer.iso2, resultKind);
  setQuizFeedback(
    correct
      ? `答對！${answer.nameZh}`
      : `答錯。正確答案：${answer.nameZh}（${answer.nameEn}）`,
    correct ? "ok" : "err"
  );

  const hasNext = setNextQuestionOrEnd();
  focusPublishedCountry(answer.iso2);
  if (!hasNext) return;
}

function startQuiz() {
  if (quiz.running) return;
  if (!quiz.pool.length) {
    setQuizFeedback(
      "沒有符合「聯合國會員／觀察員」且地圖有邊界的題目（請確認 GeoJSON 與 data/un_iso2_members_observers.json）。",
      "err"
    );
    return;
  }
  quiz.correct = 0;
  quiz.wrong = 0;
  quiz.published.clear();
  clearSolvedFillMeshes();
  hideAllLabels();
  quiz.running = true;
  ensureSolvedFillGroup();
  setQuizFeedback("", "");
  if (!setNextQuestionOrEnd()) {
    syncQuizUI();
    return;
  }
}

function stopQuiz() {
  if (!quiz.running) return;
  endQuiz("已結束測驗。", "");
}

function resetQuiz() {
  quiz.correct = 0;
  quiz.wrong = 0;
  quiz.published.clear();
  clearSolvedFillMeshes();
  hideAllLabels();
  setQuizFeedback("已重置上色與統計。", "ok");
  if (quiz.running) {
    setNextQuestionOrEnd();
  } else {
    quiz.question = null;
    syncQuizUI();
  }
}

function onMapTap(clientX, clientY) {
  if (!quiz.running || !quiz.question) {
    setQuizFeedback("請先按「開始測驗」。", "err");
    return;
  }
  const clickedIso = pickIsoAtClient(clientX, clientY);
  if (!clickedIso) {
    setQuizFeedback("請點在陸地國界內。", "err");
    return;
  }
  answerQuestion(clickedIso);
}

/** @type {{
 *   x: number,
 *   y: number,
 *   pointerId: number,
 *   at: number,
 *   dragged: boolean
 * } | null} */
let mapPickDown = null;

function markMapPickDragged(clientX, clientY) {
  if (!mapPickDown) return;
  const dx = clientX - mapPickDown.x;
  const dy = clientY - mapPickDown.y;
  if (dx * dx + dy * dy > TAP_SLOP_PX * TAP_SLOP_PX) {
    mapPickDown.dragged = true;
  }
}

function clearMapPickDown(pointerId) {
  if (mapPickDown && mapPickDown.pointerId === pointerId) {
    mapPickDown = null;
  }
}

function finishMapPick(e) {
  if (e.button !== 0 || !mapPickDown || e.pointerId !== mapPickDown.pointerId) {
    return;
  }
  const down = mapPickDown;
  mapPickDown = null;
  if (down.dragged) return;
  if (performance.now() - down.at > TAP_MAX_MS) return;
  const dx = e.clientX - down.x;
  const dy = e.clientY - down.y;
  if (dx * dx + dy * dy > TAP_SLOP_PX * TAP_SLOP_PX) return;
  onMapTap(e.clientX, e.clientY);
}

renderer.domElement.addEventListener(
  "pointerdown",
  (e) => {
    if (e.button !== 0) return;
    mapPickDown = {
      x: e.clientX,
      y: e.clientY,
      pointerId: e.pointerId,
      at: performance.now(),
      dragged: false,
    };
  },
  true
);

window.addEventListener(
  "pointermove",
  (e) => {
    if (!mapPickDown || e.pointerId !== mapPickDown.pointerId) return;
    markMapPickDragged(e.clientX, e.clientY);
  },
  true
);

renderer.domElement.addEventListener("pointercancel", (e) => {
  clearMapPickDown(e.pointerId);
});

window.addEventListener(
  "pointerup",
  (e) => {
    finishMapPick(e);
  },
  true
);

const ADMIN_GEOJSON_URL = new URL(
  "../data/ne_50m_admin_0_countries.geojson",
  import.meta.url
);

async function loadAdminGeoJSON() {
  const res = await fetch(ADMIN_GEOJSON_URL);
  if (!res.ok) throw new Error("無法載入 ne_50m_admin_0_countries.geojson");
  adminGeoJSON = await res.json();
  featureByIso2.clear();
  for (const f of adminGeoJSON.features ?? []) {
    const iso = featureToIso2(f);
    if (iso) featureByIso2.set(iso, f);
  }
}

function buildBordersFromAdmin() {
  if (!adminGeoJSON) return;
  const geometry = new THREE.BufferGeometry();
  buildBorderGeometryFromGeoJSON(adminGeoJSON, geometry);
  bordersLines = new THREE.LineSegments(
    geometry,
    new THREE.LineBasicMaterial({
      color: 0xa3d6f5,
      transparent: true,
      opacity: 0.68,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    })
  );
  bordersLines.renderOrder = 2;
  earth.add(bordersLines);
}

async function loadCountries() {
  const res = await fetch(new URL("../data/countries.json", import.meta.url));
  if (!res.ok) throw new Error("無法載入 countries.json");
  countries = await res.json();
  countryByIso.clear();
  labelByIso.clear();
  labelsGroup.clear();
  for (const c of countries) {
    countryByIso.set(c.iso2, c);
    const obj = new CSS2DObject(makeLabelEl(c));
    obj.position.copy(latLonToVector3(c.lat, c.lon, EARTH_RADIUS * 1.0025));
    labelsGroup.add(obj);
    labelByIso.set(c.iso2, obj);
  }
}

async function loadUnMemberObserverIso2() {
  const res = await fetch(
    new URL("../data/un_iso2_members_observers.json", import.meta.url)
  );
  if (!res.ok) throw new Error("無法載入 un_iso2_members_observers.json");
  const arr = await res.json();
  if (!Array.isArray(arr) || !arr.length)
    throw new Error("un_iso2_members_observers.json 格式錯誤");
  unMemberObserverIso2 = new Set(arr);
}

function buildQuizPool() {
  const allow = unMemberObserverIso2;
  if (!allow?.size) {
    quiz.pool = [];
    return;
  }
  const base = countries
    .map((c) => c.iso2)
    .filter((iso) => allow.has(iso) && featureByIso2.has(iso));
  const hasTwData =
    featureByIso2.has(TW_FREEBIE_ISO2) &&
    countries.some((c) => c.iso2 === TW_FREEBIE_ISO2);
  quiz.pool = hasTwData ? [...base, TW_FREEBIE_ISO2] : base;
}

document.getElementById("continent-shortcuts")?.addEventListener("click", (e) => {
  const btn = e.target.closest(".btn-continent");
  if (!btn) return;
  const lat = Number(btn.dataset.lat);
  const lon = Number(btn.dataset.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  spinEarthToLatLon(lat, lon, { animate: true });
});

document.getElementById("btn-quiz-start")?.addEventListener("click", startQuiz);
document.getElementById("btn-quiz-stop")?.addEventListener("click", stopQuiz);
document.getElementById("btn-quiz-reset")?.addEventListener("click", resetQuiz);

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(rendererPixelRatio());
  renderer.setSize(window.innerWidth, window.innerHeight);
  labelRenderer.setSize(window.innerWidth, window.innerHeight);
});

const _labelWorld = new THREE.Vector3();
const _camDir = new THREE.Vector3();

function animate() {
  requestAnimationFrame(animate);
  updateEarthSpin(performance.now());
  controls.update();

  if (quiz.published.size > 0) {
    _camDir.copy(camera.position).normalize();
    for (const [, obj] of labelByIso) {
      if (!obj.visible) continue;
      obj.getWorldPosition(_labelWorld);
      const outward = _labelWorld.normalize();
      if (outward.dot(_camDir) < LABEL_BACKFACE_DOT) {
        obj.element.style.visibility = "hidden";
      } else {
        obj.element.style.visibility = "visible";
        obj.element.style.opacity = "1";
        obj.element.classList.remove("dim");
      }
    }
  }

  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
}

async function boot() {
  const results = await Promise.allSettled([
    loadUnMemberObserverIso2(),
    loadCountries(),
    loadAdminGeoJSON(),
  ]);
  for (const r of results) {
    if (r.status === "rejected") console.error(r.reason);
  }
  if (adminGeoJSON) {
    buildBordersFromAdmin();
    buildQuizPool();
  }
  syncLabelPositionsFromFeatures();
  hideAllLabels();
  syncQuizUI();
  animate();
  if (results.some((r) => r.status === "rejected")) {
    setQuizFeedback(
      "部分資料載入失敗：請用本機伺服器開啟，並確認 data/countries.json、data/ne_50m_admin_0_countries.geojson、data/un_iso2_members_observers.json 存在。",
      "err"
    );
  }
}

boot();
