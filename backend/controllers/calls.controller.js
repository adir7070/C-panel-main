/* Call recordings (services/extra-calls.service.js).

   Public:
     POST /api/cpanel/calls/extra-webhook   Extra's end-of-call automation
     GET  /api/cpanel/calls/extra-status    setup check (booleans and dates, no secrets)
   Admins only (user decision 2026-11-26: every admin, nobody else):
     GET  /api/cpanel/calls?phone=&before=&limit=
     GET  /api/cpanel/calls/:id/recording   → { url } (signed, 10 minutes)
     POST /api/cpanel/calls/sync            pull recent calls now */

const calls = require("../services/extra-calls.service");

const adminOnly = (req, res) => {
  if (req.agent?.role === "admin") return true;
  res.status(403).json({ error: "admins_only", message: "רק מנהלי מערכת יכולים לשמוע הקלטות שיחות" });
  return false;
};

function fail(res, err, ctx) {
  if (err instanceof calls.ExtraError) {
    const status = err.code === "extra_not_configured" ? 503 : 502;
    return res.status(status).json({ error: err.code, message: err.message });
  }
  console.error(`[calls] ${ctx}:`, err.message);
  res.status(500).json({ error: "server_error", message: "שגיאת שרת — נסה שוב" });
}

/* 2xx only after the call was looked up (or deferred to the sync): Extra
   disables an automation after 3 failed deliveries in a row. */
exports.webhook = async (req, res) => {
  if (!calls.webhookAuthorized(req)) return res.status(401).json({ error: "unauthorized" });
  try {
    const r = await calls.handleWebhook({ ...(req.query || {}), ...(req.body || {}) });
    res.json({ ok: true, ...r });
  } catch (err) {
    console.error("[calls] webhook:", err.message);
    res.json({ ok: true, status: "deferred" });
  }
};

exports.status = async (_req, res) => {
  try {
    res.set("Cache-Control", "no-store").json(await calls.status());
  } catch (err) {
    fail(res, err, "status");
  }
};

exports.list = async (req, res) => {
  if (!adminOnly(req, res)) return;
  try {
    res.json(await calls.listCalls({ phone: req.query.phone, before: req.query.before, limit: req.query.limit }));
  } catch (err) {
    fail(res, err, "list");
  }
};

exports.recording = async (req, res) => {
  if (!adminOnly(req, res)) return;
  try {
    const url = await calls.recordingUrl(String(req.params.id));
    if (!url) return res.status(404).json({ error: "no_recording", message: "אין הקלטה לשיחה הזאת" });
    res.set("Cache-Control", "no-store").json({ url });
  } catch (err) {
    fail(res, err, "recording");
  }
};

exports.sync = async (req, res) => {
  if (!adminOnly(req, res)) return;
  try {
    const days = Math.min(90, Math.max(0, Number(req.body?.days) || 0)) || null;
    res.json(await calls.syncRecent({ days }));
  } catch (err) {
    fail(res, err, "sync");
  }
};
