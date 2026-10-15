'use client';

import { useState } from 'react';
import { BENCH, CONTROL_NAME, groupScenarios, LIBRARIES, ms, ratio, type Scenario } from '../../lib/bench';
import { Marker } from './Marker';

const ALL = [...BENCH.core, ...BENCH.extended];

/**
 * Every scenario on one axis: each library's time divided by Turbine's, on a
 * log scale so "twice as slow" is the same distance at every size. Hover or
 * focus a row for the milliseconds; the table view carries every figure.
 */
export function ScenarioChart() {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const groups = groupScenarios(ALL);

  const rel = (s: Scenario, v: number) => v / s.turbine;
  const highest = Math.max(...ALL.flatMap((s) => [rel(s, s.drizzle), rel(s, s.prisma)]));
  const lowest = Math.min(...ALL.flatMap((s) => [rel(s, s.drizzle), rel(s, s.prisma), s.control ? rel(s, s.control) : 1]));
  const minExp = Math.floor(Math.log2(Math.min(lowest, 1)));
  const maxExp = Math.ceil(Math.log2(highest));
  const ticks = Array.from({ length: maxExp - minExp + 1 }, (_, i) => 2 ** (minExp + i));
  // Rounded so the server and the browser print the same style string.
  const x = (v: number) => Math.round(((Math.log2(v) - minExp) / (maxExp - minExp)) * 100000) / 1000;

  return (
    <figure className="bench-scen">
      <div className="bench-toolbar">
        <div className="bench-legend" aria-label="Legend">
          {LIBRARIES.map((l) => (
            <span key={l.key}>
              <Marker shape={l.shape} color={l.color} />
              {l.name}
            </span>
          ))}
          <span>
            <i className="bench-control-tick" aria-hidden="true" />
            {CONTROL_NAME}
          </span>
        </div>
        <div className="bench-toggle" role="group" aria-label="View">
          <button type="button" aria-pressed={view === 'chart'} onClick={() => setView('chart')}>
            Chart
          </button>
          <button type="button" aria-pressed={view === 'table'} onClick={() => setView('table')}>
            Table
          </button>
        </div>
      </div>

      {view === 'chart' ? (
        <div className="bench-scen-plot">
          <div className="bench-scen-axis" aria-hidden="true">
            <span className="bench-scen-axis-label">Time, as a multiple of Turbine&apos;s</span>
            <span className="bench-scen-axis-track">
              {ticks.map((t) => (
                <span key={t} className={`bench-scen-tick${t === 1 ? ' is-one' : ''}`} style={{ left: `${x(t)}%` }}>
                  {t}x
                </span>
              ))}
            </span>
          </div>
          {groups.map((g) => (
            <div key={g.name} className="bench-scen-group">
              <div className="bench-scen-group-name">{g.name}</div>
              {g.rows.map((s) => {
                const tip = `${s.label}. Turbine ${ms(s.turbine)} ms, Drizzle ${ms(s.drizzle)} ms, Prisma ${ms(s.prisma)} ms${
                  s.control ? `, ${CONTROL_NAME} ${ms(s.control)} ms` : ''
                }.`;
                return (
                  // biome-ignore lint/a11y/noNoninteractiveTabindex: a focusable row is how keyboard users reach the tooltip
                  <div key={s.id} className="bench-scen-row" tabIndex={0} aria-label={tip}>
                    <span className="bench-scen-label">
                      {s.label}
                      {s.tie && <span className="bench-tie">tie</span>}
                    </span>
                    <span className="bench-scen-track" aria-hidden="true">
                      {ticks.map((t) => (
                        <span key={t} className={`bench-scen-grid${t === 1 ? ' is-one' : ''}`} style={{ left: `${x(t)}%` }} />
                      ))}
                      {s.control !== null && <span className="bench-scen-control" style={{ left: `${x(rel(s, s.control))}%` }} />}
                      {[...LIBRARIES].reverse().map((l) => (
                        <span key={l.key} className="bench-scen-dot" style={{ left: `${x(rel(s, s[l.key]))}%` }}>
                          <Marker shape={l.shape} color={l.color} />
                        </span>
                      ))}
                    </span>
                    <span className="bench-tip" role="presentation">
                      <strong>{s.label}</strong>
                      {LIBRARIES.map((l) => (
                        <span key={l.key}>
                          <Marker shape={l.shape} color={l.color} size={8} />
                          {l.name}
                          <em>{ms(s[l.key])} ms</em>
                          <b>{l.key === 'turbine' ? '' : ratio(rel(s, s[l.key]))}</b>
                        </span>
                      ))}
                      {s.control !== null && (
                        <span>
                          <i className="bench-control-tick" />
                          {CONTROL_NAME}
                          <em>{ms(s.control)} ms</em>
                          <b />
                        </span>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      ) : (
        <div className="bench-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Scenario</th>
                {LIBRARIES.map((l) => (
                  <th key={l.key}>{l.name}</th>
                ))}
                <th>{CONTROL_NAME}</th>
              </tr>
            </thead>
            <tbody>
              {groups.flatMap((g) =>
                g.rows.map((s) => {
                  const best = Math.min(s.turbine, s.drizzle, s.prisma);
                  return (
                    <tr key={s.id}>
                      <td>
                        {s.label}
                        {s.tie && <span className="bench-tie">tie</span>}
                      </td>
                      {LIBRARIES.map((l) => (
                        <td key={l.key} className={s[l.key] === best ? 'is-best' : undefined}>
                          {ms(s[l.key])}
                        </td>
                      ))}
                      <td>{s.control === null ? 'n/a' : ms(s.control)}</td>
                    </tr>
                  );
                }),
              )}
            </tbody>
          </table>
        </div>
      )}
      <figcaption className="bench-note">
        Medians in milliseconds. Further right is slower, on a log scale. A <span className="bench-tie">tie</span> is too
        close to call between Turbine and Drizzle across runs.
      </figcaption>
    </figure>
  );
}
