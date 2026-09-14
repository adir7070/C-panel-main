const express = require("express");
const router = express.Router();
const { DB } = require("../../config/db");

const COL = "wow_visits";

function parseDevice(ua) {
  if (!ua) return "unknown";
  return /Mobile|Android|iPhone|iPad/i.test(ua) ? "mobile" : "desktop";
}

function getClientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return fwd.split(",")[0].trim();
  return req.socket?.remoteAddress || null;
}

// POST /api/wow/track/:sessionId — called from published page beacon
router.post("/:sessionId", async (req, res) => {
  try {
    const ua = req.headers["user-agent"] || null;
    const ip = getClientIp(req);
    const { ref, w } = req.body || {};
    await DB.collection(COL).insertOne({
      sessionId: req.params.sessionId,
      visitedAt: new Date().toISOString(),
      ua,
      device: parseDevice(ua),
      ip: ip || null,
      referrer: ref || null,
      screenWidth: w || null,
    });
  } catch (_) {
    // best-effort
  }
  res.status(204).end();
});

// GET /api/wow/track/:sessionId — returns rich visit stats
router.get("/:sessionId", async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const visits = await DB.collection(COL)
      .find({ sessionId })
      .sort({ visitedAt: 1 })
      .toArray();

    const total = visits.length;
    const lastVisit = visits.length ? visits[visits.length - 1].visitedAt : null;

    // unique visitors by IP
    const uniqueIps = new Set(visits.map((v) => v.ip).filter(Boolean));
    const uniqueVisitors = uniqueIps.size;

    // device breakdown
    const devices = { mobile: 0, desktop: 0, unknown: 0 };
    for (const v of visits) {
      const d = v.device || parseDevice(v.ua);
      devices[d] = (devices[d] || 0) + 1;
    }

    // visits by day — last 14 days
    const today = new Date();
    const byDay = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().slice(0, 10); // YYYY-MM-DD
      const count = visits.filter((v) => v.visitedAt?.startsWith(dateStr)).length;
      byDay.push({ date: dateStr, count });
    }

    // top referrers
    const refMap = {};
    for (const v of visits) {
      if (!v.referrer) continue;
      let host = v.referrer;
      try { host = new URL(v.referrer).hostname || v.referrer; } catch (_) {}
      refMap[host] = (refMap[host] || 0) + 1;
    }
    const topReferrers = Object.entries(refMap)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([source, count]) => ({ source, count }));

    res.json({ total, lastVisit, uniqueVisitors, devices, byDay, topReferrers });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
