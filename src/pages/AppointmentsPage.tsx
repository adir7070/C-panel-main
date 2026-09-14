import { useCallback, useMemo, useState } from "react";
import {
  type Appointment, type AppointmentStatus,
  getAppointments, createAppointment, updateAppointment, deleteAppointment,
} from "../api/client";
import { useApi } from "../hooks/useApi";
import { useToast } from "../context/ToastContext";
import { Layout } from "../components/shell/Layout";
import { Header } from "../components/shell/Header";
import { Spinner } from "../components/ui/Spinner";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import { Field } from "../components/ui/Field";
import { Input, Textarea } from "../components/ui/Input";
import { Badge } from "../components/ui/Badge";
import { EmptyState } from "../components/ui/EmptyState";
import { SectionHead } from "../components/ui/SectionHead";

type View = "week" | "month" | "list";
type RangeKey = "today" | "week" | "month" | "all";

export function AppointmentsPage() {
  const toast = useToast();
  const [view, setView] = useState<View>("week");
  const [anchor, setAnchor] = useState<Date>(() => startOfWeek(new Date()));
  const [editing, setEditing] = useState<Appointment | null>(null);
  const [creating, setCreating] = useState<{ at: Date } | null>(null);

  const range: RangeKey = view === "week" ? "week" : view === "month" ? "month" : "all";

  const fetcher = useCallback(() => getAppointments(range).catch(() => ({ items: [] as Appointment[] })), [range]);
  const { data, loading, reload } = useApi(fetcher, [fetcher]);

  const items = data?.items ?? [];

  // For week/month, scope further to anchor's range
  const scoped = useMemo(() => {
    if (view === "list") return items;
    if (view === "week") {
      const start = startOfWeek(anchor).getTime();
      const end = start + 7 * 86400000;
      return items.filter(it => {
        const t = new Date(it.scheduledAt).getTime();
        return t >= start && t < end;
      });
    }
    // month
    const start = startOfMonth(anchor).getTime();
    const end = startOfMonth(addMonths(anchor, 1)).getTime();
    return items.filter(it => {
      const t = new Date(it.scheduledAt).getTime();
      return t >= start && t < end;
    });
  }, [items, view, anchor]);

  async function save(payload: { id?: string; clientPhone: string; scheduledAt: string; durationMin: number; type: string; notes?: string; status?: AppointmentStatus }) {
    try {
      if (payload.id) {
        await updateAppointment(payload.id, payload);
        toast.ok("הפגישה עודכנה");
      } else {
        await createAppointment(payload);
        toast.ok("הפגישה נוצרה");
      }
      reload();
      setEditing(null);
      setCreating(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "שגיאה");
    }
  }

  async function remove(id: string) {
    if (!confirm("למחוק את הפגישה?")) return;
    try {
      await deleteAppointment(id);
      toast.ok("נמחק");
      reload();
      setEditing(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "שגיאה");
    }
  }

  function shift(delta: number) {
    if (view === "week")  setAnchor(d => new Date(d.getTime() + delta * 7 * 86400000));
    if (view === "month") setAnchor(d => addMonths(d, delta));
  }

  const headerLabel = view === "week"
    ? `${anchor.toLocaleDateString("he-IL", { day: "2-digit", month: "long" })} – ${new Date(anchor.getTime() + 6 * 86400000).toLocaleDateString("he-IL", { day: "2-digit", month: "long" })}`
    : view === "month"
    ? anchor.toLocaleDateString("he-IL", { month: "long", year: "numeric" })
    : "כל הפגישות";

  return (
    <Layout
      header={
        <Header
          eyebrow="פגישות"
          title="לוח פגישות"
          meta={`${items.length} פגישות בתקופה`}
          trailing={
            <Button onClick={() => setCreating({ at: nextHour() })}>
              + פגישה חדשה
            </Button>
          }
        />
      }
    >
      {/* KPI strip */}
      <section className="section" style={{ marginTop: 0 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "var(--s-3)" }}>
          <ApptKpi label="היום"      value={countToday(items)}     color="var(--blue)"     bg="var(--blue-soft)" />
          <ApptKpi label="השבוע"     value={countThisWeek(items)}  color="#0891B2"        bg="#CFFAFE" />
          <ApptKpi label="ממתינות"   value={items.filter(a => a.status === "pending").length} color="var(--warning)" bg="var(--warning-bg)" />
          <ApptKpi label="הושלמו"    value={items.filter(a => a.status === "done").length}    color="var(--positive)" bg="var(--positive-bg)" />
        </div>
      </section>

      {/* Toolbar */}
      <section className="section">
        <div className="card" style={{ padding: "var(--s-3) var(--s-4)", display: "flex", gap: "var(--s-3)", alignItems: "center", flexWrap: "wrap" }}>
          <div className="tabs" style={{ width: "auto" }}>
            <button className={"tab " + (view === "week" ? "active" : "")}  onClick={() => setView("week")}>שבוע</button>
            <button className={"tab " + (view === "month" ? "active" : "")} onClick={() => setView("month")}>חודש</button>
            <button className={"tab " + (view === "list" ? "active" : "")}  onClick={() => setView("list")}>רשימה</button>
          </div>
          {view !== "list" && (
            <>
              <Button size="sm" variant="ghost" onClick={() => shift(-1)}>‹</Button>
              <span style={{ fontSize: "var(--t-md)", fontWeight: 700, minWidth: 220, textAlign: "center" }}>
                {headerLabel}
              </span>
              <Button size="sm" variant="ghost" onClick={() => shift(1)}>›</Button>
              <Button size="sm" variant="quiet" onClick={() => setAnchor(view === "week" ? startOfWeek(new Date()) : startOfMonth(new Date()))}>
                היום
              </Button>
            </>
          )}
          <div style={{ flex: 1 }} />
          <Button size="sm" variant="ghost" onClick={reload}>רענן</Button>
        </div>
      </section>

      {/* Content */}
      <section className="section">
        {loading ? (
          <Spinner size="lg" label="טוען פגישות" />
        ) : view === "week" ? (
          <WeekGrid
            anchor={anchor}
            items={scoped}
            onSlotClick={(at) => setCreating({ at })}
            onItemClick={(a) => setEditing(a)}
          />
        ) : view === "month" ? (
          <MonthGrid
            anchor={anchor}
            items={scoped}
            onDayClick={(d) => setCreating({ at: setHour(d, 10) })}
            onItemClick={(a) => setEditing(a)}
          />
        ) : (
          <ListView items={scoped} onItemClick={(a) => setEditing(a)} />
        )}
      </section>

      {/* Endpoint hint */}
      {items.length === 0 && !loading && (
        <section className="section">
          <div className="card" style={{ background: "var(--bg-tint)", border: "1px dashed var(--rule-strong)" }}>
            <p className="t-eyebrow" style={{ color: "var(--blue)" }}>endpoints נדרשים</p>
            <ul style={{ marginTop: 8, paddingInlineStart: 20, fontSize: "var(--t-sm)", color: "var(--ink-2)", lineHeight: 1.8 }}>
              <li><span className="mono">GET /cpanel/appointments?range=week|month|all</span></li>
              <li><span className="mono">POST /cpanel/appointments</span> (clientPhone, scheduledAt, durationMin, type, notes)</li>
              <li><span className="mono">PATCH /cpanel/appointments/:id</span></li>
              <li><span className="mono">DELETE /cpanel/appointments/:id</span></li>
            </ul>
          </div>
        </section>
      )}

      {(editing || creating) && (
        <AppointmentModal
          appointment={editing}
          initialAt={creating?.at}
          onClose={() => { setEditing(null); setCreating(null); }}
          onSave={save}
          onDelete={editing ? () => remove(editing.id) : undefined}
        />
      )}
    </Layout>
  );
}

