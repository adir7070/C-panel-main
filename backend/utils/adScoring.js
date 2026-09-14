// === helpers ===
const num = (x, d = 0) => (isFinite(Number(x)) ? Number(x) : d);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const parseActionsLoose = (raw) => {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'object') return [raw];
  try {
    const j = JSON.parse(raw);
    return Array.isArray(j) ? j : [j];
  } catch {}
  const text = String(raw);
  const re = /"action_type"\s*:\s*"([^"]+)"\s*,\s*"value"\s*:\s*"?(-?\d+(?:\.\d+)?)"?/g;
  const out = [];
  let m;
  while ((m = re.exec(text))) out.push({ action_type: m[1], value: Number(m[2]) });
  return out;
};

const sumLeads = (actions) => {
  const arr = parseActionsLoose(actions);
  const leadKeys = new Set([
    'lead',
    'leadgen_other',
    'onsite_conversion.lead_grouped',
    'offsite_complete_registration_add_meta_leads',
    'offsite_content_view_add_meta_leads',
  ]);
  let tot = 0;
  for (const a of arr) {
    if (a && leadKeys.has(String(a.action_type || ''))) tot += num(a.value, 0);
  }
  return tot;
};

const qualityToNum = (qRaw) => {
  const q = String(qRaw || '').toUpperCase();
  if (q === 'ABOVE_AVERAGE') return 1.0;
  if (q === 'AVERAGE') return 0.5;
  if (q.startsWith('BELOW_AVERAGE')) return 0.25;
  return 0.5; // UNKNOWN/חסר
};

/**
 * Calculates a score for an ad based on its performance metrics.
 * @param {Object} row - The ad object combining ad data and insights.
 * @param {Number} targetCpl - Target Cost Per Lead (default 20).
 * @returns {Number} Score between 0 and 100 with one decimal place.
 */
const scoreAd = (row, targetCpl = 20) => {
  const impressions = Math.max(num(row.impressions, 0), 1);
  const spend = Math.max(num(row.spend, 0), 0);
  const ilc = num(row.inline_link_clicks, 0);
  const clicks = num(row.clicks, 0);
  const clicksUsed = ilc > 0 ? ilc : clicks > 0 ? clicks : 1;
  const leads = sumLeads(row.actions);
  const qualityN = qualityToNum(row.quality_ranking);

  const ctr = (100 * clicksUsed) / impressions;
  const cvr = 100 * (leads / (clicksUsed || 1));
  const cpl = leads > 0 ? spend / leads : null;

  const ctrRef = 3;
  const cvrRef = 15;
  const cplRef = targetCpl; // אפשר להפוך לפרמטרים אם תרצה
  const ctrN = clamp(ctr / ctrRef, 0, 1);
  const cvrN = clamp(cvr / cvrRef, 0, 1);
  const cplN = 1 - clamp(cpl != null && cplRef > 0 ? cpl / cplRef : 1, 0, 1);

  const score01 = 0.2 * ctrN + 0.25 * cvrN + 0.15 * qualityN + 0.4 * cplN;
  return Math.round(clamp(score01, 0, 1) * 1000) / 10; // 0..100 בעשירית
};

module.exports = {
  scoreAd,
  sumLeads,
  qualityToNum,
  parseActionsLoose,
};
