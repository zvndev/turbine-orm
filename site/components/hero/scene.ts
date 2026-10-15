/**
 * The landing hero: a night street circuit with three light tracers.
 *
 * Loaded lazily on the client (see HeroStage.tsx), never during SSR. Vanilla
 * three.js, no React wrapper. Everything visible is generated here: textures
 * are drawn into canvases, geometry is built from the track model in
 * track.ts. Wet-asphalt reflections are faked cheaply: emissive objects get a
 * mirrored copy under the ground, and the ground is drawn partly transparent
 * over them, more so where it is wet and at grazing angles.
 */
import {
  AdditiveBlending,
  BackSide,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  HalfFloatType,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  InstancedMesh,
  LinearMipmapLinearFilter,
  CircleGeometry,
  Material,
  Mesh,
  MeshBasicMaterial,
  NormalBlending,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  RepeatWrapping,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
  Texture,
  UniformsLib,
  UniformsUtils,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderer,
  WebGLRenderTarget,
  ACESFilmicToneMapping,
  FogExp2,
} from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import {
  BAND_QUERY,
  cameraPose,
  driverAt,
  FINISH_FADE,
  RACE_PERIOD,
  raceFade,
  STILL_TIME,
  TRACK_WIDTH,
  TRAIL_SECONDS,
  trackModel,
  type TrackModel,
} from './track';

export interface HeroOptions {
  /** Render one frame and stop (prefers-reduced-motion). */
  still: boolean;
  /** Small or low-power device: fewer lights, shorter trails, cheaper post. */
  lite: boolean;
  onFirstFrame?: () => void;
}

export interface HeroHandle {
  setActive(active: boolean): void;
  /**
   * Where a mouse or pen is, in client pixels, or null once it leaves the
   * hero. Tilts the camera a little and lights the asphalt under it.
   */
  setPointer(x: number | null, y?: number): void;
  /** While held, the lead tracer pulls away faster. */
  setBoost(on: boolean): void;
  dispose(): void;
}

const HALF = TRACK_WIDTH / 2;
const BARRIER = HALF + 1.15;
const MAX_LAMPS = 24;
/** Two per tracer (head and mid-trail), plus one under the pointer. */
const TRACER_LIGHTS = 7;
const POINTER_LIGHT = 6;

/** How much faster the lead runs at full boost (1 = twice its pace). */
const BOOST_GAIN = 0.85;
/**
 * A boosted leader that gets this far ahead (in laps, on the closest of the
 * pack) is about to come back around to them, so the race ends there.
 */
const GAP_LIMIT = 0.72;
/** Brightness of the light under the pointer. */
const POINTER_STRENGTH = 6;

/* ------------------------------------------------------------------ */
/* Procedural textures                                                 */
/* ------------------------------------------------------------------ */

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tileable value noise, `octaves` layers, sampled on a size x size grid. */
function tileableNoise(size: number, base: number, octaves: number, seed: number): Float32Array {
  const out = new Float32Array(size * size);
  const rand = rng(seed);
  let amp = 1;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    const cells = base << o;
    const lattice = new Float32Array(cells * cells);
    for (let i = 0; i < lattice.length; i++) lattice[i] = rand();
    for (let y = 0; y < size; y++) {
      const fy = (y / size) * cells;
      const y0 = Math.floor(fy);
      const ty = fy - y0;
      const sy = ty * ty * (3 - 2 * ty);
      for (let x = 0; x < size; x++) {
        const fx = (x / size) * cells;
        const x0 = Math.floor(fx);
        const tx = fx - x0;
        const sx = tx * tx * (3 - 2 * tx);
        const x1 = (x0 + 1) % cells;
        const y1 = (y0 + 1) % cells;
        const a = lattice[y0 * cells + x0]!;
        const b = lattice[y0 * cells + x1]!;
        const c = lattice[y1 * cells + x0]!;
        const d = lattice[y1 * cells + x1]!;
        out[y * size + x]! += amp * (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy);
      }
    }
    total += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i]! /= total;
  return out;
}

function canvasTexture(size: number, paint: (img: ImageData) => void): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  paint(img);
  ctx.putImageData(img, 0, 0);
  const tex = new CanvasTexture(canvas);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.minFilter = LinearMipmapLinearFilter;
  return tex;
}

/** R: fine aggregate grain. G: medium patches. B: sparse bright stones. */
function asphaltTexture(): CanvasTexture {
  const size = 256;
  const medium = tileableNoise(size, 8, 3, 7);
  const rand = rng(11);
  return canvasTexture(size, (img) => {
    for (let i = 0; i < size * size; i++) {
      const fine = rand();
      const stone = rand() > 0.985 ? 255 : 0;
      img.data[i * 4] = Math.floor(fine * fine * 255);
      img.data[i * 4 + 1] = Math.floor(medium[i]! * 255);
      img.data[i * 4 + 2] = stone;
      img.data[i * 4 + 3] = 255;
    }
  });
}

/** Low-frequency wetness: where water pools on the road. */
function wetTexture(): CanvasTexture {
  const size = 256;
  const n = tileableNoise(size, 4, 5, 23);
  return canvasTexture(size, (img) => {
    for (let i = 0; i < size * size; i++) {
      const v = Math.floor(n[i]! * 255);
      img.data[i * 4] = v;
      img.data[i * 4 + 1] = v;
      img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 255;
    }
  });
}

/** A strip of city skyline: dark blocks, scattered windows, alpha above. */
function skylineTexture(width: number, seed: number, tall: number): CanvasTexture {
  const height = 256;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const rand = rng(seed);
  let x = 0;
  while (x < width) {
    const w = 18 + rand() * 70;
    const h = 30 + Math.pow(rand(), 2.2) * tall;
    const shade = 5 + Math.floor(rand() * 5);
    ctx.fillStyle = `rgb(${shade},${shade + 2},${shade + 7})`;
    ctx.fillRect(x, height - h, w, h);
    // Windows: sparse, mostly warm, a few cool.
    for (let wy = height - h + 6; wy < height - 4; wy += 7) {
      for (let wx = x + 4; wx < x + w - 4; wx += 6) {
        if (rand() > 0.82) {
          const warm = rand() > 0.25;
          const a = 0.25 + rand() * 0.6;
          ctx.fillStyle = warm ? `rgba(255,196,120,${a})` : `rgba(150,190,255,${a})`;
          ctx.fillRect(wx, wy, 2, 3);
        }
      }
    }
    if (h > tall * 0.6 && rand() > 0.5) {
      ctx.fillStyle = 'rgba(255,60,50,0.9)';
      ctx.fillRect(x + w / 2 - 1, height - h - 3, 3, 3);
    }
    x += w + rand() * 4;
  }
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = RepeatWrapping;
  return tex;
}

