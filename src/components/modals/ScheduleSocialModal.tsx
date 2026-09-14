import { useMemo, useState } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { useToast } from "../../context/ToastContext";
import {
  scheduleSocialPosts,
  resolveImgUrl,
  type WowOrganicPost,
} from "../../api/client";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Approved organic posts to schedule (one slot per post). */
  posts: WowOrganicPost[];
  phone: string;
  /** Called after a successful schedule submit. */
  onScheduled?: (orderId: string) => void;
}

/* RTL-friendly day-of-week labels — index = JS Date.getDay() (0=Sunday). */
const DAYS: { idx: number; short: string; long: string }[] = [
  { idx: 0, short: "א", long: "ראשון"  },
  { idx: 1, short: "ב", long: "שני"    },
  { idx: 2, short: "ג", long: "שלישי"  },
  { idx: 3, short: "ד", long: "רביעי"  },
  { idx: 4, short: "ה", long: "חמישי"  },
  { idx: 5, short: "ו", long: "שישי"   },
  { idx: 6, short: "ש", long: "שבת"    },
];

/* Pick a useful default: tomorrow's date in YYYY-MM-DD (local zone). */
function tomorrowIso(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Walk forward from `startIso` and collect the next `count` dates whose
 * day-of-week is in `selectedDays`. Returns ISO date strings (YYYY-MM-DD)
 * paired with a HH:MM time for display. Caller composes the timestamps.
 */
function computeDates(startIso: string, selectedDays: Set<number>, count: number): Date[] {
  if (selectedDays.size === 0 || count <= 0) return [];
  const out: Date[] = [];
  const [y, m, d] = startIso.split("-").map(Number);
  const cursor = new Date(y, m - 1, d, 0, 0, 0, 0);
  /* Safety cap so a malformed input can't loop forever. 365 days is far
     more than we'd ever schedule a single batch over. */
  for (let safety = 0; safety < 365 && out.length < count; safety++) {
    if (selectedDays.has(cursor.getDay())) {
      out.push(new Date(cursor));
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

function formatPreview(d: Date): string {
  const day = DAYS[d.getDay()].short;
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}.${mm} ${day}'`;
}

export function ScheduleSocialModal({ open, onClose, posts, phone, onScheduled }: Props) {
  const toast = useToast();
  const [startDate, setStartDate] = useState(tomorrowIso());
  const [time, setTime]           = useState("10:00");
  /* Default to Sun/Tue/Thu — a common organic-posting cadence that avoids
     weekends while still hitting 3 days/week. */
  const [days, setDays] = useState<Set<number>>(new Set([0, 2, 4]));
  const [busy, setBusy] = useState(false);

  const previewDates = useMemo(
    () => computeDates(startDate, days, posts.length),
    [startDate, days, posts.length],
  );
  const canSubmit = previewDates.length === posts.length && !busy;

  function toggleDay(idx: number) {
    setDays(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else                next.add(idx);
      return next;
    });
  }

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    try {
      const [hh, rawMin] = time.split(":").map(Number);
      /* The publish-creatives cron only runs at :00 / :15 / :30 / :45.
         Snap any non-quarter-hour minute down to the previous quarter
         so the slot is reachable. Browsers should already enforce this
         via the step=900 attribute, but be defensive. */
      const mm = Math.floor(rawMin / 15) * 15;
      const items = posts.map((post, i) => {
        const d = previewDates[i];
        d.setHours(hh, mm, 0, 0);
        return {
          imageUrl:    resolveImgUrl(post.imageUrl) || post.imageUrl || "",
          description: [post.headline, post.description, post.cta].filter(Boolean).join("\n\n"),
          scheduledAt: d.getTime(),
        };
      });
      const res = await scheduleSocialPosts({ phone, items });
      toast.ok(`תוזמן: ${items.length} פוסטים יפורסמו אוטומטית`);
      onScheduled?.(res.orderId);
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "שגיאה בתזמון");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={() => { if (!busy) onClose(); }} eyebrow="תזמון פוסטים" title={`${posts.length} פוסטים יפורסמו אוטומטית`}>
      <div style={{ display: "grid", gap: "var(--s-4)", padding: "var(--s-2) 0" }}>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--s-3)" }}>
          <label style={{ display: "grid", gap: 4 }}>
            <span className="t-eyebrow">תאריך התחלה</span>
            <input
              type="date"
              value={startDate}
              onChange={e => setStartDate(e.target.value)}
              className="input"
              style={{ direction: "ltr" }}
            />
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span className="t-eyebrow">שעת פרסום</span>
            <input
              type="time"
              value={time}
              onChange={e => setTime(e.target.value)}
              className="input"
              style={{ direction: "ltr" }}
              step={900}
              title="הקרון רץ כל 15 דקות — בחר זמן בכפולות של 00/15/30/45"
            />
          </label>
        </div>

        <div>
          <p className="t-eyebrow" style={{ marginBottom: 6 }}>ימי פרסום</p>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {DAYS.map(d => {
              const active = days.has(d.idx);
              return (
                <button
                  key={d.idx}
                  type="button"
                  onClick={() => toggleDay(d.idx)}
                  className="btn-quiet"
                  style={{
                    width: 40, height: 40,
                    borderRadius: 999,
                    border: active ? "2px solid var(--blue)" : "1px solid var(--rule)",
                    background: active ? "var(--blue)" : "transparent",
                    color: active ? "#fff" : "var(--ink)",
                    fontWeight: 700,
                    cursor: "pointer",
                    transition: "all 120ms",
                  }}
                  title={d.long}
                >
                  {d.short}
                </button>
              );
            })}
          </div>
        </div>

        <div style={{
          padding: "var(--s-3) var(--s-4)",
          background: "var(--bg-tint)",
          borderRadius: "var(--r-2)",
          border: "1px solid var(--rule)",
        }}>
          <p className="t-eyebrow" style={{ marginBottom: 6 }}>תוצאה</p>
          {previewDates.length === 0 ? (
            <p className="t-meta">בחר לפחות יום אחד.</p>
          ) : (
            <p className="t-body" style={{ direction: "ltr", textAlign: "right", lineHeight: 1.8 }}>
              {previewDates.map(formatPreview).join(" · ")} — בשעה {time}
            </p>
          )}
          {previewDates.length > 0 && previewDates.length < posts.length && (
            <p className="t-meta" style={{ marginTop: 6, color: "var(--warning)" }}>
              בחר עוד ימים — צריך לתזמן {posts.length} פוסטים אבל יש רק {previewDates.length} תאריכים זמינים.
            </p>
          )}
        </div>

        <div style={{ display: "flex", gap: "var(--s-3)", justifyContent: "flex-end" }}>
          <Button variant="ghost" onClick={onClose} disabled={busy}>ביטול</Button>
          <Button onClick={submit} loading={busy} disabled={!canSubmit}>
            תזמן {posts.length} פוסטים
          </Button>
        </div>
      </div>
    </Modal>
  );
}
