const express = require("express");
const router = express.Router();
const service = require("../services/fireberry-cpanel.service");

// ─── POST /api/fireberry-cpanel/sync/:recordId ──────────────────────────────
// Stamps the four iframe HTML fields on one Fireberry record (object 1005)
// so the embedded views point at /embed/{tab}/{phone} with the real phone
// baked in. Idempotent — safe to call multiple times.
router.post("/sync/:recordId", async (req, res) => {
  try {
    const result = await service.syncRecord(req.params.recordId);
    res.json(result);
  } catch (err) {
    res.status(500).json({
      ok: false, error: err.message,
      upstreamStatus: err.response?.status,
      upstreamBody:   err.response?.data,
    });
  }
});

// ─── POST /api/fireberry-cpanel/sync-all ────────────────────────────────────
// Bulk backfill — iterates every record on object 1005 and stamps the
// iframe HTML on each one. Costs one PUT per record.
router.post("/sync-all", async (_req, res) => {
  try {
    const result = await service.syncAllRecords();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /api/fireberry-cpanel/debug/:recordId ──────────────────────────────
// Diagnostic — returns the full raw record (all pcfsystemfields), the
// resolved phone, the current field map, and the iframe HTML that would
// be written. Use this to discover the real pcf names for the four
// iframe HTML fields before filling FIREBERRY_FIELD_MAP.
router.get("/debug/:recordId", async (req, res) => {
  try {
    const raw   = await service._getClientRecord(req.params.recordId);
    const phone = service._extractPhoneFromRecord(raw) || null;
    const iframes = {};
    for (const tab of service._TABS) {
      iframes[tab] = phone ? service._buildIframeHtml(tab, phone) : null;
    }
    res.json({
      ok: true,
      objectType:  service._CLIENT_OBJECT_TYPE,
      cpanelBase:  service._CPANEL_BASE,
      fieldMap:    service._FIREBERRY_FIELD_MAP,
      resolvedPhone: phone,
      iframes,
      rawRecord:   raw,
    });
  } catch (err) {
    res.status(500).json({
      ok: false, error: err.message,
      upstreamStatus: err.response?.status,
      upstreamBody:   err.response?.data,
    });
  }
});

module.exports = router;
