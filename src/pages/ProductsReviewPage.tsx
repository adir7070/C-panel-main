import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import {
  type ProductsReviewResponse,
  getProductsReview,
  approveProductsReview,
  rejectProductsReview,
  resolveImgUrl,
} from "../api/client";
import { Button } from "../components/ui/Button";
import { Spinner } from "../components/ui/Spinner";
import { Textarea } from "../components/ui/Input";

/**
 * Public client-facing review page — no auth required, token-keyed.
 * Client opens this via SMS link, sees ALL approved products in one place,
 * approves everything or rejects with feedback for the manager.
 *
 * Route: /products-review/:token
 */
export function ProductsReviewPage() {
  const { token } = useParams<{ token: string }>();
  const [data, setData]               = useState<ProductsReviewResponse | null>(null);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState<string | null>(null);
  const [submitting, setSubmitting]   = useState(false);
  const [showReject, setShowReject]   = useState(false);
  const [feedback, setFeedback]       = useState("");
  const [done, setDone]               = useState<"approved" | "rejected" | null>(null);

  useEffect(() => {
    if (!token) return;
    setLoading(true); setError(null);
    getProductsReview(token)
      .then(setData)
      .catch(err => setError(err instanceof Error ? err.message : "שגיאה"))
      .finally(() => setLoading(false));
  }, [token]);

  async function approve() {
    if (!token) return;
    setSubmitting(true);
    try { await approveProductsReview(token); setDone("approved"); }
    catch (err) { setError(err instanceof Error ? err.message : "שגיאה"); }
    finally { setSubmitting(false); }
  }

  async function reject() {
    if (!token) return;
    if (!feedback.trim()) { setError("אנא ספר לנו מה לא מתאים"); return; }
    setSubmitting(true);
    try { await rejectProductsReview(token, feedback.trim()); setDone("rejected"); }
    catch (err) { setError(err instanceof Error ? err.message : "שגיאה"); }
    finally { setSubmitting(false); }
  }

  if (loading) {
    return (
      <CenteredShell>
        <Spinner size="lg" label="טוען את המוצרים שלך..." />
      </CenteredShell>
    );
  }

  if (error && !data) {
    return (
      <CenteredShell>
        <div className="card" style={{ borderTop: "3px solid var(--negative)", maxWidth: 480 }}>
          <p className="t-eyebrow" style={{ color: "var(--negative)" }}>שגיאה</p>
          <p className="t-body" style={{ marginTop: "var(--s-3)" }}>{error}</p>
          <p className="t-meta" style={{ marginTop: "var(--s-3)" }}>
            הקישור אולי פג תוקף או שגוי. צור קשר עם איש המכירות שלך.
          </p>
        </div>
      </CenteredShell>
    );
  }

  if (!data) return null;

  // Already responded — show status, no actions
  if (done || data.status === "approved" || data.status === "rejected") {
    const status = done ?? data.status as "approved" | "rejected";
    return (
      <CenteredShell>
        <div className="card" style={{
          borderTop: `3px solid var(--${status === "approved" ? "positive" : "negative"})`,
          maxWidth: 480,
          textAlign: "center",
          padding: "var(--s-7)",
        }}>
          <p className="t-eyebrow" style={{ color: `var(--${status === "approved" ? "positive" : "negative"})` }}>
            {status === "approved" ? "אישרת ✓" : "דחית"}
          </p>
          <h2 style={{ fontSize: "var(--t-xl)", fontWeight: 800, marginTop: "var(--s-4)" }}>
            {status === "approved" ? "תודה! המוצרים אושרו" : "תודה על המשוב"}
          </h2>
          <p className="t-meta" style={{ marginTop: "var(--s-4)" }}>
            {status === "approved"
              ? "איש המכירות יצור איתך קשר לתיאום פרסום."
              : "איש המכירות שלך יקבל את המשוב ויחזור אליך עם גרסה מתוקנת."}
          </p>
          {(data.feedback || feedback) && status === "rejected" && (
            <div style={{ marginTop: "var(--s-5)", padding: "var(--s-4)", background: "var(--bg-tint)", borderRadius: 8, textAlign: "right" }}>
              <p className="t-eyebrow">המשוב שלך</p>
              <p className="t-body" style={{ marginTop: "var(--s-2)", whiteSpace: "pre-wrap" }}>
                {data.feedback || feedback}
              </p>
            </div>
          )}
        </div>
      </CenteredShell>
    );
  }

  const total = data.ads.length + data.organic.length + (data.lp ? 1 : 0);

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", padding: "var(--s-7) var(--s-4)" }}>
      <div style={{ maxWidth: 980, margin: "0 auto" }}>

        {/* Header */}
        <header style={{ textAlign: "center", marginBottom: "var(--s-9)" }}>
          <p className="t-eyebrow" style={{ color: "var(--blue)" }}>אישור לקוח · דשן מדיה טק</p>
          <h1 style={{ fontSize: "var(--t-3xl)", fontWeight: 900, marginTop: "var(--s-3)" }}>
            המוצרים שלך מוכנים לאישור
          </h1>
          <p className="t-body" style={{ marginTop: "var(--s-4)", color: "var(--ink-2)", maxWidth: 600, margin: "var(--s-4) auto 0" }}>
            סך הכל {total} פריטים. עיין בכולם, ולחץ "אישור" כדי שנעלה אותם, או "דחייה" כדי לבקש שינויים.
          </p>
        </header>

        {/* ADS */}
        {data.ads.length > 0 && (
          <Section title="מודעות ממומנות" count={data.ads.length}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "var(--s-5)" }}>
              {data.ads.map(ad => (
                <PreviewCard
                  key={ad.id}
                  imageUrl={resolveImgUrl(ad.imageUrl)}
                  title={ad.headline}
                  body={ad.description}
                  cta={ad.cta}
                />
              ))}
            </div>
          </Section>
        )}

        {/* ORGANIC */}
        {data.organic.length > 0 && (
          <Section title="פוסטים אורגניים" count={data.organic.length}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "var(--s-5)" }}>
              {data.organic.map(p => (
                <PreviewCard
                  key={p.id}
                  imageUrl={resolveImgUrl(p.imageUrl)}
                  title={p.headline}
                  body={p.description}
                  cta={p.cta}
                />
              ))}
            </div>
          </Section>
        )}

        {/* LP */}
        {data.lp && (
          <Section title="דף נחיתה" count={1}>
            <div className="card" style={{ padding: 0, overflow: "hidden" }}>
              {data.lp.html ? (
                <iframe
                  srcDoc={data.lp.html}
                  title="Landing page preview"
                  style={{ width: "100%", height: 720, border: "none" }}
                />
              ) : (
                <div style={{ padding: "var(--s-7)", textAlign: "center", color: "var(--ink-3)" }}>
                  <p>תצוגה מקדימה של דף הנחיתה תהיה זמינה בקרוב.</p>
                </div>
              )}
            </div>
          </Section>
        )}

        {/* Action bar — sticky bottom */}
        <div style={{
          position: "sticky",
          bottom: "var(--s-4)",
          marginTop: "var(--s-9)",
          padding: "var(--s-5)",
          background: "var(--surface)",
          borderRadius: 16,
          boxShadow: "var(--sh-elevated)",
          border: "1px solid var(--rule)",
          display: "flex",
          gap: "var(--s-3)",
          alignItems: "center",
          flexWrap: "wrap",
          justifyContent: "center",
        }}>
          {showReject ? (
            <div style={{ width: "100%", maxWidth: 600 }}>
              <p className="t-body" style={{ marginBottom: "var(--s-3)" }}>ספר לנו מה לא מתאים, ונחזור אליך עם גרסה מתוקנת:</p>
              <Textarea
                rows={4}
                value={feedback}
                onChange={e => setFeedback(e.target.value)}
                placeholder="לדוגמה: השתמשו בצבעים אחרים, הטקסט ארוך מדי..."
                autoFocus
              />
              {error && <p className="field-error" style={{ marginTop: "var(--s-2)" }}>{error}</p>}
              <div style={{ display: "flex", gap: "var(--s-2)", marginTop: "var(--s-4)" }}>
                <Button onClick={reject} loading={submitting} variant="danger">שלח דחייה</Button>
                <Button variant="ghost" onClick={() => { setShowReject(false); setError(null); }}>חזור</Button>
              </div>
            </div>
          ) : (
            <>
              <Button onClick={approve} loading={submitting} size="lg" style={{ minWidth: 200, background: "var(--positive)", color: "#fff", border: "none" }}>
                ✓ אישור הכל
              </Button>
              <Button onClick={() => setShowReject(true)} size="lg" variant="ghost">
                בקש שינויים
              </Button>
            </>
          )}
        </div>

      </div>
    </div>
  );
}

