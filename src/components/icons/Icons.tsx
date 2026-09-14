/* Dashen Media Tech brand SVG icon library — 24×24 viewBox, 2px stroke, rounded caps */

interface IconProps {
  size?: number;
  color?: string;
  className?: string;
}

function Ico({ size = 20, color = "currentColor", className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {children}
    </svg>
  );
}

/* ── Navigation ─────────────────────────────────────────────────────── */

export function IcoHome(p: IconProps) {
  return <Ico {...p}><path d="M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9.5z"/><path d="M9 21V12h6v9"/></Ico>;
}
export function IcoUsers(p: IconProps) {
  return <Ico {...p}><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3z"/><path d="M8 11c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3z"/><path d="M8 14c-4 0-6 2-6 3v1h12v-1c0-1-2-3-6-3z"/><path d="M16 14c2.67 0 5 1.5 5 3v1h-6"/></Ico>;
}
export function IcoChat(p: IconProps) {
  return <Ico {...p}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 10h8M8 14h5"/></Ico>;
}
export function IcoBroadcast(p: IconProps) {
  return <Ico {...p}><path d="M22 3 2 12l7 3"/><path d="M9 15v5l4-2.5"/><path d="M9 15l13-12"/></Ico>;
}
export function IcoTarget(p: IconProps) {
  return <Ico {...p}><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/></Ico>;
}
export function IcoTasks(p: IconProps) {
  return <Ico {...p}><path d="M9 12l2 2 4-4"/><rect x="3" y="3" width="18" height="18" rx="2"/></Ico>;
}
export function IcoCalendar(p: IconProps) {
  return <Ico {...p}><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/><path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/></Ico>;
}
export function IcoActivity(p: IconProps) {
  return <Ico {...p}><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></Ico>;
}
export function IcoPipeline(p: IconProps) {
  return <Ico {...p}><path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"/></Ico>;
}
export function IcoDigest(p: IconProps) {
  return <Ico {...p}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></Ico>;
}
export function IcoSettings(p: IconProps) {
  return <Ico {...p}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></Ico>;
}

/* ── Actions ─────────────────────────────────────────────────────────── */

export function IcoPlus(p: IconProps) {
  return <Ico {...p}><path d="M12 5v14M5 12h14"/></Ico>;
}
export function IcoX(p: IconProps) {
  return <Ico {...p}><path d="M18 6 6 18M6 6l12 12"/></Ico>;
}
export function IcoEdit(p: IconProps) {
  return <Ico {...p}><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></Ico>;
}
export function IcoTrash(p: IconProps) {
  return <Ico {...p}><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></Ico>;
}
export function IcoSearch(p: IconProps) {
  return <Ico {...p}><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></Ico>;
}
export function IcoFilter(p: IconProps) {
  return <Ico {...p}><path d="M4 6h16M7 12h10M10 18h4"/></Ico>;
}
export function IcoDownload(p: IconProps) {
  return <Ico {...p}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></Ico>;
}
export function IcoSend(p: IconProps) {
  return <Ico {...p}><path d="M22 2 11 13"/><path d="M22 2 15 22 11 13 2 9l20-7z"/></Ico>;
}
export function IcoRefresh(p: IconProps) {
  return <Ico {...p}><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 .49-3"/></Ico>;
}
export function IcoChevronRight(p: IconProps) {
  return <Ico {...p}><path d="m9 18 6-6-6-6"/></Ico>;
}
export function IcoChevronLeft(p: IconProps) {
  return <Ico {...p}><path d="m15 18-6-6 6-6"/></Ico>;
}
export function IcoChevronDown(p: IconProps) {
  return <Ico {...p}><path d="m6 9 6 6 6-6"/></Ico>;
}
export function IcoArrowRight(p: IconProps) {
  return <Ico {...p}><path d="M5 12h14M12 5l7 7-7 7"/></Ico>;
}
export function IcoLogOut(p: IconProps) {
  return <Ico {...p}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></Ico>;
}
export function IcoLink(p: IconProps) {
  return <Ico {...p}><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></Ico>;
}
export function IcoCopy(p: IconProps) {
  return <Ico {...p}><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></Ico>;
}

/* ── Status ──────────────────────────────────────────────────────────── */

export function IcoCheck(p: IconProps) {
  return <Ico {...p}><path d="M20 6 9 17l-5-5"/></Ico>;
}
export function IcoAlert(p: IconProps) {
  return <Ico {...p}><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></Ico>;
}
export function IcoInfo(p: IconProps) {
  return <Ico {...p}><circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></Ico>;
}
export function IcoBell(p: IconProps) {
  return <Ico {...p}><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></Ico>;
}

/* ── Data / Business ─────────────────────────────────────────────────── */

export function IcoTrendUp(p: IconProps) {
  return <Ico {...p}><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></Ico>;
}
export function IcoTrendDown(p: IconProps) {
  return <Ico {...p}><polyline points="23 18 13.5 8.5 8.5 13.5 1 6"/><polyline points="17 18 23 18 23 12"/></Ico>;
}
export function IcoCoin(p: IconProps) {
  return <Ico {...p}><circle cx="12" cy="12" r="9"/><path d="M14.8 9a2 2 0 0 0-1.8-1H10a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4h-3a2 2 0 0 1-1.8-1"/><path d="M12 6v2M12 16v2"/></Ico>;
}
export function IcoCard(p: IconProps) {
  return <Ico {...p}><rect x="1" y="4" width="22" height="16" rx="2"/><path d="M1 10h22"/></Ico>;
}
export function IcoPhone(p: IconProps) {
  return <Ico {...p}><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.72 12a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.77 1h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.69a16 16 0 0 0 6.29 6.29l1.05-1.05a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></Ico>;
}
export function IcoWhatsApp(p: IconProps) {
  return <Ico {...p}><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></Ico>;
}
export function IcoBarChart(p: IconProps) {
  return <Ico {...p}><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/><line x1="3" y1="20" x2="21" y2="20"/></Ico>;
}
export function IcoFile(p: IconProps) {
  return <Ico {...p}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></Ico>;
}
export function IcoEye(p: IconProps) {
  return <Ico {...p}><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></Ico>;
}
export function IcoAI(p: IconProps) {
  return <Ico {...p}><path d="M12 2a7 7 0 0 1 7 7c0 2.5-1.3 4.7-3.3 6l.8 4H7.5l.8-4A7 7 0 0 1 5 9a7 7 0 0 1 7-7z"/><path d="M9 17v2a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1v-2"/><path d="M10 9l2 2 2-2"/></Ico>;
}
