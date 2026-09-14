'use strict';

/**
 * fb-actions.service — req/res-free Facebook ad READ + ACTION cores.
 *
 * The same logic previously lived inline in controllers/cpanel.controller.js
 * handlers. Extracting it here gives ONE shared code path that BOTH the Express
 * routes AND the AI-agent tools call (services/agent/registry.js). Every
 * function takes already-resolved `creds` ({ userToken, adAccountId, pageId })
 * — resolve once per request/run via cpanel.getClientFbCredentials and pass in
 * (tokens live in Fireberry, not cached).
 *
 * Self-contained (no require of cpanel.controller) to avoid a circular dep.
 */

const axios = require("axios");
const fbAds = require("./facebook-ads.service");

const FB_GRAPH = "https://graph.facebook.com/v21.0";

/* Resolve a Page access token from a user token (lead forms need a PAGE token). */
async function getPageToken(userToken, pageId) {
  if (!userToken || !pageId) return userToken;
  try {
    const { data } = await axios.get(`${FB_GRAPH}/me/accounts`, {
      params: { access_token: userToken, fields: "id,access_token", limit: 50 },
    });
    const page = (data?.data || []).find(p => String(p.id) === String(pageId));
    return page?.access_token || userToken;
  } catch (_) { return userToken; }
}

/* Resolve the ad-account id(s) for a user token. Mirrors the cpanel helper. */
async function resolveAdAccounts(userToken, adAccountId) {
  if (adAccountId) return [String(adAccountId).replace(/^act_/, "")];
  const { data } = await axios.get(`${FB_GRAPH}/me/adaccounts`, {
    params: { access_token: userToken, fields: "id", limit: 20 },
  });
  return (data?.data || []).map(a => a.id.replace(/^act_/, ""));
}

/* ── READ: campaigns + today's insights + first creative image ─────────────── */
async function getCampaigns(creds) {
  if (!creds?.userToken) return { campaigns: [], error: "FB credentials not available" };

  let adAccounts;
  try {
    adAccounts = await resolveAdAccounts(creds.userToken, creds.adAccountId);
  } catch (e) {
    const fbMsg = e.response?.data?.error?.message || e.message;
    const fbCode = e.response?.data?.error?.code;
    return { campaigns: [], error: fbCode ? `[FB ${fbCode}] ${fbMsg}` : fbMsg };
  }
  if (!adAccounts.length) return { campaigns: [], error: "No ad accounts found" };

  let capturedFbError = null;
  const rawCampaigns = (await Promise.all(adAccounts.map(async actId => {
    try {
      const { data } = await axios.get(`${FB_GRAPH}/act_${actId}/campaigns`, {
        params: {
          access_token: creds.userToken,
          fields: "id,name,status,effective_status,daily_budget,lifetime_budget,start_time,stop_time,objective",
          filtering: JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE", "PAUSED", "DELETED", "ARCHIVED", "IN_PROCESS", "WITH_ISSUES"] }]),
          limit: 50,
        },
      });
      return data.data || [];
    } catch (err) {
      const fbMsg = err.response?.data?.error?.message || err.message;
      const fbCode = err.response?.data?.error?.code;
      capturedFbError = fbCode ? `[${fbCode}] ${fbMsg}` : fbMsg;
      return [];
    }
  }))).flat();

  if (!rawCampaigns.length && capturedFbError) return { campaigns: [], error: capturedFbError };

  const campaigns = await Promise.all(rawCampaigns.map(async (c) => {
    let spend = 0, leads = 0, impressions = 0, clicks = 0, imageUrl;
    // Only fetch live insights + creative for ACTIVE/PAUSED campaigns. Archived/
    // deleted ones have no live performance, and fetching for all (e.g. 50)
    // hammers the client's FB token → rate limit (code 17). This cuts the call
    // count from ~2×total to ~2×active.
    const live = /ACTIVE|PAUSED|IN_PROCESS|WITH_ISSUES/i.test(c.effective_status || c.status || "");
    const [insightResult, adResult] = live ? await Promise.allSettled([
      axios.get(`${FB_GRAPH}/${c.id}/insights`, {
        params: { access_token: creds.userToken, fields: "spend,actions,impressions,clicks", date_preset: "today" },
      }),
      axios.get(`${FB_GRAPH}/${c.id}/ads`, {
        params: { access_token: creds.userToken, fields: "creative{image_url,thumbnail_url,object_story_spec}", limit: 1 },
      }),
    ]) : [{ status: "skipped" }, { status: "skipped" }];
    if (insightResult.status === "fulfilled") {
      const insight = insightResult.value.data?.data?.[0];
      if (insight) {
        spend = parseFloat(insight.spend || 0);
        impressions = parseInt(insight.impressions || 0, 10);
        clicks = parseInt(insight.clicks || 0, 10);
        const leadAction = insight.actions?.find(a => a.action_type === "lead");
        leads = leadAction ? parseInt(leadAction.value, 10) : 0;
      }
    }
    if (adResult.status === "fulfilled") {
      const cr = adResult.value.data?.data?.[0]?.creative || {};
      imageUrl = cr.image_url || cr.thumbnail_url
              || cr.object_story_spec?.video_data?.image_url
              || cr.object_story_spec?.link_data?.picture
              || undefined;
    }
    const ctr = impressions > 0 ? (clicks / impressions) * 100 : undefined;
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      effectiveStatus: c.effective_status,
      dailyBudget: c.daily_budget ? parseInt(c.daily_budget, 10) / 100 : null,
      spendToday: spend,
      leadsToday: leads,
      objective: c.objective || null,
      imageUrl,
      impressions: impressions || undefined,
      clicks: clicks || undefined,
      ctr,
    };
  }));

  return { campaigns };
}