/* ── Week Grid ──────────────────────────────────────────────────────── */
function WeekGrid({
  anchor, items, onSlotClick, onItemClick,
}: {
  anchor: Date;
  items: Appointment[];
  onSlotClick: (at: Date) => void;
  onItemClick: (a: Appointment) => void;
}) {
  const start = startOfWeek(anchor);
  const days = Array.from({ length: 7 }, (_, i) => new Date(start.getTime() + i * 86400000));
  const hours = Array.from({ length: 13 }, (_, i) => i + 8); // 8:00–20:00
  const today = new Date().toDateString();

  return (
    <div className="card" style={{ padding: 0, overflow: "auto" }}>
      <div style={{
        display: "grid",
        gridTemplateColumns: "60px repeat(7, minmax(120px, 1fr))",
        minWidth: 900,
      }}>
        {/* Header row */}
        <div style={{ borderBottom: "1px solid var(--rule)", borderInlineEnd: "1px solid var(--rule)", background: "var(--bg-tint)" }} />
        {days.map((d, i) => {
          const isToday = d.toDateString() === today;
          return (
            <div key={i} style={{
              padding: "var(--s-3)",
              textAlign: "center",
              borderBottom: "1px solid var(--rule)",
              borderInlineEnd: i < 6 ? "1px solid var(--rule)" : "none",
              background: isToday ? "var(--blue-soft)" : "var(--bg-tint)",
            }}>
              <p style={{ fontSize: 11, color: "var(--ink-3)", fontWeight: 600, letterSpacing: "0.04em" }}>
                {d.toLocaleDateString("he-IL", { weekday: "short" })}
              </p>
              <p style={{ fontSize: 18, fontWeight: 800, color: isToday ? "var(--blue)" : "var(--ink)", marginTop: 2 }}>
                {d.getDate()}
              </p>
            </div>
          );
        })}

        {/* Hour rows */}
        {hours.map(hour => (
          <Row key={hour} hour={hour} days={days} items={items} onSlotClick={onSlotClick} onItemClick={onItemClick} />
        ))}
      </div>
    </div>
  );
}

