import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { type ReviewListItem, listProductReviews } from "../api/client";
import { useApi } from "../hooks/useApi";
import { Layout } from "../components/shell/Layout";
import { Header } from "../components/shell/Header";
import { Spinner } from "../components/ui/Spinner";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Badge";
import { EmptyState } from "../components/ui/EmptyState";

type FilterKey = "all" | "pending" | "approved" | "rejected";

const FILTERS: { id: FilterKey; label: string }[] = [
  { id: "all",      label: "הכל" },
  { id: "pending",  label: "ממתינות" },
  { id: "approved", label: "אושרו" },
  { id: "rejected", label: "נדחו" },
];

export function ReviewsPage() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<FilterKey>("all");

  const fetcher = useCallback(() => listProductReviews({ status: filter, limit: 200 }), [filter]);
  const { data, loading, error, reload } = useApi(fetcher, [fetcher]);

  const reviews = data?.reviews ?? [];

  return (
    <Layout
      header={
        <Header
          eyebrow="תגובות לקוחות"
          title="אישורים מלקוחות"
          meta={data ? `${reviews.length} תגובות` : "טוען…"}
          trailing={<Button variant="ghost" size="sm" onClick={reload}>רענן</Button>}
        />
      }
    >
      <section className="section" style={{ marginTop: 0 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "var(--s-3)", marginBottom: "var(--s-5)" }}>
          <Kpi label="סה״כ"     value={reviews.length}                                      color="var(--blue)"     />
          <Kpi label="ממתינות"  value={reviews.filter(r => r.status === "sent").length}      color="var(--warning)"  />
          <Kpi label="אושרו"    value={reviews.filter(r => r.status === "approved").length}  color="var(--positive)" />
          <Kpi label="נדחו"     value={reviews.filter(r => r.status === "rejected").length}  color="var(--negative)" />
        </div>
      </section>

      <section className="section" style={{ marginTop: 0 }}>
        <div className="tabs" style={{ marginBottom: "var(--s-5)", maxWidth: 480 }}>
          {FILTERS.map(f => (
            <button key={f.id} className={"tab " + (filter === f.id ? "active" : "")} onClick={() => setFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>

        {loading ? (
          <Spinner label="טוען תגובות" />
        ) : error ? (
          <EmptyState title="שגיאה" meta={error} action={<Button onClick={reload}>נסה שוב</Button>} />
        ) : reviews.length === 0 ? (
          <EmptyState
            title="אין תגובות"
            meta={filter === "all"
              ? "עדיין לא שלחת מוצרים לאישור. פתח לקוח, אשר מוצרים, ולחץ 'שלח את כל המוצרים לאישור'."
              : "אין תגובות בקטגוריה זו."}
          />
        ) : (
          <div className="card" style={{ padding: 0, overflow: "hidden" }}>
            {reviews.map((r, i) => (
              <ReviewRow
                key={r.token}
                review={r}
                onOpenClient={() => navigate(`/clients/${encodeURIComponent(r.phone)}?tab=products`)}
                last={i === reviews.length - 1}
              />
            ))}
          </div>
        )}
      </section>
    </Layout>
  );
}

function ReviewRow({ review, onOpenClient, last }: {
  review: ReviewListItem;
  onOpenClient: () => void;
  last: boolean;
}) {
  const cfg = (
    review.status === "approved"
      ? { color: "var(--positive)", bg: "var(--positive-bg, #ecfdf5)", icon: "✓", label: "אושר" }
      : review.status === "rejected"
        ? { color: "var(--negative)", bg: "var(--negative-bg, #fef2f2)", icon: "✗", label: "נדחה" }
        : { color: "var(--warning)", bg: "var(--warning-bg, #fffbeb)", icon: "⏳", label: "ממתין" }
  );

  const summary = [
    review.summary.ads > 0     ? `${review.summary.ads} מודעות`     : null,
    review.summary.organic > 0 ? `${review.summary.organic} פוסטים` : null,
    review.summary.lp          ? "דף נחיתה"                          : null,
  ].filter(Boolean).join(" + ");

  return (
    <button
      onClick={onOpenClient}
      className="row"
      style={{
        width: "100%",
        textAlign: "right",
        border: 0,
        borderBottom: last ? "none" : "1px solid var(--rule)",
        borderRadius: 0,
        padding: "var(--s-4) var(--s-5)",
        display: "grid",
        gridTemplateColumns: "auto 1fr auto",
        alignItems: "center",
        gap: "var(--s-4)",
        background: "transparent",
        cursor: "pointer",
      }}
    >
      <span style={{
        width: 36, height: 36, borderRadius: 8,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: cfg.bg, color: cfg.color, fontWeight: 800, fontSize: 16,
      }}>
        {cfg.icon}
      </span>

      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <p className="row-title">{review.clientName}</p>
          <Badge variant={review.status === "approved" ? "positive" : review.status === "rejected" ? "negative" : "warning"}>
            {cfg.label}
          </Badge>
        </div>
        <p className="t-meta tabular" dir="ltr" style={{ marginTop: 2 }}>{review.phone}</p>
        <p className="t-meta" style={{ marginTop: 2 }}>
          {summary} · נשלח {formatDateTime(review.sentAt)}
          {review.respondedAt && ` · תגובה ${formatDateTime(review.respondedAt)}`}
        </p>
        {review.status === "rejected" && review.feedback && (
          <p className="t-body" style={{
            marginTop: 6,
            padding: "6px 10px",
            background: "var(--bg-tint)",
            borderRadius: 6,
            fontStyle: "italic",
            color: "var(--ink-2)",
          }}>
            "{review.feedback}"
          </p>
        )}
      </div>

      <span style={{ color: "var(--ink-3)", fontSize: 18 }}>›</span>
    </button>
  );
}

function Kpi({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="card" style={{ padding: "var(--s-4)", borderTop: `3px solid ${color}` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="pulse-dot" style={{ background: color }} />
        <p style={{ fontSize: 11, fontWeight: 700, color, letterSpacing: "0.06em", textTransform: "uppercase" as const }}>{label}</p>
      </div>
      <p style={{ fontSize: "var(--t-2xl)", fontWeight: 800, color: "var(--ink)", marginTop: 6, lineHeight: 1, letterSpacing: "-0.02em" }}>
        {value}
      </p>
    </div>
  );
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("he-IL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}