/* ── READ: per-day leads + spend trend over `days` ─────────────────────────── */
async function getLeadsTrend(creds, days = 30) {
  if (!creds?.userToken) return { total: 0, trend: [], error: "FB credentials not available" };
  const numDays = parseInt(days, 10) || 30;
  const datePreset = numDays <= 7 ? "last_7d" : numDays <= 14 ? "last_14d" : "last_30d";

  let adAccounts;
  try {
    adAccounts = await resolveAdAccounts(creds.userToken, creds.adAccountId);
  } catch (e) {
    return { total: 0, trend: [], error: e.response?.data?.error?.message || e.message };
  }
  if (!adAccounts.length) return { total: 0, trend: [], error: "No ad accounts found" };
  const actId = adAccounts[0];

  let campaignIds = [];
  try {
    const { data: campData } = await axios.get(`${FB_GRAPH}/act_${actId}/campaigns`, {
      params: { access_token: creds.userToken, fields: "id,effective_status", limit: 50 },
    });
    // Only pull per-day insights for live campaigns — archived ones have no
    // recent leads and fetching all of them burns the FB rate limit.
    campaignIds = (campData?.data || [])
      .filter(c => /ACTIVE|PAUSED|IN_PROCESS|WITH_ISSUES/i.test(c.effective_status || ""))
      .map(c => c.id);
  } catch (_) {}

  const trendMap = {};
  let total = 0;
  await Promise.all(campaignIds.map(async cid => {
    try {
      const { data: insRes } = await axios.get(`${FB_GRAPH}/${cid}/insights`, {
        params: { access_token: creds.userToken, fields: "date_start,actions,spend", time_increment: 1, date_preset: datePreset },
      });
      for (const d of insRes?.data || []) {
        const leadAct = d.actions?.find(a => a.action_type === "lead");
        const dayLeads = leadAct ? parseInt(leadAct.value, 10) : 0;
        const daySpend = parseFloat(d.spend || 0);
        if (!trendMap[d.date_start]) trendMap[d.date_start] = { date: d.date_start, leads: 0, spend: 0 };
        trendMap[d.date_start].leads += dayLeads;
        trendMap[d.date_start].spend += daySpend;
        total += dayLeads;
      }
    } catch (_) {}
  }));

  const trend = Object.values(trendMap).sort((a, b) => a.date.localeCompare(b.date));
  return { total, trend, days: numDays };
}

/* ── ACTION: set campaign daily budget (ILS) ───────────────────────────────── */
async function setCampaignBudget(creds, campaignId, dailyBudgetIls) {
  if (!creds?.userToken) throw new Error("FB credentials not available");
  if (!campaignId || !dailyBudgetIls) throw new Error("campaignId and dailyBudgetIls are required");
  const budgetCents = Math.round(parseFloat(dailyBudgetIls) * 100);
  const { data } = await axios.post(`${FB_GRAPH}/${campaignId}`, null, {
    params: { access_token: creds.userToken, daily_budget: budgetCents },
  });
  return { success: true, id: data?.id || campaignId, dailyBudgetIls: parseFloat(dailyBudgetIls) };
}

/* ── ACTION: pause / resume a campaign ─────────────────────────────────────── */
async function setCampaignStatus(creds, campaignId, status) {
  if (!creds?.userToken) throw new Error("FB credentials not available");
  const next = String(status).toUpperCase();
  if (!["ACTIVE", "PAUSED"].includes(next)) throw new Error(`invalid status "${status}"`);
  if (!campaignId) throw new Error("campaignId is required");
  const { data } = await axios.post(`${FB_GRAPH}/${campaignId}`, null, {
    params: { access_token: creds.userToken, status: next },
  });
  return { success: true, id: data?.id || campaignId, status: next };
}

/* ── ACTION: pause / resume a single ad ────────────────────────────────────── */
async function setAdStatus(creds, adId, status) {
  if (!creds?.userToken) throw new Error("FB credentials not available");
  const next = String(status).toUpperCase();
  if (!["ACTIVE", "PAUSED"].includes(next)) throw new Error(`invalid status "${status}"`);
  if (!adId) throw new Error("adId is required");
  const { data } = await axios.post(`${FB_GRAPH}/${adId}`, null, {
    params: { access_token: creds.userToken, status: next },
  });
  return { success: true, id: data?.id || adId, status: next };
}

/* Leads can show under several action_type values depending on campaign type. */
const LEAD_TYPES = new Set([
  "lead",
  "onsite_conversion.lead_grouped",
  "offsite_conversion.fb_pixel_lead",
]);
const sumLeads = (actions) => (actions || [])
  .filter(a => LEAD_TYPES.has(a.action_type))
  .reduce((s, a) => s + parseInt(a.value || 0, 10), 0);

/* Short in-memory cache for campaign ads — repeated "show me the ads" requests
   (and retries after a rate limit) reuse the result instead of re-hitting FB.
   Successful results only; rate-limit/errors are never cached. */
const _adsCache = new Map();
const ADS_TTL_MS = 90 * 1000;

/* ── READ: ads in a campaign + per-ad insights + creative text ─────────────── */
async function getCampaignAds(creds, campaignId) {
  if (!creds?.userToken) return { ads: [], error: "FB credentials not available" };
  if (!campaignId) return { ads: [], error: "campaignId is required" };

  const cached = _adsCache.get(String(campaignId));
  if (cached && (Date.now() - cached.at) < ADS_TTL_MS) return cached.data;

  let rawAds = [];
  try {
    const { data: adsData } = await axios.get(`${FB_GRAPH}/${campaignId}/ads`, {
      params: {
        access_token: creds.userToken,
        fields: "id,name,status,effective_status,adset_id,adset{name},creative{id,image_url,thumbnail_url,video_id,title,body,call_to_action_type,object_story_spec}",
        limit: 50,
      },
    });
    rawAds = adsData?.data || [];
  } catch (err) {
    const fbErr = err.response?.data?.error;
    const fbMsg = fbErr?.message || err.message;
    const fbCode = fbErr?.code;
    const isRateLimit = fbCode === 17 || /request limit/i.test(fbMsg);
    return { ads: [], error: isRateLimit ? "מכסת קריאות פייסבוק חרגה לטוקן של הלקוח. חזור עוד מספר דקות." : fbMsg, rateLimited: isRateLimit };
  }

  const fetchInsights = (datePreset) => axios.get(`${FB_GRAPH}/${campaignId}/insights`, {
    params: {
      access_token: creds.userToken,
      fields: "ad_id,impressions,clicks,spend,reach,ctr,cpm,actions",
      level: "ad", date_preset: datePreset, limit: 500,
    },
  });

  const insAdToday = new Map(), insAdLifetime = new Map();
  const [adToday, adLife] = await Promise.allSettled([fetchInsights("today"), fetchInsights("maximum")]);
  const collect = (settled, map) => {
    if (settled.status !== "fulfilled") return;
    for (const row of settled.value.data?.data || []) if (row.ad_id) map.set(row.ad_id, row);
  };
  collect(adToday, insAdToday);
  collect(adLife, insAdLifetime);

  const pickInsight = (ad) => {
    for (const row of [insAdToday.get(ad.id), insAdLifetime.get(ad.id)]) {
      if (row && parseInt(row.impressions || 0, 10) > 0) return row;
    }
    return null;
  };

  const ads = rawAds.map((ad) => {
    let impressions = 0, clicks = 0, spend = 0, reach = 0, leads = 0, ctr = 0, cpm = 0, costPerLead;
    const r = pickInsight(ad);
    if (r) {
      impressions = parseInt(r.impressions || 0, 10);
      clicks = parseInt(r.clicks || 0, 10);
      spend = parseFloat(r.spend || 0);
      reach = parseInt(r.reach || 0, 10);
      ctr = parseFloat(r.ctr || 0);
      cpm = parseFloat(r.cpm || 0);
      leads = sumLeads(r.actions);
      if (leads > 0 && spend > 0) costPerLead = spend / leads;
    }
    const cr = ad.creative || {};
    const oss = cr.object_story_spec || {};
    return {
      id: ad.id, name: ad.name, status: ad.status, effectiveStatus: ad.effective_status,
      adSetId: ad.adset_id, adSetName: ad.adset?.name,
      creative: {
        id: cr.id,
        imageUrl: cr.image_url || oss.video_data?.image_url || oss.link_data?.picture || cr.thumbnail_url,
        title: cr.title || oss.link_data?.name || oss.video_data?.title,
        body: cr.body || oss.link_data?.message || oss.video_data?.message,
        callToAction: cr.call_to_action_type || oss.link_data?.call_to_action?.type || oss.video_data?.call_to_action?.type,
      },
      insights: { impressions, clicks, spend, ctr, cpm, reach, leads, costPerLead },
    };
  });
  const result = { ads };
  _adsCache.set(String(campaignId), { at: Date.now(), data: result });
  return result;
}

