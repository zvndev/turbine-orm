import { BENCH, CONTROL_COLOR, LIBRARIES, measuredOn, ms, overheadPercent, ratio, type Scenario } from '../../lib/bench';
import { Marker } from './Marker';

const lib = (key: string) => LIBRARIES.find((l) => l.key === key);

/** Margins on queries under 0.15 ms are inside the noise, so the highlights never quote one. */
const QUOTABLE_MS = 0.15;

/** The page's opening claim, written from the same figures as the tower below it. */
export function BenchLede() {
  const g = BENCH.geomean.overheadVsControl;
  return (
    <p className="bench-lede">
      Turbine adds {overheadPercent(g.turbine).slice(1)} to the time of hand-written SQL. Drizzle adds{' '}
      {overheadPercent(g.drizzle).slice(1)} and Prisma adds {overheadPercent(g.prisma).slice(1)}.
    </p>
  );
}

export function MeasuredOn() {
  return <span className="bench-stamp">Measured on {measuredOn()}</span>;
}

/** The widest margins in the run, picked from the data rather than written by hand. */
export function BenchHighlights() {
  const all = [...BENCH.core, ...BENCH.extended].filter((s) => s.turbine >= QUOTABLE_MS && !s.tie);
  const widest = (list: Scenario[], key: 'drizzle' | 'prisma') =>
    list.reduce((a, b) => (b[key] / b.turbine > a[key] / a.turbine ? b : a));
  const lower = (s: Scenario) => s.label.replace(/^\w/, (c) => c.toLowerCase());
  const vsPrisma = widest(all, 'prisma');
  const vsDrizzle = widest(all, 'drizzle');
  // Nested relations are what Turbine is built around, so the widest nested margin gets its own line.
  const nested = widest(
    all.filter((s) => /\+/.test(s.label) && s.id !== vsDrizzle.id),
    'drizzle',
  );
  const last = BENCH.latency.rtt.length - 1;
  const net = BENCH.latency.drizzleTransaction[last] / BENCH.latency.turbinePipeline[last];
  return (
    <ul className="bench-highlights">
      {vsPrisma.id === vsDrizzle.id ? (
        <li>
          <strong>{ratio(vsPrisma.prisma / vsPrisma.turbine)}</strong> faster than Prisma and{' '}
          <strong>{ratio(vsDrizzle.drizzle / vsDrizzle.turbine)}</strong> faster than Drizzle on {lower(vsPrisma)}
        </li>
      ) : (
        <>
          <li>
            <strong>{ratio(vsPrisma.prisma / vsPrisma.turbine)}</strong> faster than Prisma on {lower(vsPrisma)}
          </li>
          <li>
            <strong>{ratio(vsDrizzle.drizzle / vsDrizzle.turbine)}</strong> faster than Drizzle on {lower(vsDrizzle)}
          </li>
        </>
      )}
      <li>
        <strong>{ratio(nested.drizzle / nested.turbine)}</strong> faster than Drizzle on {lower(nested)}, in one round
        trip
      </li>
      <li>
        <strong>{ratio(net)}</strong> faster on a five-query dashboard {BENCH.latency.rtt[last]} ms from the database
      </li>
    </ul>
  );
}

export function StreamBars() {
  const max = Math.max(...BENCH.streaming.map((s) => s.median));
  return (
    <figure className="bench-stream">
      {BENCH.streaming.map((s) => {
        const l = lib(s.library);
        const color = l?.color ?? CONTROL_COLOR;
        return (
          <div key={s.arm} className="bench-stream-row">
            <span className="bench-stream-name">
              {l ? <Marker shape={l.shape} color={color} /> : <i className="bench-control-tick" aria-hidden="true" />}
              {s.arm}
            </span>
            <span className="bench-stream-track" aria-hidden="true">
              <span style={{ width: `${(s.median / max) * 100}%`, background: color }} />
            </span>
            <span className="bench-stream-value">{ms(s.median)} ms</span>
          </div>
        );
      })}
      <figcaption className="bench-note">Draining 50,000 rows in batches of 1,000. Shorter is faster.</figcaption>
    </figure>
  );
}

export function NetworkTable() {
  if (!BENCH.network) return null;
  return (
    <table>
      <thead>
        <tr>
          <th>Scenario</th>
          <th>Faster</th>
          <th>Slower</th>
          <th>Gap</th>
        </tr>
      </thead>
      <tbody>
        {BENCH.network.rows.map((r) => (
          <tr key={`${r.scenario}-${r.fasterArm}`}>
            <td>{r.scenario}</td>
            <td>
              <code>{r.fasterArm}</code> {ms(r.faster)}
            </td>
            <td>
              <code>{r.slowerArm}</code> {ms(r.slower)}
            </td>
            <td>{ratio(r.ratio)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
