import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Layout } from "../components/shell/Layout";
import { Header } from "../components/shell/Header";
import { Spinner } from "../components/ui/Spinner";
import { EmptyState } from "../components/ui/EmptyState";
import { getTasks, type Task, type TaskUrgency } from "../api/client";

const URGENCY_COLOR: Record<TaskUrgency | "all", string> = {
  all:    "var(--blue)",
  normal: "var(--blue)",
  yellow: "#FDD835",
  orange: "#FB8C00",
  red:    "#E53935",
  blink:  "#E53935",
};

const URGENCY_LABEL: Record<TaskUrgency, string> = {
  normal: "תקין",
  yellow: "יום+",
  orange: "2 ימים+",
  red:    "3 ימים+",
  blink:  "5 ימים+",
};

const URGENCY_ORDER: TaskUrgency[] = ["blink", "red", "orange", "yellow", "normal"];

function elapsed(hours: number): string {
  if (hours < 1)  return "פחות משעה";
  if (hours < 24) return `${hours} שעות`;
  const days = Math.floor(hours / 24);
  const rem  = hours % 24;
  return rem > 0 ? `${days} ימים ו-${rem} שעות` : `${days} ימים`;
}

export function TasksPage() {
  const navigate = useNavigate();
  const [tasks,   setTasks]   = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);
  const [filter,  setFilter]  = useState<TaskUrgency | "all">("all");

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    getTasks()
      .then(r => { if (!cancelled) setTasks(r.tasks); })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : "שגיאה בטעינת משימות"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const counts = useMemo(() => {
    const acc: Record<TaskUrgency, number> = { normal: 0, yellow: 0, orange: 0, red: 0, blink: 0 };
    tasks.forEach(t => { acc[t.urgency]++; });
    return acc;
  }, [tasks]);

  const visible = filter === "all" ? tasks : tasks.filter(t => t.urgency === filter);

  return (
    <Layout
      header={
        <Header
          eyebrow="Task Manager"
          title="משימות"
          meta={`${tasks.length} משימות פתוחות`}
        />
      }
    >
      {/* Urgency filter pills */}
      <section className="section" style={{ marginTop: 0 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {(["all", ...URGENCY_ORDER] as const).map(u => {
            const active = filter === u;
            const color  = URGENCY_COLOR[u];
            const label  = u === "all"
              ? `הכל (${tasks.length})`
              : `${URGENCY_LABEL[u as TaskUrgency]} (${counts[u as TaskUrgency]})`;
            return (
              <button
                key={u}
                onClick={() => setFilter(u)}
                style={{
                  padding:    "6px 14px",
                  borderRadius: 99,
                  border:     `1.5px solid ${color}`,
                  background: active ? color : "transparent",
                  color:      active ? "#fff"  : "var(--ink)",
                  fontSize:   "var(--t-xs)",
                  fontWeight: 700,
                  cursor:     "pointer",
                  transition: "background 120ms ease",
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      </section>

      {/* List */}
      <section className="section">
        {loading && <Spinner label="טוען משימות" />}
        {error   && <EmptyState title="שגיאה" meta={error} />}
        {!loading && !error && visible.length === 0 && (
          <EmptyState
            title={filter === "all" ? "אין משימות פתוחות 🎉" : "אין משימות בקטגוריה זו"}
            meta={filter === "all" ? "כל הלקוחות שלך מסונכרנים." : "נסה קטגוריה אחרת."}
          />
        )}

        {!loading && !error && visible.length > 0 && (
          <div style={{ display: "grid", gap: 8 }}>
            {visible.map(t => (
              <TaskCard
                key={t.id}
                task={t}
                onClick={() => navigate(`/clients/${encodeURIComponent(t.clientPhone)}`)}
              />
            ))}
          </div>
        )}
      </section>
    </Layout>
  );
}

function TaskCard({ task, onClick }: { task: Task; onClick: () => void }) {
  const color   = URGENCY_COLOR[task.urgency] ?? "var(--blue)";
  const isBlink = task.urgency === "blink";

  return (
    <div
      onClick={onClick}
      className="card"
      style={{
        border:    `1.5px solid ${color}`,
        borderRadius: 10,
        padding:   "10px 14px",
        cursor:    "pointer",
        display:   "flex",
        alignItems: "center",
        gap:       12,
        transition: "box-shadow 120ms ease",
      }}
      onMouseEnter={e => (e.currentTarget.style.boxShadow = `0 0 0 3px ${color}33`)}
      onMouseLeave={e => (e.currentTarget.style.boxShadow = "none")}
      onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } }}
      role="button"
      tabIndex={0}
    >
      {/* Urgency dot */}
      <div style={{
        width: 10, height: 10, borderRadius: "50%",
        background: color, flexShrink: 0,
        animation: isBlink ? "taskBlink 1s ease-in-out infinite" : undefined,
      }} />

      {/* Content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
          <span style={{
            fontWeight: 700, fontSize: 13, color: "var(--ink)",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {task.clientName}
          </span>
          <span style={{ fontSize: 11, color: "var(--ink-3)", flexShrink: 0 }}>{task.packageName}</span>
        </div>
        <div style={{ fontSize: 12, color, fontWeight: 700, marginTop: 2 }}>{task.taskLabel}</div>
        <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 1 }}>{task.description}</div>
      </div>

      {/* Elapsed time */}
      <div style={{ textAlign: "center", flexShrink: 0 }}>
        <div className="num" dir="ltr" style={{ fontSize: 11, fontWeight: 700, color }}>
          {elapsed(task.elapsedHours)}
        </div>
        <div style={{ fontSize: 9, color: "var(--ink-3)", letterSpacing: 0.5 }}>ממתין</div>
      </div>

      {/* Arrow */}
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ink-3)" strokeWidth="2" strokeLinecap="round">
        <polyline points="9 18 15 12 9 6" />
      </svg>
    </div>
  );
}
