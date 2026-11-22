import { useCallback } from "react";
import { Link } from "react-router-dom";
import { getLeadsForClient, formatLeadDate } from "../../api/leads";
import { useApi } from "../../hooks/useApi";
import { Badge } from "../ui/Badge";
import {
  KV, LeadCard, StatusBadge, LeadAnswersList, LeadNotesList, LeadHistoryList,
} from "../leads/LeadParts";

const NOTES_SHOWN = 3;
const HISTORY_SHOWN = 4;

/**
 * "מקור הליד" — the lead this client came from: when and where they came
 * in, what they answered on the intake form, the team's notes and the
 * status history, with a link to the full lead screen. Renders nothing
 * for clients that didn't come from a lead (or when the viewer can't see it).
 */
export function LeadOriginCard({ phone, refreshKey = 0 }: { phone: string; refreshKey?: number }) {
  const fetcher = useCallback(() => getLeadsForClient(phone).then(r => r.leads), [phone]);
  const { data } = useApi(fetcher, [fetcher, refreshKey]);
  const leads = data ?? [];
  if (leads.length === 0) return null;

  // the original lead, not a later re-submission of the same phone
  const lead = leads.find(l => !l.duplicateOf) ?? leads[leads.length - 1];
  const others = leads.filter(l => l.id !== lead.id);
  const answers = lead.answers ?? [];
  const notes = lead.notes ?? [];
  const history = lead.statusHistory ?? [];

  return (
    <LeadCard
      title="מקור הליד"
      accent="var(--blue)"
      action={<Link to={`/leads/${lead.id}`} className="btn btn-ghost btn-sm">פתח את מסך הליד</Link>}
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "var(--s-3)" }}>
        <KV label="נכנס כליד">{formatLeadDate(lead.createdAt)}</KV>
        <KV label="מקור">
          <Badge>{lead.source || "—"}</Badge>
          {lead.campaign && <span className="t-meta" style={{ marginInlineStart: 6 }}>{lead.campaign}</span>}
        </KV>
        <KV label="סטטוס ליד"><StatusBadge status={lead.status} /></KV>
        <KV label="משויך ל">{lead.assignedToName || "—"}</KV>
      </div>

      {others.length > 0 && (
        <p className="t-meta" style={{ fontSize: 12, margin: 0 }}>
          פנה שוב {others.length === 1 ? "פעם נוספת" : `${others.length} פעמים נוספות`}:{" "}
          {others.map((o, i) => (
            <span key={o.id}>
              {i > 0 && " · "}
              <Link to={`/leads/${o.id}`}>{formatLeadDate(o.createdAt)}</Link>
            </span>
          ))}
        </p>
      )}

      {answers.length > 0 && (
        <div>
          <p className="t-eyebrow" style={{ margin: "4px 0 2px" }}>שאלות שהליד ענה · {answers.length}</p>
          <LeadAnswersList answers={answers} compact />
        </div>
      )}

      {lead.message && (
        <div>
          <p className="t-eyebrow" style={{ margin: "4px 0 4px" }}>הודעה מהליד</p>
          <p className="t-body" style={{ whiteSpace: "pre-wrap", margin: 0, overflowWrap: "anywhere" }}>{lead.message}</p>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "var(--s-4)" }}>
        <div>
          <p className="t-eyebrow" style={{ margin: "4px 0 6px" }}>הערות · {notes.length}</p>
          <LeadNotesList notes={notes} limit={NOTES_SHOWN} />
          {notes.length > NOTES_SHOWN && (
            <Link to={`/leads/${lead.id}`} className="t-meta" style={{ fontSize: 12, display: "inline-block", marginTop: 6 }}>
              עוד {notes.length - NOTES_SHOWN} הערות במסך הליד
            </Link>
          )}
        </div>
        <div>
          <p className="t-eyebrow" style={{ margin: "4px 0 6px" }}>היסטוריית סטטוס</p>
          <LeadHistoryList history={history} limit={HISTORY_SHOWN} />
        </div>
      </div>
    </LeadCard>
  );
}