/* ── READ: deep optimization analysis of a campaign ─────────────────────────
   Ranks the ads BY THE NUMBERS (never the model), finds the winner + the
   laggards, and returns pure data-derived optimization hints so the agent can
   propose applying what worked to the rest of the ads. */
async function analyzeCampaign(creds, campaignId) {
  const { ads, error } = await getCampaignAds(creds, campaignId);
  if (error) return { error };
  // only ads that actually ran (have impressions) can be judged
  const ran = ads.filter(a => (a.insights?.impressions || 0) > 0);
  if (!ran.length) return { adsTotal: ads.length, ranWithData: 0, note: "אין עדיין מספיק דאטה (אף מודעה לא צברה חשיפות) כדי לנתח מה עובד." };

  const totalLeads = ran.reduce((s, a) => s + (a.insights.leads || 0), 0);
  const hasLeads = totalLeads > 0;

  // Score: with leads → lower cost-per-lead wins (0-lead ads sink); else → higher CTR wins.
  const score = (a) => {
    const i = a.insights;
    if (hasLeads) return i.leads > 0 && i.costPerLead > 0 ? 1 / i.costPerLead : (i.leads > 0 ? 1 : 0);
    return i.ctr || 0;
  };
  const ranked = [...ran].sort((a, b) => score(b) - score(a));
  const slim = (a) => ({
    id: a.id, name: a.name, status: a.effectiveStatus || a.status,
    imageUrl: a.creative?.imageUrl, headline: a.creative?.title, body: a.creative?.body, cta: a.creative?.callToAction,
    impressions: a.insights.impressions, clicks: a.insights.clicks, spend: Math.round(a.insights.spend),
    leads: a.insights.leads, ctr: a.insights.ctr != null ? Number(a.insights.ctr.toFixed(2)) : null,
    costPerLead: a.insights.costPerLead != null ? Math.round(a.insights.costPerLead) : null,
  });

  const winner = ranked[0];
  const isActive = (a) => /ACTIVE/i.test(a.effectiveStatus || a.status || "");
  // An ad hasn't had a fair test until it spent enough to plausibly produce a
  // lead. Judging a 1₪-spend ad as a "loser" is noise — so require a real spend
  // floor (≈1.5 leads' worth at the winner's rate, but at least 25₪) before an
  // ad can be flagged. Without this, a winner whose cost-per-lead rounds to ~0
  // makes the old "≥30% of winner spend" threshold near-zero and flags everything.
  const winnerCPL = winner.insights.costPerLead || 0;
  const MIN_SPEND_TO_JUDGE = Math.max(25, Math.round(winnerCPL * 1.5));
  // laggards = active ads that spent enough to judge AND clearly underperform the winner
  const laggards = ranked.slice(1).filter(a => {
    if (!isActive(a)) return false;
    const spend = a.insights.spend || 0;
    if (spend < MIN_SPEND_TO_JUDGE) return false;   // too little spend — still learning, not a loser
    if (hasLeads) {
      if ((a.insights.leads || 0) === 0) return true;                                    // real spend, zero leads
      return winnerCPL > 0 && a.insights.costPerLead >= winnerCPL * 1.5;                 // ≥1.5× winner's cost-per-lead
    }
    return (winner.insights.ctr || 0) > 0 && (a.insights.ctr || 0) <= (winner.insights.ctr || 0) * 0.5;
  })
    .sort((a, b) => (b.insights.spend || 0) - (a.insights.spend || 0))  // most money at stake first
    .slice(0, 4);                                                       // keep the recommendation focused

  const hints = [];
  const clearWinner = ranked.length >= 2 && (hasLeads ? (winner.insights.leads || 0) > 0 : (winner.insights.ctr || 0) > 0);
  const cplText = winnerCPL >= 1 ? `${Math.round(winnerCPL)}₪` : "פחות מ-1₪";
  if (clearWinner) {
    hints.push(hasLeads
      ? `המודעה המנצחת "${winner.name}" מביאה לידים בעלות ${cplText} לליד — הכי זולה בקמפיין.`
      : `המודעה המנצחת "${winner.name}" עם ה-CTR הגבוה בקמפיין (${winner.insights.ctr?.toFixed(2)}%).`);
    hints.push(`הכיוון: להחיל את מה שעובד במנצחת (המסר/הזווית/התמונה) על שאר המודעות, ולעצור/לרענן את החלשות.`);
  }
  for (const l of laggards) {
    hints.push(l.insights?.leads === 0 && (l.insights?.spend || 0) > 0
      ? `מודעה "${l.name}" הוציאה ${Math.round(l.insights.spend)}₪ בלי לידים — מועמדת לעצירה או רענון.`
      : `מודעה "${l.name}" מתפקדת מתחת למנצחת — שווה לרענן טקסט/תמונה בסגנון המנצחת.`);
  }
  if (clearWinner && !laggards.length) {
    hints.push("שאר המודעות שרצו עדיין לא צברו מספיק הוצאה כדי לקבוע שהן חלשות — שווה לתת להן עוד זמן או להסיט תקציב למנצחת.");
  }

  return {
    campaignId,
    adsTotal: ads.length,
    ranWithData: ran.length,
    metric: hasLeads ? "cost_per_lead" : "ctr",
    totals: { leads: totalLeads, spend: Math.round(ran.reduce((s, a) => s + (a.insights.spend || 0), 0)) },
    clearWinner,
    winner: slim(winner),
    laggards: laggards.map(slim),
    ranking: ranked.map(slim),
    optimizationHints: hints,
  };
}