function Row({
  hour, days, items, onSlotClick, onItemClick,
}: {
  hour: number;
  days: Date[];
  items: Appointment[];
  onSlotClick: (at: Date) => void;
  onItemClick: (a: Appointment) => void;
}) {
  return (
    <>
      <div style={{
        padding: "var(--s-2)",
        textAlign: "center",
        fontSize: 11,
        color: "var(--ink-3)",
        fontWeight: 600,
        borderBottom: "1px solid var(--rule)",
        borderInlineEnd: "1px solid var(--rule)",
        height: 64,
      }} dir="ltr">
        {String(hour).padStart(2, "0")}:00
      </div>
      {days.map((day, di) => {
        const slotStart = setHour(day, hour);
        const slotEnd = new Date(slotStart.getTime() + 3600000);
        const slotItems = items.filter(it => {
          const t = new Date(it.scheduledAt).getTime();
          return t >= slotStart.getTime() && t < slotEnd.getTime();
        });
        return (
          <div
            key={di}
            onClick={() => slotItems.length === 0 && onSlotClick(slotStart)}
            style={{
              padding: 4,
              borderBottom: "1px solid var(--rule)",
              borderInlineEnd: di < 6 ? "1px solid var(--rule)" : "none",
              cursor: slotItems.length === 0 ? "pointer" : "default",
              minHeight: 64,
              position: "relative",
              transition: "background 100ms ease",
            }}
            onMouseEnter={e => { if (slotItems.length === 0) e.currentTarget.style.background = "var(--blue-soft)"; }}
            onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
          >
            {slotItems.map(it => (
              <button
                key={it.id}
                onClick={(e) => { e.stopPropagation(); onItemClick(it); }}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "right",
                  background: statusBg(it.status),
                  color: statusFg(it.status),
                  border: `1px solid ${statusBorder(it.status)}`,
                  borderRadius: 6,
                  padding: "4px 6px",
                  cursor: "pointer",
                  fontSize: 11,
                  fontWeight: 700,
                  marginBottom: 2,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                <div className="tabular" dir="ltr" style={{ fontSize: 10, fontWeight: 800 }}>
                  {new Date(it.scheduledAt).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" })}
                </div>
                <div style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{it.clientName}</div>
              </button>
            ))}
          </div>
        );
      })}
    </>
  );
}

/* ── Month Grid ─────────────────────────────────────────────────────── */
function MonthGrid({
  anchor, items, onDayClick, onItemClick,
}: {
  anchor: Date;
  items: Appointment[];
  onDayClick: (d: Date) => void;
  onItemClick: (a: Appointment) => void;
}) {
  const monthStart = startOfMonth(anchor);
  const gridStart = startOfWeek(monthStart);
  const cells = Array.from({ length: 42 }, (_, i) => new Date(gridStart.getTime() + i * 86400000));
  const today = new Date().toDateString();
  const weekDays = ["א'", "ב'", "ג'", "ד'", "ה'", "ו'", "ש'"];

  return (
    <div className="card" style={{ padding: 0, overflow: "hidden" }}>
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(7, 1fr)",
        background: "var(--bg-tint)",
        borderBottom: "1px solid var(--rule)",
      }}>
        {weekDays.map((d, i) => (
          <div key={i} style={{
            padding: "var(--s-3)",
            textAlign: "center",
            fontSize: 11,
            fontWeight: 700,
            color: "var(--ink-3)",
            letterSpacing: "0.06em",
            borderInlineEnd: i < 6 ? "1px solid var(--rule)" : "none",
          }}>
            {d}
          </div>
        ))}
      </div>
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(7, 1fr)",
        gridAutoRows: "minmax(96px, auto)",
      }}>
        {cells.map((d, i) => {
          const inMonth = d.getMonth() === monthStart.getMonth();
          const isToday = d.toDateString() === today;
          const dayItems = items.filter(it => new Date(it.scheduledAt).toDateString() === d.toDateString());
          return (
            <div
              key={i}
              onClick={() => onDayClick(d)}
              style={{
                padding: "var(--s-2)",
                borderInlineEnd: (i % 7) < 6 ? "1px solid var(--rule)" : "none",
                borderBottom: i < 35 ? "1px solid var(--rule)" : "none",
                background: !inMonth ? "var(--bg-tint)" : isToday ? "var(--blue-soft)" : "var(--surface)",
                cursor: "pointer",
                opacity: inMonth ? 1 : 0.55,
              }}
            >
              <div style={{
                fontSize: 12,
                fontWeight: isToday ? 800 : 600,
                color: isToday ? "var(--blue)" : "var(--ink-2)",
                marginBottom: 4,
              }}>
                {d.getDate()}
              </div>
              {dayItems.slice(0, 3).map(it => (
                <button
                  key={it.id}
                  onClick={(e) => { e.stopPropagation(); onItemClick(it); }}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "right",
                    background: statusBg(it.status),
                    color: statusFg(it.status),
                    border: 0,
                    borderRadius: 4,
                    padding: "2px 6px",
                    fontSize: 10,
                    fontWeight: 700,
                    cursor: "pointer",
                    marginBottom: 2,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  <span className="tabular" dir="ltr" style={{ marginInlineEnd: 4 }}>
                    {new Date(it.scheduledAt).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" })}
                  </span>
                  {it.clientName}
                </button>
              ))}
              {dayItems.length > 3 && (
                <p style={{ fontSize: 10, color: "var(--ink-3)", fontWeight: 600 }}>+{dayItems.length - 3} עוד</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── List view ──────────────────────────────────────────────────────── */
function ListView({ items, onItemClick }: { items: Appointment[]; onItemClick: (a: Appointment) => void }) {
  if (items.length === 0) {
    return <EmptyState title="אין פגישות" meta="לחץ '+' כדי ליצור פגישה חדשה." />;
  }
  const sorted = items.slice().sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime());
  return (
    <div className="card" style={{ padding: 0, overflow: "hidden" }}>
      {sorted.map(it => {
        const d = new Date(it.scheduledAt);
        return (
          <button
            key={it.id}
            onClick={() => onItemClick(it)}
            className="row"
            style={{ width: "100%", textAlign: "right", borderRadius: 0, marginBottom: 0, gridTemplateColumns: "auto 1fr auto" }}
          >
            <div className="chip chip-blue" style={{ width: 56, height: 56, borderRadius: 12, flexDirection: "column", fontSize: 11, fontWeight: 800 }}>
              <span style={{ fontSize: 18 }}>{d.getDate()}</span>
              <span style={{ opacity: 0.7 }}>{d.toLocaleDateString("he-IL", { month: "short" })}</span>
            </div>
            <div>
              <p className="row-title">{it.clientName}</p>
              <p className="t-meta tabular" dir="ltr">{it.clientPhone}</p>
              <p className="t-meta">
                {d.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" })} · {it.durationMin} דק׳ · {it.type}
              </p>
            </div>
            <Badge variant={badgeVariant(it.status)}>{statusLabel(it.status)}</Badge>
          </button>
        );
      })}
    </div>
  );
}

/* ── Modal ──────────────────────────────────────────────────────────── */
function AppointmentModal({
  appointment, initialAt, onClose, onSave, onDelete,
}: {
  appointment: Appointment | null;
  initialAt?: Date;
  onClose: () => void;
  onSave: (p: { id?: string; clientPhone: string; scheduledAt: string; durationMin: number; type: string; notes?: string; status?: AppointmentStatus }) => void;
  onDelete?: () => void;
}) {
  const isEdit = Boolean(appointment);
  const initDate = appointment ? new Date(appointment.scheduledAt) : initialAt ?? nextHour();
  const [phone, setPhone]     = useState(appointment?.clientPhone ?? "");
  const [date, setDate]       = useState(toDateInput(initDate));
  const [time, setTime]       = useState(toTimeInput(initDate));
  const [duration, setDuration] = useState(String(appointment?.durationMin ?? 30));
  const [type, setType]       = useState(appointment?.type ?? "פגישת עבודה");
  const [notes, setNotes]     = useState(appointment?.notes ?? "");
  const [status, setStatus]   = useState<AppointmentStatus>(appointment?.status ?? "pending");
  const [error, setError]     = useState<string | null>(null);

  function submit() {
    if (!phone.trim()) { setError("טלפון לקוח נדרש"); return; }
    const at = new Date(`${date}T${time}:00`);
    if (Number.isNaN(at.getTime())) { setError("תאריך/שעה לא תקינים"); return; }
    const dur = Number(duration);
    if (!Number.isFinite(dur) || dur < 5) { setError("משך זמן לא תקין"); return; }
    onSave({
      id: appointment?.id,
      clientPhone: phone.trim(),
      scheduledAt: at.toISOString(),
      durationMin: dur,
      type,
      notes: notes.trim() || undefined,
      status,
    });
  }

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow={isEdit ? "עריכה" : "פגישה חדשה"}
      title={isEdit ? appointment!.clientName : "קביעת פגישה"}
      footer={
        <>
          <Button onClick={submit}>{isEdit ? "שמור" : "צור פגישה"}</Button>
          <Button variant="ghost" onClick={onClose}>ביטול</Button>
          {onDelete && <Button variant="danger" onClick={onDelete}>מחק</Button>}
        </>
      }
    >
      <div style={{ display: "grid", gap: "var(--s-4)" }}>
        <Field label="טלפון לקוח">
          <Input value={phone} onChange={e => setPhone(e.target.value)} dir="ltr" placeholder="0501234567" disabled={isEdit} />
        </Field>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "var(--s-3)" }}>
          <Field label="תאריך">
            <Input type="date" value={date} onChange={e => setDate(e.target.value)} dir="ltr" />
          </Field>
          <Field label="שעה">
            <Input type="time" value={time} onChange={e => setTime(e.target.value)} dir="ltr" />
          </Field>
          <Field label="משך (דק')">
            <Input type="number" value={duration} onChange={e => setDuration(e.target.value)} dir="ltr" min={5} step={5} />
          </Field>
        </div>
        <Field label="סוג">
          <select className="input" value={type} onChange={e => setType(e.target.value)}>
            <option>פגישת עבודה</option>
            <option>שיחת חזרה</option>
            <option>הדגמה</option>
            <option>חתימת חוזה</option>
            <option>אחר</option>
          </select>
        </Field>
        {isEdit && (
          <Field label="סטטוס">
            <select className="input" value={status} onChange={e => setStatus(e.target.value as AppointmentStatus)}>
              <option value="pending">ממתין</option>
              <option value="confirmed">אושר</option>
              <option value="done">התקיים</option>
              <option value="canceled">בוטל</option>
            </select>
          </Field>
        )}
        <Field label="הערות">
          <Textarea rows={3} value={notes} onChange={e => setNotes(e.target.value)} />
        </Field>
        {error && <p className="field-error">{error}</p>}
      </div>
    </Modal>
  );
}

/* ── Helpers ───────────────────────────────────────────────────────── */

function startOfWeek(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  // Israel — week starts Sunday
  x.setDate(x.getDate() - x.getDay());
  return x;
}
function startOfMonth(d: Date): Date {
  const x = new Date(d);
  x.setDate(1);
  x.setHours(0, 0, 0, 0);
  return x;
}
function addMonths(d: Date, n: number): Date {
  const x = new Date(d);
  x.setMonth(x.getMonth() + n);
  return x;
}
function setHour(d: Date, h: number): Date {
  const x = new Date(d);
  x.setHours(h, 0, 0, 0);
  return x;
}
function nextHour(): Date {
  const d = new Date();
  d.setHours(d.getHours() + 1, 0, 0, 0);
  return d;
}
function toDateInput(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function toTimeInput(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function statusBg(s: AppointmentStatus): string {
  return s === "confirmed" ? "var(--positive-bg)"
       : s === "done"      ? "var(--bg-tint)"
       : s === "canceled"  ? "var(--negative-bg)"
       : "var(--warning-bg)";
}
function statusFg(s: AppointmentStatus): string {
  return s === "confirmed" ? "var(--positive)"
       : s === "done"      ? "var(--ink-3)"
       : s === "canceled"  ? "var(--negative)"
       : "var(--warning)";
}
function statusBorder(s: AppointmentStatus): string {
  return s === "confirmed" ? "rgba(16,185,129,0.4)"
       : s === "done"      ? "var(--rule)"
       : s === "canceled"  ? "rgba(239,68,68,0.4)"
       : "rgba(245,158,11,0.4)";
}
function statusLabel(s: AppointmentStatus): string {
  return s === "pending" ? "ממתין" : s === "confirmed" ? "אושר" : s === "done" ? "התקיים" : "בוטל";
}
function badgeVariant(s: AppointmentStatus): "positive" | "warning" | "negative" | "default" {
  return s === "confirmed" ? "positive" : s === "canceled" ? "negative" : s === "done" ? "default" : "warning";
}

void SectionHead;

function ApptKpi({ label, value, color }: { label: string; value: number; color: string; bg?: string }) {
  return (
    <div className="card" style={{
      padding: "var(--s-4)",
      borderTop: `3px solid ${color}`,
      cursor: "default",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="pulse-dot" style={{ background: color }} />
        <p style={{ fontSize: 11, fontWeight: 700, color: color, letterSpacing: "0.06em", textTransform: "uppercase" }}>{label}</p>
      </div>
      <p className="num" style={{
        fontSize: "var(--t-2xl)", fontWeight: 800, color: "var(--ink)",
        marginTop: 6, lineHeight: 1, letterSpacing: "-0.02em",
      }}>{value}</p>
    </div>
  );
}

function countToday(items: Appointment[]): number {
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const tomorrow = t.getTime() + 86400000;
  return items.filter(a => {
    const x = new Date(a.scheduledAt).getTime();
    return x >= t.getTime() && x < tomorrow;
  }).length;
}

function countThisWeek(items: Appointment[]): number {
  const start = startOfWeek(new Date()).getTime();
  const end = start + 7 * 86400000;
  return items.filter(a => {
    const x = new Date(a.scheduledAt).getTime();
    return x >= start && x < end;
  }).length;
}
