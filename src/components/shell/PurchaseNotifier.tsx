import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { getGlobalSocket } from "../../hooks/useSocket";
import { useAuth } from "../../context/AuthContext";

interface PurchaseEvent {
  phone: string;
  businessName?: string | null;
  packageName: string;
  amount: number;
  coinsGranted: number;
  at: string;
  managerAgentId?: string | null;
}

const AUTO_DISMISS_MS = 14_000;

/**
 * Listens on the global socket for `cpanel_new_purchase` (targeted at the
 * assigned account manager) and `cpanel_new_purchase_admin` (broadcast to
 * everyone — admin role consumes this). Shows a celebratory popup with a
 * "פתח לקוח" jump button, plays a short chime via Web Audio so the
 * manager hears it even with the tab backgrounded.
 */
export function PurchaseNotifier() {
  const [evt, setEvt] = useState<PurchaseEvent | null>(null);
  const nav = useNavigate();
  const { agent } = useAuth();
  const reduce = useReducedMotion();

  useEffect(() => {
    if (!agent) return;
    const sock = getGlobalSocket();
    if (!sock) return;

    const onPurchase = (p: PurchaseEvent) => {
      setEvt(p);
      playChime();
    };

    sock.on("cpanel_new_purchase", onPurchase);
    /* Admins receive the global broadcast too — assigned managers
       already got it via the targeted room, so deliberately skip
       the global listener for them to avoid double-firing. */
    if (agent.role === "admin") {
      sock.on("cpanel_new_purchase_admin", onPurchase);
    }
    return () => {
      sock.off("cpanel_new_purchase", onPurchase);
      sock.off("cpanel_new_purchase_admin", onPurchase);
    };
  }, [agent]);

  useEffect(() => {
    if (!evt) return;
    const t = window.setTimeout(() => setEvt(null), AUTO_DISMISS_MS);
    return () => window.clearTimeout(t);
  }, [evt]);

  const motionProps = reduce
    ? { initial: false }
    : {
        initial: { opacity: 0, y: -24, scale: 0.94 },
        animate: { opacity: 1, y: 0, scale: 1,
                   transition: { type: "spring" as const, stiffness: 320, damping: 26 } },
        exit:    { opacity: 0, y: -16, scale: 0.96,
                   transition: { duration: 0.22, ease: [0.4, 0, 1, 1] as [number, number, number, number] } },
      };

  return (
    <AnimatePresence>
      {evt && (
        <motion.div
          {...motionProps}
          role="alert"
          aria-live="assertive"
          style={{
            position: "fixed",
            top: 24,
            insetInlineStart: "50%",
            transform: "translateX(-50%)",
            zIndex: 1000,
            background: "linear-gradient(135deg, #059669 0%, #047857 100%)",
            color: "#fff",
            padding: "16px 20px",
            borderRadius: 14,
            boxShadow: "0 20px 44px rgba(5, 150, 105, 0.38), 0 4px 12px rgba(0,0,0,0.12)",
            display: "flex",
            alignItems: "center",
            gap: 14,
            maxWidth: 560,
            minWidth: 360,
          }}
        >
          <span
            aria-hidden="true"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 44,
              height: 44,
              borderRadius: 12,
              background: "rgba(255,255,255,0.18)",
              flexShrink: 0,
            }}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M14.5 9c-.6-1.1-1.7-1.6-2.7-1.6-1.6 0-2.8 1-2.8 2.2 0 2.7 5.5 1.6 5.5 4.4 0 1.6-1.6 2.2-3.2 2.2-1.6 0-2.8-1-2.8-2.2" />
              <path d="M12 5.5v13" />
            </svg>
          </span>

          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{
              margin: 0,
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              opacity: 0.88,
            }}>
              רכישה חדשה · עכשיו
            </p>
            <p style={{
              margin: "3px 0 0",
              fontSize: 16,
              fontWeight: 800,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}>
              {evt.businessName || evt.phone} · {evt.packageName}
            </p>
            <p
              dir="ltr"
              style={{
                margin: "2px 0 0",
                fontSize: 13,
                opacity: 0.92,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              ₪{evt.amount.toLocaleString("he-IL")} · +{evt.coinsGranted.toLocaleString("he-IL")} coins
            </p>
          </div>

          <button
            type="button"
            onClick={() => {
              const p = evt.phone;
              setEvt(null);
              nav(`/clients/${p}`);
            }}
            style={{
              background: "#fff",
              color: "#047857",
              border: 0,
              padding: "8px 14px",
              borderRadius: 8,
              fontWeight: 700,
              fontSize: 13,
              cursor: "pointer",
              flexShrink: 0,
              boxShadow: "0 2px 6px rgba(0,0,0,0.12)",
              transition: "transform 150ms var(--ease-out, ease-out)",
            }}
            onMouseEnter={e => { e.currentTarget.style.transform = "scale(1.04)"; }}
            onMouseLeave={e => { e.currentTarget.style.transform = "scale(1)"; }}
          >
            פתח לקוח
          </button>

          <button
            type="button"
            onClick={() => setEvt(null)}
            aria-label="סגור"
            style={{
              background: "transparent",
              border: 0,
              color: "#fff",
              opacity: 0.72,
              cursor: "pointer",
              fontSize: 22,
              padding: 4,
              lineHeight: 1,
              flexShrink: 0,
            }}
          >×</button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* Two-note ascending chime via Web Audio — no mp3 asset needed and
   always works regardless of bundler/CDN setup. Browsers may still
   block autoplay if the page hasn't been interacted with yet; that's
   acceptable since the manager is actively using the panel. */
function playChime() {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const now = ctx.currentTime;

    const beep = (freq: number, start: number, dur: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, now + start);
      gain.gain.setValueAtTime(0, now + start);
      gain.gain.linearRampToValueAtTime(0.18, now + start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + start);
      osc.stop(now + start + dur);
    };

    beep(880, 0,    0.16);  // A5
    beep(1318, 0.10, 0.22); // E6 — ascending fifth, "cha-ching" feel
    window.setTimeout(() => ctx.close().catch(() => {}), 600);
  } catch { /* audio is best-effort */ }
}
