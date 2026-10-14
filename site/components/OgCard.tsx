import { ImageResponse } from 'next/og';

/**
 * The shared 1200x630 social card. `opengraph-image.tsx` and
 * `twitter-image.tsx` were byte-identical copies of this markup; the two route
 * files now hold only the metadata exports Next.js reads by convention
 * (`runtime`, `alt`, `size`, `contentType`, default) and delegate the drawing
 * here, so the card can never drift between the two surfaces.
 *
 * It follows the site's night-circuit look: near-black, one amber accent, and
 * a light trail drawn with plain gradients (no images, no fonts to fetch).
 */
export const OG_CARD_ALT = 'Turbine ORM, the TypeScript ORM for Postgres: raw SQL speed, zero raw SQL';
export const OG_CARD_SIZE = { width: 1200, height: 630 };
export const OG_CARD_CONTENT_TYPE = 'image/png';

const BG = '#05070b';
const ACCENT = '#ffb01f';
const TEXT = '#f2f4f8';
const MUTED = '#8a93a6';

export function renderOgCard() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          padding: '0 88px',
          background: BG,
          fontFamily: 'system-ui, sans-serif',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {/* Warm haze low on the right, where the trail runs */}
        <div
          style={{
            position: 'absolute',
            right: -160,
            bottom: -220,
            width: 900,
            height: 520,
            borderRadius: '50%',
            background: 'radial-gradient(ellipse, rgba(255,140,30,0.16) 0%, transparent 70%)',
          }}
        />

        {/* The light trail: a soft glow under a bright core, fading to the left */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 58,
            height: 26,
            background: 'linear-gradient(90deg, transparent 0%, rgba(255,106,0,0) 30%, rgba(255,140,30,0.22) 78%, rgba(255,190,90,0.4) 100%)',
            borderRadius: 13,
          }}
        />
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 70,
            height: 3,
            background: 'linear-gradient(90deg, transparent 0%, rgba(255,106,0,0.2) 35%, #ffb01f 80%, #fff4dc 100%)',
          }}
        />

        {/* Brand */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 18, marginBottom: 44 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 60,
              height: 60,
              borderRadius: 12,
              background: 'rgba(255,176,31,0.12)',
              border: '1px solid rgba(255,176,31,0.35)',
            }}
          >
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none">
              <path d="M13 3L4 14h7l-1 7 9-11h-7l1-7z" fill={ACCENT} />
            </svg>
          </div>
          <span style={{ fontSize: 34, fontWeight: 800, color: TEXT, letterSpacing: '0.12em' }}>TURBINE</span>
        </div>

        {/* Headline */}
        <div style={{ display: 'flex', flexDirection: 'column', marginBottom: 28 }}>
          <span style={{ fontSize: 96, fontWeight: 800, color: TEXT, lineHeight: 1, letterSpacing: '-0.02em' }}>
            Raw SQL speed.
          </span>
          <span style={{ fontSize: 96, fontWeight: 800, color: ACCENT, lineHeight: 1.05, letterSpacing: '-0.02em' }}>
            Zero raw SQL.
          </span>
        </div>

        {/* Subline */}
        <p style={{ fontSize: 30, color: MUTED, margin: 0, fontWeight: 400 }}>
          The TypeScript ORM for Postgres. Within 8% of hand-written SQL.
        </p>
      </div>
    ),
    { ...OG_CARD_SIZE },
  );
}
