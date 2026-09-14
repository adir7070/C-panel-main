const express = require("express");
const router = express.Router();
const service = require("../services/fireberry-ads.service");

// ─── POST /api/fireberry-ads/generate ───────────────────────────────────────
// Called by Fireberry Automation webhook when a customer record's "status"
// field flips to "ready to generate ads". Body: { recordId }
router.post("/generate", async (req, res) => {
  try {
    // Accept recordId from either the JSON body OR the query string —
    // Fireberry's automation editor lets the operator put merge fields in
    // either place, and merge-field substitution behaves differently in
    // each context. Supporting both means the integration "just works"
    // regardless of where the operator pasted the variable.
    const recordId =
      req.body?.recordId || req.body?.id || req.body?.accountid ||
      req.query?.recordId || req.query?.id || req.query?.accountid;
    if (!recordId) {
      return res.status(400).json({ ok: false, error: "recordId is required (in body or query)" });
    }
    // ?force=true (or { force: true } in body) skips the "session already
    // generating/ready" reuse check — needed to recover from dead pipelines
    // killed mid-flight by a deploy.
    const force = req.body?.force === true || req.query.force === "true";
    const result = await service.triggerGenerationFromFireberry(recordId, { force });
    res.json({ ok: true, ...result });
  } catch (err) {
    // axios errors carry the upstream response body in err.response.data —
    // surface it so the caller can tell whether Fireberry or WOW rejected.
    const upstream = err.response?.data;
    console.error("[fireberry-ads/generate] error:", err.message, upstream || "");
    res.status(500).json({
      ok: false,
      error: err.message,
      upstreamStatus: err.response?.status,
      upstreamBody:   upstream,
    });
  }
});

// ─── GET /api/fireberry-ads/debug/:recordId ─────────────────────────────────
// Diagnostic endpoint. Reads a record from Fireberry and returns BOTH the
// raw fields AND the mapped WOW brief, so you can verify the field map
// without running the full pipeline. Safe to call repeatedly.
router.get("/debug/:recordId", async (req, res) => {
  try {
    const raw   = await service._getCustomerRecord(req.params.recordId, false);
    const brief = service._mapToWowBrief(raw);

    // Per-field diagnosis. Tag each field with which Fireberry object it
    // should live on, and pull the value from the matching raw record.
    const map         = service._FIREBERRY_FIELD_MAP;
    const onBrief     = service._FIELDS_ON_BRIEF;
    const onCustomer  = service._FIELDS_ON_CUSTOMER;
    const briefRaw    = raw.__brief    || {};
    const customerRaw = raw.__customer || {};
    const fieldCheck  = {};
    for (const [key, pcf] of Object.entries(map)) {
      if (!pcf) continue;
      const livesOn = onBrief.has(key)    ? "brief(1012)"
                    : onCustomer.has(key) ? "customer(1)"
                    : "unknown";
      const source  = onBrief.has(key) ? briefRaw : customerRaw;
      fieldCheck[key] = {
        pcf,
        livesOn,
        present: Object.prototype.hasOwnProperty.call(source, pcf),
        value:   source[pcf] ?? null,
      };
    }

    res.json({
      ok: true,
      objectTypes: {
        brief:    service._BRIEF_OBJECT_TYPE,
        customer: service._CUSTOMER_OBJECT_TYPE,
      },
      fieldMap:    map,
      fieldCheck,
      mappedBrief: brief,
      briefRecord:    briefRaw,
      customerRecord: customerRaw,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message,
      upstreamStatus: err.response?.status,
      upstreamBody:   err.response?.data,
    });
  }
});

// ─── GET /api/fireberry-ads/session/:recordId ───────────────────────────────
// Called by the embedded HTML widget on every poll. Returns the session id,
// live status, current ads list (when ready), and prior decisions.
router.get("/session/:recordId", async (req, res) => {
  try {
    const data = await service.getSessionForRecord(req.params.recordId);
    if (!data.found) {
      return res.status(404).json({ ok: false, error: "no session for this record" });
    }
    res.json({ ok: true, ...data });
  } catch (err) {
    console.error("[fireberry-ads/session] error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── POST /api/fireberry-ads/sync-iframe/:recordId ──────────────────────────
// Manually backfill the iframe HTML field on a single brief record. Useful
// for records created before the integration started auto-stamping the
// iframe in /generate.
router.post("/sync-iframe/:recordId", async (req, res) => {
  try {
    const result = await service.syncIframeForRecord(req.params.recordId);
    res.json(result);
  } catch (err) {
    res.status(500).json({
      ok: false, error: err.message,
      upstreamStatus: err.response?.status, upstreamBody: err.response?.data,
    });
  }
});

// ─── POST /api/fireberry-ads/sync-iframes-all ───────────────────────────────
// Bulk backfill — iterates every record on the brief object and stamps the
// iframe HTML. One PUT per record; expensive but one-shot.
router.post("/sync-iframes-all", async (_req, res) => {
  try {
    const result = await service.syncIframeForAllRecords();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── POST /api/fireberry-ads/decision ───────────────────────────────────────
// Body: { recordId, adId, decision: 'approved' | 'rejected' }
router.post("/decision", async (req, res) => {
  try {
    const { recordId, adId, decision } = req.body || {};
    if (!recordId || adId === undefined || !decision) {
      return res.status(400).json({
        ok: false,
        error: "recordId, adId, decision are required",
      });
    }
    const result = await service.saveDecision(recordId, adId, decision);
    res.json(result);
  } catch (err) {
    console.error("[fireberry-ads/decision] error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
