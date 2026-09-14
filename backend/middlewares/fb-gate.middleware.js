/**
 * Facebook / Meta integration switch.
 *
 * Every per-client Meta credential (user token, page id, ad account) used to
 * live in Fireberry custom fields. Fireberry is gone, and nothing writes those
 * tokens into MongoDB yet — so every Graph-backed route would fail anyway,
 * each in its own way (400 here, 500 there, a Graph error message elsewhere).
 *
 * This gate makes that single fact explicit and uniform: while the integration
 * is off, those routes answer 503 `fb_unavailable` and never touch Graph. The
 * C-panel renders that code as a calm "לא זמין" panel instead of a red error.
 *
 * Flip FB_INTEGRATION_ENABLED=true once client tokens are stored in Mongo
 * (users.fb_user_token / users.page_id / users.ad_account_id — see
 * getClientFbCredentials in controllers/cpanel.controller.js).
 */
const FB_ENABLED = process.env.FB_INTEGRATION_ENABLED === "true";

if (!FB_ENABLED) {
  console.log("⏸️  Meta/Facebook routes disabled (set FB_INTEGRATION_ENABLED=true to enable)");
}

module.exports = function fbGate(_req, res, next) {
  if (FB_ENABLED) return next();
  return res.status(503).json({
    error: "fb_unavailable",
    message: "חיבור פייסבוק אינו זמין כרגע",
  });
};

module.exports.enabled = FB_ENABLED;
