/**
 * The hero circuit, as pure math: no WebGL, no DOM. Shared by the live scene
 * (loaded lazily on the client) and the static SVG fallback (rendered on the
 * server at build time), so the fallback is the same scene from the same
 * camera, not an illustration of it.
 *
 * The track is a closed Catmull-Rom curve in the XZ plane (y is up). Each
 * tracer drives its own line over it: the lead tracer a minimum-curvature
 * racing line, the other two a less committed line with some wander. Speed
 * comes from a simple lap-time model (lateral grip caps corner speed, forward
 * and backward passes cap acceleration and braking), so the lead tracer gains
 * time in the corners the way a car on a cleaner line would.
 */
import { CatmullRomCurve3, Vector3 } from 'three';

export const TRACK_WIDTH = 3.4;
const HALF = TRACK_WIDTH / 2;
/** Samples along the closed centerline. */
const N = 1600;

/** Control points (x, z) of the centerline, clockwise seen from above. */
const CONTROL: ReadonlyArray<readonly [number, number]> = [
  [-28, 16],
  [-6, 16.2],
  [16, 16],
  [29, 15.6],
  [34.5, 14.2],
  [36.6, 10],
  [36.8, 3.5],
  [34.4, -1.2],
  [39.6, -5.8],
  [37.2, -10.6],
  [35.6, -17.2],
  [31.4, -21.2],
  [25, -22.2],
  [14, -22.4],
  [6.2, -22],
  [2.2, -19.4],
  [1.4, -14.2],
  [-1.4, -9.6],
  [-7, -8.6],
  [-16, -8.8],
  [-20.6, -11],
  [-22.2, -16.4],
  [-24.6, -22.6],
  [-29.4, -25.4],
  [-34.6, -23.4],
  [-36.8, -17],
  [-37, -6],
  [-37.4, 6],
  [-36.4, 12.4],
  [-33, 15.6],
];

export interface Polyline {
  x: Float32Array;
  z: Float32Array;
  /** Cumulative arc length at each sample; `length` closes the loop. */
  s: Float32Array;
  length: number;
}

export interface TracerSpec {
  id: 'lead' | 'second' | 'third';
  /** Linear-ish sRGB hex of the light. */
  color: string;
  /** Secondary hue the trail fades toward (a gradient along its age). */
  tail: string;
  /** How much of the minimum-curvature line this driver commits to (0..1). */
  commit: number;
  /** Constant lateral lane offset, so trails do not sit on top of each other. */
  lane: number;
  /** Lateral wander amplitude (a scrappier line). */
  wander: number;
  wanderSeed: number;
  vmax: number;
  aLat: number;
  aAcc: number;
  aBrk: number;
  /** Brightness multiplier of the light and its trail. */
  intensity: number;
}

/**
 * The lead tracer is Turbine cornflower blue. The other two are desaturated nods to a
 * teal family and an acid lime, kept dim enough to read as company
 * on the track rather than as labels.
 */
export const TRACERS: readonly TracerSpec[] = [
  {
    id: 'lead',
    color: '#6f9bf7',
    tail: '#274fa5',
    commit: 1,
    lane: 0,
    wander: 0,
    wanderSeed: 0,
    vmax: 48,
    aLat: 74,
    aAcc: 30,
    aBrk: 64,
    intensity: 1,
  },
  {
    id: 'second',
    color: '#4fb3b9',
    tail: '#2f8a8f',
    commit: 0.45,
    lane: 0.55,
    wander: 0.22,
    wanderSeed: 1.7,
    vmax: 43,
    aLat: 59,
    aAcc: 23,
    aBrk: 54,
    intensity: 0.62,
  },
  {
    id: 'third',
    color: '#b9d672',
    tail: '#8fae4a',
    commit: 0.3,
    lane: -0.55,
    wander: 0.3,
    wanderSeed: 4.2,
    vmax: 42.6,
    aLat: 58,
    aAcc: 22.5,
    aBrk: 52,
    intensity: 0.58,
  },
];

