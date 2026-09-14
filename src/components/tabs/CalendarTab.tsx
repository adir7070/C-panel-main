import { useEffect, useRef, useState } from "react";
import {
  calendarScheduleUpload,
  cancelCalendarEvent,
  getClientCalendar,
  rescheduleCreative,
  resolveImgUrl,
  type CalendarOrder,
} from "../../api/client";
import { Spinner } from "../ui/Spinner";

const HE_DAY: Record<string, number> = {
  "ראשון": 0, "שני": 1, "שלישי": 2, "רביעי": 3, "חמישי": 4, "שישי": 5, "שבת": 6,
};
const DAY_LABELS = ["א", "ב", "ג", "ד", "ה", "ו", "ש"];

const HE_MONTHS = [
  "ינואר","פברואר","מרץ","אפריל","מאי","יוני",
  "יולי","אוגוסט","ספטמבר","אוקטובר","נובמבר","דצמבר",
];

interface CalEvent {
  date: Date;
  label: string;
  status: "published" | "scheduled";
  orderId: string;
  creativeIndex: number;
  imageUrl?: string;
  time?: string;
  /* Where the event came from — decides which delete path to call.
     "order" = a creative inside an ai_creation_orders doc;
     "stored" = a standalone instagram_posts doc. */
  source: "order" | "stored";
}

interface StoredPost {
  id: string | number;
  status?: string;
  imgurl?: string;
  description?: string;
  scheduled_at?: number;
  created_at?: number;
}

function buildStoredPostEvents(storedPosts: StoredPost[]): CalEvent[] {
  return storedPosts
    .filter(p => p.scheduled_at && !isNaN(p.scheduled_at))
    .map(p => {
      const d = new Date(p.scheduled_at!);
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      return {
        date: d,
        label: p.description || "פוסט",
        status: (p.status === "published" ? "published" : "scheduled") as "published" | "scheduled",
        orderId: String(p.id),
        creativeIndex: 0,
        imageUrl: p.imgurl,
        time: `${hh}:${mm}`,
        source: "stored" as const,
      };
    });
}

function toDotDate(d: number, m: number, y: number): string {
  return `${String(d).padStart(2, "0")}.${String(m + 1).padStart(2, "0")}.${String(y).slice(-2)}`;
}

function buildEvents(orders: CalendarOrder[]): CalEvent[] {
  const events: CalEvent[] = [];
  for (const o of orders) {
    const creatives = o.creatives ?? [];
    const pointer   = o.publishPointer ?? 0;
    const slots     = o.publish?.slots ?? [];

    creatives.forEach((c, i) => {
      (c.publishLog ?? []).forEach(e => {
        if (e.overallStatus === "success" || e.overallStatus === "partial") {
          events.push({
            date: new Date(e.publishedAt),
            label: c.desc ?? "פוסט",
            status: "published",
            orderId: o._id,
            creativeIndex: i,
            imageUrl: c.imageUrl,
            source: "order",
          });
        }
      });
    });

    for (let i = pointer; i < creatives.length; i++) {
      const slot = slots[i];
      if (!slot) continue;
      let d: Date | null = null;
      if (slot.specificDate) {
        /* Two date formats coexist in the same field across the
           codebase: DD.MM.YY (rescheduleCreative, calendarScheduleUpload,
           instagram-posts) and YYYY-MM-DD ISO (scheduleSocial, cron's
           today-match query). Detect and handle both — without this,
           orders created by /ai-creation-order/schedule-social didn't
           render here. */
        let yyyy: number, mm1: number, dd1: number;
        if (slot.specificDate.includes("-")) {
          // ISO: 2026-06-01
          const [y, m, d2] = slot.specificDate.split("-").map(Number);
          yyyy = y; mm1 = m; dd1 = d2;
        } else {
          // Legacy: 01.06.26
          const [dd, mm, yy] = slot.specificDate.split(".").map(Number);
          yyyy = 2000 + yy; mm1 = mm; dd1 = dd;
        }
        d = new Date(yyyy, mm1 - 1, dd1);
        if (slot.time && slot.time !== "--:--") {
          const [h, m] = slot.time.split(":").map(Number);
          d.setHours(h, m, 0, 0);
        }
      } else if (slot.days?.length && slot.time && slot.time !== "--:--") {
        const [h, m] = slot.time.split(":").map(Number);
        const targetDay = HE_DAY[slot.days[0]] ?? 0;
        const now = new Date();
        d = new Date();
        d.setHours(h, m, 0, 0);
        let diff = (targetDay - now.getDay() + 7) % 7;
        if (diff === 0 && d <= now) diff = 7;
        d.setDate(d.getDate() + diff);
      }
      if (d) {
        events.push({
          date: d,
          label: creatives[i].desc ?? "פוסט",
          status: "scheduled",
          orderId: o._id,
          creativeIndex: i,
          imageUrl: creatives[i].imageUrl,
          time: slot.time && slot.time !== "--:--" ? slot.time : undefined,
          source: "order",
        });
      }
    }
  }
  return events;
}

