import { ImageResponse } from 'next/og';

export const runtime = 'edge';

export const alt = 'Turbine ORM - Postgres-native TypeScript ORM';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OGImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#09090B',
          fontFamily: 'system-ui, sans-serif',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {/* Subtle radial glow behind the logo */}
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -55%)',
            width: 600,
            height: 400,
            borderRadius: '50%',
            background: 'radial-gradient(ellipse, rgba(245,158,11,0.10) 0%, transparent 70%)',
          }}
        />

        {/* Lightning bolt icon */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 72,
            height: 72,
            borderRadius: 18,
            background: 'rgba(245,158,11,0.12)',
            border: '1px solid rgba(245,158,11,0.25)',
            marginBottom: 32,
          }}
        >
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none">
            <path d="M13 3L4 14h7l-1 7 9-11h-7l1-7z" fill="#F59E0B" />
          </svg>
        </div>

        {/* Title */}
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 16,
            marginBottom: 20,
          }}
        >
          <span
            style={{
              fontSize: 72,
              fontWeight: 800,
              color: '#EDEDEF',
              letterSpacing: '-0.03em',
            }}
          >
            Turbine
          </span>
          <span
            style={{
              fontSize: 72,
              fontWeight: 800,
              color: '#F59E0B',
              letterSpacing: '-0.03em',
            }}
          >
            ORM
          </span>
        </div>

        {/* Tagline */}
        <p
          style={{
            fontSize: 28,
            color: '#A1A1AA',
            margin: 0,
            fontWeight: 400,
            letterSpacing: '-0.01em',
          }}
        >
          Postgres-native TypeScript ORM for the Edge
        </p>

        {/* Bottom accent bar */}
        <div
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            height: 4,
            background: 'linear-gradient(90deg, transparent, #F59E0B, transparent)',
          }}
        />
      </div>
    ),
    { ...size },
  );
}