/** One race lasts this long, then the lights fade and the grid resets. Short enough that the leader never comes back around to the pack. */
export const RACE_PERIOD = 30;
/** The moment the static fallback and the reduced-motion still depict. */
export const STILL_TIME = 8.8;
/** Seconds of history each trail shows. */
export const TRAIL_SECONDS = 1.5;

function closedLength(x: Float32Array, z: Float32Array, s: Float32Array): number {
  const n = x.length;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    s[i] = acc;
    const j = (i + 1) % n;
    acc += Math.hypot(x[j]! - x[i]!, z[j]! - z[i]!);
  }
  return acc;
}

function makePolyline(x: Float32Array, z: Float32Array): Polyline {
  const s = new Float32Array(x.length);
  const length = closedLength(x, z, s);
  return { x, z, s, length };
}

/** Signed curvature at each sample of a closed polyline (positive = turning left). */
function curvature(line: Polyline, smooth = 6): Float32Array {
  const n = line.x.length;
  const k = new Float32Array(n);
  const step = 3;
  for (let i = 0; i < n; i++) {
    const a = (i - step + n) % n;
    const b = (i + step) % n;
    const ax = line.x[a]!;
    const az = line.z[a]!;
    const px = line.x[i]!;
    const pz = line.z[i]!;
    const bx = line.x[b]!;
    const bz = line.z[b]!;
    const cross = (px - ax) * (bz - pz) - (pz - az) * (bx - px);
    const d1 = Math.hypot(px - ax, pz - az);
    const d2 = Math.hypot(bx - px, bz - pz);
    const d3 = Math.hypot(bx - ax, bz - az);
    // In XZ with y up, a negative cross product turns left when seen from above.
    k[i] = d1 * d2 * d3 > 1e-9 ? (-2 * cross) / (d1 * d2 * d3) : 0;
  }
  if (smooth <= 0) return k;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let j = -smooth; j <= smooth; j++) acc += k[(i + j + n) % n]!;
    out[i] = acc / (2 * smooth + 1);
  }
  return out;
}

export interface TrackModel {
  center: Polyline;
  /** Unit tangent and left normal (in XZ) at each centerline sample. */
  tx: Float32Array;
  tz: Float32Array;
  nx: Float32Array;
  nz: Float32Array;
  curvature: Float32Array;
  /** The lead tracer's lateral offset from the centerline, per sample. */
  racingOffset: Float32Array;
  drivers: Driver[];
}

export interface Driver {
  spec: TracerSpec;
  line: Polyline;
  /** Cumulative time at each sample of `line`, for one flying lap. */
  t: Float32Array;
  lapTime: number;
}

function buildCenter(): Polyline {
  const curve = new CatmullRomCurve3(
    CONTROL.map(([x, z]) => new Vector3(x, 0, z)),
    true,
    'centripetal',
  );
  const pts = curve.getSpacedPoints(N);
  const x = new Float32Array(N);
  const z = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    x[i] = pts[i]!.x;
    z[i] = pts[i]!.z;
  }
  return makePolyline(x, z);
}

/**
 * Minimum-curvature line: Laplacian smoothing of the offset, projected on the
 * normal and clamped to the track. Converges to the outside-inside-outside
 * line a driver would take.
 */