/* ── Helpers ──────────────────────────────────────────────────────── */

function CenteredShell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      minHeight: "100vh",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "var(--s-5)",
      background: "var(--bg)",
    }}>
      {children}
    </div>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: "var(--s-9)" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: "var(--s-3)", marginBottom: "var(--s-5)" }}>
        <h2 style={{ fontSize: "var(--t-xl)", fontWeight: 800 }}>{title}</h2>
        <span className="t-meta">{count} פריטים</span>
      </div>
      {children}
    </section>
  );
}

function PreviewCard({ imageUrl, title, body, cta }: {
  imageUrl?: string;
  title?: string;
  body?: string;
  cta?: string;
}) {
  return (
    <article className="card" style={{ padding: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
      {imageUrl && (
        <img src={imageUrl} alt="" style={{ width: "100%", aspectRatio: "1", objectFit: "cover", display: "block" }} loading="lazy" />
      )}
      <div style={{ padding: "var(--s-5)", display: "flex", flexDirection: "column", gap: "var(--s-3)", flex: 1 }}>
        {title && <p style={{ fontWeight: 800, fontSize: "var(--t-lg)", lineHeight: 1.3 }}>{title}</p>}
        {body && <p style={{ fontSize: "var(--t-sm)", color: "var(--ink-2)", lineHeight: 1.6, flex: 1 }}>{body}</p>}
        {cta && (
          <span style={{
            alignSelf: "flex-start",
            padding: "8px 18px",
            background: "var(--blue)",
            color: "#fff",
            borderRadius: 8,
            fontSize: "var(--t-sm)",
            fontWeight: 700,
          }}>
            {cta}
          </span>
        )}
      </div>
    </article>
  );
}
