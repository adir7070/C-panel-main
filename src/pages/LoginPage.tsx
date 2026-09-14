import { useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { useAuth } from "../context/AuthContext";
import { Button } from "../components/ui/Button";
import { Field } from "../components/ui/Field";
import { Input } from "../components/ui/Input";
import dashenLogo from "../assets/dashen-logo.jpg";

/**
 * SaaS-modern login. Two-column shell:
 *   - Left (sticky on desktop): brand cover with logo, headline, soft mesh
 *     gradient background, rotating feature highlights.
 *   - Right: minimal form. Inputs stagger in on mount, error shakes
 *     subtly when login fails.
 *
 * Per ui-ux-pro-max skill rules:
 *   - All inputs labeled, autoComplete attributes set
 *   - Focus rings (global :focus-visible) on every interactive element
 *   - Reduced-motion → no stagger, no shake
 *   - Form is the only thing visible on mobile; cover hidden under 900px
 */
const FEATURES = [
  { title: "מבט אחד על כל לקוח",        meta: "פרופיל · קמפיינים · לידים · חיוב" },
  { title: "צ'אט חכם עם AI",              meta: "תגובות מהירות · ניתוח סנטימנט · קבצים" },
  { title: "יצירת קריאייטיב אוטומטית",     meta: "10 מודעות · דף נחיתה · לוגו · וידאו" },
  { title: "ארנק עמלות בזמן אמת",          meta: "כל עסקה · כל תשלום · גרף חודשי" },
];

export function LoginPage() {
  const { login } = useAuth();
  const reduce = useReducedMotion();

  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [shakeKey, setShakeKey] = useState(0);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login(name.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "שגיאה בהתחברות");
      setShakeKey(k => k + 1);
    } finally {
      setLoading(false);
    }
  }

  /* Form-level stagger on mount. Each child uses its own variant. */
  const containerVariants = reduce ? undefined : {
    hidden: { opacity: 0 },
    show: {
      opacity: 1,
      transition: { staggerChildren: 0.06, delayChildren: 0.10 },
    },
  };
  const itemVariants = reduce ? undefined : {
    hidden: { opacity: 0, y: 12 },
    show:   { opacity: 1, y: 0, transition: { duration: 0.32, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] } },
  };

  return (
    <div className="login-shell">
      {/* ── COVER (left in LTR, right in RTL) ── */}
      <aside className="login-cover">
        {/* Soft mesh-gradient background — single SVG, fixed, decorative. */}
        <div className="login-cover-bg" aria-hidden="true" />

        <div style={{ position: "relative", display: "flex", flexDirection: "column", height: "100%", gap: "var(--s-7)" }}>
          {/* Logo + meta */}
          <motion.div
            initial={reduce ? false : { opacity: 0, y: -8 }}
            animate={reduce ? undefined : { opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.22, 1, 0.36, 1] } }}
            style={{ display: "flex", alignItems: "center", gap: "var(--s-3)" }}
          >
            <img src={dashenLogo} alt="דשן מדיה טק" style={{ height: 44, width: 44, borderRadius: "50%", objectFit: "cover", background: "#fff" }} />
            <div style={{
              padding: "3px 10px",
              borderRadius: 99,
              background: "rgba(255,255,255,0.12)",
              color: "rgba(255,255,255,0.78)",
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
            }}>
              Operations
            </div>
          </motion.div>

          {/* Headline */}
          <motion.div
            initial={reduce ? false : { opacity: 0, y: 16 }}
            animate={reduce ? undefined : { opacity: 1, y: 0, transition: { duration: 0.5, delay: 0.10, ease: [0.22, 1, 0.36, 1] } }}
            style={{ flex: "0 0 auto" }}
          >
            <h1 style={{
              fontSize: "clamp(36px, 4.5vw, 56px)",
              fontWeight: 800,
              lineHeight: 1.05,
              letterSpacing: "-0.02em",
              color: "#fff",
              margin: 0,
              maxWidth: 460,
            }}>
              ניהול תיקי לקוחות,<br />
              <span style={{ color: "rgba(255,255,255,0.65)" }}>הכל במקום אחד.</span>
            </h1>
            <p style={{
              marginTop: "var(--s-5)",
              fontSize: "var(--t-md)",
              lineHeight: 1.6,
              color: "rgba(255,255,255,0.78)",
              maxWidth: 440,
            }}>
              פלטפורמת התפעול של דשן מדיה טק — פרופיל לקוח, קמפיינים פעילים, לידים,
              חיובים, צ'אט ויצירת קריאייטיב, מבט אחד.
            </p>
          </motion.div>

          {/* Feature list — staggered fade-in */}
          <motion.ul
            initial={reduce ? false : "hidden"}
            animate="show"
            variants={containerVariants}
            style={{
              listStyle: "none",
              padding: 0,
              margin: "auto 0 0",
              display: "flex",
              flexDirection: "column",
              gap: "var(--s-3)",
              maxWidth: 460,
            }}
          >
            {FEATURES.map((f) => (
              <motion.li
                key={f.title}
                variants={itemVariants}
                style={{
                  display: "flex",
                  gap: "var(--s-3)",
                  alignItems: "flex-start",
                  padding: "var(--s-3) var(--s-4)",
                  borderRadius: "var(--r-2)",
                  background: "rgba(255,255,255,0.06)",
                  backdropFilter: "blur(6px)",
                  WebkitBackdropFilter: "blur(6px)",
                  border: "1px solid rgba(255,255,255,0.10)",
                }}
              >
                <CheckIcon />
                <div>
                  <p style={{ margin: 0, fontWeight: 700, color: "#fff", fontSize: "var(--t-sm)" }}>{f.title}</p>
                  <p style={{ margin: "2px 0 0", fontSize: "var(--t-xs)", color: "rgba(255,255,255,0.62)" }}>{f.meta}</p>
                </div>
              </motion.li>
            ))}
          </motion.ul>

          {/* Footer line */}
          <div style={{ paddingTop: "var(--s-4)", borderTop: "1px solid rgba(255,255,255,0.10)", color: "rgba(255,255,255,0.5)", fontSize: "var(--t-xs)" }}>
            דשן מדיה טק &middot; Account Management Suite &middot; v2026
          </div>
        </div>
      </aside>

      {/* ── FORM ── */}
      <main className="login-main">
        <motion.form
          onSubmit={onSubmit}
          initial={reduce ? false : "hidden"}
          animate="show"
          variants={containerVariants}
          style={{ width: "100%", maxWidth: 380 }}
        >
          <motion.div variants={itemVariants}>
            <p className="t-eyebrow">כניסה למערכת</p>
            <h2 style={{
              fontSize: "var(--t-2xl)",
              fontWeight: 800,
              letterSpacing: "-0.015em",
              color: "var(--ink)",
              margin: "var(--s-2) 0 var(--s-3)",
            }}>ברוכים הבאים</h2>
            <p className="t-meta" style={{ marginBottom: "var(--s-7)" }}>
              הזן את פרטי המנהל לכניסה.
            </p>
          </motion.div>

          <motion.div variants={itemVariants} style={{ display: "flex", flexDirection: "column", gap: "var(--s-5)" }}>
            <Field label="שם משתמש">
              <Input
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="שם המנהל"
                autoComplete="username"
                required
                autoFocus
              />
            </Field>

            <Field label="סיסמה">
              <div style={{ position: "relative" }}>
                <Input
                  type={showPass ? "text" : "password"}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="current-password"
                  required
                  style={{ paddingInlineEnd: 56 }}
                />
                <button
                  type="button"
                  onClick={() => setShowPass(v => !v)}
                  aria-label={showPass ? "הסתר סיסמה" : "הצג סיסמה"}
                  style={{
                    position: "absolute",
                    insetInlineEnd: 10,
                    top: "50%",
                    transform: "translateY(-50%)",
                    background: "transparent",
                    border: 0,
                    cursor: "pointer",
                    color: "var(--ink-3)",
                    fontSize: 12,
                    fontWeight: 600,
                    padding: "4px 8px",
                    lineHeight: 1,
                    borderRadius: "var(--r-1)",
                  }}
                >
                  {showPass ? "הסתר" : "הצג"}
                </button>
              </div>
            </Field>
          </motion.div>

          {error && (
            <motion.div
              key={shakeKey}
              initial={reduce ? false : { x: -8 }}
              animate={reduce ? undefined : {
                x: [0, -6, 6, -4, 4, 0],
                transition: { duration: 0.42, ease: [0.36, 0.07, 0.19, 0.97] as [number, number, number, number] },
              }}
              style={{ marginTop: "var(--s-5)" }}
            >
              <div role="alert" style={{
                padding: "10px 14px",
                borderRadius: "var(--r-2)",
                background: "var(--negative-bg)",
                color: "var(--negative)",
                fontSize: "var(--t-sm)",
                fontWeight: 600,
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}>
                <ExclamationIcon />
                <span>{error}</span>
              </div>
            </motion.div>
          )}

          <motion.div variants={itemVariants} style={{ marginTop: "var(--s-7)" }}>
            <Button type="submit" loading={loading} size="lg" style={{ width: "100%" }}>
              {loading ? "מתחבר…" : "כניסה"}
            </Button>
          </motion.div>

          <motion.div
            variants={itemVariants}
            style={{
              marginTop: "var(--s-7)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              color: "var(--ink-3)",
              fontSize: "var(--t-xs)",
            }}
          >
            <LockIcon />
            <span>כניסה מאובטחת · SSL/TLS</span>
          </motion.div>
        </motion.form>
      </main>

      <style>{`
        .login-shell {
          min-height: 100vh;
          display: grid;
          grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr);
          background: var(--bg);
        }
        .login-cover {
          position: relative;
          isolation: isolate;
          padding: var(--s-7) var(--s-7);
          display: flex;
          flex-direction: column;
          background: linear-gradient(135deg, #0F1B2D 0%, #1E3A8A 55%, #0073EA 110%);
          color: #fff;
          overflow: hidden;
          border-inline-start: 1px solid var(--rule);
        }
        /* Soft radial mesh pattern over the gradient — adds depth, no asset. */
        .login-cover-bg {
          position: absolute;
          inset: 0;
          background:
            radial-gradient(at 18% 12%, rgba(0,194,255,0.30) 0%, transparent 45%),
            radial-gradient(at 85% 88%, rgba(120,75,209,0.28) 0%, transparent 50%),
            radial-gradient(at 50% 50%, rgba(255,255,255,0.04) 0%, transparent 60%);
          z-index: -1;
          pointer-events: none;
        }
        .login-main {
          padding: var(--s-9) var(--s-7);
          display: flex;
          align-items: center;
          justify-content: center;
        }
        @media (max-width: 900px) {
          .login-shell { grid-template-columns: 1fr; }
          .login-cover { display: none; }
          .login-main  { padding: var(--s-7) var(--s-5); }
        }
      `}</style>
    </div>
  );
}

/* ─── inline icon set (no external dep) ─── */

function CheckIcon() {
  return (
    <span style={{
      flexShrink: 0,
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      width: 22, height: 22,
      borderRadius: 99,
      background: "rgba(255,255,255,0.14)",
      color: "#fff",
      marginTop: 2,
    }} aria-hidden="true">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    </span>
  );
}

function ExclamationIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="13" />
      <circle cx="12" cy="16.5" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 1 1 8 0v4" />
    </svg>
  );
}