function minimumCurvatureOffsets(
  center: Polyline,
  nx: Float32Array,
  nz: Float32Array,
  margin: number,
): Float32Array {
  const n = center.x.length;
  const o = new Float32Array(n);
  const limit = HALF - margin;
  const px = new Float32Array(n);
  const pz = new Float32Array(n);
  for (let iter = 0; iter < 700; iter++) {
    for (let i = 0; i < n; i++) {
      px[i] = center.x[i]! + o[i]! * nx[i]!;
      pz[i] = center.z[i]! + o[i]! * nz[i]!;
    }
    for (let i = 0; i < n; i++) {
      const a = (i - 4 + n) % n;
      const b = (i + 4) % n;
      const mx = (px[a]! + px[b]!) / 2 - px[i]!;
      const mz = (pz[a]! + pz[b]!) / 2 - pz[i]!;
      const next = o[i]! + 0.5 * (mx * nx[i]! + mz * nz[i]!);
      o[i] = Math.max(-limit, Math.min(limit, next));
    }
  }
  // A final light smoothing pass removes clamp kinks.
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let j = -10; j <= 10; j++) acc += o[(i + j + n) % n]!;
    out[i] = acc / 21;
  }
  return out;
}

function lapTimes(line: Polyline, spec: TracerSpec): { t: Float32Array; lapTime: number } {
  const n = line.x.length;
  const k = curvature(line, 8);
  const v = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const kk = Math.abs(k[i]!);
    v[i] = kk > 1e-6 ? Math.min(spec.vmax, Math.sqrt(spec.aLat / kk)) : spec.vmax;
  }
  const ds = (i: number) => {
    const j = (i + 1) % n;
    return Math.hypot(line.x[j]! - line.x[i]!, line.z[j]! - line.z[i]!);
  };
  // Two laps of each pass so the closed loop settles.
  for (let pass = 0; pass < 2; pass++) {
    for (let c = 0; c < 2 * n; c++) {
      const i = c % n;
      const j = (i + 1) % n;
      const cap = Math.sqrt(v[i]! * v[i]! + 2 * spec.aAcc * ds(i));
      if (v[j]! > cap) v[j] = cap;
    }
    for (let c = 2 * n; c > 0; c--) {
      const j = c % n;
      const i = (j - 1 + n) % n;
      const cap = Math.sqrt(v[j]! * v[j]! + 2 * spec.aBrk * ds(i));
      if (v[i]! > cap) v[i] = cap;
    }
  }
  const t = new Float32Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    t[i] = acc;
    const j = (i + 1) % n;
    acc += (2 * ds(i)) / (v[i]! + v[j]!);
  }
  return { t, lapTime: acc };
}

let cached: TrackModel | null = null;

export function trackModel(): TrackModel {
  if (cached) return cached;
  const center = buildCenter();
  const n = center.x.length;
  const tx = new Float32Array(n);
  const tz = new Float32Array(n);
  const nx = new Float32Array(n);
  const nz = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i - 1 + n) % n;
    const b = (i + 1) % n;
    let dx = center.x[b]! - center.x[a]!;
    let dz = center.z[b]! - center.z[a]!;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    tx[i] = dx;
    tz[i] = dz;
    // Left of travel, seen from above with y up: rotate the tangent by +90 deg.
    nx[i] = dz;
    nz[i] = -dx;
  }
  const k = curvature(center, 10);
  const racingOffset = minimumCurvatureOffsets(center, nx, nz, 0.42);

  const drivers: Driver[] = TRACERS.map((spec) => {
    const x = new Float32Array(n);
    const z = new Float32Array(n);
    const limit = HALF - 0.32;
    for (let i = 0; i < n; i++) {
      const u = (i / n) * Math.PI * 2;
      const wander =
        spec.wander *
        (Math.sin(u * 7 + spec.wanderSeed) * 0.6 + Math.sin(u * 13 + spec.wanderSeed * 2.3) * 0.4);
      const o = Math.max(-limit, Math.min(limit, spec.commit * racingOffset[i]! + spec.lane + wander));
      x[i] = center.x[i]! + o * nx[i]!;
      z[i] = center.z[i]! + o * nz[i]!;
    }
    const line = makePolyline(x, z);
    const { t, lapTime } = lapTimes(line, spec);
    return { spec, line, t, lapTime };
  });

  cached = { center, tx, tz, nx, nz, curvature: k, racingOffset, drivers };
  return cached;
}