/* ------------------------------------------------------------------ */
/* Shared shader code                                                  */
/* ------------------------------------------------------------------ */

const LIGHTING = /* glsl */ `
  #define MAX_LAMPS ${MAX_LAMPS}
  #define TRACER_LIGHTS ${TRACER_LIGHTS}
  uniform vec4 uLamps[MAX_LAMPS];
  uniform vec3 uLampColor;
  uniform vec4 uTracerLights[TRACER_LIGHTS];
  uniform vec3 uTracerColors[TRACER_LIGHTS];
  uniform vec3 uAmbient;

  // Diffuse plus a glossy term that grows with wetness. p is the world
  // position, n the normal, v the direction to the camera.
  vec3 shade(vec3 p, vec3 n, vec3 v, vec3 albedo, float gloss) {
    vec3 diffuse = uAmbient;
    vec3 spec = vec3(0.0);
    float shin = mix(18.0, 140.0, gloss);
    for (int i = 0; i < MAX_LAMPS; i++) {
      vec4 lamp = uLamps[i];
      if (lamp.w <= 0.0) continue;
      vec3 l = lamp.xyz - p;
      float d2 = dot(l, l);
      vec3 ld = l * inversesqrt(d2);
      float ndl = max(dot(n, ld), 0.0);
      float e = lamp.w * ndl / (d2 + 1.0);
      diffuse += uLampColor * e;
      vec3 h = normalize(ld + v);
      spec += uLampColor * lamp.w * pow(max(dot(n, h), 0.0), shin) / (d2 * 0.25 + 1.0);
    }
    for (int i = 0; i < TRACER_LIGHTS; i++) {
      vec4 tl = uTracerLights[i];
      vec3 l = tl.xyz - p;
      float d2 = dot(l, l);
      float r2 = tl.w * tl.w;
      vec3 ld = l * inversesqrt(d2 + 1e-4);
      float ndl = max(dot(n, ld), 0.0) * 0.7 + 0.3;
      float fall = r2 / (d2 + r2 * 0.18) * exp(-d2 / (r2 * 6.0));
      diffuse += uTracerColors[i] * fall * ndl;
      vec3 h = normalize(ld + v);
      spec += uTracerColors[i] * fall * pow(max(dot(n, h), 0.0), shin * 0.5);
    }
    return albedo * diffuse + spec * gloss * 0.9;
  }
`;

const SURFACE_VERT = /* glsl */ `
  attribute float aS;
  attribute float aLat;
  attribute float aLine;
  varying vec3 vWorld;
  varying float vS;
  varying float vLat;
  varying float vLine;
  #include <fog_pars_vertex>
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vS = aS;
    vLat = aLat;
    vLine = aLine;
    vec4 mvPosition = viewMatrix * world;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

/**
 * Ground, track and kerbs share one fragment shader; defines pick the paint.
 * Alpha below 1 lets the mirrored glow layer show through as reflections.
 */
const SURFACE_FRAG = /* glsl */ `
  uniform sampler2D uGrain;
  uniform sampler2D uWet;
  uniform float uHalf;
  varying vec3 vWorld;
  varying float vS;
  varying float vLat;
  varying float vLine;
  ${LIGHTING}
  #include <fog_pars_fragment>

  void main() {
    vec2 xz = vWorld.xz;
    vec4 g = texture2D(uGrain, xz * 0.42);
    vec4 g2 = texture2D(uGrain, xz * 0.071 + 0.37);
    float wetRaw = texture2D(uWet, xz * 0.0135).r;
    float wet = smoothstep(0.46, 0.66, wetRaw);
    float grain = g.r * 0.65 + g2.g * 0.7;

    #if defined(KERB)
      float stripe = step(0.5, fract(vS / 1.3));
      vec3 albedo = mix(vec3(0.50, 0.035, 0.04), vec3(0.62, 0.62, 0.6), stripe);
      albedo *= 0.8 + 0.3 * g.r;
      wet *= 0.6;
    #elif defined(TRACK)
      vec3 albedo = vec3(0.04, 0.042, 0.048) * (0.4 + grain * 1.0);
      albedo += g.b * 0.05;
      // Rubbered racing line: darker and a touch smoother.
      float rubber = 1.0 - smoothstep(0.25, 0.75, abs(vLat - vLine));
      albedo *= 1.0 - rubber * 0.35;
      wet = max(wet, rubber * 0.25);
      // White edge lines, slightly worn.
      float edge = smoothstep(uHalf - 0.26, uHalf - 0.22, abs(vLat)) * (1.0 - smoothstep(uHalf - 0.1, uHalf - 0.06, abs(vLat)));
      albedo = mix(albedo, vec3(0.55) * (0.75 + 0.35 * g.r), edge * (0.65 + 0.35 * g2.g));
      // Start line: two rows of checks across the road.
      float sl = step(0.0, vS) * step(vS, 0.7);
      float checks = mod(floor(vS / 0.35) + floor((vLat + uHalf) / 0.35), 2.0);
      albedo = mix(albedo, vec3(0.6) * checks + 0.01, sl);
    #else
      vec3 albedo = vec3(0.012, 0.013, 0.017) * (0.35 + grain * 1.1);
      albedo += g.b * 0.025;
    #endif

    vec3 v = normalize(cameraPosition - vWorld);
    vec3 n = vec3(0.0, 1.0, 0.0);
    float gloss = wet * 0.9 + 0.08;
    vec3 col = shade(vWorld, n, v, albedo * (1.0 - wet * 0.45), gloss * (0.45 + g.r * 0.9));

    // Fresnel: grazing views reflect more, wet patches much more.
    float fres = pow(clamp(1.0 - v.y, 0.0, 1.0), 5.0);
    float reflectivity = clamp(0.03 + fres * 0.12 + wet * (0.2 + fres * 0.5), 0.0, 0.88);
    gl_FragColor = vec4(col, 1.0 - reflectivity);
    #include <fog_fragment>
  }
