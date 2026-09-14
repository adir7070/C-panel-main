'use strict';

/**
 * signals.service — PURE detectors over a client's assembled context. No I/O,
 * no LLM: each detector turns real numbers into a typed "something happened"
 * signal the proactive layer can act on. Metrics are computed HERE in code and
 * handed to the model as facts — the model never invents them.
 *
 * detect(view, meta) → [{ kind, severity, summary, data }]  (severity desc)
 *   view : assembleContext().view
 *   meta : { nowHour?, lastContentAt? }
 */

const THRESHOLDS = {
  leadsDropPct: 0.40,      // ≥40% week-over-week drop
  minPriorLeads: 5,        // ignore tiny samples
  cpaRisePct: 0.50,        // ≥50% WoW CPA rise
  budgetExhaustPct: 0.95,  // spent ≥95% of daily
  budgetExhaustHour: 14,   // ...before this hour
  noContentDays: 14,
  lowBalance: 70,          // < a leads-launch cost → can barely act, nudge a top-up
};

const SEV = { high: 3, medium: 2, low: 1 };

/* Split per-day series into [prior7, last7]. */
function splitWeeks(byDay = []) {
  const sorted = [...byDay].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const last7 = sorted.slice(-7);
  const prior7 = sorted.slice(-14, -7);
  const sum = (arr, k) => arr.reduce((s, d) => s + (Number(d[k]) || 0), 0);
  return {
    last: { leads: sum(last7, "leads"), spend: sum(last7, "spend") },
    prior: { leads: sum(prior7, "leads"), spend: sum(prior7, "spend") },
  };
}

