'use strict';

/**
 * action-quality — a deterministic (no LLM) gate that runs BEFORE the policy
 * chokepoint on every write tool. It blocks vague / placeholder / nonsensical
 * arguments from ever reaching Facebook or billing, and returns a Hebrew
 * "ask the client" note so the MODEL turns the failure into a clarifying
 * question instead of a broken action.
 *
 * Complements policy.engine (which decides auto/approval/block on LEGIT args);
 * this rejects args that shouldn't execute in any mode. Pure + unit-testable.
 */

const GENERIC = ["מודעה", "קמפיין", "פרסום", "בדיקה", "טסט", "test", "חדש", "כללי", "רגיל", "משהו", "new", "ad", "campaign"];

const isGeneric = (s) => {
  const t = String(s || "").trim().toLowerCase();
  if (!t) return true;
  return GENERIC.some(g => t === g || t === `${g} חדש` || t === `${g} חדשה`);
};
const len = (s) => String(s || "").trim().length;

const RULES = {
  launch_campaign(args) {
    if (len(args.name) < 4 || isGeneric(args.name))
      return "שם הקמפיין כללי מדי — שאל את הלקוח מה שם/נושא הקמפיין (למשל לפי השירות המקודם).";
    if (len(args.headline) < 6 || isGeneric(args.headline))
      return "כותרת המודעה חסרה או כללית מדי — נסח כותרת ממוקדת לפי העסק והמטרה, או שאל את הלקוח מה המסר.";
    const b = parseFloat(args.dailyBudgetIls);
    if (args.dailyBudgetIls != null && (!Number.isFinite(b) || b < 10 || b > 500))
      return "התקציב היומי לא סביר (מתחת ל-10₪ או מעל 500₪) — ודא עם הלקוח מה התקציב הרצוי.";
    if (args.campaignType === "traffic" && !/^https?:\/\//.test(String(args.websiteUrl || "")))
      return "לקמפיין תנועה חסרה כתובת אתר תקינה — שאל את הלקוח לאיזה עמוד להפנות.";
    return null;
  },
  update_budget(args, rc) {
    const b = parseFloat(args.dailyBudgetIls);
    if (!Number.isFinite(b) || b < 5 || b > 1000)
      return "ערך התקציב לא סביר — ודא עם הלקוח מה התקציב היומי הרצוי בשקלים.";
    const known = (rc?.view?.performance?.campaigns || []).some(c => String(c.id) === String(args.campaignId));
    if (rc?.view?.performance?.campaigns?.length && !known)
      return "ה-campaignId לא נמצא ברשימת הקמפיינים של הלקוח — קרא ל-get_performance וקח מזהה אמיתי.";
    return null;
  },
  update_ad_text(args) {
    if (!len(args.title) && !len(args.body) && !len(args.callToAction))
      return "לא סופק שום טקסט חדש — שאל את הלקוח מה בדיוק לשנות (כותרת? תיאור?).";
    if ((args.title && isGeneric(args.title)) || (args.body && isGeneric(args.body)))
      return "הטקסט החדש כללי מדי — נסח טקסט אמיתי לפי בקשת הלקוח או שאל אותו מה המסר.";
    return null;
  },
  generate_ad_image(args) {
    if (len(args.concept) < 8 || isGeneric(args.concept))
      return "הקונספט לתמונה עמום מדי — נסח תיאור ויזואלי ממשי (נושא, אווירה, סגנון) לפי העסק, או שאל את הלקוח לכיוון.";
    return null;
  },
  edit_ad_image(args) {
    if (len(args.text) < 2)
      return "חסר הטקסט שיופיע על התמונה — שאל את הלקוח מה בדיוק לכתוב עליה.";
    if (len(args.text) > 200)
      return "הטקסט לתמונה ארוך מדי (מעל 200 תווים) — בקש מהלקוח נוסח קצר וממוקד.";
    return null;
  },
  create_social_campaign(args) {
    const n = parseInt(args.count, 10);
    if (args.count != null && (!Number.isFinite(n) || n < 1 || n > 10))
      return "מספר הפוסטים לא סביר — ודא עם הלקוח כמה פוסטים הוא רוצה (1-10).";
    if (!Array.isArray(args.schedule) || !args.schedule.length)
      return "חסרים זמני פרסום — שאל את הלקוח באילו ימים ושעות לפרסם את הפוסטים.";
    if (len(args.concept) < 5)
      return "הקונספט לפוסטים חסר — שאל את הלקוח על מה הפוסטים (איזה שירות/נושא).";
    return null;
  },
};

/**
 * check(toolName, args, rc) → { ok: true } | { ok: false, ask }
 * `ask` is model-facing Hebrew: what to clarify with the client.
 */
function check(toolName, args = {}, rc = null) {
  const rule = RULES[toolName];
  if (!rule) return { ok: true };
  try {
    const ask = rule(args, rc);
    return ask ? { ok: false, ask } : { ok: true };
  } catch (_) {
    return { ok: true }; // the gate must never break a legit action
  }
}

module.exports = { check };