/**
 * Where a driver is `time` seconds after the start of a race (all three cross
 * the start line together at time 0). Writes into `out` as [x, z, heading].
 */
export function driverAt(d: Driver, time: number, out: Float32Array): void {
  const laps = Math.floor(time / d.lapTime);
  const tau = time - laps * d.lapTime;
  const t = d.t;
  const n = t.length;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (t[mid]! <= tau) lo = mid;
    else hi = mid - 1;
  }
  const i = lo;
  const j = (i + 1) % n;
  const t1 = j === 0 ? d.lapTime : t[j]!;
  const f = t1 > t[i]! ? (tau - t[i]!) / (t1 - t[i]!) : 0;
  const x0 = d.line.x[i]!;
  const z0 = d.line.z[i]!;
  const x1 = d.line.x[j]!;
  const z1 = d.line.z[j]!;
  out[0] = x0 + (x1 - x0) * f;
  out[1] = z0 + (z1 - z0) * f;
  out[2] = Math.atan2(z1 - z0, x1 - x0);
}

/** Seconds the lights take to fade out when a race ends. */
export const FINISH_FADE = 1.4;

/**
 * Opacity of the lights at a point in the race: fade in at the start, out
 * toward `end`, the race time at which the lights are gone.
 */
export function raceFade(time: number, end = RACE_PERIOD): number {
  const fadeIn = Math.min(1, time / 0.5);
  const fadeOut = Math.min(1, Math.max(0, (end - time) / FINISH_FADE));
  return fadeIn * fadeOut;
}

export interface CameraPose {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
  /** Fraction of the frame height to shift the image down (portrait framing). */
  shiftY: number;
  /** Fraction of the frame width to shift the image right (room for text on the left). */
  shiftX: number;
}

/**
 * A low three-quarter view that drifts slowly. Portrait viewports get their
 * own framing: closer, looking along the main straight, pushed toward the
 * bottom of the frame under the headline.
 */
/**
 * Below this width the scene is a band between the hero copy and the stats,
 * not the hero's backdrop. Keep in step with the 900px breakpoint in
 * globals.css.
 */
export const BAND_QUERY = '(max-width: 899.98px)';

export function cameraPose(time: number, aspect: number, band = false): CameraPose {
  const sway = Math.sin(time * 0.045) * 0.16 + Math.sin(time * 0.017 + 1.3) * 0.08;
  const bob = Math.sin(time * 0.06);
  if (band) {
    // Band: from the south, above the main straight, the whole lap across
    // the frame. Taller bands pull back so the ends stay in shot.
    const theta = 0.2 + sway * 0.3;
    const radius = 85 * Math.max(1, 1.85 / aspect);
    return {
      position: [Math.sin(theta) * radius, 52 + bob * 1.2, -4 + Math.cos(theta) * radius],
      target: [0, 0, -4],
      fov: 32,
      shiftY: 0.03,
      shiftX: 0,
    };
  }
  if (aspect < 0.9) {
    // Portrait: look down the circuit's long axis from higher up, so the
    // whole lap fits the narrow frame below the headline.
    const theta = -1.55 + sway * 0.35;
    const radius = 162;
    return {
      position: [2 + Math.sin(theta) * radius, 56 + bob * 1.5, -4 + Math.cos(theta) * radius],
      target: [0, 0, -5],
      fov: 40,
      shiftY: -0.26,
      shiftX: 0,
    };
  }
  // Landscape: low and from the west, the main straight receding on the
  // right. Narrower frames pull back so the circuit stays clear of the text.
  const theta = -1.4 + sway;
  const radius = 140 * Math.max(1, 1.5 / aspect);
  return {
    position: [2 + Math.sin(theta) * radius, 13 + bob * 1.1, -4 + Math.cos(theta) * radius],
    target: [4, 0, -6],
    fov: 26,
    shiftY: -0.06,
    shiftX: -0.26,
  };
}
