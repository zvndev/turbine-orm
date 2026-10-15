/** A series marker. Each library has its own shape, so identity never rests on colour alone. */
export function Marker({ shape, color, size = 10 }: { shape: 'circle' | 'square' | 'diamond'; color: string; size?: number }) {
  const h = size / 2;
  return (
    <svg className="bench-marker" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      {shape === 'circle' && <circle cx={h} cy={h} r={h - 0.5} fill={color} />}
      {shape === 'square' && <rect x="0.75" y="0.75" width={size - 1.5} height={size - 1.5} rx="1.5" fill={color} />}
      {shape === 'diamond' && <path d={`M${h} 0.3L${size - 0.3} ${h}L${h} ${size - 0.3}L0.3 ${h}Z`} fill={color} />}
    </svg>
  );
}
