'use strict';

/**
 * tech-report.service — the agent's "hi-tech division" report. Mines the agent's
 * own audit trail (`agent_actions`) for recurring TECHNICAL failures, clusters
 * them by tool+error, and has the model produce a RICH dev-facing analysis per
 * cluster: severity, detailed explanation, impact, root cause, step-by-step fix,
 * and pointers to the likely code (file/function). Surfaced in CPANEL ›
 * "עדכונים מהסוכן"; each item expands to the full detail.
 *
 * Cached ~10min (aggregation + one LLM call).
 */

const { getDB } = require("../../config/db");
const { getClient, MODELS } = require("./anthropic-client");

let _cache = { at: 0, data: null, windowDays: null };
let _generating = false;
const CACHE_MS = 10 * 60 * 1000;

/* Where each tool is implemented — fed to the model so code pointers are real. */
const TOOL_IMPL = {
  generate_ad_image: "registry.js → buildAndUploadImage → services/post-generation-quality.js (OpenAI gpt-image; env OpenAI_API_KEY; העלאה ל-Backblaze)",
  launch_campaign: "services/fb-actions.service.js → launchCampaign (Meta Graph v21: campaign→adset→leadForm→uploadAdImage→creative→ad)",
  create_social_campaign: "services/social-campaign.service.js → autoFulfillSocialCampaign (generateHqSocialPosts + publish-creatives.cron)",
  update_ad_text: "services/fb-actions.service.js → updateAdText (Meta adcreatives; link_data.name/message/call_to_action)",
  update_budget: "services/fb-actions.service.js → setCampaignBudget",
  update_audience: "services/fb-actions.service.js → updateAdAudience (geo/gender/interests targeting)",
  pause_campaign: "services/fb-actions.service.js → setCampaignStatus",
  resume_campaign: "services/fb-actions.service.js → setCampaignStatus",
  pause_ad: "services/fb-actions.service.js → setAdStatus",
  delete_ad: "services/fb-actions.service.js → deleteAd",
  get_campaign_ads: "services/fb-actions.service.js → getCampaignAds (Meta insights; rate-limit code 4/17/32)",
  get_performance: "services/agent/context.js → assembleContext (fb-actions.getCampaigns)",
  add_to_gallery: "services/business-profile-write.service.js → addToGallery (business_profiles.images)",
  attach_image_to_service: "services/business-profile-write.service.js → addToService",
  update_profile: "services/business-profile-write.service.js → updateProfile",
  add_service: "services/business-profile-write.service.js → addService",
  set_logo: "services/business-profile-write.service.js → setLogo",
};

/* Cluster recent failed tool calls by (tool + error prefix), with samples + clients. */
async function aggregateFailures(windowDays) {
  const since = new Date(Date.now() - windowDays * 86400000);
  const rows = await getDB().collection("agent_actions").aggregate([
    { $match: { type: "tool_call", status: "failed", at: { $gte: since } } },
    { $group: {
      _id: { tool: "$tool", err: { $substrCP: [{ $ifNull: ["$result.error", "שגיאה לא ידועה"] }, 0, 70] } },
      count: { $sum: 1 },
      clients: { $addToSet: "$clientPhone" },
      lastAt: { $max: "$at" },
      firstAt: { $min: "$at" },
      sampleError: { $last: "$result.error" },
      samples: { $push: { at: "$at", clientPhone: "$clientPhone", args: "$args", error: "$result.error" } },
    } },
    { $sort: { count: -1 } },
    { $limit: 10 },
  ]).toArray();
  return rows.map(r => ({
    tool: r._id.tool,
    errorSample: r.sampleError || r._id.err || "",
    count: r.count,
    clients: (r.clients || []).filter(Boolean),
    clientsAffected: (r.clients || []).filter(Boolean).length,
    firstAt: r.firstAt,
    lastAt: r.lastAt,
    samples: (r.samples || []).slice(-4).reverse(),
  }));
}