export function CalendarTab({ phone }: { phone: string }) {
  const [orders, setOrders]         = useState<CalendarOrder[]>([]);
  const [storedPosts, setStoredPosts] = useState<StoredPost[]>([]);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState<string | null>(null);
  const [year, setYear]   = useState(() => new Date().getFullYear());
  const [month, setMonth] = useState(() => new Date().getMonth());

  // Day-detail panel
  const [selectedDay, setSelectedDay] = useState<number | null>(null);

  // Drag state
  const dragEvent = useRef<CalEvent | null>(null);
  const [dropTargetDay, setDropTargetDay] = useState<number | null>(null);

  // Pending reschedule (after drop, show time picker)
  const [pendingDrop, setPendingDrop] = useState<{ event: CalEvent; day: number } | null>(null);
  const [dropTime, setDropTime]       = useState("09:00");
  const [saving, setSaving]           = useState(false);

  // Delete-in-progress key (so only the clicked post shows a spinner state)
  const [deletingKey, setDeletingKey] = useState<string | null>(null);

  // Upload new image flow
  const uploadInputRef                         = useRef<HTMLInputElement>(null);
  const [uploadFile, setUploadFile]            = useState<File | null>(null);
  const [uploadPreview, setUploadPreview]      = useState<string | null>(null);
  const [uploadTime, setUploadTime]            = useState("09:00");
  const [uploadDesc, setUploadDesc]            = useState("");
  const [uploading, setUploading]              = useState(false);

  function load() {
    setLoading(true); setError(null);
    getClientCalendar(phone)
      .then(r => {
        setOrders(r.orders);
        setStoredPosts((r as any).storedPosts ?? []);
      })
      .catch(e => setError(e instanceof Error ? e.message : "שגיאה"))
      .finally(() => setLoading(false));
  }

  useEffect(load, [phone]);

  if (loading) return <Spinner size="lg" label="טוען לוח שנה" />;
  if (error)   return <p style={{ color: "var(--negative)" }}>{error}</p>;

  const events      = [...buildEvents(orders), ...buildStoredPostEvents(storedPosts)];
  const firstDay    = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const monthName   = `${HE_MONTHS[month]} ${year}`;
  const today       = new Date();

  const eventsByDay: Record<string, CalEvent[]> = {};
  events.forEach(e => {
    if (e.date.getFullYear() === year && e.date.getMonth() === month) {
      const key = String(e.date.getDate());
      (eventsByDay[key] ??= []).push(e);
    }
  });

  const cells = [
    ...Array.from({ length: firstDay },    (_, i) => ({ day: 0, key: `e${i}` })),
    ...Array.from({ length: daysInMonth }, (_, i) => ({ day: i + 1, key: `d${i + 1}` })),
  ];

  function prev() {
    const d = new Date(year, month - 1);
    setYear(d.getFullYear()); setMonth(d.getMonth());
  }
  function next() {
    const d = new Date(year, month + 1);
    setYear(d.getFullYear()); setMonth(d.getMonth());
  }

  // ── Drag handlers ──────────────────────────────────────────────────────────
  function handleDotDragStart(e: React.DragEvent, ev: CalEvent) {
    dragEvent.current = ev;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", JSON.stringify({ orderId: ev.orderId, creativeIndex: ev.creativeIndex }));
  }

  function handleCellDragOver(e: React.DragEvent, day: number) {
    if (!dragEvent.current) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropTargetDay(day);
  }

  function handleCellDrop(e: React.DragEvent, day: number) {
    e.preventDefault();
    const ev = dragEvent.current;
    if (!ev || day === ev.date.getDate()) { dragEvent.current = null; setDropTargetDay(null); return; }
    setDropTime(ev.time ?? "09:00");
    setPendingDrop({ event: ev, day });
    dragEvent.current = null;
    setDropTargetDay(null);
    setSelectedDay(null);
  }

  function handleDragEnd() {
    dragEvent.current = null;
    setDropTargetDay(null);
  }

  // ── Save reschedule ────────────────────────────────────────────────────────
  async function confirmReschedule() {
    if (!pendingDrop) return;
    setSaving(true);
    try {
      const dateStr = toDotDate(pendingDrop.day, month, year);
      await rescheduleCreative(phone, pendingDrop.event.orderId, pendingDrop.event.creativeIndex, dateStr, dropTime);
      setPendingDrop(null);
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : "שגיאה בשמירה");
    } finally {
      setSaving(false);
    }
  }

  // ── Delete a scheduled post ────────────────────────────────────────────────
  function eventKey(ev: CalEvent) { return `${ev.source}:${ev.orderId}:${ev.creativeIndex}`; }
  async function handleDelete(ev: CalEvent) {
    if (ev.status === "published") return; // already live — can't unpublish
    if (!window.confirm("למחוק את הפוסט המתוזמן הזה? הפעולה אינה ניתנת לביטול.")) return;
    setDeletingKey(eventKey(ev));
    try {
      if (ev.source === "stored") {
        await cancelCalendarEvent(phone, { source: "stored", storedPostId: ev.orderId });
      } else {
        await cancelCalendarEvent(phone, { source: "order", orderId: ev.orderId, creativeIndex: ev.creativeIndex });
      }
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : "שגיאה במחיקה");
    } finally {
      setDeletingKey(null);
    }
  }

  // ── Upload handlers ────────────────────────────────────────────────────────
  function handleUploadFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    setUploadFile(f);
    if (uploadPreview) URL.revokeObjectURL(uploadPreview);
    setUploadPreview(f ? URL.createObjectURL(f) : null);
    setUploadDesc("");
    setUploadTime("09:00");
  }

  async function confirmUpload() {
    if (!uploadFile || selectedDay === null) return;
    setUploading(true);
    try {
      const dateStr = toDotDate(selectedDay, month, year);
      await calendarScheduleUpload(phone, uploadFile, dateStr, uploadTime, uploadDesc);
      setUploadFile(null);
      if (uploadPreview) URL.revokeObjectURL(uploadPreview);
      setUploadPreview(null);
      setUploadDesc("");
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : "שגיאת העלאה");
    } finally {
      setUploading(false);
    }
  }

  function cancelUpload() {
    setUploadFile(null);
    if (uploadPreview) URL.revokeObjectURL(uploadPreview);
    setUploadPreview(null);
  }

  // ── Selected-day events ────────────────────────────────────────────────────
  const selectedDayEvents = selectedDay ? (eventsByDay[String(selectedDay)] ?? []) : [];

  return (
    <div style={{ direction: "rtl", display: "flex", gap: "var(--s-5)", alignItems: "flex-start" }}>
      {/* ── Calendar grid ─────────────────────────────────────────────────── */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s-4)", marginBottom: "var(--s-5)" }}>
          <button className="btn-quiet" onClick={prev} style={{ fontSize: 20, lineHeight: 1, padding: "var(--s-1) var(--s-3)" }}>‹</button>
          <h3 style={{ margin: 0, fontSize: "var(--t-lg)", fontWeight: 700, flex: 1, textAlign: "center" }}>{monthName}</h3>
          <button className="btn-quiet" onClick={next} style={{ fontSize: 20, lineHeight: 1, padding: "var(--s-1) var(--s-3)" }}>›</button>
        </div>

        {/* Day labels */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2, marginBottom: 4 }}>
          {DAY_LABELS.map(l => (
            <div key={l} style={{ textAlign: "center", fontSize: 11, fontWeight: 700, color: "var(--ink-3)", padding: "var(--s-1)" }}>{l}</div>
          ))}
        </div>

        {/* Grid cells */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2 }}>
          {cells.map(({ day, key }) => {
            const dayEvents = day ? (eventsByDay[String(day)] ?? []) : [];
            const isToday   = day > 0 && day === today.getDate() && month === today.getMonth() && year === today.getFullYear();
            const isSelected = day > 0 && day === selectedDay;
            const isDropTarget = day > 0 && day === dropTargetDay;

            return (
              <div
                key={key}
                onClick={() => day > 0 && setSelectedDay(isSelected ? null : day)}
                onDragOver={day > 0 ? e => handleCellDragOver(e, day) : undefined}
                onDragLeave={() => setDropTargetDay(null)}
                onDrop={day > 0 ? e => handleCellDrop(e, day) : undefined}
                style={{
                  minHeight: 64,
                  borderRadius: "var(--r-1)",
                  background: isDropTarget
                    ? "color-mix(in srgb, var(--blue) 12%, var(--bg-card))"
                    : isSelected
                    ? "color-mix(in srgb, var(--blue) 8%, var(--bg-card))"
                    : day ? "var(--bg-card)" : "transparent",
                  border: day
                    ? isDropTarget
                      ? "2px dashed var(--blue)"
                      : isSelected
                      ? "2px solid var(--blue)"
                      : isToday
                      ? "2px solid var(--blue)"
                      : "1px solid var(--rule)"
                    : "none",
                  padding: day ? "var(--s-2)" : 0,
                  visibility: day ? "visible" : "hidden",
                  cursor: day ? "pointer" : "default",
                  transition: "background 0.15s, border-color 0.15s",
                }}
              >
                {day > 0 && (
                  <>
                    <div style={{ fontSize: 12, fontWeight: isToday ? 800 : 500, color: isToday ? "var(--blue)" : "var(--ink-2)" }}>
                      {day}
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 2, marginTop: 2 }}>
                      {dayEvents.map((e, i) => (
                        <div
                          key={i}
                          title={e.label}
                          draggable={e.status === "scheduled"}
                          onDragStart={e.status === "scheduled" ? ev => handleDotDragStart(ev, e) : undefined}
                          onDragEnd={handleDragEnd}
                          style={{
                            width: 10, height: 10,
                            borderRadius: "50%",
                            background: e.status === "published" ? "var(--positive)" : "var(--blue)",
                            flexShrink: 0,
                            cursor: e.status === "scheduled" ? "grab" : "default",
                          }}
                          onClick={ev => { ev.stopPropagation(); setSelectedDay(day); }}
                        />
                      ))}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>

        {/* Legend */}
        <div style={{ display: "flex", gap: "var(--s-5)", marginTop: "var(--s-4)", fontSize: 12, color: "var(--ink-3)" }}>
          <span>
            <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: "var(--positive)", marginLeft: 4, verticalAlign: "middle" }} />
            פורסם
          </span>
          <span>
            <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: "var(--blue)", marginLeft: 4, verticalAlign: "middle" }} />
            מתוזמן (ניתן לגרור)
          </span>
        </div>
      </div>

      {/* ── Day-detail side panel ──────────────────────────────────────────── */}
      {selectedDay !== null && (
        <div style={{
          width: 280,
          flexShrink: 0,
          background: "var(--bg-card)",
          border: "1px solid var(--rule)",
          borderRadius: "var(--r-2)",
          padding: "var(--s-4)",
          maxHeight: 560,
          overflowY: "auto",
        }}>
          {/* Panel header */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "var(--s-3)" }}>
            <span style={{ fontWeight: 700, fontSize: "var(--t-sm)" }}>
              {selectedDay} {HE_MONTHS[month]}
            </span>
            <button
              className="btn-quiet"
              onClick={() => { setSelectedDay(null); cancelUpload(); }}
              style={{ fontSize: 16, lineHeight: 1, padding: "2px 6px" }}
            >
              ✕
            </button>
          </div>

          {/* Existing posts */}
          {selectedDayEvents.length === 0 ? (
            <p style={{ color: "var(--ink-3)", fontSize: 13, margin: "0 0 var(--s-4)" }}>אין פוסטים ביום זה</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)", marginBottom: "var(--s-4)" }}>
              {selectedDayEvents.map((ev, i) => (
                <div
                  key={i}
                  draggable={ev.status === "scheduled"}
                  onDragStart={ev.status === "scheduled" ? e => handleDotDragStart(e, ev) : undefined}
                  onDragEnd={handleDragEnd}
                  title={ev.status === "scheduled" ? "גרור לתאריך אחר לתזמון מחדש" : undefined}
                  style={{
                    borderRadius: "var(--r-1)",
                    border: "1px solid var(--rule)",
                    overflow: "hidden",
                    cursor: ev.status === "scheduled" ? "grab" : "default",
                    background: "var(--bg)",
                  }}
                >
                  <div style={{ position: "relative" }}>
                    {ev.imageUrl && (
                      <img
                        src={resolveImgUrl(ev.imageUrl) ?? ev.imageUrl}
                        alt={ev.label}
                        style={{ width: "100%", height: 140, objectFit: "cover", display: "block" }}
                        onError={e => {
                          (e.target as HTMLImageElement).style.display = "none";
                          const ph = (e.target as HTMLElement).nextElementSibling as HTMLElement | null;
                          if (ph) ph.style.display = "flex";
                        }}
                      />
                    )}
                    <div style={{ height: 80, background: "var(--bg-card)", display: ev.imageUrl ? "none" : "flex", alignItems: "center", justifyContent: "center", color: "var(--ink-3)", fontSize: 24 }}>
                      🖼
                    </div>
                  </div>
                  <div style={{ padding: "var(--s-2) var(--s-3)" }}>
                    <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 2 }}>{ev.label}</div>
                    <div style={{ display: "flex", alignItems: "center", gap: "var(--s-2)", fontSize: 11, color: "var(--ink-3)" }}>
                      <span style={{
                        width: 7, height: 7, borderRadius: "50%",
                        background: ev.status === "published" ? "var(--positive)" : "var(--blue)",
                        flexShrink: 0, display: "inline-block",
                      }} />
                      {ev.status === "published" ? "פורסם" : "מתוזמן"}
                      {ev.time && <span>· {ev.time}</span>}
                    </div>
                    {ev.status === "scheduled" && (
                      <div style={{ fontSize: 10, color: "var(--ink-3)", marginTop: 4 }}>גרור לתאריך אחר לתזמון מחדש</div>
                    )}
                    {ev.status === "scheduled" && (
                      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 6 }}>
                        <button
                          onMouseDown={e => e.stopPropagation()}
                          onClick={() => handleDelete(ev)}
                          disabled={deletingKey === eventKey(ev)}
                          style={{
                            fontSize: 11, fontWeight: 600,
                            color: "var(--negative)",
                            background: "transparent",
                            border: "1px solid var(--negative)",
                            borderRadius: "var(--r-1)",
                            padding: "3px 10px",
                            cursor: deletingKey === eventKey(ev) ? "default" : "pointer",
                          }}
                        >
                          {deletingKey === eventKey(ev) ? "מוחק…" : "🗑 מחק"}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ── Upload new image section ─────────────────────────────────── */}
          <div style={{ borderTop: "1px solid var(--rule)", paddingTop: "var(--s-3)" }}>
            {/* Hidden file input */}
            <input
              ref={uploadInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              style={{ display: "none" }}
              onChange={handleUploadFileChange}
            />

            {!uploadFile ? (
              <button
                className="btn"
                style={{ width: "100%", fontSize: 13 }}
                onClick={() => uploadInputRef.current?.click()}
              >
                + העלה תמונה חדשה
              </button>
            ) : (
              <div>
                {uploadPreview && (
                  <img
                    src={uploadPreview}
                    alt="preview"
                    style={{ width: "100%", height: 130, objectFit: "cover", borderRadius: "var(--r-1)", marginBottom: "var(--s-2)", display: "block" }}
                  />
                )}
                <div style={{ marginBottom: "var(--s-2)" }}>
                  <label style={{ display: "block", fontSize: 12, color: "var(--ink-2)", marginBottom: 4 }}>שעה</label>
                  <input
                    type="time"
                    value={uploadTime}
                    onChange={e => setUploadTime(e.target.value)}
                    style={{ width: "100%", padding: "var(--s-1) var(--s-2)", border: "1px solid var(--rule)", borderRadius: "var(--r-1)", fontSize: 13, background: "var(--bg)", color: "var(--ink-1)" }}
                  />
                </div>
                <div style={{ marginBottom: "var(--s-3)" }}>
                  <label style={{ display: "block", fontSize: 12, color: "var(--ink-2)", marginBottom: 4 }}>תיאור (אופציונלי)</label>
                  <input
                    type="text"
                    value={uploadDesc}
                    onChange={e => setUploadDesc(e.target.value)}
                    placeholder="תיאור הפוסט..."
                    style={{ width: "100%", padding: "var(--s-1) var(--s-2)", border: "1px solid var(--rule)", borderRadius: "var(--r-1)", fontSize: 13, background: "var(--bg)", color: "var(--ink-1)" }}
                  />
                </div>
                <div style={{ display: "flex", gap: "var(--s-2)" }}>
                  <button
                    className="btn"
                    onClick={confirmUpload}
                    disabled={uploading}
                    style={{ flex: 1, fontSize: 13 }}
                  >
                    {uploading ? "מעלה..." : "שמור"}
                  </button>
                  <button
                    className="btn-quiet"
                    onClick={cancelUpload}
                    disabled={uploading}
                    style={{ fontSize: 13 }}
                  >
                    ביטול
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Time-picker dialog ─────────────────────────────────────────────── */}
      {pendingDrop && (
        <div
          style={{
            position: "fixed", inset: 0, zIndex: 9999,
            background: "rgba(0,0,0,0.4)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
          onClick={() => !saving && setPendingDrop(null)}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: "var(--bg-card)",
              borderRadius: "var(--r-2)",
              padding: "var(--s-6)",
              minWidth: 280,
              boxShadow: "0 8px 32px rgba(0,0,0,0.2)",
              direction: "rtl",
            }}
          >
            <h4 style={{ margin: "0 0 var(--s-4)", fontSize: "var(--t-base)", fontWeight: 700 }}>
              תזמון מחדש ל-{pendingDrop.day} {HE_MONTHS[month]}
            </h4>
            <div style={{ marginBottom: "var(--s-5)" }}>
              <label style={{ display: "block", fontSize: 13, color: "var(--ink-2)", marginBottom: "var(--s-2)" }}>
                שעה
              </label>
              <input
                type="time"
                value={dropTime}
                onChange={e => setDropTime(e.target.value)}
                style={{
                  width: "100%",
                  padding: "var(--s-2) var(--s-3)",
                  border: "1px solid var(--rule)",
                  borderRadius: "var(--r-1)",
                  fontSize: "var(--t-base)",
                  background: "var(--bg)",
                  color: "var(--ink-1)",
                }}
              />
            </div>
            <div style={{ display: "flex", gap: "var(--s-3)", justifyContent: "flex-start" }}>
              <button
                className="btn"
                onClick={confirmReschedule}
                disabled={saving}
                style={{ minWidth: 80 }}
              >
                {saving ? "שומר..." : "שמור"}
              </button>
              <button
                className="btn-quiet"
                onClick={() => setPendingDrop(null)}
                disabled={saving}
              >
                ביטול
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