/* Convert nested creative payload → flat axios params (Meta wants stringified objects). */
function mapToParams(payload) {
  const out = {};
  for (const [k, v] of Object.entries(payload)) {
    if (v == null) continue;
    out[k] = typeof v === "object" ? JSON.stringify(v) : v;
  }
  return out;
}

/* ── ACTION: replace an ad's text (title/body/CTA). Meta can't edit creative
   text in place, so we read the creative → build a new one → repoint the ad. ── */
async function updateAdText(creds, adId, { title, body, callToAction, link, imageUrl, status, leadFormId } = {}) {
  if (!creds?.userToken) throw new Error("FB credentials not available");
  if (!adId) throw new Error("adId is required");
  if (title === undefined && body === undefined && callToAction === undefined && link === undefined && imageUrl === undefined && leadFormId === undefined) {
    throw new Error("nothing to update — provide title, body, callToAction, link, imageUrl, or leadFormId");
  }

  const { data: adData } = await axios.get(`${FB_GRAPH}/${adId}`, {
    params: {
      access_token: creds.userToken,
      fields: "account_id,creative{id,object_story_spec,image_hash,image_url,link_url,name,call_to_action_type}",
    },
  });
  const cr = adData.creative || {};
  const oss = cr.object_story_spec ? JSON.parse(JSON.stringify(cr.object_story_spec)) : null;
  const accountId = adData.account_id;
  if (!accountId) throw new Error("ad has no account_id");

  // Swapping the creative image → upload the new picture's BYTES to the ad
  // account's image library first (Meta references creative images by hash, and
  // url-upload needs a special capability — see uploadAdImage). Do it once here.
  let newImageHash;
  if (imageUrl !== undefined) {
    if (oss && oss.video_data) throw new Error("זו מודעת וידאו — לא ניתן להחליף בה תמונה. אפשר לשנות טקסט/לינק/כפתור.");
    newImageHash = await fbAds.uploadAdImage(creds.userToken, `act_${String(accountId).replace(/^act_/, "")}`, imageUrl);
    if (!newImageHash) throw new Error("העלאת התמונה החדשה למטא נכשלה");
  }

  let creativePayload;
  if (oss && oss.link_data) {
    if (title !== undefined) oss.link_data.name = title;
    if (body !== undefined) oss.link_data.message = body;
    if (newImageHash) {
      oss.link_data.image_hash = newImageHash;  // point the creative at the new image
      delete oss.link_data.picture;             // drop any URL-based image to avoid a conflict
    }
    if (link !== undefined) {
      oss.link_data.link = link;   // the ad's destination URL
      // update the CTA's link only if it currently links out (traffic ad); a
      // lead-gen CTA value holds { lead_gen_form_id } — never overwrite that.
      if (oss.link_data.call_to_action?.value?.link) oss.link_data.call_to_action.value.link = link;
    }
    if (callToAction !== undefined) {
      oss.link_data.call_to_action = oss.link_data.call_to_action || {};
      oss.link_data.call_to_action.type = callToAction;
      if (!oss.link_data.call_to_action.value) {
        oss.link_data.call_to_action.value = { link: oss.link_data.link || "https://iconiqmedia.co.il" };
      }
    }
    if (leadFormId !== undefined) {
      // Point the ad at a (new) lead form. Meta forms are immutable, so "changing
      // questions" = create a new form + repoint here. Keep the existing CTA type
      // (or SIGN_UP), and keep an external link on link_data (FB policy 1815316).
      oss.link_data.call_to_action = {
        type: oss.link_data.call_to_action?.type || "SIGN_UP",
        value: { lead_gen_form_id: String(leadFormId) },
      };
      if (!oss.link_data.link) oss.link_data.link = "https://iconiqmedia.co.il";
    }
    creativePayload = { object_story_spec: oss };
  } else if (oss && oss.video_data) {
    if (title !== undefined) oss.video_data.title = title;
    if (body !== undefined) oss.video_data.message = body;
    if (link !== undefined && oss.video_data.call_to_action?.value?.link) oss.video_data.call_to_action.value.link = link;
    if (callToAction !== undefined) {
      oss.video_data.call_to_action = oss.video_data.call_to_action || {};
      oss.video_data.call_to_action.type = callToAction;
    }
    if (leadFormId !== undefined) {
      oss.video_data.call_to_action = {
        type: oss.video_data.call_to_action?.type || "SIGN_UP",
        value: { lead_gen_form_id: String(leadFormId) },
      };
    }
    creativePayload = { object_story_spec: oss };
  } else if (cr.image_url || cr.image_hash) {
    creativePayload = {
      name: cr.name || `Updated ${Date.now()}`,
      // new image → use the fresh hash and drop the old url; otherwise keep both.
      image_hash: newImageHash || cr.image_hash,
      ...(newImageHash ? {} : { image_url: cr.image_url }),
      link_url: link ?? (cr.link_url || "https://iconiqmedia.co.il"),
      message: body ?? "", title: title ?? cr.name,
      call_to_action_type: callToAction ?? cr.call_to_action_type,
    };
  } else {
    throw new Error("creative shape not supported for inline edit — manual update required");
  }

  const { data: createRes } = await axios.post(
    `${FB_GRAPH}/act_${String(accountId).replace(/^act_/, "")}/adcreatives`,
    null,
    { params: { access_token: creds.userToken, ...mapToParams(creativePayload) } },
  );
  const newCreativeId = createRes.id;
  if (!newCreativeId) throw new Error("Meta did not return new creative_id");

  const adUpdateParams = { access_token: creds.userToken, creative: JSON.stringify({ creative_id: newCreativeId }) };
  if (status && ["ACTIVE", "PAUSED"].includes(status)) adUpdateParams.status = status;
  const { data: updateRes } = await axios.post(`${FB_GRAPH}/${adId}`, null, { params: adUpdateParams });
  return { success: !!updateRes.success, creativeId: newCreativeId };
}

