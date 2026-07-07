import type { HomePose } from '../insights'

/** Chutku himself — a hand-drawn orange tabby in pure SVG + CSS (zero deps),
 * replacing the pixel mascot on the mood card (owner request 2026-07-06).
 * Always gently alive (blink + tail sway) with a real expression per mood:
 *  - happy:  squinted ^‿^ eyes, open smile + tongue, fast happy tail
 *  - grumpy: airplane ears, heavy brows over half-lidded eyes, a frown,
 *            slow irritated tail flicks
 *  - alert:  wide eyes with pupils darting side to side (the food schemer)
 *  - awake:  round green eyes, soft "w" mouth, lazy tail
 * All motion is CSS keyframes gated behind prefers-reduced-motion
 * (styles.css) — reduced motion gets a friendly static Chutku.
 * Colors ride the theme vars, so his fur IS the app accent. */
export default function ChutkuCat({
  pose = 'awake',
  size = 88,
}: {
  pose?: HomePose
  size?: number
}) {
  const fur = 'var(--accent)'
  const stripe = 'color-mix(in srgb, var(--accent) 55%, #5b2c07)'
  const cream = '#ffefd9'
  const iris = 'var(--ok)'
  const dark = '#2b1608'
  const nose = '#f98a9b'

  const grumpy = pose === 'grumpy'
  const happy = pose === 'happy'
  const alert = pose === 'alert'

  return (
    <svg
      className={`cc pose-${pose}`}
      width={size}
      height={(size * 110) / 120}
      viewBox="0 0 120 110"
      role="img"
      aria-label={`Chutku looking ${pose}`}
    >
      {/* tail (behind the body) */}
      <g className="cc-tail">
        <path
          d="M86 90 Q 112 84 107 58"
          fill="none"
          stroke={fur}
          strokeWidth="10"
          strokeLinecap="round"
        />
        <path
          d="M104.2 70 q 5 1.5 6.4 -0.8 M101 78.5 q 5 1.5 6.8 -0.6"
          fill="none"
          stroke={stripe}
          strokeWidth="3"
          strokeLinecap="round"
        />
      </g>

      {/* body */}
      <ellipse cx="60" cy="86" rx="30" ry="19" fill={fur} />
      <path
        d="M33 80 q 6 -2 9 2 M87 80 q -6 -2 -9 2"
        fill="none"
        stroke={stripe}
        strokeWidth="3.4"
        strokeLinecap="round"
      />
      <ellipse cx="60" cy="92" rx="15" ry="10.5" fill={cream} />

      {/* head */}
      <g className="cc-head">
        {/* ears — grumpy flattens them sideways ("airplane ears") */}
        <g transform={grumpy ? 'rotate(-38 40 28)' : undefined}>
          <path d="M33 32 L38 7 L55 21 Z" fill={fur} />
          <path d="M38 26 L40.5 13.5 L49 20.5 Z" fill={nose} opacity="0.75" />
        </g>
        <g transform={grumpy ? 'rotate(38 80 28)' : undefined}>
          <path d="M87 32 L82 7 L65 21 Z" fill={fur} />
          <path d="M82 26 L79.5 13.5 L71 20.5 Z" fill={nose} opacity="0.75" />
        </g>

        <circle cx="60" cy="40" r="26" fill={fur} />
        {/* tabby forehead stripes */}
        <g fill={stripe}>
          <rect x="52" y="15" width="3.4" height="9.5" rx="1.7" />
          <rect x="58.3" y="13.5" width="3.4" height="11" rx="1.7" />
          <rect x="64.6" y="15" width="3.4" height="9.5" rx="1.7" />
        </g>
        {/* cheek stripes */}
        <path
          d="M35.5 39 q 5 -1 7.5 1.5 M84.5 39 q -5 -1 -7.5 1.5"
          fill="none"
          stroke={stripe}
          strokeWidth="2.6"
          strokeLinecap="round"
        />

        {/* eyes */}
        {happy ? (
          <g
            fill="none"
            stroke={dark}
            strokeWidth="2.6"
            strokeLinecap="round"
          >
            <path d="M42.5 38.5 q 5.5 -6.5 11 0" />
            <path d="M66.5 38.5 q 5.5 -6.5 11 0" />
          </g>
        ) : (
          <g className="cc-blink">
            <ellipse cx="48" cy="38" rx={alert ? 5.6 : 4.8} ry={alert ? 6.4 : 5.4} fill={iris} />
            <ellipse cx="72" cy="38" rx={alert ? 5.6 : 4.8} ry={alert ? 6.4 : 5.4} fill={iris} />
            <g className="cc-pupils" fill={dark}>
              <ellipse cx="48" cy="38.6" rx="2.2" ry={alert ? 3.8 : 3.1} />
              <ellipse cx="72" cy="38.6" rx="2.2" ry={alert ? 3.8 : 3.1} />
            </g>
            <g fill="#fff" opacity="0.9">
              <circle cx="49.6" cy="36.2" r="1.15" />
              <circle cx="73.6" cy="36.2" r="1.15" />
            </g>
            {grumpy && (
              <>
                {/* heavy lids over the top of the eyes */}
                <rect x="41" y="30.5" width="14" height="6.4" rx="2.4" fill={fur} />
                <rect x="65" y="30.5" width="14" height="6.4" rx="2.4" fill={fur} />
                {/* knitted brows */}
                <path
                  d="M42 32.5 l 11 2.6 M78 32.5 l -11 2.6"
                  stroke={dark}
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  fill="none"
                />
              </>
            )}
          </g>
        )}

        {/* muzzle + nose + mouth */}
        <ellipse cx="60" cy="51" rx="11.5" ry="8" fill={cream} />
        <path d="M56.6 47.2 h6.8 a1.4 1.4 0 0 1 1.05 2.3 l-3.4 3.6 a1.4 1.4 0 0 1 -2.1 0 l-3.4 -3.6 a1.4 1.4 0 0 1 1.05 -2.3 Z" fill={nose} />
        {happy ? (
          <>
            <path
              d="M51.5 53.5 q 8.5 9 17 0"
              fill="none"
              stroke={dark}
              strokeWidth="2.4"
              strokeLinecap="round"
            />
            <path d="M56.5 56.5 q 3.5 4.5 7 0 q -1 4.4 -3.5 4.4 t -3.5 -4.4 Z" fill={nose} />
          </>
        ) : grumpy ? (
          <path
            d="M54.5 57.5 q 5.5 -3.6 11 0"
            fill="none"
            stroke={dark}
            strokeWidth="2.2"
            strokeLinecap="round"
          />
        ) : (
          <path
            d="M60 53.5 q -2.8 3.4 -6.2 1.4 M60 53.5 q 2.8 3.4 6.2 1.4"
            fill="none"
            stroke={dark}
            strokeWidth="2"
            strokeLinecap="round"
          />
        )}

        {/* whiskers */}
        <g stroke={cream} strokeWidth="1.6" strokeLinecap="round" opacity="0.8">
          <path d="M40 48 L22 45" />
          <path d="M40.5 52 L23.5 53.5" />
          <path d="M80 48 L98 45" />
          <path d="M79.5 52 L96.5 53.5" />
        </g>
      </g>
    </svg>
  )
}
