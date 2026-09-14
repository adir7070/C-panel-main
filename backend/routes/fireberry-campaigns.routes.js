const express = require("express");
const router = express.Router();
const service = require("../services/fireberry-campaigns.service");

// POST /api/fireberry-campaigns/sync/:recordId — one campaign record
router.post("/sync/:recordId", async (req, res) => {
  try {
    const result = await service.syncRecord(req.params.recordId);
    res.json(result);
  } catch (err) {
    res.status(500).json({
      ok: false, error: err.message,
      upstreamStatus: err.response?.status, upstreamBody: err.response?.data,
    });
  }
});

// POST /api/fireberry-campaigns/sync-all
router.post("/sync-all", async (_req, res) => {
  try {
    const result = await service.syncAllRecords();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/fireberry-campaigns/debug/:recordId — discovery helper
router.get("/debug/:recordId", async (req, res) => {
  try {
    const raw   = await service._getCampaignRecord(req.params.recordId);
    const phone = service._extractPhoneFromRecord(raw) || null;
    const iframes = {};
    for (const tab of service._TABS) {
      iframes[tab] = phone ? service._buildIframeHtml(tab, phone) : null;
    }
    res.json({
      ok: true,
      objectType:  service._CAMPAIGN_OBJECT_TYPE,
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
