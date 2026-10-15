'use client';

import { useState } from 'react';
import { BENCH, LIBRARIES, ms } from '../../lib/bench';
import { Marker } from './Marker';

const W = 720;
const H = 300;
const PAD = { top: 20, right: 150, bottom: 40, left: 48 };

/**
 * A five-query dashboard as round-trip time grows: Turbine's pipeline sends
 * the batch in one round trip, while a transaction in Drizzle or Prisma pays
 * for about seven. Hover a column for the three values at that distance.
 */
export function LatencyChart() {
  const { rtt, turbinePipeline, drizzleTransaction, prismaTransaction } = BENCH.latency;
  const series = [
    { lib: LIBRARIES[0], label: 'Turbine pipeline()', values: turbinePipeline },
    { lib: LIBRARIES[1], label: 'Drizzle transaction', values: drizzleTransaction },
    { lib: LIBRARIES[2], label: 'Prisma $transaction', values: prismaTransaction, dash: '5 5' },
  ];
  const [active, setActive] = useState<number | null>(null);

  const top = Math.ceil(Math.max(...series.flatMap((s) => s.values)) / 50) * 50;
  const yTicks = Array.from({ length: top / 50 + 1 }, (_, i) => i * 50);
  const iw = W - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  const px = (i: number) => PAD.left + (i / (rtt.length - 1)) * iw;
  const py = (v: number) => PAD.top + ih - (v / top) * ih;

  // Drizzle and Prisma finish together, so Prisma is dashed and Drizzle shows through its gaps.
  // Direct labels sit at the line ends; nudge apart the two that finish together.
  const ends = series.map((s) => py(s.values[s.values.length - 1]));
  const labelY = [...ends];
  if (Math.abs(labelY[1] - labelY[2]) < 26) {
    const mid = (labelY[1] + labelY[2]) / 2;
    labelY[1] = mid - 13;
    labelY[2] = mid + 13;
  }
  const last = rtt.length - 1;
  const fold = Math.round(drizzleTransaction[last] / turbinePipeline[last]);

  return (
    <figure className="bench-latency">
      <div className="bench-legend" aria-label="Legend">
        {series.map((s) => (
          <span key={s.label}>
            <Marker shape={s.lib.shape} color={s.lib.color} />
            {s.label}
          </span>
        ))}
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Five-query dashboard time by added round-trip time. At ${rtt[last]} ms Turbine takes ${ms(
          turbinePipeline[last],
        )} ms, Drizzle ${ms(drizzleTransaction[last])} ms and Prisma ${ms(prismaTransaction[last])} ms.`}
        onMouseLeave={() => setActive(null)}
      >
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={py(t)} y2={py(t)} className="bench-grid" />
            <text x={PAD.left - 10} y={py(t) + 4} textAnchor="end" className="bench-axis-text">
              {t}
            </text>
          </g>
        ))}
        <text x={PAD.left - 10} y={PAD.top - 8} textAnchor="end" className="bench-axis-text is-unit">
          ms
        </text>
        {rtt.map((r, i) => (
          <text key={r} x={px(i)} y={H - PAD.bottom + 22} textAnchor="middle" className="bench-axis-text">
            {r} ms
          </text>
        ))}
        <text x={PAD.left + iw / 2} y={H - 4} textAnchor="middle" className="bench-axis-text is-title">
          Round-trip time added between app and database
        </text>
        {active !== null && <line x1={px(active)} x2={px(active)} y1={PAD.top} y2={PAD.top + ih} className="bench-crosshair" />}
        {series.map((s, si) => (
          <g key={s.label}>
            <polyline
              points={s.values.map((v, i) => `${px(i)},${py(v)}`).join(' ')}
              fill="none"
              stroke={s.lib.color}
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
              strokeDasharray={'dash' in s ? s.dash : undefined}
            />
            {s.values.map((v, i) => (
              <circle key={rtt[i]} cx={px(i)} cy={py(v)} r={active === i ? 5 : 4} fill={s.lib.color} className="bench-point" />
            ))}
            <text x={px(last) + 12} y={labelY[si] + 4} className="bench-end-label">
              {s.lib.name} {ms(s.values[last])}
            </text>
          </g>
        ))}
        {rtt.map((r, i) => (
          <rect
            key={r}
            x={px(i) - iw / (rtt.length - 1) / 2}
            y={PAD.top}
            width={iw / (rtt.length - 1)}
            height={ih}
            fill="transparent"
            onMouseEnter={() => setActive(i)}
          />
        ))}
      </svg>
      {active !== null && (
        <div className="bench-latency-tip" style={{ left: `${(px(active) / W) * 100}%` }}>
          <strong>+{rtt[active]} ms round trip</strong>
          {series.map((s) => (
            <span key={s.label}>
              <Marker shape={s.lib.shape} color={s.lib.color} size={8} />
              {s.lib.name}
              <em>{ms(s.values[active])} ms</em>
            </span>
          ))}
        </div>
      )}
      <figcaption className="bench-note">
        At {rtt[last]} ms, the transaction takes about {fold} times as long. A local proxy adds the round-trip time, so
        every arm meets the same distance.
      </figcaption>
    </figure>
  );
}
