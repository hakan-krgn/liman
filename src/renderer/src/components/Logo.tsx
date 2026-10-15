/** The app mark: a prompt chevron resting on harbour water (see build/icon.svg). */
export function Logo({ size = 22 }: { size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="logo">
      <defs>
        <linearGradient id="liman-logo-bg" x1="0.15" y1="0" x2="0.85" y2="1">
          <stop offset="0" stopColor="#7C86FF" />
          <stop offset="0.55" stopColor="#5B5FEF" />
          <stop offset="1" stopColor="#3D3BC4" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="8" fill="url(#liman-logo-bg)" />
      <g fill="none" stroke="#fff" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 10.4 L13.8 15.1 L8 19.9" strokeWidth="2.7" />
        <path d="M15.3 19.9 c1.45 -1.25 2.9 -1.25 4.35 0 s2.9 1.25 4.35 0" strokeWidth="2.3" opacity="0.92" />
      </g>
    </svg>
  )
}
