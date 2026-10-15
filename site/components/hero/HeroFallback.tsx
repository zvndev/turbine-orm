import { PerspectiveCamera, Vector3 } from 'three';
import {
  cameraPose,
  driverAt,
  STILL_TIME,
  TRACK_WIDTH,
  TRAIL_SECONDS,
  trackModel,
} from './track';

/**
 * The hero scene as a static SVG, projected on the server (at build time)
 * from the same track model and camera the WebGL scene uses, at the same
 * moment of the race the live scene opens on. It is what the page shows
 * before the scene loads, when WebGL is missing, and while it fades in.
 *
 * Three framings, swapped by CSS: landscape and portrait backdrops for wide
 * screens, and the band that sits under the copy on narrow ones.
 */

const HALF = TRACK_WIDTH / 2;
const BARRIER = HALF + 1.15;

interface Frame {
  w: number;
  h: number;
  className: string;
  band?: boolean;
}

const FRAMES: Frame[] = [
  { w: 1600, h: 900, className: 'hero-fallback-wide' },
  { w: 780, h: 1600, className: 'hero-fallback-tall' },
  { w: 780, h: 420, className: 'hero-fallback-band', band: true },
];

function makeProjector(frame: Frame) {
  const aspect = frame.w / frame.h;
  const pose = cameraPose(STILL_TIME, aspect, frame.band);
  const camera = new PerspectiveCamera(pose.fov, aspect, 4, 1200);
  camera.position.set(...pose.position);
  camera.lookAt(pose.target[0], pose.target[1], pose.target[2]);
  camera.setViewOffset(frame.w, frame.h, pose.shiftX * frame.w, pose.shiftY * frame.h, frame.w, frame.h);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  const v = new Vector3();
  const project = (x: number, y: number, z: number): [number, number] | null => {
    v.set(x, y, z).project(camera);
    if (v.z > 1 || v.z < -1) return null;
    return [((v.x + 1) / 2) * frame.w, ((1 - v.y) / 2) * frame.h];
  };
  // The horizon: a far point on the ground straight ahead.
  const dir = new Vector3();
  camera.getWorldDirection(dir);
  dir.y = 0;
  dir.normalize();
  const far = project(camera.position.x + dir.x * 600, 0, camera.position.z + dir.z * 600);
  return { project, horizon: far ? far[1] : frame.h * 0.4 };
}

function pathFrom(points: Array<[number, number] | null>, close = false): string {
  let d = '';
  let pen = false;
  for (const p of points) {
    if (!p) {
      pen = false;
      continue;
    }
    d += `${pen ? 'L' : 'M'}${Math.round(p[0])} ${Math.round(p[1])}`;
    pen = true;
  }
  return close ? `${d}Z` : d;
}