function detect(view, meta = {}) {
  const out = [];
  const perf = view?.performance || {};
  const byDay = perf.leads14d?.byDay || [];
  const { last, prior } = splitWeeks(byDay);
  const nowHour = Number.isInteger(meta.nowHour) ? meta.nowHour : 12;

  // 1) leads drop WoW
  if (prior.leads >= THRESHOLDS.minPriorLeads) {
    const drop = (prior.leads - last.leads) / prior.leads;
    if (drop >= THRESHOLDS.leadsDropPct) {
      out.push({
        kind: "leads_drop", severity: "high",
        summary: `ירידה של ${Math.round(drop * 100)}% בלידים השבוע (${last.leads} מול ${prior.leads} בשבוע הקודם)`,
        data: { lastLeads: last.leads, priorLeads: prior.leads, dropPct: Math.round(drop * 100) },
      });
    }
  }

  // 2) CPA rising WoW
  if (last.leads > 0 && prior.leads > 0) {
    const lastCpa = last.spend / last.leads;
    const priorCpa = prior.spend / prior.leads;
    if (priorCpa > 0 && (lastCpa - priorCpa) / priorCpa >= THRESHOLDS.cpaRisePct) {
      out.push({
        kind: "cpa_rising", severity: "high",
        summary: `עלות לליד עלתה מ-${priorCpa.toFixed(1)}₪ ל-${lastCpa.toFixed(1)}₪ (עלייה של ${Math.round(((lastCpa - priorCpa) / priorCpa) * 100)}%)`,
        data: { lastCpa: +lastCpa.toFixed(1), priorCpa: +priorCpa.toFixed(1) },
      });
    }
  }

  // 2a) NEW LEADS today → time-sensitive follow-up nudge. Speed-to-lead is the
  // #1 closing factor, so this runs on its own fast cadence (proactive layer
  // gives new_leads a short cooldown + global-cap exemption). Count from code.
  const leadsToday = (perf.campaigns || []).reduce((s, c) => s + (Number(c.leadsToday) || 0), 0);
  if (leadsToday >= 1) {
    out.push({
      kind: "new_leads", severity: "medium",
      summary: `נכנסו ${leadsToday} לידים חדשים היום — כדאי לחזור אליהם מהר (מהירות תגובה מכריעה בסגירה)`,
      data: { leadsToday },
    });
  }

  // 2b) WEEKLY WINS — a positive, trust-building report when results are
  // genuinely good. Only fires when the week is meaningful AND improving or
  // strongly steady — never alongside a real decline (leads_drop/cpa_rising are
  // high-severity and mutually exclusive with these conditions). ~weekly cadence
  // comes from the proactive layer's 7-day per-kind cooldown.
  if (last.leads >= 3) {
    const lastCpa  = last.leads  > 0 ? last.spend  / last.leads  : 0;
    const priorCpa = prior.leads > 0 ? prior.spend / prior.leads : 0;
    const leadsUp     = prior.leads > 0 && last.leads > prior.leads;
    const cpaDown     = priorCpa > 0 && lastCpa > 0 && lastCpa <= priorCpa * 0.9;   // ≥10% cheaper
    const strongStart = prior.leads < THRESHOLDS.minPriorLeads && last.leads >= 5;  // strong week, weak/absent prior
    const notDeclining = !(prior.leads > 0 && (prior.leads - last.leads) / prior.leads >= THRESHOLDS.leadsDropPct);
    if (notDeclining && (leadsUp || cpaDown || strongStart)) {
      const leadsDeltaPct = prior.leads > 0 ? Math.round(((last.leads - prior.leads) / prior.leads) * 100) : null;
      out.push({
        kind: "weekly_wins", severity: "medium",
        summary: `שבוע חזק: ${last.leads} לידים${leadsDeltaPct != null && leadsDeltaPct > 0 ? ` (עלייה של ${leadsDeltaPct}% מהשבוע הקודם)` : ""}${lastCpa > 0 ? `, עלות ממוצעת ${lastCpa.toFixed(1)}₪ לליד` : ""}`,
        data: {
          lastLeads: last.leads, priorLeads: prior.leads, leadsDeltaPct,
          lastCpa: lastCpa > 0 ? +lastCpa.toFixed(1) : null,
          priorCpa: priorCpa > 0 ? +priorCpa.toFixed(1) : null,
          spend: Math.round(last.spend),
        },
      });
    }
  }

  // 3) daily budget exhausted early
  if (nowHour < THRESHOLDS.budgetExhaustHour) {
    for (const c of perf.campaigns || []) {
      if (/ACTIVE/i.test(c.status) && c.dailyBudget > 0 && c.spendToday >= c.dailyBudget * THRESHOLDS.budgetExhaustPct) {
        out.push({
          kind: "budget_exhausted", severity: "medium",
          summary: `קמפיין "${c.name}" כבר ניצל ${Math.round((c.spendToday / c.dailyBudget) * 100)}% מהתקציב היומי (${c.spendToday}/${c.dailyBudget}₪) לפני הצהריים`,
          data: { campaignId: c.id, name: c.name, spendToday: c.spendToday, dailyBudget: c.dailyBudget },
        });
        break; // one per run is enough
      }
    }
  }

  // 4) zero active campaigns (but campaigns exist)
  if (perf.totalCampaigns > 0 && perf.activeCampaigns === 0) {
    out.push({
      kind: "zero_active", severity: "high",
      summary: `אין אף קמפיין פעיל כרגע (${perf.totalCampaigns} קמפיינים, כולם מושהים) — לא מגיעים לידים חדשים`,
      data: { totalCampaigns: perf.totalCampaigns },
    });
  }

  // 4b) NO campaign at all → the sales opportunity. Client isn't getting any
  // value from Kliq yet; the agent switches to consultative-sales mode and
  // proposes a first campaign. `canLaunch` = FB is connected (no creds error),
  // so the agent can actually launch it; otherwise it must route to onboarding.
  if (perf.totalCampaigns === 0) {
    const canLaunch = !perf.campaignsError;
    out.push({
      kind: "no_campaign", severity: "high",
      summary: canLaunch
        ? `ללקוח אין אף קמפיין — הזדמנות להשיק קמפיין ראשון שיביא לו לידים`
        : `ללקוח אין אף קמפיין ואין חיבור פייסבוק פעיל — הזדמנות מכירה, אך צריך קודם לחבר חשבון`,
      data: { totalCampaigns: 0, canLaunch },
    });
  }

  // 5) working campaign worth optimizing — a positive, low-priority nudge that
  // only surfaces when nothing urgent is wrong. The proactive run then uses
  // analyze_campaign to find the winner + propose applying it to the rest.
  for (const c of perf.campaigns || []) {
    if (/ACTIVE/i.test(c.status) && (c.leadsToday || 0) >= 1 && (c.spendToday || 0) >= 15) {
      out.push({
        kind: "campaign_optimizable", severity: "low",
        summary: `הקמפיין "${c.name}" עובד ומביא לידים — הזדמנות לנתח מה עובד הכי טוב ולייעל את שאר המודעות`,
        data: { campaignId: c.id, name: c.name, leadsToday: c.leadsToday, spendToday: c.spendToday },
      });
      break; // one optimization nudge per run
    }
  }

  // (removed) low-balance nudge — coins are hidden under the subscription
  // model; the client is never prompted about tokens. A quota limit surfaces
  // only as "upgrade your subscription" when an action is actually blocked.

  // 6) no new content for a while
  if (meta.lastContentAt) {
    const days = (Date.now() - new Date(meta.lastContentAt).getTime()) / 86400000;
    if (days >= THRESHOLDS.noContentDays) {
      out.push({
        kind: "no_content", severity: "low",
        summary: `לא יצא תוכן חדש כבר ${Math.round(days)} ימים — הזדמנות לרענן עם פוסטים/מודעות חדשים`,
        data: { daysSinceContent: Math.round(days) },
      });
    }
  }

  return out.sort((a, b) => SEV[b.severity] - SEV[a.severity]);
}

module.exports = { detect, THRESHOLDS };
