/**
 * Brand-decorative SVG icon library — used wherever the cpanel previously
 * used emojis (📣, 🌐, 🎬, 🎯, ❤️, …). Each icon is filled-color, 24×24
 * viewBox, designed to look at home both at 16px (chips) and 48px (large
 * decorative anchors).
 *
 * Different file from Icons.tsx (which is line-art for navigation).
 */

interface IconProps {
  size?: number;
  className?: string;
  color?: string;
  background?: string;
}

function wrap({ size = 24, className, children }: { size?: number; className?: string; children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      aria-hidden
      xmlns="http://www.w3.org/2000/svg"
    >
      {children}
    </svg>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Product / item icons (used by ProductCounter in PersonalCatalog)
─────────────────────────────────────────────────────────────────────── */

/** Megaphone — Facebook ad */
export function IcoAd({ size, className }: IconProps) {
  return wrap({ size, className, children: (
    <>
      <defs>
        <linearGradient id="ad-gr" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%"   stopColor="#1E3A8A" />
          <stop offset="100%" stopColor="#2563EB" />
        </linearGradient>
      </defs>
      <path d="M3 11l13-5v12L3 13v-2z"  fill="url(#ad-gr)" />
      <path d="M16 8.5v7l4 1.5V7l-4 1.5z" fill="#1E3A8A" />
      <rect x="4.5" y="13" width="3" height="6" rx="1" fill="#2563EB" />
      <circle cx="20" cy="12" r="1" fill="#06B6D4" />
    </>
  )});
}

/** Globe — landing page */
export function IcoLandingPage({ size, className }: IconProps) {
  return wrap({ size, className, children: (
    <>
      <defs>
        <linearGradient id="lp-gr" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%"   stopColor="#0EA5E9" />
          <stop offset="100%" stopColor="#0369A1" />
        </linearGradient>
      </defs>
      <circle cx="12" cy="12" r="9" fill="url(#lp-gr)" />
      <path d="M3.5 12h17M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" stroke="#fff" strokeWidth="1.2" fill="none" />
      <circle cx="12" cy="12" r="9" fill="none" stroke="#0C4A6E" strokeWidth="0.8" />
    </>
  )});
}

/** Play / video */
export function IcoVideo({ size, className }: IconProps) {
  return wrap({ size, className, children: (
    <>
      <defs>
        <linearGradient id="vid-gr" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%"   stopColor="#DC2626" />
          <stop offset="100%" stopColor="#991B1B" />
        </linearGradient>
      </defs>
      <rect x="2" y="5" width="20" height="14" rx="3" fill="url(#vid-gr)" />
      <path d="M10 9l5 3-5 3V9z" fill="#fff" />
    </>
  )});
}

/** Brush + frame — logo design */
export function IcoLogoDesign({ size, className }: IconProps) {
  return wrap({ size, className, children: (
    <>
      <defs>
        <linearGradient id="logo-gr" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%"   stopColor="#A78BFA" />
          <stop offset="100%" stopColor="#7C3AED" />
        </linearGradient>
      </defs>
      <path
        d="M4 4h12l4 4v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"
        fill="url(#logo-gr)"
      />
      <path d="M16 4v4h4" fill="none" stroke="#5B21B6" strokeWidth="1" />
      <circle cx="9" cy="13" r="2.5" fill="#FCD34D" />
      <circle cx="15" cy="14.5" r="2" fill="#06B6D4" opacity="0.85" />
      <circle cx="11.5" cy="17" r="1.5" fill="#EC4899" opacity="0.85" />
    </>
  )});
}

/** Sparkle / organic social */
export function IcoSocialOrganic({ size, className }: IconProps) {
  return wrap({ size, className, children: (
    <>
      <defs>
        <linearGradient id="org-gr" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="#F472B6" />
          <stop offset="100%" stopColor="#A855F7" />
        </linearGradient>
      </defs>
      <path
        d="M12 2 L13.5 9 L21 10.5 L13.5 12 L12 19 L10.5 12 L3 10.5 L10.5 9 Z"
        fill="url(#org-gr)"
      />
      <circle cx="18" cy="5" r="1.2" fill="#F472B6" />
      <circle cx="5"  cy="18" r="1"   fill="#A855F7" />
    </>
  )});
}

/** Globe with link/chain — domain product */
export function IcoDomain({ size, className }: IconProps) {
  return wrap({ size, className, children: (
    <>
      <defs>
        <linearGradient id="dom-gr" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%"   stopColor="#14B8A6" />
          <stop offset="100%" stopColor="#0F766E" />
        </linearGradient>
      </defs>
      <circle cx="12" cy="12" r="9" fill="url(#dom-gr)" />
      <path d="M3.5 12h17M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" stroke="#fff" strokeWidth="1.2" fill="none" />
      <path d="M9 14l3-3 3 3M12 11v6" stroke="#fff" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </>
  )});
}

/** Rocket — generic campaign / boost (used for traffic/lead campaign items) */
export function IcoCampaign({ size, className }: IconProps) {
  return wrap({ size, className, children: (
    <>
      <defs>
        <linearGradient id="cmp-gr" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="#60A5FA" />
          <stop offset="100%" stopColor="#1D4ED8" />
        </linearGradient>
      </defs>
      <path d="M14 3c4 0 7 3 7 7l-7 7-3-3 3-11z" fill="url(#cmp-gr)" />
      <circle cx="16" cy="8" r="1.6" fill="#fff" />
      <path d="M5 19l4-4M3 21l3-3M7 21l2-2" stroke="#F59E0B" strokeWidth="1.4" strokeLinecap="round" fill="none" />
      <path d="M14 17l-3-3-3 6 6-3z" fill="#FBBF24" />
    </>
  )});
}

/** Stars + Pro badge — social pro tier */
export function IcoSocialPro({ size, className }: IconProps) {
  return wrap({ size, className, children: (
    <>
      <defs>
        <linearGradient id="spro-gr" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%"   stopColor="#F472B6" />
          <stop offset="100%" stopColor="#7C3AED" />
        </linearGradient>
      </defs>
      <path d="M12 2 L13.5 9 L21 10.5 L13.5 12 L12 19 L10.5 12 L3 10.5 L10.5 9 Z" fill="url(#spro-gr)" />
      <circle cx="18" cy="18" r="4" fill="#FBBF24" stroke="#fff" strokeWidth="1" />
      <text x="18" y="20" textAnchor="middle" fontSize="4.5" fontWeight="800" fill="#78350F">PRO</text>
    </>
  )});
}

/** Generic package / cube — fallback for unknown product keys */
export function IcoProductGeneric({ size, className }: IconProps) {
  return wrap({ size, className, children: (
    <>
      <defs>
        <linearGradient id="gen-gr" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%"   stopColor="#94A3B8" />
          <stop offset="100%" stopColor="#475569" />
        </linearGradient>
      </defs>
      <path d="M12 3 L21 8 V16 L12 21 L3 16 V8 Z" fill="url(#gen-gr)" />
      <path d="M12 3 L21 8 L12 13 L3 8 Z" fill="#CBD5E1" />
      <path d="M12 13 L21 8 V16 L12 21 Z" fill="#334155" opacity="0.5" />
    </>
  )});
}

/* ─────────────────────────────────────────────────────────────────────
   Campaign objectives (used in CharacterizationTab → ServiceEditor)
─────────────────────────────────────────────────────────────────────── */

/** Bullseye — leads */
export function IcoLeads({ size, className }: IconProps) {
  return wrap({ size, className, children: (
    <>
      <circle cx="12" cy="12" r="10" fill="#DC2626" />
      <circle cx="12" cy="12" r="6.5" fill="#fff" />
      <circle cx="12" cy="12" r="3.5" fill="#DC2626" />
      <circle cx="12" cy="12" r="1.4" fill="#fff" />
    </>
  )});
}

/** Lightning bolt — conversions */
export function IcoConversions({ size, className }: IconProps) {
  return wrap({ size, className, children: (
    <>
      <defs>
        <linearGradient id="conv-gr" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="#FBBF24" />
          <stop offset="100%" stopColor="#D97706" />
        </linearGradient>
      </defs>
      <path d="M13 2 L4 13 L11 13 L11 22 L20 11 L13 11 Z" fill="url(#conv-gr)" stroke="#92400E" strokeWidth="0.8" strokeLinejoin="round" />
    </>
  )});
}

/** Chat bubble — messages */
export function IcoMessages({ size, className }: IconProps) {
  return wrap({ size, className, children: (
    <>
      <defs>
        <linearGradient id="msg-gr" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="#22D3EE" />
          <stop offset="100%" stopColor="#0891B2" />
        </linearGradient>
      </defs>
      <path d="M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4H5a2 2 0 0 1-2-2V5z" fill="url(#msg-gr)" />
      <circle cx="9"  cy="10" r="1" fill="#fff" />
      <circle cx="13" cy="10" r="1" fill="#fff" />
      <circle cx="17" cy="10" r="1" fill="#fff" />
    </>
  )});
}

/** Globe with arrows — traffic */
export function IcoTraffic({ size, className }: IconProps) {
  return wrap({ size, className, children: (
    <>
      <defs>
        <linearGradient id="trf-gr" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%"   stopColor="#10B981" />
          <stop offset="100%" stopColor="#047857" />
        </linearGradient>
      </defs>
      <circle cx="12" cy="12" r="8" fill="url(#trf-gr)" />
      <path d="M4 12h16" stroke="#fff" strokeWidth="1.4" />
      <path d="M12 4a12 12 0 0 1 0 16M12 4a12 12 0 0 0 0 16" stroke="#fff" strokeWidth="1.4" fill="none" />
      <path d="M18 7l3 1-1 3" fill="none" stroke="#FBBF24" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </>
  )});
}

/** Megaphone outline — reach (different from Ad) */
export function IcoReach({ size, className }: IconProps) {
  return wrap({ size, className, children: (
    <>
      <defs>
        <linearGradient id="rch-gr" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%"   stopColor="#F59E0B" />
          <stop offset="100%" stopColor="#B45309" />
        </linearGradient>
      </defs>
      <path d="M3 10v4l13 4V6L3 10z" fill="url(#rch-gr)" />
      <path d="M16 7v10l4 1.5V5.5L16 7z" fill="#92400E" />
      <path d="M5 14v4a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1v-3" fill="#F59E0B" />
      <path d="M19 12c1 0 2-1 2-2.5S20 7 19 7" stroke="#FCD34D" strokeWidth="1.4" fill="none" strokeLinecap="round" />
    </>
  )});
}

/** Eye — brand awareness */
export function IcoAwareness({ size, className }: IconProps) {
  return wrap({ size, className, children: (
    <>
      <defs>
        <linearGradient id="awa-gr" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="#A78BFA" />
          <stop offset="100%" stopColor="#7C3AED" />
        </linearGradient>
      </defs>
      <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" fill="url(#awa-gr)" />
      <circle cx="12" cy="12" r="3.5" fill="#fff" />
      <circle cx="12" cy="12" r="2"   fill="#1E1B4B" />
    </>
  )});
}

/** Heart — engagement */
export function IcoEngagement({ size, className }: IconProps) {
  return wrap({ size, className, children: (
    <>
      <defs>
        <linearGradient id="eng-gr" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="#FB7185" />
          <stop offset="100%" stopColor="#E11D48" />
        </linearGradient>
      </defs>
      <path d="M12 21s-7-4.5-9-9a5 5 0 0 1 9-3 5 5 0 0 1 9 3c-2 4.5-9 9-9 9z" fill="url(#eng-gr)" />
    </>
  )});
}

/* ─────────────────────────────────────────────────────────────────────
   Decorative icons (large, used as anchor/empty-state visuals)
─────────────────────────────────────────────────────────────────────── */

/** Camera (large, decorative) — photo upload empty state */
export function IcoCamera({ size, className }: IconProps) {
  return wrap({ size, className, children: (
    <>
      <defs>
        <linearGradient id="cam-gr" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="#60A5FA" />
          <stop offset="100%" stopColor="#1D4ED8" />
        </linearGradient>
      </defs>
      <rect x="2" y="6" width="20" height="14" rx="3" fill="url(#cam-gr)" />
      <rect x="7" y="3" width="6" height="4" rx="1" fill="#1E3A8A" />
      <circle cx="12" cy="13" r="4.5" fill="#0F172A" />
      <circle cx="12" cy="13" r="3"   fill="#3B82F6" />
      <circle cx="13.2" cy="11.8" r="1" fill="#fff" opacity="0.7" />
      <circle cx="18" cy="9" r="0.8" fill="#FBBF24" />
    </>
  )});
}

/** Palette (large, decorative) — brand colors / logo upload empty state */
export function IcoPalette({ size, className }: IconProps) {
  return wrap({ size, className, children: (
    <>
      <defs>
        <linearGradient id="pal-gr" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%"   stopColor="#FBBF24" />
          <stop offset="100%" stopColor="#F472B6" />
        </linearGradient>
      </defs>
      <path
        d="M12 3a9 9 0 0 0 0 18c1.6 0 1.5-1 1-1.5-1-1 0-2.5 1.5-2.5H17a4 4 0 0 0 4-4c0-5-4-10-9-10z"
        fill="url(#pal-gr)"
      />
      <circle cx="7"  cy="11" r="1.4" fill="#DC2626" />
      <circle cx="9"  cy="7"  r="1.4" fill="#FBBF24" />
      <circle cx="13" cy="6"  r="1.4" fill="#10B981" />
      <circle cx="17" cy="9"  r="1.4" fill="#3B82F6" />
    </>
  )});
}

/** Person silhouette — avatar */
export function IcoPerson({ size, className }: IconProps) {
  return wrap({ size, className, children: (
    <>
      <defs>
        <linearGradient id="prs-gr" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="#A5B4FC" />
          <stop offset="100%" stopColor="#6366F1" />
        </linearGradient>
      </defs>
      <circle cx="12" cy="8" r="4.5" fill="url(#prs-gr)" />
      <path d="M3 21c0-4 4-7 9-7s9 3 9 7" fill="url(#prs-gr)" />
    </>
  )});
}

/** Crosshair / target — targeting CTA */
export function IcoCrosshair({ size, className }: IconProps) {
  return wrap({ size, className, children: (
    <>
      <circle cx="12" cy="12" r="9"   fill="none" stroke="#1E3A8A" strokeWidth="1.6" />
      <circle cx="12" cy="12" r="5.5" fill="none" stroke="#2563EB" strokeWidth="1.6" />
      <circle cx="12" cy="12" r="2"   fill="#DC2626" />
      <line x1="12" y1="1"  x2="12" y2="5"  stroke="#1E3A8A" strokeWidth="1.6" />
      <line x1="12" y1="19" x2="12" y2="23" stroke="#1E3A8A" strokeWidth="1.6" />
      <line x1="1"  y1="12" x2="5"  y2="12" stroke="#1E3A8A" strokeWidth="1.6" />
      <line x1="19" y1="12" x2="23" y2="12" stroke="#1E3A8A" strokeWidth="1.6" />
    </>
  )});
}

/** Sparkle — generate / AI */
export function IcoSparkle({ size, className }: IconProps) {
  return wrap({ size, className, children: (
    <>
      <defs>
        <linearGradient id="spk-gr" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%"   stopColor="#A78BFA" />
          <stop offset="100%" stopColor="#06B6D4" />
        </linearGradient>
      </defs>
      <path d="M12 2 L14 10 L22 12 L14 14 L12 22 L10 14 L2 12 L10 10 Z" fill="url(#spk-gr)" />
      <circle cx="19" cy="5" r="1.2" fill="#FBBF24" />
      <circle cx="5"  cy="19" r="1"  fill="#22D3EE" />
    </>
  )});
}

/* ─────────────────────────────────────────────────────────────────────
   Digest pipeline steps (used by DigestPage hero)
─────────────────────────────────────────────────────────────────────── */

/** Robot head — AI */
export function IcoAiBrain({ size, className }: IconProps) {
  return wrap({ size, className, children: (
    <>
      <defs>
        <linearGradient id="ai-gr" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="#A78BFA" />
          <stop offset="100%" stopColor="#5B21B6" />
        </linearGradient>
      </defs>
      <rect x="4" y="7" width="16" height="13" rx="3" fill="url(#ai-gr)" />
      <line x1="12" y1="3" x2="12" y2="7" stroke="#5B21B6" strokeWidth="1.6" />
      <circle cx="12" cy="3" r="1.4" fill="#FBBF24" />
      <circle cx="9"  cy="13" r="1.6" fill="#fff" />
      <circle cx="15" cy="13" r="1.6" fill="#fff" />
      <rect x="9" y="16.5" width="6" height="1.2" rx="0.6" fill="#fff" />
    </>
  )});
}

/** Bar chart — live metrics */
export function IcoChartBars({ size, className }: IconProps) {
  return wrap({ size, className, children: (
    <>
      <defs>
        <linearGradient id="bar-gr" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="#22D3EE" />
          <stop offset="100%" stopColor="#0891B2" />
        </linearGradient>
      </defs>
      <rect x="3"  y="14" width="4" height="7"  rx="1" fill="url(#bar-gr)" />
      <rect x="10" y="9"  width="4" height="12" rx="1" fill="url(#bar-gr)" />
      <rect x="17" y="4"  width="4" height="17" rx="1" fill="url(#bar-gr)" />
    </>
  )});
}

/** Bell with notification dot — smart alerts */
export function IcoBellAlert({ size, className }: IconProps) {
  return wrap({ size, className, children: (
    <>
      <defs>
        <linearGradient id="bell-gr" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="#FBBF24" />
          <stop offset="100%" stopColor="#D97706" />
        </linearGradient>
      </defs>
      <path d="M5 17h14l-2-2v-5a5 5 0 0 0-10 0v5l-2 2z" fill="url(#bell-gr)" stroke="#92400E" strokeWidth="1" />
      <path d="M10 19a2 2 0 0 0 4 0" fill="#92400E" />
      <circle cx="18" cy="6" r="3" fill="#DC2626" stroke="#fff" strokeWidth="1.5" />
    </>
  )});
}

/** Paper plane / send — multi-channel send */
export function IcoMultiSend({ size, className }: IconProps) {
  return wrap({ size, className, children: (
    <>
      <defs>
        <linearGradient id="send-gr" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%"   stopColor="#34D399" />
          <stop offset="100%" stopColor="#047857" />
        </linearGradient>
      </defs>
      <path d="M2 12 L22 3 L18 21 L11 14 Z" fill="url(#send-gr)" />
      <path d="M11 14 L22 3" stroke="#065F46" strokeWidth="1" fill="none" />
      <path d="M11 14 L11 20 L14 17" fill="#065F46" />
    </>
  )});
}

/* ─────────────────────────────────────────────────────────────────────
   Avatar visual styles (AvatarDesigner picker chips)
─────────────────────────────────────────────────────────────────────── */

export function IcoStyleCaricature({ size, className }: IconProps) {
  return wrap({ size, className, children: (
    <>
      <circle cx="12" cy="10" r="7" fill="#FBBF24" />
      <circle cx="9"  cy="9"  r="1" fill="#1E1B4B" />
      <circle cx="15" cy="9"  r="1" fill="#1E1B4B" />
      <path d="M8 13c1 2 3 3 4 3s3-1 4-3" fill="none" stroke="#1E1B4B" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M5 6c1-2 4-3 7-3s6 1 7 3" fill="none" stroke="#1E1B4B" strokeWidth="1.2" />
    </>
  )});
}

export function IcoStyleRealistic({ size, className }: IconProps) {
  return <IcoCamera size={size} className={className} />;
}

export function IcoStyleSemiReal({ size, className }: IconProps) {
  return wrap({ size, className, children: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="1.5" fill="#A78BFA" />
      <path d="M3 16l5-4 4 3 5-5 4 3v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" fill="#5B21B6" />
      <circle cx="8" cy="9" r="1.5" fill="#FBBF24" />
    </>
  )});
}

export function IcoStyle3D({ size, className }: IconProps) {
  return wrap({ size, className, children: (
    <>
      <path d="M12 3 L21 8 V16 L12 21 L3 16 V8 Z" fill="#06B6D4" />
      <path d="M12 3 L21 8 L12 13 L3 8 Z" fill="#67E8F9" />
      <path d="M12 13 L21 8 V16 L12 21 Z" fill="#0E7490" />
    </>
  )});
}

export function IcoStyleVector({ size, className }: IconProps) {
  return wrap({ size, className, children: (
    <>
      <path d="M3 21 L7 17 L13 11 L17 15 L21 11" stroke="#1E3A8A" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="2"  y="20" width="2" height="2" fill="#DC2626" />
      <rect x="6"  y="16" width="2" height="2" fill="#10B981" />
      <rect x="12" y="10" width="2" height="2" fill="#FBBF24" />
      <rect x="16" y="14" width="2" height="2" fill="#A855F7" />
      <rect x="20" y="10" width="2" height="2" fill="#06B6D4" />
    </>
  )});
}

export function IcoStyleAnime({ size, className }: IconProps) {
  return wrap({ size, className, children: (
    <>
      <circle cx="12" cy="12" r="3.5" fill="#F472B6" />
      {[0, 60, 120, 180, 240, 300].map(a => {
        const rad = (a * Math.PI) / 180;
        const cx = 12 + Math.cos(rad) * 6;
        const cy = 12 + Math.sin(rad) * 6;
        return <ellipse key={a} cx={cx} cy={cy} rx="3.5" ry="2.2" fill="#FBCFE8" transform={`rotate(${a} ${cx} ${cy})`} />;
      })}
      <circle cx="12" cy="12" r="1.5" fill="#FBBF24" />
    </>
  )});
}

export function IcoStylePixel({ size, className }: IconProps) {
  return wrap({ size, className, children: (
    <>
      {/* tiny pixel-art alien */}
      <rect x="6"  y="6"  width="3" height="3" fill="#10B981" />
      <rect x="15" y="6"  width="3" height="3" fill="#10B981" />
      <rect x="6"  y="9"  width="12" height="3" fill="#10B981" />
      <rect x="3"  y="12" width="3" height="3" fill="#10B981" />
      <rect x="9"  y="12" width="2" height="3" fill="#1E1B4B" />
      <rect x="13" y="12" width="2" height="3" fill="#1E1B4B" />
      <rect x="18" y="12" width="3" height="3" fill="#10B981" />
      <rect x="6"  y="15" width="12" height="2" fill="#10B981" />
      <rect x="6"  y="17" width="3" height="2" fill="#10B981" />
      <rect x="15" y="17" width="3" height="2" fill="#10B981" />
    </>
  )});
}

export function IcoStyleMascot({ size, className }: IconProps) {
  return wrap({ size, className, children: (
    <>
      {/* friendly bear face */}
      <circle cx="6"  cy="6"  r="2.5" fill="#92400E" />
      <circle cx="18" cy="6"  r="2.5" fill="#92400E" />
      <circle cx="12" cy="13" r="8"   fill="#A16207" />
      <circle cx="9"  cy="11" r="1"   fill="#1E1B4B" />
      <circle cx="15" cy="11" r="1"   fill="#1E1B4B" />
      <ellipse cx="12" cy="14.5" rx="3" ry="2" fill="#FCD34D" />
      <ellipse cx="12" cy="15"   rx="0.8" ry="0.5" fill="#1E1B4B" />
    </>
  )});
}

export function IcoStyleMyPhoto({ size, className }: IconProps) {
  return wrap({ size, className, children: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" fill="#0EA5E9" />
      <circle cx="12" cy="9" r="3" fill="#fff" />
      <path d="M5 19c0-3 3-5 7-5s7 2 7 5z" fill="#fff" />
    </>
  )});
}

/** Inbox / drop zone */
export function IcoInbox({ size, className }: IconProps) {
  return wrap({ size, className, children: (
    <>
      <defs>
        <linearGradient id="ibx-gr" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="#A5B4FC" />
          <stop offset="100%" stopColor="#4F46E5" />
        </linearGradient>
      </defs>
      <path d="M3 5h18v9h-5l-1 2h-6l-1-2H3z" fill="url(#ibx-gr)" />
      <path d="M3 14h5l1 2h6l1-2h5v5H3z" fill="#3730A3" />
      <path d="M12 3v6m0 0l-3-3m3 3l3-3" stroke="#fff" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </>
  )});
}

/* ─────────────────────────────────────────────────────────────────────
   Utility / functional icons — use currentColor, adapt to context
─────────────────────────────────────────────────────────────────────── */

export function IcoCheck({ size = 16, color = "currentColor", className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden xmlns="http://www.w3.org/2000/svg">
      <path d="M4 12.5L9.5 18L20 7" stroke={color} strokeWidth="2.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IcoXMark({ size = 16, color = "currentColor", className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden xmlns="http://www.w3.org/2000/svg">
      <path d="M5 5L19 19M19 5L5 19" stroke={color} strokeWidth="2.5" fill="none" strokeLinecap="round" />
    </svg>
  );
}

export function IcoPause({ size = 16, color = "currentColor", className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden xmlns="http://www.w3.org/2000/svg">
      <rect x="6" y="5" width="4" height="14" rx="1.5" fill={color} />
      <rect x="14" y="5" width="4" height="14" rx="1.5" fill={color} />
    </svg>
  );
}

export function IcoPlay({ size = 16, color = "currentColor", className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden xmlns="http://www.w3.org/2000/svg">
      <path d="M6 4L20 12L6 20V4Z" fill={color} />
    </svg>
  );
}

export function IcoStar({ size = 16, color = "currentColor", className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden xmlns="http://www.w3.org/2000/svg">
      <path d="M12 2L14.5 9.5H22L16 14L18.5 21.5L12 17L5.5 21.5L8 14L2 9.5H9.5L12 2Z" fill={color} />
    </svg>
  );
}

export function IcoStatusDot({ size = 8, color = "currentColor", className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 8 8" className={className} aria-hidden xmlns="http://www.w3.org/2000/svg">
      <circle cx="4" cy="4" r="4" fill={color} />
    </svg>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Look-up helpers — pick the right icon by string key.
─────────────────────────────────────────────────────────────────────── */

export function AvatarStyleIcon({ styleKey, size = 18 }: { styleKey: string; size?: number }) {
  switch (styleKey) {
    case "caricature": return <IcoStyleCaricature size={size} />;
    case "realistic":  return <IcoStyleRealistic  size={size} />;
    case "semiReal":   return <IcoStyleSemiReal   size={size} />;
    case "3d":         return <IcoStyle3D         size={size} />;
    case "vector":     return <IcoStyleVector     size={size} />;
    case "anime":      return <IcoStyleAnime      size={size} />;
    case "pixel":      return <IcoStylePixel      size={size} />;
    case "mascot":     return <IcoStyleMascot     size={size} />;
    case "myPhoto":    return <IcoStyleMyPhoto    size={size} />;
    default:           return null;
  }
}

export function ProductIcon({ itemKey, size = 24 }: { itemKey: string; size?: number }) {
  // Exact-key match first
  switch (itemKey) {
    case "ad":        return <IcoAd            size={size} />;
    case "lp":        return <IcoLandingPage   size={size} />;
    case "video":     return <IcoVideo         size={size} />;
    case "logo":      return <IcoLogoDesign    size={size} />;
    case "social_ad": return <IcoSocialOrganic size={size} />;
    case "domain":    return <IcoDomain        size={size} />;
    case "social_pro":   return <IcoSocialPro    size={size} />;
    case "ad_10":        return <IcoAd            size={size} />;
    case "social_ad_10": return <IcoSocialOrganic size={size} />;
  }
  // Heuristic fallback by substring — covers admin-created keys like
  // "lead_campaign", "leads_campaign", "traffic_campaign", "lp_hosting"
  // so any newly-added DB product still renders an icon.
  const k = itemKey.toLowerCase();
  if (k.includes("lead"))    return <IcoLeads          size={size} />;
  if (k.includes("traffic")) return <IcoTraffic        size={size} />;
  if (k.includes("campaign")) return <IcoCampaign      size={size} />;
  if (k.includes("social"))  return <IcoSocialOrganic  size={size} />;
  if (k.includes("video"))   return <IcoVideo          size={size} />;
  if (k.includes("lp") || k.includes("landing") || k.includes("page")) return <IcoLandingPage size={size} />;
  if (k.includes("domain") || k.includes("url"))  return <IcoDomain size={size} />;
  // Generic cube — last-resort so every row has a visual anchor
  return <IcoProductGeneric size={size} />;
}

export function CampaignIcon({ objective, size = 18 }: { objective: string; size?: number }) {
  switch (objective) {
    case "LEAD_GENERATION": return <IcoLeads       size={size} />;
    case "CONVERSIONS":     return <IcoConversions size={size} />;
    case "MESSAGES":        return <IcoMessages    size={size} />;
    case "TRAFFIC":         return <IcoTraffic     size={size} />;
    case "REACH":           return <IcoReach       size={size} />;
    case "BRAND_AWARENESS": return <IcoAwareness   size={size} />;
    case "ENGAGEMENT":      return <IcoEngagement  size={size} />;
    default:                return null;
  }
}