function Scene({ frame }: { frame: Frame }) {
  const m = trackModel();
  const n = m.center.x.length;
  const { project, horizon } = makeProjector(frame);
  // Coarse on purpose: this markup ships in the page twice (HTML and the
  // RSC payload), and whole pixels on a curve this smooth look the same.
  const step = 16;
  const along = (offset: number, y: number) => {
    const pts: Array<[number, number] | null> = [];
    for (let c = 0; c <= n; c += step) {
      const i = c % n;
      pts.push(project(m.center.x[i]! + offset * m.nx[i]!, y, m.center.z[i]! + offset * m.nz[i]!));
    }
    return pts;
  };
  const left = along(HALF, 0);
  const right = along(-HALF, 0);
  const surface = pathFrom([...left, ...right.slice().reverse()], true);

  // Trails at the still moment, oldest segment faintest.
  const trails = m.drivers.map((d) => {
    const seg: string[] = [];
    const o = new Float32Array(3);
    const samples = 48;
    const pts: Array<[number, number] | null> = [];
    for (let k = 0; k < samples; k++) {
      driverAt(d, Math.max(0, STILL_TIME - (k / (samples - 1)) * TRAIL_SECONDS), o);
      pts.push(project(o[0]!, 0.3, o[1]!));
    }
    for (let s = 0; s < 6; s++) {
      seg.push(pathFrom(pts.slice(s * 8, s * 8 + 9)));
    }
    return { spec: d.spec, seg, head: pts[0] };
  });

  // Street lamps where the live scene puts them is not worth duplicating; a
  // handful of soft points along the far straight sells the same light.
  const lamps: Array<[number, number]> = [];
  for (let c = 40; c < n; c += 150) {
    const side = lamps.length % 2 ? 1 : -1;
    const off = side * (BARRIER + 1.6);
    const p = project(m.center.x[c]! + off * m.nx[c]!, 4.3, m.center.z[c]! + off * m.nz[c]!);
    if (p) lamps.push(p);
  }

  const id = frame.className;
  return (
    <svg
      className={frame.className}
      viewBox={`0 0 ${frame.w} ${frame.h}`}
      preserveAspectRatio="xMidYMid slice"
      role="presentation"
    >
      <defs>
        <linearGradient id={`${id}-sky`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#040509" />
          <stop offset={(horizon / frame.h).toFixed(3)} stopColor="#141a2a" />
          <stop offset={Math.min(1, horizon / frame.h + 0.02).toFixed(3)} stopColor="#0b0e17" />
          <stop offset="1" stopColor="#05070b" />
        </linearGradient>
        <radialGradient id={`${id}-lamp`}>
          <stop offset="0" stopColor="#fff1e2" stopOpacity="0.95" />
          <stop offset="0.18" stopColor="#ffd4b2" stopOpacity="0.35" />
          <stop offset="1" stopColor="#ffb08a" stopOpacity="0" />
        </radialGradient>
        {/* Frame-sized region: a bounding-box one clips the blur off a flat trail. */}
        <filter id={`${id}-glow`} filterUnits="userSpaceOnUse" x="0" y="0" width={frame.w} height={frame.h}>
          <feGaussianBlur stdDeviation="6" />
        </filter>
      </defs>
      <rect width={frame.w} height={frame.h} fill={`url(#${id}-sky)`} />
      <rect y={horizon - 40} width={frame.w} height="80" fill="#3a2410" opacity="0.18" filter={`url(#${id}-glow)`} />
      <path d={surface} fill="#0d1018" />
      <path d={pathFrom(left)} fill="none" stroke="#c8ccd4" strokeOpacity="0.22" strokeWidth="1.1" />
      <path d={pathFrom(right)} fill="none" stroke="#c8ccd4" strokeOpacity="0.22" strokeWidth="1.1" />
      <path d={pathFrom(along(BARRIER, 0.55))} fill="none" stroke="#6b89bd" strokeOpacity="0.5" strokeWidth="1.3" />
      <path d={pathFrom(along(-BARRIER, 0.55))} fill="none" stroke="#6b89bd" strokeOpacity="0.5" strokeWidth="1.3" />
      {lamps.map(([x, y]) => (
        <circle key={`${x}-${y}`} cx={x} cy={y} r="26" fill={`url(#${id}-lamp)`} />
      ))}
      {trails.map((t) => (
        <g key={t.spec.id} opacity={t.spec.intensity}>
          {t.seg.map((d, s) => (
            <path
              key={`g${s}`}
              d={d}
              fill="none"
              stroke={s < 2 ? t.spec.color : t.spec.tail}
              strokeOpacity={0.8 * (1 - s / 6)}
              strokeWidth="14"
              strokeLinecap="round"
              filter={`url(#${id}-glow)`}
            />
          ))}
          {t.seg.map((d, s) => (
            <path
              key={`c${s}`}
              d={d}
              fill="none"
              stroke={s < 2 ? '#fee7f3' : t.spec.color}
              strokeOpacity={1 - s / 6}
              strokeWidth={2.4 - s * 0.3}
              strokeLinecap="round"
            />
          ))}
          {t.head && <circle cx={t.head[0]} cy={t.head[1]} r="5" fill="#fef1f8" />}
        </g>
      ))}
    </svg>
  );
}

export function HeroFallback() {
  return (
    <>
      {FRAMES.map((f) => (
        <Scene key={f.className} frame={f} />
      ))}
    </>
  );
}
