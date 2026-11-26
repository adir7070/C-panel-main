import { useState } from "react";
import { Link } from "react-router-dom";
import { formatDuration, getCallRecordingUrl, SKIP_REASON_LABEL, type CallRecord } from "../../api/calls";
import { Button } from "../ui/Button";

function formatWhen(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("he-IL", { timeZone: "Asia/Jerusalem", day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** Rows of calls with an inline player. `showParty` adds the other side's
 *  number and its lead / client (off on a lead's own page). */
export function CallsList({ calls, showParty = true }: { calls: CallRecord[]; showParty?: boolean }) {
  return (
    <div style={{ display: "grid", gap: 6 }}>
      {calls.map(c => <CallRow key={c.id} call={c} showParty={showParty} />)}
    </div>
  );
}

function CallRow({ call: c, showParty }: { call: CallRecord; showParty: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "none" | "error">("idle");
  const [msg, setMsg] = useState("");

  async function play() {
    setState("loading");
    try {
      const r = await getCallRecordingUrl(c.id);
      setUrl(r.url);
      setState("idle");
    } catch (e) {
      const status = (e as { status?: number }).status;
      setState(status === 404 ? "none" : "error");
      setMsg(e instanceof Error ? e.message : "");
    }
  }

  const dirIcon = c.direction === "out" ? "↗" : "↙";
  const dirLabel = c.direction === "out" ? (c.answered ? "יוצאת" : "יוצאת · לא נענתה") : (c.answered ? "נכנסת" : "נכנסת · לא נענתה");
  const partyName = c.client?.name || c.lead?.name || c.contactName;

  return (
    <div style={{ display: "grid", gap: 6, padding: "8px 12px", borderRadius: "var(--r-2)", background: "var(--bg)" }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", fontSize: 13 }}>
        <span title={dirLabel} style={{ fontWeight: 800, color: c.answered ? (c.direction === "out" ? "#1E3A8A" : "#15803D") : "#B91C1C", width: 16, textAlign: "center" }}>{dirIcon}</span>
        <span className="num" style={{ color: "var(--ink-2)", minWidth: 110 }}>{formatWhen(c.startedAt)}</span>
        <span style={{ color: "var(--ink-3)", minWidth: 120 }}>{dirLabel}</span>
        <span className="num" style={{ color: "var(--ink-2)", minWidth: 44 }}>{formatDuration(c.duration)}</span>
        {showParty && (
          <span style={{ display: "flex", gap: 6, alignItems: "center", flex: 1, minWidth: 160 }}>
            <span dir="ltr" className="num">{c.otherLocal || "חסוי"}</span>
            {partyName && <span style={{ color: "var(--ink-2)" }}>· {partyName}</span>}
            {c.client ? (
              <Link to={`/clients/${encodeURIComponent(c.client.phone)}`} style={{ fontSize: 12 }}>לקוח ›</Link>
            ) : c.lead ? (
              <Link to={`/leads/${encodeURIComponent(c.lead.id)}`} style={{ fontSize: 12 }}>ליד ›</Link>
            ) : null}
          </span>
        )}
        <span style={{ marginInlineStart: "auto" }}>
          {c.answered && !url && (
            c.recordingSkipReason ? (
              <span style={{ fontSize: 12, color: "var(--ink-3)" }}>אין הקלטה · {SKIP_REASON_LABEL[c.recordingSkipReason] ?? c.recordingSkipReason}</span>
            ) : state === "none" ? (
              <span style={{ fontSize: 12, color: "var(--ink-3)" }}>אין הקלטה</span>
            ) : (
              <Button size="sm" variant="ghost" onClick={play} loading={state === "loading"}>▶ השמע</Button>
            )
          )}
        </span>
      </div>
      {url && <audio src={url} controls autoPlay preload="auto" style={{ width: "100%", height: 36 }} onError={() => { setUrl(null); setState("error"); setMsg("הקישור פג — לחץ שוב להשמעה"); }} />}
      {state === "error" && <div style={{ fontSize: 12, color: "#B91C1C" }}>{msg || "לא ניתן לטעון את ההקלטה"}</div>}
    </div>
  );
}
