/**
 * SmartCity AI brand mark.
 *
 * A product mark, not a state emblem. It borrows the UAE flag's four colours
 * as a vertical bar — the way the flag reads — beside a city/network glyph,
 * which roots the product in its market without implying that this platform
 * is an official government service. The UAE coat of arms and any ministry or
 * authority logo are deliberately not used.
 */
export default function BrandMark({
  size = 40,
  showWordmark = true,
  subtitle,
}: {
  size?: number;
  showWordmark?: boolean;
  subtitle?: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <svg
        width={size}
        height={size}
        viewBox="0 0 48 48"
        fill="none"
        role="img"
        aria-label="SmartCity AI"
        className="shrink-0"
      >
        {/* Flag bar: red hoist with green/white/black fly, as on the UAE flag */}
        <rect x="2" y="6" width="7" height="36" rx="1.5" fill="#CE1126" />
        <rect x="10.5" y="6" width="7" height="12" rx="1.5" fill="#00732F" />
        <rect x="10.5" y="18" width="7" height="12" rx="1.5" fill="#EDEEE7" />
        <rect x="10.5" y="30" width="7" height="12" rx="1.5" fill="#0B0B0B" />

        {/* City / network glyph — nodes and links, the thing the platform models */}
        <g stroke="#8FD9E8" strokeWidth="1.6" strokeLinecap="round">
          <path d="M23 38V22l6-5 6 5v16" />
          <path d="M29 38v-7" />
          <path d="M23 30h12" />
        </g>
        <g fill="#F2A65A">
          <circle cx="29" cy="17" r="2.2" />
          <circle cx="23" cy="30" r="1.8" />
          <circle cx="35" cy="30" r="1.8" />
        </g>
        <circle cx="29" cy="17" r="5" stroke="#F2A65A" strokeWidth="0.8" opacity="0.45" fill="none" />
      </svg>

      {showWordmark && (
        <div className="leading-tight">
          <div className="font-display text-lg tracking-tight text-paper">SmartCity AI</div>
          <div className="font-mono text-[10px] text-blueprint-line/70 uppercase tracking-wider">
            {subtitle ?? "United Arab Emirates"}
          </div>
        </div>
      )}
    </div>
  );
}