`;

/* ------------------------------------------------------------------ */
/* Geometry helpers                                                    */
/* ------------------------------------------------------------------ */

/**
 * A ribbon along the centerline between two lateral offsets. `from`/`to`
 * are functions of the sample index so kerbs and barriers can narrow where
 * the inside of a tight corner would fold over itself.
 */
function ribbon(
  m: TrackModel,
  indices: number[],
  from: (i: number) => number,
  to: (i: number) => number,
  y: number,
  closed: boolean,
): BufferGeometry {
  const count = indices.length;
  const pos = new Float32Array(count * 2 * 3);
  const s = new Float32Array(count * 2);
  const lat = new Float32Array(count * 2);
  const line = new Float32Array(count * 2);
  for (let k = 0; k < count; k++) {
    const i = indices[k]!;
    const a = from(i);
    const b = to(i);
    const cx = m.center.x[i]!;
    const cz = m.center.z[i]!;
    pos.set([cx + a * m.nx[i]!, y, cz + a * m.nz[i]!, cx + b * m.nx[i]!, y, cz + b * m.nz[i]!], k * 6);
    s[k * 2] = s[k * 2 + 1] = m.center.s[i]!;
    lat[k * 2] = a;
    lat[k * 2 + 1] = b;
    line[k * 2] = line[k * 2 + 1] = m.racingOffset[i]!;
  }
  const idx: number[] = [];
  const segs = closed ? count : count - 1;
  for (let k = 0; k < segs; k++) {
    const a = k * 2;
    const b = ((k + 1) % count) * 2;
    idx.push(a, b, a + 1, a + 1, b, b + 1);
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(pos, 3));
  geo.setAttribute('aS', new BufferAttribute(s, 1));
  geo.setAttribute('aLat', new BufferAttribute(lat, 1));
  geo.setAttribute('aLine', new BufferAttribute(line, 1));
  geo.setIndex(idx);
  return geo;
}

/** Largest safe offset toward the inside of a corner before geometry folds. */
function insideLimit(m: TrackModel, i: number, wanted: number, side: number): number {
  const k = m.curvature[i]!;
  if (Math.sign(k) !== side || Math.abs(k) < 1e-4) return wanted;
  return Math.min(wanted, 0.9 / Math.abs(k));
}

/* ------------------------------------------------------------------ */
/* The scene                                                           */
/* ------------------------------------------------------------------ */

export function startHeroScene(canvas: HTMLCanvasElement, options: HeroOptions): HeroHandle {
  const { lite, still } = options;
  const model = trackModel();
  const n = model.center.x.length;

  const disposables: Array<{ dispose(): void }> = [];
  const track = <T extends { dispose(): void }>(x: T): T => {
    disposables.push(x);
    return x;
  };

  const renderer = new WebGLRenderer({
    canvas,
    antialias: false,
    alpha: false,
    stencil: false,
    powerPreference: 'high-performance',
  });
  const maxRatio = lite ? 1.5 : 2;
  let pixelRatio = Math.min(window.devicePixelRatio || 1, maxRatio);
  renderer.setPixelRatio(pixelRatio);
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.setClearColor(0x05070c, 1);

  const scene = new Scene();
  // Linear colour, matched to the sky dome's horizon so fogged things sink into it.
  const fog = new FogExp2(0x000000, lite ? 0.0095 : 0.0085);
  fog.color.setRGB(0.014, 0.018, 0.033);
  scene.fog = fog;

  const camera = new PerspectiveCamera(32, 1, 4, 1200);

  /* ---------- textures ---------- */
  const grainTex = track(asphaltTexture());
  const wetTex = track(wetTexture());
  grainTex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  wetTex.anisotropy = grainTex.anisotropy;

  /* ---------- shared light uniforms ---------- */
  const lampUniform = { value: Array.from({ length: MAX_LAMPS }, () => new Vector4()) };
  const tracerLightUniform = { value: Array.from({ length: TRACER_LIGHTS }, () => new Vector4()) };
  const tracerColorUniform = { value: Array.from({ length: TRACER_LIGHTS }, () => new Vector3()) };
  const lampColor = new Color(1.0, 0.88, 0.76);
  const lightUniforms = {
    uLamps: lampUniform,
    uLampColor: { value: new Vector3(lampColor.r, lampColor.g, lampColor.b) },
    uTracerLights: tracerLightUniform,
    uTracerColors: tracerColorUniform,
    uAmbient: { value: new Vector3(0.03, 0.036, 0.06) },
  };

  const surfaceMaterial = (define: string | null, order: number) => {
    const mat = new ShaderMaterial({
      uniforms: {
        ...UniformsUtils.clone(UniformsLib.fog),
        ...lightUniforms,
        uGrain: { value: grainTex },
        uWet: { value: wetTex },
        uHalf: { value: HALF },
      },
      defines: define ? { [define]: '' } : {},
      vertexShader: SURFACE_VERT,
      fragmentShader: SURFACE_FRAG,
      transparent: true,
      fog: true,
      depthWrite: true,
      blending: NormalBlending,
    });
    track(mat);
    return { mat, order };
  };

  /* ---------- sky dome (mirrored below the horizon, seen through wet ground) ---------- */
  const skyMat = track(
    new ShaderMaterial({
      side: BackSide,
      depthWrite: false,
      uniforms: {},
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          float y = abs(vDir.y);
          vec3 zenith = vec3(0.002, 0.003, 0.007);
          vec3 horizon = vec3(0.008, 0.011, 0.022);
          vec3 col = mix(horizon, zenith, smoothstep(0.0, 0.45, y));
          // Sodium haze of the city, strongest along one side of the sky.
          float side = 0.55 + 0.45 * smoothstep(-0.6, 0.9, vDir.x * 0.6 - vDir.z * 0.8);
          col += vec3(0.05, 0.032, 0.016) * exp(-y * 11.0) * side;
          col += vec3(0.01, 0.014, 0.03) * exp(-y * 3.0);
          // Below the horizon this is what wet ground reflects: keep it dim.
          if (vDir.y < 0.0) col *= 0.32;
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    }),
  );
  const sky = new Mesh(track(new SphereGeometry(700, 32, 16)), skyMat);
  sky.renderOrder = -20;
  scene.add(sky);

  /* ---------- reflection layer: mirrored emissive things under the ground ---------- */
  const mirror = new Group();
  mirror.scale.y = -1;
  scene.add(mirror);

  /* ---------- skyline ---------- */
  const skylineLayers = lite ? [{ r: 420, h: 20, seed: 5, tall: 170, w: 2048 }] : [
    { r: 460, h: 24, seed: 5, tall: 190, w: 2048 },
    { r: 330, h: 11, seed: 9, tall: 150, w: 2048 },
  ];
  skylineLayers.forEach((layer, li) => {
    const tex = track(skylineTexture(layer.w, layer.seed, layer.tall));
    tex.repeat.set(3, 1);
    const mat = track(
      new MeshBasicMaterial({
        map: tex,
        transparent: true,
        side: BackSide,
        depthWrite: false,
        fog: false,
        color: new Color(0.42, 0.42, 0.46),
      }),
    );
    const geo = track(new CylinderGeometry(layer.r, layer.r, layer.h, 96, 1, true));
    const mesh = new Mesh(geo, mat);
    mesh.position.y = layer.h / 2 - 0.5;
    mesh.renderOrder = -16 + li;
    scene.add(mesh);
  });

  /* ---------- ground ---------- */
  // The ground stops inside the nearest skyline ring and sits a hair below the
  // track, which is drawn first: the ground then fails the depth test under it.
  const ground = surfaceMaterial(null, 10);
  const groundGeo = track(new CircleGeometry(320, 72));
  groundGeo.rotateX(-Math.PI / 2);
  groundGeo.translate(0, -0.03, 0);
  const zeros = new Float32Array(groundGeo.attributes.position!.count);
  groundGeo.setAttribute('aS', new BufferAttribute(zeros, 1));
  groundGeo.setAttribute('aLat', new BufferAttribute(zeros, 1));
  groundGeo.setAttribute('aLine', new BufferAttribute(zeros, 1));
  const groundMesh = new Mesh(groundGeo, ground.mat);
  groundMesh.renderOrder = ground.order;
  scene.add(groundMesh);

  /* ---------- track surface ---------- */
  const all = Array.from({ length: n }, (_, i) => i);
  const trackMat = surfaceMaterial('TRACK', 5);
  const trackMesh = new Mesh(
    track(ribbon(model, all, () => -HALF, () => HALF, 0, true)),
    trackMat.mat,
  );
  trackMesh.renderOrder = trackMat.order;
  scene.add(trackMesh);

  /* ---------- kerbs on the inside (and the outside of tight corners) ---------- */
  const kerbMat = surfaceMaterial('KERB', 6);
  const kerbRuns: number[][] = [];
  for (const side of [1, -1]) {
    let run: number[] = [];
    for (let c = 0; c < n; c++) {
      const k = model.curvature[c]!;
      const inside = Math.sign(k) === side && Math.abs(k) > 0.085;
      const outside = Math.sign(k) === -side && Math.abs(k) > 0.2;
      if (inside || outside) run.push(c);
      else if (run.length) {
        if (run.length > 6) kerbRuns.push([side, ...run]);
        run = [];
      }
    }
    if (run.length > 6) kerbRuns.push([side, ...run]);
  }
  for (const r of kerbRuns) {
    const side = r[0]!;
    const run = r.slice(1);
    // Extend each run a little so kerbs start before the turn-in.
    const first = run[0]!;
    const last = run[run.length - 1]!;
    const ext: number[] = [];
    for (let e = 10; e > 0; e--) ext.push((first - e + n) % n);
    ext.push(...run);
    for (let e = 1; e <= 10; e++) ext.push((last + e) % n);
    const geo = track(
      ribbon(
        model,
        ext,
        (i) => side * insideLimit(model, i, HALF - 0.02, side),
        (i) => side * insideLimit(model, i, HALF + 0.55, side),
        0.02,
        false,
      ),
    );
    const mesh = new Mesh(geo, kerbMat.mat);
    mesh.renderOrder = kerbMat.order;
    scene.add(mesh);
  }

  /* ---------- barriers with a lit top edge ---------- */
  const barrierMat = track(
    new ShaderMaterial({
      uniforms: { ...UniformsUtils.clone(UniformsLib.fog), ...lightUniforms },
      fog: true,
      side: DoubleSide,
      vertexShader: /* glsl */ `
        attribute float aTop;
        attribute vec3 aNormal;
        varying vec3 vWorld;
        varying float vTop;
        varying vec3 vNormal;
        #include <fog_pars_vertex>
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          vWorld = world.xyz;
          vTop = aTop;
          vNormal = aNormal;
          vec4 mvPosition = viewMatrix * world;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vWorld;
        varying float vTop;
        varying vec3 vNormal;
        ${LIGHTING}
        #include <fog_pars_fragment>
        void main() {
          vec3 v = normalize(cameraPosition - vWorld);
          vec3 col = shade(vWorld, normalize(vNormal), v, vec3(0.05, 0.055, 0.065), 0.1);
          float strip = smoothstep(0.82, 0.94, vTop);
          col += vec3(0.42, 0.55, 0.78) * strip * 0.75;
          gl_FragColor = vec4(col, 1.0);
          #include <fog_fragment>
        }
      `,
    }),
  );
  const barrierGlowMat = track(
    new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
      vertexShader: /* glsl */ `
        attribute float aTop;
        varying float vTop;
        varying float vDepth;
        void main() {
          vTop = aTop;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vDepth = -mv.z;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vTop;
        varying float vDepth;
        void main() {
          float strip = smoothstep(0.82, 0.96, vTop);
          float fade = exp(-vDepth * 0.012);
          gl_FragColor = vec4(vec3(0.3, 0.42, 0.62) * strip * 0.45 * fade, 1.0);
        }
      `,
    }),
  );
  for (const side of [1, -1]) {
    const height = 0.55;
    const pos: number[] = [];
    const top: number[] = [];
    const nrm: number[] = [];
    const idx: number[] = [];
    let v = 0;
    for (let c = 0; c <= n; c++) {
      const i = c % n;
      const off = side * insideLimit(model, i, BARRIER, side);
      const x = model.center.x[i]! + off * model.nx[i]!;
      const z = model.center.z[i]! + off * model.nz[i]!;
      // Face toward the track.
      const fx = -side * model.nx[i]!;
      const fz = -side * model.nz[i]!;
      pos.push(x, 0, z, x, height, z);
      top.push(0, 1);
      nrm.push(fx, 0, fz, fx, 0.4, fz);
      if (c > 0) idx.push(v - 2, v, v - 1, v - 1, v, v + 1);
      v += 2;
    }
    const geo = track(new BufferGeometry());
    geo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute('aTop', new BufferAttribute(new Float32Array(top), 1));
    geo.setAttribute('aNormal', new BufferAttribute(new Float32Array(nrm), 3));
    geo.setIndex(idx);
    const wall = new Mesh(geo, barrierMat);
    scene.add(wall);
    if (!lite) mirror.add(new Mesh(geo, barrierGlowMat));
  }

  /* ---------- street lamps: poles, heads, haze cones, light pools ---------- */
  const lamps: Vector3[] = [];
  {
    const spacing = lite ? 20 : 13.5;
    let next = 6;
    let side = 1;
    for (let c = 0; c < n && lamps.length < MAX_LAMPS; c++) {
      if (model.center.s[c]! < next) continue;
      if (Math.abs(model.curvature[c]!) > 0.05) continue;
      const off = side * (BARRIER + 1.6);
      const x = model.center.x[c]! + off * model.nx[c]!;
      const z = model.center.z[c]! + off * model.nz[c]!;
      // Keep lamps off every other part of the circuit.
      let clear = true;
      for (let j = 0; j < n; j += 3) {
        if (Math.hypot(model.center.x[j]! - x, model.center.z[j]! - z) < BARRIER + 1.2) {
          clear = false;
          break;
        }
      }
      if (!clear) continue;
      lamps.push(new Vector3(x, 4.3, z));
      next = model.center.s[c]! + spacing;
      side = -side;
    }
  }
  lamps.forEach((p, i) => lampUniform.value[i]!.set(p.x, p.y, p.z, lite ? 46 : 40));

  const poleMat = track(new MeshBasicMaterial({ color: 0x080a10, fog: true }));
  const poleGeo = track(new BoxGeometry(0.12, 4.3, 0.12));
  poleGeo.translate(0, 2.15, 0);
  const poles = new InstancedMesh(poleGeo, poleMat, lamps.length);
  const tmp = new Object3D();
  lamps.forEach((p, i) => {
    tmp.position.set(p.x, 0, p.z);
    tmp.updateMatrix();
    poles.setMatrixAt(i, tmp.matrix);
  });
  scene.add(poles);

  /** Camera-facing glows, instanced: lamp heads, tracer heads, and their reflections. */
  const glowMaterial = (stretch: number) =>
    track(
      new ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        uniforms: { uStretch: { value: stretch } },
        vertexShader: /* glsl */ `
          attribute vec3 aOffset;
          attribute vec2 aSize;
          attribute vec3 aColor;
          uniform float uStretch;
          varying vec2 vUv;
          varying vec3 vColor;
          void main() {
            vUv = position.xy * 2.0;
            vColor = aColor;
            vec4 mv = modelViewMatrix * vec4(aOffset, 1.0);
            mv.xy += position.xy * aSize * vec2(1.0, uStretch);
            gl_Position = projectionMatrix * mv;
          }
        `,
        fragmentShader: /* glsl */ `
          varying vec2 vUv;
          varying vec3 vColor;
          void main() {
            float r2 = dot(vUv, vUv);
            float core = exp(-r2 * 22.0);
            float halo = exp(-r2 * 4.0) * 0.35;
            float a = (core + halo) * (1.0 - smoothstep(0.85, 1.0, r2));
            gl_FragColor = vec4(vColor * a, 1.0);
          }
        `,
      }),
    );
  const glowGeometry = (count: number) => {
    const geo = new InstancedBufferGeometry();
    const quad = track(new PlaneGeometry(1, 1));
    geo.index = quad.index;
    geo.setAttribute('position', quad.attributes.position!);
    geo.setAttribute('aOffset', new InstancedBufferAttribute(new Float32Array(count * 3), 3));
    geo.setAttribute('aSize', new InstancedBufferAttribute(new Float32Array(count * 2), 2));
    geo.setAttribute('aColor', new InstancedBufferAttribute(new Float32Array(count * 3), 3));
    geo.instanceCount = count;
    return track(geo);
  };

  const lampGlowGeo = glowGeometry(lamps.length);
  lamps.forEach((p, i) => {
    (lampGlowGeo.attributes.aOffset as InstancedBufferAttribute).setXYZ(i, p.x, p.y, p.z);
    (lampGlowGeo.attributes.aSize as InstancedBufferAttribute).setXY(i, 1.3, 1.3);
    (lampGlowGeo.attributes.aColor as InstancedBufferAttribute).setXYZ(i, 2.6, 2.0, 1.35);
  });
  const lampGlows = new Mesh(lampGlowGeo, glowMaterial(1));
  lampGlows.frustumCulled = false;
  lampGlows.renderOrder = 25;
  scene.add(lampGlows);
  const lampReflections = new Mesh(lampGlowGeo, glowMaterial(3.2));
  lampReflections.frustumCulled = false;
  mirror.add(lampReflections);

  if (!lite) {
    const coneMat = track(
      new ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        side: DoubleSide,
        vertexShader: /* glsl */ `
          varying float vH;
          varying vec3 vN;
          varying vec3 vV;
          void main() {
            vH = position.y / 4.1 + 0.5;
            vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
            vN = normalize(mat3(modelMatrix * instanceMatrix) * normal);
            vV = normalize(cameraPosition - world.xyz);
            gl_Position = projectionMatrix * viewMatrix * world;
          }
        `,
        fragmentShader: /* glsl */ `
          varying float vH;
          varying vec3 vN;
          varying vec3 vV;
          void main() {
            float facing = pow(abs(dot(normalize(vN), normalize(vV))), 1.6);
            float a = facing * pow(clamp(vH, 0.0, 1.0), 1.4) * 0.06;
            gl_FragColor = vec4(vec3(1.0, 0.8, 0.58) * a, 1.0);
          }
        `,
      }),
    );
    const coneGeo = track(new ConeGeometry(1.9, 4.1, 24, 1, true));
    const cones = new InstancedMesh(coneGeo, coneMat, lamps.length);
    cones.renderOrder = 24;
    lamps.forEach((p, i) => {
      tmp.position.set(p.x, p.y - 2.05, p.z);
      tmp.updateMatrix();
      cones.setMatrixAt(i, tmp.matrix);
    });
    scene.add(cones);
  }

  /* ---------- tracers: light walls, ground glow, heads, reflections ---------- */
  const samples = lite ? 80 : 150;
  interface TracerParts {
    wall: BufferGeometry;
    flat: BufferGeometry;
    color: Color;
    tail: Color;
    /** Each trail material's brightness, with the value it was built at. */
    gains: Array<{ uniform: { value: number }; base: number }>;
  }
  const trailVert = /* glsl */ `
    attribute float aAge;
    attribute float aV;
    varying float vAge;
    varying float vV;
    void main() {
      vAge = aAge;
      vV = aV;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `;
  const wallMaterial = (c: Color, t: Color, gain: number) =>
    track(
      new ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        side: DoubleSide,
        uniforms: { uColor: { value: c }, uTail: { value: t }, uGain: { value: gain }, uFade: { value: 1 } },
        vertexShader: trailVert,
        fragmentShader: /* glsl */ `
          uniform vec3 uColor;
          uniform vec3 uTail;
          uniform float uGain;
          uniform float uFade;
          varying float vAge;
          varying float vV;
          void main() {
            float life = clamp(1.0 - vAge, 0.0, 1.0);
            float a = pow(life, 1.7);
            float edge = mix(0.28, 1.0, pow(clamp(vV, 0.0, 1.0), 4.0));
            float base = smoothstep(0.0, 0.12, vV);
            vec3 col = mix(uTail, uColor, pow(life, 0.6));
            gl_FragColor = vec4(col * a * edge * base * uGain * uFade, 1.0);
          }
        `,
      }),
    );
  const flatMaterial = (c: Color, t: Color, gain: number) =>
    track(
      new ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        side: DoubleSide,
        uniforms: { uColor: { value: c }, uTail: { value: t }, uGain: { value: gain }, uFade: { value: 1 } },
        vertexShader: trailVert,
        fragmentShader: /* glsl */ `
          uniform vec3 uColor;
          uniform vec3 uTail;
          uniform float uGain;
          uniform float uFade;
          varying float vAge;
          varying float vV;
          void main() {
            float life = clamp(1.0 - vAge, 0.0, 1.0);
            float across = exp(-vV * vV * 3.5);
            vec3 col = mix(uTail, uColor, life);
            gl_FragColor = vec4(col * pow(life, 2.2) * across * uGain * uFade, 1.0);
          }
        `,
      }),
    );

  const trailGeometry = () => {
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(samples * 2 * 3), 3));
    const age = new Float32Array(samples * 2);
    const v = new Float32Array(samples * 2);
    for (let k = 0; k < samples; k++) {
      age[k * 2] = age[k * 2 + 1] = k / (samples - 1);
      v[k * 2] = 0;
      v[k * 2 + 1] = 1;
    }
    geo.setAttribute('aAge', new BufferAttribute(age, 1));
    geo.setAttribute('aV', new BufferAttribute(v, 1));
    const idx: number[] = [];
    for (let k = 0; k < samples - 1; k++) {
      const a = k * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
    geo.setIndex(idx);
    return track(geo);
  };

  const fadeUniforms: Array<{ value: number }> = [];
  const parts: TracerParts[] = model.drivers.map((d) => {
    const color = new Color(d.spec.color);
    const tail = new Color(d.spec.tail);
    const gain = 3.2 * d.spec.intensity;
    const wall = trailGeometry();
    const flat = trailGeometry();
    // The flat glow's aV runs -1..1 across its width.
    const fv = flat.attributes.aV as BufferAttribute;
    for (let k = 0; k < samples; k++) {
      fv.setX(k * 2, -1);
      fv.setX(k * 2 + 1, 1);
    }
    const wm = wallMaterial(color, tail, gain);
    const fm = flatMaterial(color, tail, gain * 0.5);
    const rm = wallMaterial(color, tail, gain * 0.55);
    fadeUniforms.push(wm.uniforms.uFade!, fm.uniforms.uFade!, rm.uniforms.uFade!);
    const gains = [wm, fm, rm].map((m) => ({ uniform: m.uniforms.uGain!, base: m.uniforms.uGain!.value as number }));
    const wallMesh = new Mesh(wall, wm);
    const flatMesh = new Mesh(flat, fm);
    const reflMesh = new Mesh(wall, rm);
    for (const mesh of [wallMesh, flatMesh, reflMesh]) mesh.frustumCulled = false;
    wallMesh.renderOrder = 30;
    flatMesh.renderOrder = 29;
    scene.add(wallMesh, flatMesh);
    mirror.add(reflMesh);
    return { wall, flat, color, tail, gains };
  });

  const headGlowGeo = glowGeometry(parts.length);
  const heads = new Mesh(headGlowGeo, glowMaterial(1));
  heads.frustumCulled = false;
  heads.renderOrder = 31;
  scene.add(heads);
  const headReflections = new Mesh(headGlowGeo, glowMaterial(2.6));
  headReflections.frustumCulled = false;
  mirror.add(headReflections);

  /* ---------- post-processing ---------- */
  const size = new Vector2(1, 1);
  const target = track(
    new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: lite ? 0 : 4 }),
  );
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new Vector2(256, 256), lite ? 0.75 : 0.85, 0.45, 0.82);
  composer.addPass(bloom);
  const grade = new ShaderPass({
    uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uAspect: { value: 1 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D tDiffuse;
      uniform float uTime;
      uniform float uAspect;
      varying vec2 vUv;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
      void main() {
        vec2 c = vUv - 0.5;
        c.x *= uAspect;
        float r = length(c);
        // A whisper of lateral colour fringing toward the corners.
        vec2 dir = (vUv - 0.5) * 0.0025 * r;
        vec3 col;
        col.r = texture2D(tDiffuse, vUv + dir).r;
        col.g = texture2D(tDiffuse, vUv).g;
        col.b = texture2D(tDiffuse, vUv - dir).b;
        col *= 1.0 - smoothstep(0.45, 1.25, r) * 0.65;
        float g = hash(vUv * 1024.0 + fract(uTime * 7.0)) - 0.5;
        col += g * 0.012;
        gl_FragColor = vec4(max(col, 0.0), 1.0);
      }
    `,
  });
  composer.addPass(grade);
  const output = new OutputPass();
  composer.addPass(output);
  disposables.push(composer);

  /* ---------- per-frame update ---------- */
  const scratch = new Float32Array(3);
  const head = new Float32Array(3);
  const prev = new Float32Array(3);

  /**
   * The race in progress. `start` is when it began, in scene seconds. The
   * leader runs `leadExtra` seconds ahead of the race clock (boosting adds
   * to it). `end` is the race time the lights are gone: RACE_PERIOD, or
   * sooner once a boosted leader is about to come back around to the pack.
   */
  const race = { start: 0, leadExtra: 0, end: RACE_PERIOD };
  /** 0..1, eased toward 1 while the boost is held. */
  let boost = 0;
  let boostHeld = false;

  /** How far ahead the leader is, in laps, of the closest of the pack. */
  function leadGap(raceTime: number): number {
    const [lead, ...pack] = model.drivers;
    const leadLaps = (raceTime + race.leadExtra) / lead!.lapTime;
    let gap = Number.POSITIVE_INFINITY;
    for (const d of pack) gap = Math.min(gap, leadLaps - raceTime / d.lapTime);
    return gap;
  }

  function updateTracers(raceTime: number) {
    const fade = raceFade(raceTime, race.end);
    for (const u of fadeUniforms) u.value = fade;
    const offs = headGlowGeo.attributes.aOffset as InstancedBufferAttribute;
    const sizes = headGlowGeo.attributes.aSize as InstancedBufferAttribute;
    const cols = headGlowGeo.attributes.aColor as InstancedBufferAttribute;
    const dt = TRAIL_SECONDS / (samples - 1);
    model.drivers.forEach((d, di) => {
      const p = parts[di]!;
      const lift = di === 0 ? boost : 0;
      const time = di === 0 ? raceTime + race.leadExtra : raceTime;
      // A boosted trail reaches further back along the line, so it streaks.
      const step = dt * (1 + 0.9 * lift);
      for (const g of p.gains) g.uniform.value = g.base * (1 + 0.7 * lift);
      const wallPos = p.wall.attributes.position as BufferAttribute;
      const flatPos = p.flat.attributes.position as BufferAttribute;
      let px = 0;
      let pz = 0;
      for (let k = 0; k < samples; k++) {
        const t = Math.max(0, time - k * step);
        driverAt(d, t, scratch);
        const x = scratch[0]!;
        const z = scratch[1]!;
        const age = k / (samples - 1);
        const h = (0.07 + 0.95 * Math.pow(1 - age, 0.55)) * (1 + 0.3 * lift);
        wallPos.setXYZ(k * 2, x, 0.05, z);
        wallPos.setXYZ(k * 2 + 1, x, h, z);
        // Flat glow: perpendicular to the direction of travel.
        let dx = k === 0 ? 0 : px - x;
        let dz = k === 0 ? 0 : pz - z;
        if (k === 0) {
          driverAt(d, Math.max(0, time - step), prev);
          dx = x - prev[0]!;
          dz = z - prev[1]!;
        }
        const len = Math.hypot(dx, dz) || 1;
        const w = 1.5 * Math.pow(1 - age, 0.4) + 0.15;
        const sx = (-dz / len) * w;
        const sz = (dx / len) * w;
        flatPos.setXYZ(k * 2, x + sx, 0.05, z + sz);
        flatPos.setXYZ(k * 2 + 1, x - sx, 0.05, z - sz);
        px = x;
        pz = z;
        if (k === 0) {
          head[0] = x;
          head[1] = z;
        }
        // Light cast on the road: from the head and from partway down the trail.
        if (k === 0 || k === Math.floor(samples * 0.3)) {
          const slot = di * 2 + (k === 0 ? 0 : 1);
          const strength = (k === 0 ? 1.0 : 0.45) * fade * d.spec.intensity * (1 + 0.6 * lift);
          tracerLightUniform.value[slot]!.set(x, 0.4, z, k === 0 ? 1.5 : 2.2);
          tracerColorUniform.value[slot]!.set(
            p.color.r * strength * 1.3,
            p.color.g * strength * 1.3,
            p.color.b * strength * 1.3,
          );
        }
      }
      wallPos.needsUpdate = true;
      flatPos.needsUpdate = true;
      const g = 5.5 * d.spec.intensity * fade * (1 + 0.9 * lift);
      const r = 2.6 * (1 + 0.45 * lift);
      offs.setXYZ(di, head[0]!, 0.36, head[1]!);
      sizes.setXY(di, r, r);
      cols.setXYZ(di, p.color.r * g, p.color.g * g, p.color.b * g);
    });
    offs.needsUpdate = true;
    sizes.needsUpdate = true;
    cols.needsUpdate = true;
  }

  /* ---------- pointer: a little camera tilt and a light on the asphalt ---------- */
  /** Pointer over the canvas, -1..1 each way (y up), and whether it is there at all. */
  const pointer = { x: 0, y: 0, inside: false };
  /** The pointer position the camera follows, eased. */
  const tilt = new Vector2();
  /** 0..1, how much of the pointer light is on. */
  let pointerGlow = 0;
  const lightAt = new Vector3();
  let lightPlaced = false;
  const ray = new Vector3();
  const hit = new Vector3();
  const forward = new Vector3();
  const right = new Vector3();
  const up = new Vector3();
  const WORLD_UP = new Vector3(0, 1, 0);

  const bandQuery = window.matchMedia(BAND_QUERY);
  function placeCamera(camTime: number) {
    const aspect = size.x / Math.max(1, size.y);
    const pose = cameraPose(camTime, aspect, bandQuery.matches);
    // A slight punch-in while boosting.
    camera.fov = pose.fov * (1 - 0.05 * boost);
    camera.aspect = aspect;
    camera.position.set(...pose.position);
    if (tilt.x !== 0 || tilt.y !== 0) {
      // Slide across and up toward the pointer, still aimed at the same spot.
      forward.set(pose.target[0], pose.target[1], pose.target[2]).sub(camera.position);
      const dist = forward.length();
      forward.divideScalar(dist || 1);
      right.crossVectors(forward, WORLD_UP).normalize();
      up.crossVectors(right, forward);
      camera.position.addScaledVector(right, tilt.x * dist * 0.045);
      camera.position.addScaledVector(up, tilt.y * dist * 0.03);
    }
    camera.lookAt(pose.target[0], pose.target[1], pose.target[2]);
    camera.setViewOffset(size.x, size.y, pose.shiftX * size.x, pose.shiftY * size.y, size.x, size.y);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  }

  /** Where the pointer meets the ground, or false when it is off the ground. */
  function pointerOnGround(): boolean {
    if (!pointer.inside) return false;
    ray.set(pointer.x, pointer.y, 0.5).unproject(camera).sub(camera.position).normalize();
    if (ray.y > -0.02) return false;
    const d = -camera.position.y / ray.y;
    if (d > 420) return false;
    hit.copy(camera.position).addScaledVector(ray, d);
    return true;
  }

  function updatePointerLight(dt: number) {
    const onGround = pointerOnGround();
    if (onGround) {
      if (!lightPlaced || pointerGlow < 0.02) lightAt.copy(hit);
      else lightAt.lerp(hit, 1 - Math.exp(-dt * 12));
      lightPlaced = true;
    }
    pointerGlow += ((onGround ? 1 : 0) - pointerGlow) * (1 - Math.exp(-dt * (onGround ? 4 : 2.5)));
    if (pointerGlow < 1e-3) pointerGlow = 0;
    const s = POINTER_STRENGTH * pointerGlow;
    tracerLightUniform.value[POINTER_LIGHT]!.set(lightAt.x, 2.2, lightAt.z, 6.5);
    tracerColorUniform.value[POINTER_LIGHT]!.set(0.78 * s, 0.84 * s, 1.0 * s);
  }

  function resize() {
    const parent = canvas.parentElement;
    const w = Math.max(1, Math.floor(parent?.clientWidth ?? canvas.clientWidth));
    const h = Math.max(1, Math.floor(parent?.clientHeight ?? canvas.clientHeight));
    size.set(w, h);
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(w, h, false);
    composer.setPixelRatio(pixelRatio);
    composer.setSize(w, h);
    bloom.resolution.set((w * pixelRatio) / 2, (h * pixelRatio) / 2);
    grade.uniforms.uAspect!.value = w / h;
  }

  /* ---------- loop ---------- */
  let raf = 0;
  let active = false;
  let disposed = false;
  let firstFrame = false;
  // Live and still both open on the moment the static fallback depicts.
  let elapsed = STILL_TIME;
  let last = 0;
  let frames = 0;
  let slowFrames = 0;
  const bloomBase = bloom.strength;

  /** Advance the race, the boost and the pointer easing by `dt` seconds. */
  function advance(dt: number) {
    elapsed += dt;
    let raceTime = elapsed - race.start;
    if (raceTime >= race.end) {
      race.start = elapsed;
      race.leadExtra = 0;
      race.end = RACE_PERIOD;
      raceTime = 0;
    }
    const ease = (from: number, to: number, rate: number) => from + (to - from) * (1 - Math.exp(-dt * rate));
    boost = ease(boost, boostHeld ? 1 : 0, boostHeld ? 5 : 2.2);
    if (boost < 1e-3) boost = 0;
    if (race.end === RACE_PERIOD) {
      race.leadExtra += dt * BOOST_GAIN * boost;
      if (leadGap(raceTime) >= GAP_LIMIT) race.end = Math.min(RACE_PERIOD, raceTime + FINISH_FADE);
    }
    tilt.set(ease(tilt.x, pointer.inside ? pointer.x : 0, 2.5), ease(tilt.y, pointer.inside ? pointer.y : 0, 2.5));
  }

  function render(time: number, dt = 0) {
    updateTracers(elapsed - race.start);
    placeCamera(elapsed);
    updatePointerLight(dt);
    bloom.strength = bloomBase * (1 + 0.25 * boost);
    grade.uniforms.uTime!.value = time;
    composer.render();
    if (!firstFrame) {
      firstFrame = true;
      options.onFirstFrame?.();
    }
  }

  function tick(now: number) {
    raf = 0;
    if (!active || disposed) return;
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 1 / 60;
    last = now;
    advance(dt);
    render(elapsed, dt);
    // Adaptive quality: if frames stay slow, drop resolution a step at a time.
    frames++;
    if (frames > 40) {
      if (dt > 0.026) slowFrames++;
      else slowFrames = Math.max(0, slowFrames - 1);
      if (slowFrames > 45 && pixelRatio > 1) {
        pixelRatio = Math.max(1, pixelRatio - 0.25);
        slowFrames = 0;
        resize();
      }
    }
    raf = requestAnimationFrame(tick);
  }

  const ro = new ResizeObserver(() => {
    resize();
    if (still || !active) render(elapsed);
  });
  if (canvas.parentElement) ro.observe(canvas.parentElement);
  resize();
  render(elapsed);

  return {
    setActive(next: boolean) {
      if (disposed || still) return;
      if (next === active) return;
      active = next;
      if (active) {
        last = 0;
        raf = requestAnimationFrame(tick);
      } else if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    },
    setPointer(x: number | null, y = 0) {
      if (disposed || still) return;
      if (x === null) {
        pointer.inside = false;
        return;
      }
      const rect = canvas.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      pointer.x = Math.max(-1, Math.min(1, ((x - rect.left) / rect.width) * 2 - 1));
      pointer.y = Math.max(-1, Math.min(1, 1 - ((y - rect.top) / rect.height) * 2));
      pointer.inside = true;
    },
    setBoost(on: boolean) {
      if (disposed || still) return;
      boostHeld = on;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      active = false;
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      bloom.dispose();
      grade.dispose();
      output.dispose();
      scene.traverse((obj) => {
        const mesh = obj as Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material as Material | Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat?.dispose();
      });
      for (const d of disposables) d.dispose();
      for (const t of [grainTex, wetTex] as Texture[]) t.dispose();
      renderer.renderLists.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
