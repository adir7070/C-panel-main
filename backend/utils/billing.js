/**
 * billing.js — the coin-billing kill switch.
 *
 * המטבעות באפליקציה חינם: כל ניכוי מדולג ואף לקוח לא נחסם על יתרה.
 * להחזרת החיוב: BILLING_ENABLED=true והפעלה מחדש — כל ערך אחר (כולל
 * לא-מוגדר) משאיר את הכל חינם.
 *
 * Callers must SKIP the debit rather than charge a price of 0. Several
 * call sites read a price of 0 as "product has no valid price" and reject
 * (social-redeem.service.js "חבילה ללא מחיר תקין", cpanel coin-redeem
 * "שירות לא נתמך"), and Cardcom rejects an Amount of 0 outright — so a
 * zeroed price produces a 404/400/500, not a free action.
 *
 * Scope is the client-facing coin economy only. Real-money paths — agency
 * CPANEL sales, invoices, commissions, and the coin shop — keep charging.
 */
const billingEnabled = () => process.env.BILLING_ENABLED === "true";

module.exports = { billingEnabled };