/* Rich dev-facing analysis per cluster. */
async function annotate(clusters) {
  if (!clusters.length) return [];
  try {
    const client = getClient();
    const list = clusters.map((c, i) =>
      `#${i} כלי=${c.tool} | מימוש=${TOOL_IMPL[c.tool] || "לא ידוע"} | מופעים=${c.count} | לקוחות=${c.clientsAffected} | שגיאה="${String(c.errorSample).slice(0, 220)}"`,
    ).join("\n");
    const resp = await client.messages.create({
      model: MODELS.loop,
      max_tokens: 4000,
      thinking: { type: "disabled" },  // JSON-utility call — keep max_tokens for the JSON, not thinking
      system: `אתה מהנדס מערכת בכיר בצוות ההנדסה של Kliq. לפניך אשכולות של כשלים טכניים חוזרים מיומן הסוכן. לכל אשכול הפק ניתוח עשיר ומפורט למפתחים בעברית מקצועית. השתמש במידע ה"מימוש" כדי להצביע על הקוד האמיתי. זהה סוגי כשל: מפתח API שגוי/פג (401/403), מגבלת קצב פייסבוק (code 4/17/32), פרמטר Meta שגוי, timeout, נתון חסר, הרשאה. לכל אשכול החזר: severity (high/medium/low), title (קצר), detail (2-4 משפטים — מה בדיוק קורה טכנית), impact (מה זה שובר ומי מושפע), rootCause (הסיבה), steps (מערך של 2-5 צעדי תיקון קונקרטיים ומעשיים), codePointers (קבצים/פונקציות רלוונטיים לבדיקה). החזר JSON תקין בלבד, בלי פסיקים נגררים ובלי טקסט נוסף: {"items":[{"index":0,"severity":"high","title":"...","detail":"...","impact":"...","rootCause":"...","steps":["...","..."],"codePointers":"..."}]}.`,
      messages: [{ role: "user", content: `אשכולות הכשלים:\n${list}` }],
    });
    const txt = resp.content.filter(c => c.type === "text").map(c => c.text).join("");
    const m = txt.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse((m ? m[0] : txt).replace(/,\s*([}\]])/g, "$1"));
    const byIndex = {};
    for (const it of (parsed.items || [])) byIndex[it.index] = it;
    return clusters.map((c, i) => {
      const a = byIndex[i] || {};
      return {
        ...c,
        implNote: TOOL_IMPL[c.tool] || null,
        severity: a.severity || "medium",
        title: a.title || `${c.tool} נכשל (${c.count})`,
        detail: a.detail || "",
        impact: a.impact || "",
        rootCause: a.rootCause || "",
        steps: Array.isArray(a.steps) ? a.steps : [],
        codePointers: a.codePointers || TOOL_IMPL[c.tool] || "",
      };
    });
  } catch (e) {
    console.warn("[tech-report] annotate failed:", e.message);
    return clusters.map(c => ({ ...c, implNote: TOOL_IMPL[c.tool] || null, severity: "medium", title: `${c.tool} נכשל (${c.count})`, detail: "", impact: "", rootCause: "", steps: [], codePointers: TOOL_IMPL[c.tool] || "" }));
  }
}

/* Aggregation + LLM annotate can take >30s → would trip Heroku's H12 (503) if it
   ran inside the request. So refresh runs in the BACKGROUND and updates the cache;
   getReport returns instantly (cache or a "generating" placeholder) and the client
   polls until generating=false. */
async function refresh(windowDays) {
  if (_generating) return;
  _generating = true;
  try {
    const clusters = await aggregateFailures(windowDays);
    const items = await annotate(clusters);
    const totalFailures = clusters.reduce((s, c) => s + c.count, 0);
    _cache = { at: Date.now(), data: { generatedAt: new Date(), windowDays, totalFailures, items }, windowDays };
  } catch (e) {
    console.error("[tech-report] refresh failed:", e.message);
  } finally {
    _generating = false;
  }
}

function getReport({ windowDays = 7, force = false } = {}) {
  const fresh = _cache.data && _cache.windowDays === windowDays && (Date.now() - _cache.at) < CACHE_MS;
  if (fresh && !force) return { ..._cache.data, cached: true, generating: _generating };
  // (re)generate in the background — never block the HTTP request on the LLM call
  refresh(windowDays).catch(() => {});
  const base = (_cache.data && _cache.windowDays === windowDays)
    ? _cache.data
    : { generatedAt: null, windowDays, totalFailures: 0, items: [] };
  return { ...base, cached: !!_cache.data, generating: true };
}

module.exports = { getReport, aggregateFailures };
