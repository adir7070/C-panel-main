import { useEffect, useState } from "react";
import { Modal } from "../ui/Modal";
import { Field } from "../ui/Field";
import { Input } from "../ui/Input";
import { Button } from "../ui/Button";

interface Props {
  open: boolean;
  businessName?: string;
  initialColors?: {
    primary?: string;
    secondary?: string;
    accent?: string;
    /* Optional extra brand colors — propagated to the server so the
       OpenAI palette expansion seeds from all 6, not just the first 3. */
    extra1?: string;
    extra2?: string;
    extra3?: string;
  };
  onClose: () => void;
  onApply: (logoUrl: string) => void;
}

const STYLES = [
  { id: "minimal",   label: "מינימליסטי" },
  { id: "modern",    label: "מודרני" },
  { id: "elegant",   label: "אלגנטי" },
  { id: "playful",   label: "שובב" },
  { id: "bold",      label: "נועז" },
  { id: "monogram",  label: "מונוגרמה" },
];

/* Each palette is 3 vibrant accent colors (primary / secondary / accent2).
   The server expands these into a 12-tone palette before sending to
   OpenAI gpt-image-1 so the resulting logo uses tints/shades + analogous
   hues and feels colorful, not flat 2-tone. The 3rd slot used to be a
   cream "background" — removed since logos now ship transparent (via
   the gpt-image-1 background:"transparent" flag) and don't need one. */
const PALETTES: { name: string; colors: [string, string, string] }[] = [
  { name: "כחול-ציאן",  colors: ["#1E3A8A", "#06B6D4", "#FBBF24"] },
  { name: "ירוק-זית",   colors: ["#14532D", "#84CC16", "#F59E0B"] },
  { name: "ורוד-סגול",  colors: ["#831843", "#A855F7", "#EC4899"] },
  { name: "כתום-חום",   colors: ["#7C2D12", "#F97316", "#FCD34D"] },
  { name: "שחור-זהב",   colors: ["#0F172A", "#F59E0B", "#FBBF24"] },
  { name: "אדום-בורדו", colors: ["#7F1D1D", "#DC2626", "#F87171"] },
];

/* Average end-to-end time for a gpt-image-2 logo with the strict Hebrew
   wordmark lock prompt, measured across recent runs. Used to drive the
   "progress bar fill" during the loading screen — purely visual; the
   actual completion signal is the polled job status. */
const EXPECTED_LOGO_SECONDS = 90;

