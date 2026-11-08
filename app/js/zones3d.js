// 3D-карта зон роста волос: процедурная голова, светящиеся зоны, симуляция роста.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ZONE_LIST } from './zones-data.js';

const smooth = THREE.MathUtils.smoothstep;
const gauss = (v) => Math.exp(-v);

// ---------- форма головы ----------
// Радиус как функция направления на единичной сфере + общая деформация.
function shapePoint(d) {
  const { x, y, z } = d;
  const ax = Math.abs(x);
  const face = smooth(z, 0.2, 0.7) * (1 - smooth(y, 0.1, 0.35));
  let r = 1;
  r -= 0.1 * gauss(((ax - 0.33) / 0.13) ** 2 + ((y - 0.04) / 0.09) ** 2) * face; // глазницы
  r += 0.05 * gauss(((y - 0.17) / 0.06) ** 2 + (x / 0.45) ** 2) * smooth(z, 0.6, 0.9); // надбровье
  r += 0.2 * gauss((x / 0.075) ** 2) * THREE.MathUtils.clamp((0.06 - y) / 0.36, 0, 1) * gauss(((y + 0.13) / 0.2) ** 2) * smooth(z, 0.7, 0.95); // нос
  r += 0.05 * gauss(((ax - 0.48) / 0.15) ** 2 + ((y + 0.1) / 0.12) ** 2) * smooth(z, 0.3, 0.8); // скулы
  r += 0.035 * gauss((x / 0.17) ** 2 + ((y + 0.5) / 0.05) ** 2) * smooth(z, 0.7, 0.95); // губы
  r += 0.06 * gauss((x / 0.18) ** 2 + ((y + 0.74) / 0.1) ** 2) * smooth(z, 0.5, 0.9); // подбородок
  r += 0.12 * gauss(((y + 0.1) / 0.17) ** 2 + ((z + 0.06) / 0.1) ** 2) * smooth(ax, 0.86, 0.98); // уши

  const p = new THREE.Vector3(x * r * 0.82, y * r, z * r * 1.02);
  // нижняя часть: сужение челюсти и переход в шею
  const low = smooth(-y, 0.0, 0.9);
  p.x *= 1 - 0.3 * low * smooth(z, -0.2, 0.6);
  p.z *= 1 - 0.45 * smooth(-y, 0.15, 0.85) * smooth(-z, 0.0, 0.6);
  p.z += 0.07 * smooth(-y, 0.4, 0.9) * smooth(z, 0.2, 0.8);
  return p;
}

// Нижняя граница волосистой части (широта) в зависимости от азимута.
const HAIRLINE = [[0, 0.52], [0.42, 0.46], [0.72, 0.18], [1.1, -0.04], [1.57, 0.02], [2.0, -0.22], [2.6, -0.5], [Math.PI, -0.56]];
function hairlineLat(az) {
  for (let i = 1; i < HAIRLINE.length; i++) {
    const [a1, l1] = HAIRLINE[i];
    if (az <= a1) {
      const [a0, l0] = HAIRLINE[i - 1];
      return l0 + ((az - a0) / (a1 - a0)) * (l1 - l0);
    }
  }
  return HAIRLINE[HAIRLINE.length - 1][1];
}

// Классификация точки на единичной сфере по зонам (индекс в ZONE_LIST или -1).
const ZI = Object.fromEntries(ZONE_LIST.map((z, i) => [z.id, i]));
function classify(d) {
  const lat = Math.asin(THREE.MathUtils.clamp(d.y, -1, 1));
  const az = Math.abs(Math.atan2(d.x, d.z));
  if (lat < hairlineLat(az)) return -1;
  const ax = Math.abs(d.x);
  if (d.z < -0.2 && d.y < 0.5) return ZI.occipital;
  if (ax > 0.62) return d.z > 0.22 ? ZI.temporal : ZI.parietal;
  if (d.z > 0.4 && ax > 0.3 + (0.95 - d.z) * 0.55) return ZI.recession; // треугольник, сужающийся назад
  if (d.z > 0.72) return ZI.hairline;
  if (d.z > 0.35) return ZI.frontal;
  if (d.z > -0.2) return ZI.mid;
  return ZI.vertex;
}

