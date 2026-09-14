const https = require("https");
const http = require("http");
const { URL } = require("url");
const axios = require("axios");
const { getDB } = require("../config/db");

const POSTIFY_URL = process.env.POSTIFY_API_URL || "";
const POSTIFY_KEY = process.env.CPANEL_API_KEY || "";

// ── helpers ────────────────────────────────────────────────────────────

function postifyHeaders() {
  return { "x-api-key": POSTIFY_KEY, "Content-Type": "application/json" };
}

async function getClientFbCredentials(phone) {
  const db = getDB();
  // Try business_profiles first (C-panel stores credentials here as plain fields)
  const bp = await db.collection("business_profiles").findOne({ phone });
  if (bp?.facebookUsername && bp?.facebookPassword) {
    return { email: bp.facebookUsername, password: bp.facebookPassword };
  }
  // Fallback: ad_briefs (old cpanel path)
  let brief = await db.collection("ad_briefs").findOne({ phone });
  if (!brief) brief = await db.collection("client_briefs").findOne({ phone });
  if (!brief) return null;
  const email = brief.answers?.fb_username?.raw ?? brief.answers?.fb_username ?? brief.fb_username ?? null;
  const password = brief.answers?.fb_password?.raw ?? brief.answers?.fb_password ?? brief.fb_password ?? null;
  return { email, password };
}

// ── POST /clients/:phone/fb-connect/start ─────────────────────────────
exports.startFbConnect = async (req, res) => {
  try {
    if (!POSTIFY_URL) return res.status(500).json({ error: "POSTIFY_API_URL not configured" });

    const { phone } = req.params;
    const creds = await getClientFbCredentials(phone);
    if (!creds?.email || !creds?.password) {
      return res.status(400).json({ error: "No Facebook credentials saved for this client" });
    }

    const response = await axios.post(
      `${POSTIFY_URL}/api/fb-app-connect`,
      { email: creds.email, password: creds.password, phone },
      { headers: postifyHeaders(), timeout: 30000 }
    );

    res.json(response.data);
  } catch (err) {
    console.error("[FbConnect] startFbConnect:", err.message);
    const data = err.response?.data;
    res.status(err.response?.status || 500).json(data || { error: err.message });
  }
};

// ── GET /clients/:phone/fb-connect/:sessionId/stream (SSE proxy) ──────
exports.streamFbConnect = (req, res) => {
  const { sessionId } = req.params;
  if (!POSTIFY_URL) return res.status(500).end();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const target = new URL(`${POSTIFY_URL}/api/fb-app-connect/${sessionId}/screenshots`);
  target.searchParams.set("apiKey", POSTIFY_KEY);

  const lib = target.protocol === "https:" ? https : http;
  const upstream = lib.get(target.toString(), (upRes) => {
    upRes.on("data", (chunk) => res.write(chunk));
    upRes.on("end", () => res.end());
  });
  upstream.on("error", () => res.end());
  req.on("close", () => upstream.destroy());
};

// ── GET /clients/:phone/fb-connect/:sessionId/setup-stream (SSE proxy)
exports.streamSetup = (req, res) => {
  const { sessionId } = req.params;
  if (!POSTIFY_URL) return res.status(500).end();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const target = new URL(`${POSTIFY_URL}/api/fb-app-connect/${sessionId}/setup-stream`);
  target.searchParams.set("apiKey", POSTIFY_KEY);

  const lib = target.protocol === "https:" ? https : http;
  const upstream = lib.get(target.toString(), (upRes) => {
    upRes.on("data", (chunk) => res.write(chunk));
    upRes.on("end", () => res.end());
  });
  upstream.on("error", () => res.end());
  req.on("close", () => upstream.destroy());
};

// ── POST /clients/:phone/fb-connect/:sessionId/pick-method ────────────
exports.pickMethod = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const response = await axios.post(
      `${POSTIFY_URL}/api/fb-app-connect/${sessionId}/pick-method`,
      req.body,
      { headers: postifyHeaders(), timeout: 15000 }
    );
    res.json(response.data);
  } catch (err) {
    console.error("[FbConnect] pickMethod:", err.message);
    res.status(err.response?.status || 500).json(err.response?.data || { error: err.message });
  }
};

// ── POST /clients/:phone/fb-connect/:sessionId/code ───────────────────
exports.submitCode = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const response = await axios.post(
      `${POSTIFY_URL}/api/fb-app-connect/${sessionId}/code`,
      req.body,
      { headers: postifyHeaders(), timeout: 15000 }
    );
    res.json(response.data);
  } catch (err) {
    console.error("[FbConnect] submitCode:", err.message);
    res.status(err.response?.status || 500).json(err.response?.data || { error: err.message });
  }
};

// ── POST /clients/:phone/fb-connect/result ────────────────────────────
exports.saveFbResult = async (req, res) => {
  try {
    const { phone } = req.params;
    const { fbPostifyProfileId, fbUserId } = req.body;
    const db = getDB();
    await db.collection("business_profiles").updateOne(
      { phone },
      {
        $set: {
          fbPostifyProfileId: fbPostifyProfileId || null,
          fbUserId: fbUserId || null,
          fbConnectionStatus: "connected",
          fbConnectedAt: new Date(),
        },
      },
      { upsert: true }
    );
    res.json({ success: true });
  } catch (err) {
    console.error("[FbConnect] saveFbResult:", err.message);
    res.status(500).json({ error: err.message });
  }
};

// ── GET /clients/:phone/fb-status ─────────────────────────────────────
exports.getFbStatus = async (req, res) => {
  try {
    const { phone } = req.params;
    const db = getDB();
    const profile = await db.collection("business_profiles").findOne(
      { phone },
      { projection: { fbConnectionStatus: 1, fbConnectedAt: 1, fbPostifyProfileId: 1, fbUserId: 1 } }
    );
    res.json({
      status: profile?.fbConnectionStatus || "none",
      connectedAt: profile?.fbConnectedAt || null,
      fbPostifyProfileId: profile?.fbPostifyProfileId || null,
      fbUserId: profile?.fbUserId || null,
    });
  } catch (err) {
    console.error("[FbConnect] getFbStatus:", err.message);
    res.status(500).json({ error: err.message });
  }
};