export function LogoGenerator({ open, businessName, initialColors, onClose, onApply }: Props) {
  const [name, setName] = useState(businessName ?? "");
  const [tagline, setTagline] = useState("");
  const [style, setStyle] = useState("modern");
  const [colors, setColors] = useState<[string, string, string]>(["#1E3A8A", "#06B6D4", "#FBBF24"]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /* Seconds elapsed since the user clicked "צור לוגו". Drives the live
     counter + progress bar on the loading screen so the manager has a
     concrete signal something IS happening during the 60-180s wait. */
  const [elapsedSec, setElapsedSec] = useState(0);

  useEffect(() => {
    if (!open) return;
    setName(businessName ?? "");
    if (initialColors?.primary && initialColors?.secondary) {
      setColors([
        initialColors.primary,
        initialColors.secondary,
        initialColors.accent ?? "#FBBF24",
      ]);
    }
  }, [open, businessName, initialColors]);

  /* Tick the elapsed-time counter every second while a generation is
     in flight. Reset to 0 the moment busy flips on (so previous run's
     count doesn't leak), and stop the interval when it flips off. */
  useEffect(() => {
    if (!busy) return;
    setElapsedSec(0);
    const startedAt = Date.now();
    const id = setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [busy]);

  async function generate() {
    if (!name.trim()) { setError("יש להזין שם עסק"); return; }
    setBusy(true); setError(null);
    try {
      const token = localStorage.getItem("cpanel_token");
      const authHeaders: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
      /* Append any user-defined extra brand colors so they seed OpenAI's
         palette expansion alongside the three slot-pickers above. We don't
         show them as picker tiles in this modal (keeps the UI compact) —
         they're pulled silently from Characterization → Brand. */
      const extras = [initialColors?.extra1, initialColors?.extra2, initialColors?.extra3]
        .filter((c): c is string => typeof c === "string" && c.trim().length > 0);
      const allColors = [...colors, ...extras];

      /* Step 1 — POST kicks off a BACKGROUND job. Returns immediately with
         { jobId } so we don't hit Heroku's 30s H12 timeout (gpt-image-1
         at quality:"high" routinely runs 25-45s for a logo). */
      const res = await fetch("/api/cpanel/logo/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({ businessName: name, tagline, style, colors: allColors }),
      });
      const startJson = await res.json().catch(() => ({}));
      if (!res.ok || !startJson?.jobId) {
        throw new Error(startJson?.error || "כשל ביצירת לוגו");
      }
      const jobId = startJson.jobId as string;

      /* Step 2 — poll the job until done / error. 2s interval keeps load
         low. gpt-image-2 with the strict Hebrew wordmark lock prompt can
         take 60-120s end-to-end, occasionally up to ~150s when OpenAI is
         under load. We cap at 180s (90 polls) — a fail-safe so the modal
         doesn't spin forever if the background job truly crashes. If a
         retry-timeout fires the user can just try again. */
      const POLL_MS = 2000;
      const MAX_POLLS = 90;
      for (let i = 0; i < MAX_POLLS; i++) {
        await new Promise(r => setTimeout(r, POLL_MS));
        const pollRes = await fetch(`/api/cpanel/logo/job/${encodeURIComponent(jobId)}`, {
          headers: authHeaders,
        });
        const pollJson = await pollRes.json().catch(() => ({}));
        if (!pollRes.ok) {
          /* 404 here means the job vanished (Mongo expired or dyno wiped
             it). Surface a retryable error rather than hanging. */
          throw new Error(pollJson?.error || "המשימה אבדה — נסה שוב");
        }
        if (pollJson?.status === "done" && pollJson?.url) {
          onApply(pollJson.url);
          onClose();
          return;
        }
        if (pollJson?.status === "error") {
          throw new Error(pollJson?.error || "כשל ביצירת לוגו");
        }
        /* status === "pending" — keep polling */
      }
      throw new Error("ייצור הלוגו לוקח יותר מדי זמן — נסה שוב");
    } catch (e: any) {
      setError(e?.message || "שגיאה בלתי צפויה");
    } finally {
      setBusy(false);
    }
  }

  /* Pulse keyframes for the loading spinner — defined inline so the
     component is self-contained (no global CSS edit needed). */
  const pulseKeyframes = `@keyframes logoGenSpin{from{transform:rotate(0)}to{transform:rotate(360deg)}}@keyframes logoGenPulse{0%,100%{opacity:.6}50%{opacity:1}}`;

  /* Progress bar fill — caps at 95% even past EXPECTED_LOGO_SECONDS so
     the manager doesn't think the job is hung when it's just slow. The
     remaining 5% is reserved for the moment polling sees "done". */
  const progressPct = Math.min(95, Math.round((elapsedSec / EXPECTED_LOGO_SECONDS) * 100));

  /* Floating "still working" toast — appears whenever a job is in flight
     but the modal is closed, so the manager always has a visible signal
     that the logo is still being made. The component itself stays mounted
     across modal open/close cycles (parent renders it unconditionally),
     which is what lets the polling loop survive a "סגור חלון" click. */
  const minimizedBar = busy && !open ? (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        bottom: 20,
        insetInlineStart: 20,
        zIndex: 1100,
        background: "linear-gradient(135deg, var(--blue) 0%, #06B6D4 100%)",
        color: "#fff",
        padding: "12px 16px",
        borderRadius: 12,
        boxShadow: "0 8px 24px rgba(30,58,138,0.35)",
        display: "flex",
        alignItems: "center",
        gap: 12,
        minWidth: 280,
        maxWidth: 360,
        fontFamily: "inherit",
      }}
    >
      <div style={{
        width: 28, height: 28,
        border: "3px solid rgba(255,255,255,0.35)",
        borderTopColor: "#fff",
        borderRadius: "50%",
        animation: "logoGenSpin 1s linear infinite",
        flexShrink: 0,
      }} />
      <div style={{ flex: 1, lineHeight: 1.4 }}>
        <div style={{ fontWeight: 700, fontSize: 13 }}>מייצר לוגו ברקע…</div>
        <div style={{ fontSize: 11, opacity: 0.92 }}>
          {elapsedSec}s · יופיע אוטומטית כשיהיה מוכן
        </div>
      </div>
    </div>
  ) : null;

  return (
    <>
    {/* Keyframes are defined OUTSIDE the Modal so they're available to
        the minimizedBar (which renders when the Modal is closed and
        therefore not in the DOM). */}
    <style>{pulseKeyframes}</style>
    {minimizedBar}
    <Modal open={open} onClose={busy ? () => {} : onClose} eyebrow="Brand" title="יצירת לוגו" size="lg"
      footer={busy ? (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          {/* Keep the cancel option during generation — the OpenAI call
              keeps running server-side regardless (the job record
              eventually expires) but the manager can dismiss the modal
              if they want to come back to it. */}
          <Button variant="ghost" onClick={onClose}>סגור חלון (הייצור ממשיך ברקע)</Button>
        </div>
      ) : (
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <Button variant="ghost" onClick={onClose}>בטל</Button>
          <Button onClick={generate}>צור לוגו</Button>
        </div>
      )}
    >
      {busy ? (
        /* Full-modal loading state — replaces the form so the manager
           has unambiguous feedback ("something IS happening, here's
           how long, here's roughly when it'll be done") instead of
           staring at a faded form for 90 seconds. */
        <div style={{
          display: "grid", gap: "var(--s-5)",
          padding: "var(--s-6) var(--s-3)",
          textAlign: "center",
        }}>
          <div style={{ display: "flex", justifyContent: "center" }}>
            <div style={{
              width: 64, height: 64,
              border: "4px solid var(--rule)",
              borderTopColor: "var(--blue)",
              borderRadius: "50%",
              animation: "logoGenSpin 1s linear infinite",
            }} />
          </div>
          <div>
            <h3 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>יוצר לוגו…</h3>
            <p style={{ margin: "var(--s-2) 0 0", fontSize: 14, color: "var(--ink-2)", lineHeight: 1.6 }}>
              ייצור איכותי לוקח עד 3 דקות. אנא אל תסגרו את הדפדפן ואל תרעננו.
            </p>
          </div>
          <div style={{ display: "grid", gap: "var(--s-2)", maxWidth: 360, margin: "0 auto", width: "100%" }}>
            <div style={{
              height: 8, background: "var(--bg-tint)", borderRadius: 999, overflow: "hidden",
              border: "1px solid var(--rule)",
            }}>
              <div style={{
                height: "100%",
                width: `${progressPct}%`,
                background: "linear-gradient(90deg, var(--blue) 0%, #06B6D4 100%)",
                transition: "width 0.5s ease",
              }} />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--ink-3)" }}>
              <span style={{ animation: "logoGenPulse 1.5s ease-in-out infinite" }}>
                {elapsedSec < 30 ? "מנתח את העסק…"
                  : elapsedSec < 60 ? "בונה הרכב חזותי…"
                  : elapsedSec < 90 ? "מצייר אותיות בעברית…"
                  : "כמעט מוכן, ממתין לחזרה של OpenAI…"}
              </span>
              <span>{elapsedSec}s</span>
            </div>
          </div>
          {error && <p style={{ color: "var(--negative)", fontSize: 13 }}>{error}</p>}
        </div>
      ) : (
      <div style={{ display: "grid", gap: "var(--s-5)" }}>
        <Field label="שם העסק">
          <Input value={name} onChange={e => setName(e.target.value)} placeholder="שם שיופיע על הלוגו" />
        </Field>

        <Field label="תגית / סלוגן" hint="אופציונלי, יופיע מתחת לשם">
          <Input value={tagline} onChange={e => setTagline(e.target.value)} placeholder="לדוגמה: מאז 1995" />
        </Field>

        <div>
          <p className="t-eyebrow" style={{ marginBottom: "var(--s-3)" }}>סגנון</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--s-2)" }}>
            {STYLES.map(s => (
              <button
                key={s.id}
                type="button"
                onClick={() => setStyle(s.id)}
                style={{
                  padding: "8px 16px",
                  background: style === s.id ? "var(--blue)" : "var(--paper)",
                  color: style === s.id ? "#fff" : "var(--ink)",
                  border: "1px solid " + (style === s.id ? "var(--blue)" : "var(--rule-strong)"),
                  borderRadius: "var(--r-2)",
                  cursor: "pointer",
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className="t-eyebrow" style={{ marginBottom: "var(--s-3)" }}>פלטה</p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "var(--s-2)" }}>
            {PALETTES.map(p => {
              const active = p.colors.join(",") === colors.join(",");
              return (
                <button
                  key={p.name}
                  type="button"
                  onClick={() => setColors(p.colors)}
                  style={{
                    padding: "10px 12px",
                    background: "var(--paper)",
                    border: active ? "2px solid var(--blue)" : "1px solid var(--rule-strong)",
                    borderRadius: "var(--r-2)",
                    cursor: "pointer",
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                  }}
                >
                  <div style={{ display: "flex", gap: 4 }}>
                    {p.colors.map(c => (
                      <span key={c} style={{ flex: 1, height: 22, background: c, borderRadius: 4, border: "1px solid var(--rule)" }} />
                    ))}
                  </div>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>{p.name}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <p className="t-eyebrow" style={{ marginBottom: "var(--s-3)" }}>או צבעים מותאמים</p>
          <p style={{ margin: "0 0 var(--s-3)", fontSize: 11, color: "var(--ink-3)", lineHeight: 1.5 }}>
            ה-AI יקבל פלטה מורחבת של 9 גוונים שנגזרים אוטומטית מ-3 הצבעים שלך — לוגו עשיר וצבעוני, ללא רקע (PNG שקוף).
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "var(--s-3)" }}>
            {(["primary", "secondary", "accent"] as const).map((label, i) => (
              <label key={label} style={{ position: "relative", display: "block", cursor: "pointer" }}>
                <div style={{
                  height: 44,
                  background: colors[i],
                  borderRadius: "var(--r-1)",
                  border: "1px solid var(--rule-strong)",
                }} />
                <input
                  type="color"
                  value={colors[i]}
                  onChange={e => {
                    const next: [string, string, string] = [...colors];
                    next[i] = e.target.value.toUpperCase();
                    setColors(next);
                  }}
                  style={{ position: "absolute", inset: 0, opacity: 0, width: "100%", height: "100%", cursor: "pointer" }}
                />
              </label>
            ))}
          </div>
        </div>

        {error && <p style={{ color: "var(--negative)", fontSize: 13 }}>{error}</p>}
      </div>
      )}
    </Modal>
    </>
  );
}