function buildHead() {
  const geo = new THREE.SphereGeometry(1, 192, 144);
  const pos = geo.attributes.position;
  const dirs = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    dirs.set([v.x, v.y, v.z], i * 3);
    const p = shapePoint(v);
    pos.setXYZ(i, p.x, p.y, p.z);
  }
  geo.computeVertexNormals();
  return { geo, dirs };
}

// ---------- шейдеры ----------
const glowVert = /* glsl */ `
  varying vec3 vN; varying vec3 vV; varying vec3 vW;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vW = wp.xyz;
    vN = normalize(mat3(modelMatrix) * normal);
    vV = normalize(cameraPosition - wp.xyz);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }`;

const rimFrag = /* glsl */ `
  uniform float uTime; uniform float uScan; uniform vec3 uColor;
  varying vec3 vN; varying vec3 vV; varying vec3 vW;
  void main() {
    float fres = pow(1.0 - max(dot(normalize(vN), normalize(vV)), 0.0), 3.0);
    float scan = smoothstep(0.05, 0.0, abs(vW.y - uScan));
    float grid = 1.0 - smoothstep(0.0, 0.035, abs(fract(vW.y * 9.0) - 0.5) - 0.465);
    float a = fres * 0.6 + scan * 0.8 + grid * 0.04;
    gl_FragColor = vec4(uColor * (fres * 0.9 + scan * 1.8 + grid * 0.2), a);
  }`;

const zoneVert = /* glsl */ `
  attribute vec3 aDir;
  varying vec3 vDir; varying vec3 vN; varying vec3 vV; varying vec3 vW;
  void main() {
    vDir = aDir;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vW = wp.xyz;
    vN = normalize(mat3(modelMatrix) * normal);
    vV = normalize(cameraPosition - wp.xyz);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }`;

// GLSL-копия classify(): константы берутся из тех же таблиц, что и в JS.
const f = (n) => Number(n).toFixed(4);
const zoneFrag = /* glsl */ `
  uniform vec3 uColors[${ZONE_LIST.length}]; uniform float uReveal[${ZONE_LIST.length}];
  uniform float uSelIdx; uniform float uSelAmt; uniform float uDim; uniform float uTime; uniform float uScan;
  varying vec3 vDir; varying vec3 vN; varying vec3 vV; varying vec3 vW;
  const float AZ[${HAIRLINE.length}] = float[](${HAIRLINE.map((p) => f(p[0])).join(',')});
  const float LT[${HAIRLINE.length}] = float[](${HAIRLINE.map((p) => f(p[1])).join(',')});
  float hairlineLat(float az) {
    for (int i = 1; i < ${HAIRLINE.length}; i++) {
      if (az <= AZ[i]) return mix(LT[i - 1], LT[i], (az - AZ[i - 1]) / (AZ[i] - AZ[i - 1]));
    }
    return LT[${HAIRLINE.length - 1}];
  }
  float classify(vec3 d, out float margin) {
    float lat = asin(clamp(d.y, -1.0, 1.0));
    float az = abs(atan(d.x, d.z));
    margin = lat - hairlineLat(az);
    if (margin < 0.0) return -1.0;
    float ax = abs(d.x);
    if (d.z < -0.2 && d.y < 0.5) return ${f(ZI.occipital)};
    if (ax > 0.62) return d.z > 0.22 ? ${f(ZI.temporal)} : ${f(ZI.parietal)};
    if (d.z > 0.4 && ax > 0.3 + (0.95 - d.z) * 0.55) return ${f(ZI.recession)};
    if (d.z > 0.72) return ${f(ZI.hairline)};
    if (d.z > 0.35) return ${f(ZI.frontal)};
    if (d.z > -0.2) return ${f(ZI.mid)};
    return ${f(ZI.vertex)};
  }
  void main() {
    vec3 d = normalize(vDir);
    float margin;
    float id = classify(d, margin);
    if (id < 0.0) discard;
    int i = int(id + 0.5);
    float isSel = step(abs(id - uSelIdx), 0.5) * uSelAmt;
    float others = uSelIdx >= 0.0 ? mix(0.55, 1.0, isSel) : 1.0;
    float fres = pow(1.0 - max(dot(normalize(vN), normalize(vV)), 0.0), 2.0);
    float pulse = 0.5 + 0.5 * sin(uTime * 3.2);
    float scan = smoothstep(0.06, 0.0, abs(vW.y - uScan));
    // «соты» — мелкий технический узор
    vec2 g = vec2(atan(d.x, d.z) * 18.0, asin(d.y) * 22.0);
    float dots = smoothstep(0.3, 0.15, length(fract(g) - 0.5));
    // светящиеся границы: между зонами и по краю волосистой части
    float edge = clamp(fwidth(id) * 2.0, 0.0, 1.0);
    edge = max(edge, 1.0 - smoothstep(0.0, 0.025, margin));
    float a = uReveal[i] * uDim * others * (0.38 + 0.2 * fres + dots * 0.15 + isSel * (0.2 + 0.15 * pulse) + scan * 0.3 + edge * 0.6);
    vec3 col = uColors[i] * (0.75 + isSel * (0.9 + 0.6 * pulse) + dots * 0.25 + edge * (1.4 + isSel * 1.4)) + vec3(scan * 0.6);
    gl_FragColor = vec4(col, a);
  }`;

function circleTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.3, 'rgba(160,220,255,0.6)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

// ---------- сцена ----------
export function createZoneScene(container, { onSelect, onGrowth } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x03060b);
  scene.fog = new THREE.FogExp2(0x03060b, 0.06);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.3;

  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
  camera.position.set(0.8, 3.2, 11);
  const HOME = new THREE.Vector3(2.5, 1.25, 2.9);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, -0.2, 0);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.minDistance = 2.4;
  controls.maxDistance = 7;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.8;

  // свет: тёплый ключевой + цветные контровые, как в игровых витринах персонажей
  const key = new THREE.DirectionalLight(0xfff1e0, 1.5);
  key.position.set(3, 4, 4);
  const rimA = new THREE.DirectionalLight(0x3fb8ff, 2.4);
  rimA.position.set(-4, 2, -3);
  const rimB = new THREE.DirectionalLight(0xff4fa3, 1.2);
  rimB.position.set(4, 1, -4);
  scene.add(key, rimA, rimB, new THREE.HemisphereLight(0x8fb4ff, 0x0b0f18, 0.35));

  const timeU = { value: 0 };
  const scanU = { value: -2 };

  // фон-купол с градиентом
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(30, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'varying vec3 vP; void main(){ float h = normalize(vP).y; vec3 c = mix(vec3(0.004,0.008,0.016), vec3(0.03,0.07,0.12), smoothstep(-0.3, 0.6, h)); gl_FragColor = vec4(c,1.0); }',
    }),
  );
  scene.add(dome);

  const root = new THREE.Group();
  scene.add(root);

  // голова
  const { geo: headGeo, dirs } = buildHead();
  const headMat = new THREE.MeshPhysicalMaterial({
    color: 0x3c4756, roughness: 0.5, metalness: 0.1, clearcoat: 0.4, clearcoatRoughness: 0.4,
    sheen: 0.3, sheenColor: new THREE.Color(0x3d7fb8), sheenRoughness: 0.6,
  });
  const head = new THREE.Mesh(headGeo, headMat);
  root.add(head);

  const rim = new THREE.Mesh(headGeo, new THREE.ShaderMaterial({
    uniforms: { uTime: timeU, uScan: scanU, uColor: { value: new THREE.Color(0x48c8ff) } },
    vertexShader: glowVert, fragmentShader: rimFrag,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  rim.scale.setScalar(1.003);
  root.add(rim);

  // шея и подиум
  const neckGeo = new THREE.CylinderGeometry(0.44, 0.56, 1.2, 64, 1, true);
  neckGeo.translate(0, -1.2, -0.14);
  root.add(new THREE.Mesh(neckGeo, headMat));
  const ringMat = new THREE.ShaderMaterial({
    uniforms: { uTime: timeU },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    vertexShader: 'varying vec2 vU; void main(){ vU = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `uniform float uTime; varying vec2 vU;
      void main(){ vec2 p = vU - 0.5; float r = length(p) * 2.0; float a = atan(p.y, p.x);
        float ring = smoothstep(0.04, 0.0, abs(r - 0.8)) + 0.6 * smoothstep(0.02, 0.0, abs(r - 0.62));
        float dash = step(0.5, fract(a * 6.0 / 3.14159 + uTime * 0.25));
        float glow = smoothstep(1.0, 0.2, r) * 0.18;
        float v = ring * (0.5 + 0.5 * dash) + glow;
        gl_FragColor = vec4(vec3(0.25, 0.75, 1.0) * v * 1.6, v); }`,
  });
  const ring = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 3.4), ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = -1.78;
  scene.add(ring);

  // частицы
  const P = 420;
  const pp = new Float32Array(P * 3);
  const pSpeed = new Float32Array(P);
  for (let i = 0; i < P; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = 1.4 + Math.random() * 2.2;
    pp.set([Math.cos(a) * r, -1.8 + Math.random() * 4.2, Math.sin(a) * r], i * 3);
    pSpeed[i] = 0.05 + Math.random() * 0.15;
  }
  const pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute('position', new THREE.BufferAttribute(pp, 3));
  const particles = new THREE.Points(pGeo, new THREE.PointsMaterial({
    size: 0.05, map: circleTexture(), color: 0x7fd4ff, transparent: true, opacity: 0.8,
    depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  scene.add(particles);

  // ---------- зоны ----------
  const index = headGeo.index.array;
  const triZone = new Int8Array(index.length / 3);
  const c = new THREE.Vector3();
  for (let t = 0; t < triZone.length; t++) {
    c.set(0, 0, 0);
    for (let k = 0; k < 3; k++) {
      const i = index[t * 3 + k] * 3;
      c.x += dirs[i]; c.y += dirs[i + 1]; c.z += dirs[i + 2];
    }
    triZone[t] = classify(c.normalize());
  }

  const P3 = headGeo.attributes.position;
  const N3 = headGeo.attributes.normal;
  const lift = (i, amt, out) => out.fromBufferAttribute(P3, i).addScaledVector(new THREE.Vector3().fromBufferAttribute(N3, i), amt);

  // Одна оверлей-сетка на всю голову: зона вычисляется в шейдере для каждого пикселя,
  // поэтому границы зон гладкие и не зависят от плотности сетки.
  headGeo.setAttribute('aDir', new THREE.BufferAttribute(dirs, 3));
  const zoneU = {
    uColors: { value: ZONE_LIST.map((z) => new THREE.Color(z.color)) },
    uReveal: { value: new Array(ZONE_LIST.length).fill(0) },
    uSelIdx: { value: -1 }, uSelAmt: { value: 0 }, uDim: { value: 1 },
    uTime: timeU, uScan: scanU,
  };
  const zoneMesh = new THREE.Mesh(headGeo, new THREE.ShaderMaterial({
    uniforms: zoneU, vertexShader: zoneVert, fragmentShader: zoneFrag,
    transparent: true, depthWrite: false,
  }));
  zoneMesh.scale.setScalar(1.004);
  root.add(zoneMesh);

  const zones = ZONE_LIST.map((z, zi) => {
    const centroid = new THREE.Vector3();
    const tmp = new THREE.Vector3();
    let n = 0;
    for (let t = 0; t < triZone.length; t++) {
      if (triZone[t] !== zi) continue;
      centroid.add(tmp.fromBufferAttribute(P3, index[t * 3]));
      n++;
    }
    return { z, zi, centroid: centroid.divideScalar(n), anchor: new THREE.Vector3() };
  });

  // точная поверхность для маркеров: ближайшая вершина головы к центроиду
  for (const zn of zones) {
    let best = Infinity;
    let bi = 0;
    const tmp = new THREE.Vector3();
    for (let t = 0; t < triZone.length; t++) {
      if (triZone[t] !== zn.zi) continue;
      const vi = index[t * 3];
      tmp.fromBufferAttribute(P3, vi);
      const dd = tmp.distanceToSquared(zn.centroid);
      if (dd < best) { best = dd; bi = vi; }
    }
    lift(bi, 0.02, zn.anchor);
    zn.normal = new THREE.Vector3().fromBufferAttribute(N3, bi);
  }

  // ---------- волосы (инстансы) ----------
  const STRANDS = 14000;
  const scalpTris = [];
  const areas = [];
  let total = 0;
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
  for (let t = 0; t < triZone.length; t++) {
    if (triZone[t] < 0) continue;
    A.fromBufferAttribute(P3, index[t * 3]);
    B.fromBufferAttribute(P3, index[t * 3 + 1]);
    C.fromBufferAttribute(P3, index[t * 3 + 2]);
    total += B.clone().sub(A).cross(C.clone().sub(A)).length() / 2;
    scalpTris.push(t);
    areas.push(total);
  }
  const strandGeo = new THREE.CylinderGeometry(0.003, 0.007, 1, 4, 4);
  strandGeo.translate(0, 0.5, 0);
  const hairMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45, metalness: 0.05 });
  const hairU = { uLen: { value: 0 }, uMode: { value: 0 }, uTime: timeU };
  hairMat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, hairU);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uLen; uniform float uMode; uniform float uTime; attribute vec2 aGrow; attribute vec2 aInfo;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        // aGrow: доля роста без/с лечением; aInfo: фаза покачивания и полная длина пряди
        float h = transformed.y;
        float f = mix(aGrow.x, aGrow.y, uMode);
        float L = uLen * f * aInfo.y;
        transformed.y = h * L;
        transformed.xz *= mix(0.5, 1.0, f);
        float bend = h * h * L;
        transformed.z += bend * 0.55;
        transformed.x += sin(uTime * 1.3 + aInfo.x) * bend * 0.15;`);
  };
  const hair = new THREE.InstancedMesh(strandGeo, hairMat, STRANDS);
  const aGrow = new Float32Array(STRANDS * 2);
  const aInfo = new Float32Array(STRANDS * 2);
  const crown = new THREE.Vector3(0, 0.92, -0.38);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const nA = new THREE.Vector3(), nB = new THREE.Vector3(), nC = new THREE.Vector3();
  const tint = new THREE.Color();
  for (let s = 0; s < STRANDS; s++) {
    const r = Math.random() * total;
    let lo = 0, hi = areas.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (areas[mid] < r) lo = mid + 1; else hi = mid; }
    const t = scalpTris[lo];
    const ia = index[t * 3], ib = index[t * 3 + 1], ic = index[t * 3 + 2];
    let u = Math.random(), v = Math.random();
    if (u + v > 1) { u = 1 - u; v = 1 - v; }
    const w = 1 - u - v;
    A.fromBufferAttribute(P3, ia); B.fromBufferAttribute(P3, ib); C.fromBufferAttribute(P3, ic);
    const p = A.multiplyScalar(w).addScaledVector(B, u).addScaledVector(C, v);
    nA.fromBufferAttribute(N3, ia); nB.fromBufferAttribute(N3, ib); nC.fromBufferAttribute(N3, ic);
    const nrm = nA.multiplyScalar(w).addScaledVector(nB, u).addScaledVector(nC, v).normalize();
    // волосы расходятся от завитка на макушке и ложатся по поверхности
    const flow = p.clone().sub(crown);
    flow.addScaledVector(nrm, -flow.dot(nrm)).normalize();
    const dir = nrm.clone().multiplyScalar(0.3).addScaledVector(flow, 1).normalize();
    // локальная ось Z смотрит в кожу — изгиб в шейдере прижимает прядь к голове
    const bz = nrm.clone().negate().addScaledVector(dir, nrm.dot(dir)).normalize();
    const bx = new THREE.Vector3().crossVectors(dir, bz);
    q.setFromRotationMatrix(new THREE.Matrix4().makeBasis(bx, dir, bz));
    m.compose(p.addScaledVector(nrm, -0.004), q, new THREE.Vector3(1, 1, 1));
    hair.setMatrixAt(s, m);
    const z = ZONE_LIST[triZone[t]];
    const jitter = 0.8 + Math.random() * 0.2;
    aGrow[s * 2] = z.growth.no * jitter;
    aGrow[s * 2 + 1] = z.growth.tx * jitter;
    aInfo[s * 2] = Math.random() * 6.28;
    aInfo[s * 2 + 1] = 0.16 + Math.random() * 0.08;
    tint.setHSL(0.075 + Math.random() * 0.02, 0.42, 0.2 + Math.random() * 0.12);
    hair.setColorAt(s, tint);
  }
  strandGeo.setAttribute('aGrow', new THREE.InstancedBufferAttribute(aGrow, 2));
  strandGeo.setAttribute('aInfo', new THREE.InstancedBufferAttribute(aInfo, 2));
  hair.frustumCulled = false;
  hair.visible = false;
  root.add(hair);

  // ---------- постобработка (bloom) ----------
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.7, 0.5, 0.82);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // ---------- взаимодействие ----------
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let down = null;
  let selected = null;
  let focusTarget = null;
  const el = renderer.domElement;
  el.style.touchAction = 'none';
  el.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
  el.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 6) return;
    const rect = el.getBoundingClientRect();
    ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObject(head, false)[0];
    if (!hit) return;
    const vi = hit.face.a * 3;
    const zi = classify(new THREE.Vector3(dirs[vi], dirs[vi + 1], dirs[vi + 2]));
    if (zi >= 0) onSelect?.(ZONE_LIST[zi].id);
  });
  controls.addEventListener('start', () => { focusTarget = null; controls.autoRotate = false; });

  function select(id, fly = true) {
    if (selected !== id) zoneU.uSelAmt.value = 0;
    selected = id;
    zoneU.uSelIdx.value = ZONE_LIST.findIndex((z) => z.id === id);
    const zn = zones.find((x) => x.z.id === id);
    if (zn && fly) {
      const dirv = zn.anchor.clone().sub(controls.target).normalize();
      dirv.y += 0.2;
      focusTarget = dirv.normalize().multiplyScalar(4.4).add(controls.target);
      controls.autoRotate = false;
    }
  }

  // ---------- симуляция роста ----------
  let growth = null; // { start, mode }
  const GROW_SECONDS = 9;
  function startGrowth(mode) {
    growth = { t: 0, mode };
    hair.visible = true;
    hairU.uMode.value = mode === 'tx' ? 1 : 0;
    hairU.uLen.value = 0;
    controls.autoRotate = true;
  }
  function stopGrowth() {
    growth = null;
    hair.visible = false;
    onGrowth?.(null);
  }

  // ---------- размер ----------
  const label = container.querySelector('.z3d-label');
  function resize() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    bloom.resolution.set(w / 2, h / 2);
    // на вертикальном экране сохраняем горизонтальный угол обзора, чтобы голова влезала по ширине
    camera.aspect = w / h;
    const HFOV = 36;
    camera.fov = camera.aspect < 1
      ? THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(HFOV / 2)) / camera.aspect))
      : HFOV;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  // ---------- цикл ----------
  const timer = new THREE.Timer();
  timer.connect(document);
  let elapsed = 0;
  let introDone = false;
  const tmpV = new THREE.Vector3();
  const camDir = new THREE.Vector3();

  function frame() {
    timer.update();
    const dt = Math.min(timer.getDelta(), 0.05);
    elapsed += dt;
    timeU.value = elapsed;

    // интро: облёт камеры и поочерёдное появление зон
    if (!introDone) {
      camera.position.lerp(HOME, 1 - Math.exp(-1.6 * dt));
      if (camera.position.distanceTo(HOME) < 0.05) introDone = true;
    }
    if (focusTarget) {
      camera.position.lerp(focusTarget, 1 - Math.exp(-3.5 * dt));
      if (camera.position.distanceTo(focusTarget) < 0.02) focusTarget = null;
      introDone = true;
    }

    // сканирующая линия: каждые 7 секунд снизу вверх
    const cycle = (elapsed % 7) / 2.2;
    scanU.value = cycle <= 1 ? THREE.MathUtils.lerp(-1.8, 1.25, cycle) : -5;

    // зоны появляются по очереди, выбранная плавно подсвечивается
    for (let i = 0; i < zones.length; i++) {
      zoneU.uReveal.value[i] = THREE.MathUtils.clamp((elapsed - 0.6 - i * 0.18) / 0.7, 0, 1);
    }
    zoneU.uSelAmt.value = THREE.MathUtils.damp(zoneU.uSelAmt.value, 1, 5, dt);
    zoneU.uDim.value = THREE.MathUtils.damp(zoneU.uDim.value, growth ? 0.3 : 1, 4, dt);

    if (growth) {
      growth.t += dt;
      const k = Math.min(growth.t / GROW_SECONDS, 1);
      hairU.uLen.value = 1 - Math.pow(1 - k, 1.6);
      onGrowth?.({ month: Math.round(k * 12), mode: growth.mode, done: k >= 1 });
    }

    // частицы поднимаются вверх
    const arr = pGeo.attributes.position.array;
    for (let i = 0; i < P; i++) {
      arr[i * 3 + 1] += pSpeed[i] * dt;
      if (arr[i * 3 + 1] > 2.5) arr[i * 3 + 1] = -1.8;
    }
    pGeo.attributes.position.needsUpdate = true;
    ring.rotation.z += dt * 0.15;

    controls.update(dt);

    // подпись выбранной зоны над моделью
    if (label) {
      const zn = selected && zones.find((x) => x.z.id === selected);
      if (zn) {
        camDir.copy(camera.position).sub(zn.anchor).normalize();
        const facing = camDir.dot(zn.normal);
        tmpV.copy(zn.anchor).project(camera);
        label.style.opacity = facing > 0.05 ? '1' : '0';
        label.style.transform = `translate(${((tmpV.x + 1) / 2) * container.clientWidth}px, ${((1 - tmpV.y) / 2) * container.clientHeight}px)`;
      } else {
        label.style.opacity = '0';
      }
    }

    composer.render(dt);
  }

  let running = false;
  function start() { if (!running) { running = true; timer.reset?.(); renderer.setAnimationLoop(frame); } }
  function pause() { running = false; renderer.setAnimationLoop(null); }
  start();

  return {
    canvas: el,
    select,
    startGrowth,
    stopGrowth,
    resetView() { focusTarget = HOME.clone(); controls.autoRotate = true; },
    setAutoRotate(v) { controls.autoRotate = v; },
    get autoRotate() { return controls.autoRotate; },
    start,
    pause,
    resize,
  };
}