/* ── ACTION: change the DESTINATION LINK across a client's live ads ──────────
   The client's site URL is wrong in their published ads → point them all at the
   correct URL. Scoped to one campaign (campaignId) or, by default, the ads in
   the client's ACTIVE campaigns (what's actually serving). Capped to bound Meta
   calls; per-ad failures don't abort the batch. Lead forms are preserved. */
async function updateAdsLink(creds, { link, campaignId, maxAds = 12 } = {}) {
  if (!creds?.userToken) throw new Error("FB credentials not available");
  let url = String(link || "").trim();
  if (!url) throw new Error("link is required");
  if (!/^https?:\/\//i.test(url)) url = "https://" + url.replace(/^\/+/, "");
  try { new URL(url); } catch { throw new Error(`כתובת לא תקינה: ${link}`); }

  // resolve the target campaigns
  let campaignIds = [];
  if (campaignId) {
    campaignIds = [String(campaignId)];
  } else {
    const { campaigns = [] } = await getCampaigns(creds);
    campaignIds = campaigns
      .filter(c => /ACTIVE/i.test(c.effectiveStatus || c.status || ""))
      .map(c => c.id);
    if (!campaignIds.length) campaignIds = campaigns.slice(0, 3).map(c => c.id); // fallback: recent
  }

  // collect ads across those campaigns (cap total)
  const adList = [];
  for (const cid of campaignIds) {
    if (adList.length >= maxAds) break;
    const { ads = [] } = await getCampaignAds(creds, cid);
    for (const a of ads) {
      if (adList.length >= maxAds) break;
      if (a?.id && !/DELETED|ARCHIVED/i.test(a.effectiveStatus || a.status || "")) adList.push({ id: a.id, name: a.name });
    }
  }
  if (!adList.length) return { updated: 0, failed: 0, total: 0, link: url, note: "לא נמצאו מודעות פעילות לעדכון" };

  let updated = 0, failed = 0;
  const details = [];
  for (const ad of adList) {
    try {
      await updateAdText(creds, ad.id, { link: url });
      updated++;
      details.push({ adId: ad.id, name: ad.name, ok: true });
    } catch (e) {
      failed++;
      details.push({ adId: ad.id, name: ad.name, ok: false, error: e.response?.data?.error?.message || e.message });
    }
  }
  return { updated, failed, total: adList.length, link: url, details };
}

/* ── ACTION: duplicate a (winning) ad within its own ad set ─────────────────
   "Scale the winner" — clone the ad so it gets a fresh delivery start under the
   same ad set + budget (CBO redistributes the existing budget; this does NOT
   raise spend on its own). Reuses the same creative_id. Starts PAUSED so the
   client's approval → resume is an explicit, visible step. */
async function duplicateAd(creds, adId, { status = "PAUSED" } = {}) {
  if (!creds?.userToken) throw new Error("FB credentials not available");
  if (!adId) throw new Error("adId is required");

  const { data: ad } = await axios.get(`${FB_GRAPH}/${adId}`, {
    params: { access_token: creds.userToken, fields: "account_id,adset_id,name,creative{id}" },
  });
  const accountId = ad.account_id;
  const adsetId = ad.adset_id;
  const creativeId = ad.creative?.id;
  if (!accountId || !adsetId || !creativeId) {
    throw new Error("לא ניתן לשכפל מודעה זו (חסר adset/creative) — נסה מודעה אחרת");
  }

  const newName = `${ad.name || "Ad"} (עותק)`.slice(0, 100);
  const { data } = await axios.post(
    `${FB_GRAPH}/act_${String(accountId).replace(/^act_/, "")}/ads`,
    null,
    {
      params: {
        access_token: creds.userToken,
        name: newName,
        adset_id: adsetId,
        creative: JSON.stringify({ creative_id: creativeId }),
        status: ["ACTIVE", "PAUSED"].includes(status) ? status : "PAUSED",
      },
    },
  );
  if (!data?.id) throw new Error("מטא לא החזירה מזהה למודעה החדשה");
  return { success: true, newAdId: data.id, name: newName, status, sourceAdId: adId };
}

/* ── ACTION: delete an ad (Meta soft-deletes → status DELETED) ──────────────── */
async function deleteAd(creds, adId) {
  if (!creds?.userToken) throw new Error("FB credentials not available");
  if (!adId) throw new Error("adId is required");
  const { data } = await axios.delete(`${FB_GRAPH}/${adId}`, { params: { access_token: creds.userToken } });
  return { success: !!data.success, id: adId };
}

/* ── READ: Facebook targeting search (geo / interests / locales) ────────────── */
async function searchTargeting(creds, { type = "adgeolocation", q } = {}) {
  if (!creds?.userToken) return { results: [], error: "FB credentials not available" };
  if (!q || !String(q).trim()) return { results: [] };
  const params = { access_token: creds.userToken, type, q: String(q).trim(), locale: "he_IL", limit: 25 };
  if (type === "adgeolocation") params.location_types = ["city", "region", "country", "subcity", "neighborhood"];
  const { data } = await axios.get(`${FB_GRAPH}/search`, { params });
  return { results: Array.isArray(data?.data) ? data.data : [] };
}

/* ── ACTION: update an ad set's audience targeting (geo/gender quirks verbatim) ── */
async function updateAdAudience(creds, adSetId, audience = {}) {
  if (!creds?.userToken) throw new Error("FB credentials not available");
  if (!adSetId) throw new Error("adSetId is required");
  const { ageMin, ageMax, genders, locations, interests, customAudiences, excludedAudiences, placements } = audience;

  const targeting = {};
  if (ageMin != null) targeting.age_min = Number(ageMin);
  if (ageMax != null) targeting.age_max = Number(ageMax);
  if (Array.isArray(genders) && genders.length) {
    const fbGenders = [];
    if (genders.includes("male")) fbGenders.push(1);
    if (genders.includes("female")) fbGenders.push(2);
    if (fbGenders.length === 1) targeting.genders = fbGenders;
  }
  if (Array.isArray(locations) && locations.length) {
    const empty = () => ({ countries: [], regions: [], cities: [] });
    const inc = empty(), exc = empty();
    let incHas = false, excHas = false;
    for (const l of locations) {
      if (!l) continue;
      const bucket = l.include === false ? exc : inc;
      if (l.include === false) excHas = true; else incHas = true;
      if (l.type === "country") {
        if (l.key) bucket.countries.push(l.key);
      } else if (l.type === "region") {
        if (l.key) bucket.regions.push({ key: String(l.key) });
      } else if (l.type === "city" || l.type === "address") {
        if (l.key) bucket.cities.push({ key: String(l.key), radius: Number(l.radiusKm) > 0 ? Number(l.radiusKm) : 17, distance_unit: "kilometer" });
      }
    }
    const compact = (b) => {
      const out = {};
      if (b.countries.length) out.countries = b.countries;
      if (b.regions.length) out.regions = b.regions;
      if (b.cities.length) out.cities = b.cities;
      return out;
    };
    if (incHas) targeting.geo_locations = compact(inc);
    if (excHas) targeting.excluded_geo_locations = compact(exc);
  }
  if (Array.isArray(interests) && interests.length) {
    targeting.interests = interests.filter(i => i.id).map(i => ({ id: i.id, name: i.name }));
  }
  if (Array.isArray(customAudiences) && customAudiences.length) {
    targeting.custom_audiences = customAudiences.map(a => ({ id: a.id }));
  }
  if (Array.isArray(excludedAudiences) && excludedAudiences.length) {
    targeting.excluded_custom_audiences = excludedAudiences.map(a => ({ id: a.id }));
  }
  if (Array.isArray(placements) && placements.length) {
    targeting.publisher_platforms = placements;
  }

  const { data } = await axios.post(`${FB_GRAPH}/${adSetId}`, null, {
    params: { access_token: creds.userToken, targeting: JSON.stringify(targeting) },
  });
  return { success: !!data.success, id: adSetId };
}

/* ── ACTION: launch a NEW campaign end-to-end (reuses the proven 7-step
   facebook-ads.service pipeline, same order as the CPANEL launch flow). The ad
   is created PAUSED, so the campaign delivers nothing until a human/agent
   activates it — a built-in safety net on top of the approval gate. ── */
async function launchCampaign(creds, args = {}) {
  if (!creds?.userToken) throw new Error("FB credentials not available");
  const {
    campaignType = "leads", name, dailyBudgetIls, imageUrl, imageUrls,
    headline, subheadline, proofLine, websiteUrl, privacyUrl,
  } = args;
  if (!["leads", "traffic"].includes(campaignType)) throw new Error(`invalid campaignType "${campaignType}"`);
  if (!name) throw new Error("name is required");
  // One ad per image. imageUrls[] → a multi-creative campaign (cap 5); a single
  // imageUrl keeps the original one-ad path byte-for-byte (imgs=[imageUrl]).
  const imgs = (Array.isArray(imageUrls) && imageUrls.length ? imageUrls : [imageUrl]).filter(Boolean).slice(0, 5);
  if (!imgs.length) throw new Error("imageUrl is required (use an existing creative image from get_campaign_ads)");
  if (!headline) throw new Error("headline is required");
  if (campaignType === "traffic" && !websiteUrl) throw new Error("websiteUrl is required for a traffic campaign");

  const accounts = await resolveAdAccounts(creds.userToken, creds.adAccountId);
  if (!accounts.length) throw new Error("no ad account for this client");
  const actId = `act_${accounts[0]}`;
  const pageId = creds.pageId;
  if (!pageId) throw new Error("client has no Facebook page id");

  const linkUrl = (campaignType === "traffic" ? websiteUrl : (websiteUrl || privacyUrl)) || "https://iconiqmedia.co.il";

  const campaignId = await fbAds.createCampaign(creds.userToken, actId, name, campaignType);
  // Everything after the campaign is wrapped so a mid-way failure ROLLS BACK the
  // campaign (deleting it cascades to adset+ad) — otherwise a failed launch would
  // leave an empty orphan campaign on the client's account.
  try {
    if (Number.isFinite(parseFloat(dailyBudgetIls)) && parseFloat(dailyBudgetIls) > 0) {
      try { await setCampaignBudget(creds, campaignId, dailyBudgetIls); } catch (e) { console.warn("[launch] budget set failed:", e.message); }
    }
    const adsetId = await fbAds.createAdSet(creds.userToken, actId, campaignId, pageId, campaignType);

    // Lead form INLINE (shared by every ad). FB requires follow_up_action_text
    // TOGETHER with follow_up_action_url and rejects extra fields — the shared
    // createLeadForm omits follow_up_action_text → "Invalid parameter". Mirror the
    // working CPANEL launch (cpanel.controller ~5822) exactly.
    let formId = null;
    if (campaignType === "leads") {
      const pageToken = await getPageToken(creds.userToken, pageId);
      const formFields = new URLSearchParams();
      formFields.append("name", `ליד - ${name} - ${Date.now()}`.slice(0, 100));
      formFields.append("privacy_policy", JSON.stringify({ url: linkUrl, link_text: "מדיניות פרטיות" }));
      formFields.append("questions", JSON.stringify([{ type: "FULL_NAME" }, { type: "PHONE" }]));
      formFields.append("follow_up_action_text", "תודה! ניצור איתך קשר בהקדם.");
      formFields.append("follow_up_action_url", linkUrl);
      formFields.append("locale", "he_IL");
      const formRes = await axios.post(
        `${FB_GRAPH}/${pageId}/leadgen_forms`,
        formFields.toString(),
        { headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Bearer ${pageToken}` } },
      );
      formId = formRes.data?.id;
      if (!formId) throw new Error("lead form creation returned no id");
    }

    // One creative + ad PER IMAGE, all under the same adset + lead form. A single
    // image runs this loop exactly once (identical to the original one-ad flow).
    const adIds = [];
    for (let i = 0; i < imgs.length; i++) {
      const imageHash = await fbAds.uploadAdImage(creds.userToken, actId, imgs[i]);
      // Creative INLINE — FB policy 1815316: lead-gen ads MUST carry an external
      // link_data.link even when the form opens on-platform.
      const objectStorySpec = {
        page_id: pageId,
        link_data: {
          link: linkUrl,
          message: [subheadline, proofLine].filter(Boolean).join("\n"),
          name: headline,
          ...(imageHash ? { image_hash: imageHash } : {}),
          call_to_action: {
            type: campaignType === "leads" ? "SIGN_UP" : "LEARN_MORE",
            value: campaignType === "leads" && formId ? { lead_gen_form_id: formId } : { link: linkUrl },
          },
        },
      };
      const { data: cr } = await axios.post(
        `${FB_GRAPH}/${actId}/adcreatives`,
        new URLSearchParams({
          name: String(name).slice(0, 100),
          object_story_spec: JSON.stringify(objectStorySpec),
          access_token: creds.userToken,
        }).toString(),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
      );
      const creativeId = cr.id;
      if (!creativeId) throw new Error("creative creation returned no id");
      const adName = imgs.length > 1 ? `${name} - מודעה ${i + 1}` : `${name} - מודעה`;
      const adId = await fbAds.createAd(creds.userToken, actId, adsetId, creativeId, adName);
      adIds.push(adId);
    }

    return {
      success: true, campaignId, adSetId: adsetId, adId: adIds[0], adIds, adsCreated: adIds.length,
      note: `הקמפיין נוצר עם ${adIds.length} מודעות. המודעות במצב PAUSED ולא ירוצו עד שתופעלנה — כך אפשר לבדוק לפני שמתחילים להוציא תקציב.`,
    };
  } catch (e) {
    try {
      await axios.delete(`${FB_GRAPH}/${campaignId}`, { params: { access_token: creds.userToken } });
      console.log(`[launch] rolled back campaign ${campaignId} after failure: ${e.message}`);
    } catch (delErr) { console.warn(`[launch] rollback delete failed for ${campaignId}:`, delErr.message); }
    throw e;
  }
}

/* ── READ: account-wide "what worked best + its style" ───────────────────────
   Scans ALL of the client's ads (across ad accounts), ranks them by real
   performance (adScoring: CTR + conversion + quality + cost-per-lead), and
   extracts the WINNING STYLE (dominant structure, recurring hooks/CTAs, tone,
   pain/benefit words, top examples) via the existing strategyBuilder — the same
   engine the app's ad-creative wizard uses. Returns the winner(s) WITH their
   campaignId/adSetId/adId + creative image, so the agent can build a new ad IN
   THE EXISTING campaign (duplicate_ad the winner → restyle) instead of spinning
   up an unrelated new campaign. Read-only. */
async function getWinningAdsStyle(creds, { targetCpl = 20, limit = 3 } = {}) {
  if (!creds?.userToken) return { error: "FB credentials not available" };
  const adScoring = require("../utils/adScoring");
  const { buildStrategy } = require("./strategyBuilder.service");

  let adAccounts;
  try {
    adAccounts = await resolveAdAccounts(creds.userToken, creds.adAccountId);
  } catch (e) {
    return { error: e.response?.data?.error?.message || e.message };
  }
  if (!adAccounts.length) return { error: "No ad accounts found" };

  const rawAds = [];
  for (const actId of adAccounts) {
    try {
      const { data } = await axios.get(`${FB_GRAPH}/act_${actId}/ads`, {
        params: {
          access_token: creds.userToken,
          fields: "id,name,effective_status,campaign_id,adset_id,creative{image_url,thumbnail_url,object_story_spec},insights.date_preset(maximum){impressions,clicks,inline_link_clicks,spend,ctr,actions,quality_ranking}",
          filtering: JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE", "PAUSED"] }]),
          limit: 100,
        },
      });
      for (const ad of data?.data || []) rawAds.push(ad);
    } catch (err) {
      const fbMsg = err.response?.data?.error?.message || err.message;
      const fbCode = err.response?.data?.error?.code;
      if (fbCode === 17 || /request limit/i.test(fbMsg)) {
        return { error: "מכסת קריאות פייסבוק חרגה — נסה שוב עוד מספר דקות.", rateLimited: true };
      }
      // otherwise skip this ad account, keep going
    }
  }

  const scored = rawAds
    .map((ad) => {
      const ins = (ad.insights?.data && ad.insights.data[0]) || {};
      const row = {
        impressions: ins.impressions, spend: ins.spend, clicks: ins.clicks,
        inline_link_clicks: ins.inline_link_clicks, actions: ins.actions, quality_ranking: ins.quality_ranking,
      };
      const impressions = parseInt(ins.impressions || 0, 10);
      const spend = parseFloat(ins.spend || 0);
      const ctr = parseFloat(ins.ctr || 0);
      const leads = adScoring.sumLeads(ins.actions);
      const cpl = leads > 0 && spend > 0 ? spend / leads : null;
      const oss = ad.creative?.object_story_spec || {};
      const ld = oss.link_data || oss.video_data || {};
      return {
        id: ad.id, campaignId: ad.campaign_id, adSetId: ad.adset_id, name: ad.name,
        effectiveStatus: ad.effective_status,
        score: adScoring.scoreAd(row, targetCpl),
        impressions, spend: Math.round(spend), leads,
        ctr: ctr ? Number(ctr.toFixed(2)) : null,
        costPerLead: cpl != null ? Math.round(cpl) : null,
        imageUrl: ad.creative?.image_url || ld.picture || ad.creative?.thumbnail_url || null,
        headline: ld.name || "",
        body: (ld.message || "").slice(0, 300),
        cta: ld.call_to_action?.type || "",
        creative: ad.creative, // kept so buildStrategy can read object_story_spec
      };
    })
    .filter((a) => a.impressions > 0 && a.creative?.object_story_spec);

  if (!scored.length) {
    return { adsScanned: rawAds.length, winners: [], note: "אין עדיין מספיק דאטה (מודעות עם טקסט וחשיפות) כדי לזהות סגנון מנצח. אפשר להתחיל קמפיין חדש." };
  }

  const sorted = [...scored].sort((a, b) => b.score - a.score);
  const above = sorted.filter((a) => a.score >= 60);
  const top = (above.length >= limit ? above : sorted).slice(0, limit);

  let style = null;
  try { style = buildStrategy(top); } catch (_) { /* style is best-effort */ }

  const slim = (a) => ({
    adId: a.id, campaignId: a.campaignId, adSetId: a.adSetId, name: a.name,
    score: a.score, leads: a.leads, spend: a.spend, ctr: a.ctr, costPerLead: a.costPerLead,
    imageUrl: a.imageUrl, headline: a.headline, body: a.body, cta: a.cta,
  });
  const winners = top.map(slim);

  return {
    adsScanned: scored.length,
    metric: winners.some((w) => w.leads > 0) ? "cost_per_lead" : "ctr",
    winner: winners[0],
    winners,
    style,
  };
}

/* ── LEAD FORMS ──────────────────────────────────────────────────────────────
   Meta lead forms are IMMUTABLE: you can't edit an existing form's questions.
   "Change a question" therefore = create a NEW form with the new questions, then
   repoint the chosen ad at it (updateAdText with leadFormId). ── */

const STD_LEAD_QUESTIONS = new Set([
  "FULL_NAME", "FIRST_NAME", "LAST_NAME", "PHONE", "EMAIL", "CITY", "COMPANY_NAME", "JOB_TITLE",
]);

/* Map the agent's simple question list → Meta's questions[] shape. Each item is
   either a standard type string ("FULL_NAME"/"PHONE"/"EMAIL"/…) or an object
   { type, label?, options? } — a CUSTOM question carries a label, and options[]
   turns it into a multiple-choice question. */
function mapLeadQuestions(list) {
  const out = [];
  for (const q of Array.isArray(list) ? list : []) {
    if (typeof q === "string") {
      const t = q.toUpperCase().trim();
      if (STD_LEAD_QUESTIONS.has(t)) out.push({ type: t });
      // CUSTOM questions need an ASCII `key` (Meta rejects/erratically-errors
      // without one, esp. with Hebrew labels).
      else if (t) out.push({ type: "CUSTOM", key: `custom_${out.length}`, label: q.slice(0, 300) });
      continue;
    }
    if (q && typeof q === "object") {
      const t = String(q.type || "").toUpperCase().trim();
      if (STD_LEAD_QUESTIONS.has(t)) { out.push({ type: t }); continue; }
      const label = q.label || q.question || q.text;
      if (!label) continue;
      const key = `custom_${out.length}`;
      const cq = { type: "CUSTOM", key, label: String(label).slice(0, 300) };
      if (Array.isArray(q.options) && q.options.length) {
        // Meta requires each choice option to carry BOTH key AND value — sending
        // only {value} is what caused "An unknown error has occurred".
        cq.options = q.options.filter(Boolean).slice(0, 10).map((o, i) => ({ key: `${key}_opt${i}`, value: String(o).slice(0, 120) }));
      }
      out.push(cq);
    }
  }
  return out;
}

/* Create a NEW lead form on the client's page with the given questions. Mirrors
   the proven inline recipe in launchCampaign (urlencoded + page-token Bearer). */
async function createLeadForm(creds, { name, questions, privacyUrl, followUpText, followUpUrl } = {}) {
  if (!creds?.userToken) throw new Error("FB credentials not available");
  const pageId = creds.pageId;
  if (!pageId) throw new Error("client has no Facebook page id");
  const pageToken = await getPageToken(creds.userToken, pageId);

  let qs = mapLeadQuestions(questions);
  if (!qs.length) qs = [{ type: "FULL_NAME" }, { type: "PHONE" }]; // sane default
  const priv = privacyUrl || "https://iconiqmedia.co.il";

  const formFields = new URLSearchParams();
  formFields.append("name", `${name || "טופס לידים"} - ${Date.now()}`.slice(0, 100));
  formFields.append("privacy_policy", JSON.stringify({ url: priv, link_text: "מדיניות פרטיות" }));
  formFields.append("questions", JSON.stringify(qs));
  formFields.append("follow_up_action_text", followUpText || "תודה! ניצור איתך קשר בהקדם.");
  formFields.append("follow_up_action_url", followUpUrl || priv);
  formFields.append("locale", "he_IL");

  const { data } = await axios.post(
    `${FB_GRAPH}/${pageId}/leadgen_forms`,
    formFields.toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Bearer ${pageToken}` } },
  );
  if (!data?.id) throw new Error("מטא לא החזירה מזהה לטופס");
  return { formId: data.id, questions: qs };
}

/* Read the lead form currently attached to an ad + its questions (so the agent
   can show what's there before changing). Returns hasForm:false for non-lead ads. */
async function getAdLeadForm(creds, adId) {
  if (!creds?.userToken) return { error: "FB credentials not available" };
  if (!adId) return { error: "adId is required" };
  let oss = {};
  try {
    const { data: ad } = await axios.get(`${FB_GRAPH}/${adId}`, {
      params: { access_token: creds.userToken, fields: "creative{object_story_spec}" },
    });
    oss = ad.creative?.object_story_spec || {};
  } catch (e) {
    return { error: e.response?.data?.error?.message || e.message };
  }
  const cta = oss.link_data?.call_to_action || oss.video_data?.call_to_action || {};
  const formId = cta.value?.lead_gen_form_id || null;
  if (!formId) return { hasForm: false, note: "למודעה הזו אין טופס לידים מחובר (ייתכן שזו מודעת תנועה או סוג אחר)." };
  try {
    const pageToken = await getPageToken(creds.userToken, creds.pageId);
    const { data: form } = await axios.get(`${FB_GRAPH}/${formId}`, {
      params: { access_token: pageToken, fields: "name,status,locale,questions" },
    });
    return {
      hasForm: true, formId, name: form.name, status: form.status,
      questions: (form.questions || []).map((q) => ({ type: q.type, label: q.label || q.key || null })),
    };
  } catch (e) {
    return { hasForm: true, formId, error: e.response?.data?.error?.message || e.message };
  }
}

module.exports = {
  FB_GRAPH,
  getWinningAdsStyle,
  mapLeadQuestions,
  createLeadForm,
  getAdLeadForm,
  resolveAdAccounts,
  getPageToken,
  getCampaigns,
  getLeadsTrend,
  getCampaignAds,
  analyzeCampaign,
  setCampaignBudget,
  setCampaignStatus,
  setAdStatus,
  updateAdText,
  updateAdsLink,
  duplicateAd,
  deleteAd,
  searchTargeting,
  updateAdAudience,
  launchCampaign,
  mapToParams,
};
