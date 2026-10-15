import { BENCH, CONTROL_NAME, LIBRARIES, overheadPercent, ratio } from '../../lib/bench';
import { Marker } from './Marker';

/**
 * The page's lead chart: each library's time per query as a multiple of the
 * same query written by hand, laid out like a race timing tower. The grey part
 * of every bar is the SQL itself, which every library has to run; the coloured
 * part is what the library adds on top.
 */
export function GapTower() {
  const g = BENCH.geomean.overheadVsControl;
  const rows = [...LIBRARIES].sort((a, b) => g[a.key] - g[b.key]);
  const max = Math.max(...rows.map((r) => g[r.key])) * 1.04;

  return (
    <figure className="bench-tower">
      <div className="bench-tower-rows" role="table" aria-label="Time per query as a multiple of hand-written SQL">
        <div className="bench-tower-row is-control" role="row">
          <span className="bench-tower-pos" role="cell" aria-hidden="true" />
          <span className="bench-tower-name" role="rowheader">
            {CONTROL_NAME}
          </span>
          <span className="bench-tower-track" role="cell" aria-hidden="true">
            <span className="bench-tower-sql" style={{ width: `${(1 / max) * 100}%` }} />
          </span>
          <span className="bench-tower-ratio" role="cell">
            1.00x
          </span>
          <span className="bench-tower-gap" role="cell">
            baseline
          </span>
        </div>
        {rows.map((lib, i) => {
          const r = g[lib.key];
          return (
            <div
              key={lib.key}
              className={`bench-tower-row${lib.key === 'turbine' ? ' is-lead' : ''}`}
              role="row"
              style={{ '--c': lib.color, '--i': i } as React.CSSProperties}
            >
              <span className="bench-tower-pos" role="cell">
                {i + 1}
              </span>
              <span className="bench-tower-name" role="rowheader">
                <Marker shape={lib.shape} color={lib.color} />
                {lib.name}
              </span>
              <span className="bench-tower-track" role="cell" aria-hidden="true">
                <span className="bench-tower-sql" style={{ width: `${(1 / max) * 100}%` }} />
                <span className="bench-tower-over" style={{ width: `${((r - 1) / max) * 100}%` }} />
              </span>
              <span className="bench-tower-ratio" role="cell">
                {ratio(r)}
              </span>
              <span className="bench-tower-gap" role="cell">
                {overheadPercent(r)}
              </span>
            </div>
          );
        })}
      </div>
      <figcaption className="bench-key">
        <span>
          <i className="bench-key-sql" /> the SQL itself, the same for everyone
        </span>
        <span>
          <i className="bench-key-over" /> what the library adds
        </span>
        <span className="bench-key-note">Geometric mean of {g.scenarios} scenarios with a hand-written control.</span>
      </figcaption>
    </figure>
  );
}
