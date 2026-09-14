import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { createProxyMiddleware } from "http-proxy-middleware";
import { generateLocalAds, GENERATED_DIR } from "./server/localAdsPipeline.js";
import { exchangeFacebookCode } from "./server/facebookOAuth.js";
import { authRouter } from "./server/auth.js";
import { leadsRouter } from "./server/leads.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const dist = path.join(__dirname, "dist");

const PORT = process.env.PORT || 3000;
// No hardcoded backend host — set API_TARGET to your backend's origin.
// Falls back to a local placeholder so a missing env var fails loudly
// (connection refused) instead of silently proxying to a dead host.
const API_TARGET = process.env.API_TARGET || "http://localhost:3901";
// Parts of the backend that live in THIS repo (MongoDB-backed):
//   LOCAL_AUTH=1  → this server owns /api/agents/login + the managers lists
//                   (standalone mode, no main backend).
//   LOCAL_AUTH=0  → the main backend behind API_TARGET owns login; the leads
//                   module below validates its tokens against the SHARED
//                   agents collection (MONGO_URI must point at the same DB).
//   LOCAL_LEADS=1 → the leads pipeline (/api/leads/*) is served here.
const LOCAL_AUTH = process.env.LOCAL_AUTH !== "0";
const LOCAL_LEADS = process.env.LOCAL_LEADS !== "0";

console.log(`[cpanel] API proxy target: ${API_TARGET}`);
console.log(`[cpanel] local auth: ${LOCAL_AUTH ? "on (standalone)" : "off (main backend owns login)"} · local leads: ${LOCAL_LEADS ? "on" : "off"}`);
if (LOCAL_AUTH && !process.env.AUTH_SECRET) console.warn("[cpanel] AUTH_SECRET is not set — login will fail. See .env.example");
if (LOCAL_LEADS && !process.env.LEADS_INTAKE_KEY) console.warn("[cpanel] LEADS_INTAKE_KEY is not set — POST /api/leads/intake is OPEN to anyone");

app.disable("x-powered-by");
app.set("trust proxy", 1); // Heroku/any reverse proxy → req.ip is the real client
app.use((_req, res, next) => { res.setHeader("X-Content-Type-Options", "nosniff"); next(); });

// ── Local backend: auth (/api/agents/*, managers) + leads (/api/leads/*) ─
// Mounted BEFORE the generic /api proxy so these routes are answered
// here; everything else under /api still forwards to API_TARGET. Their
// JSON body parsers are scoped to their own paths — never at app level —
// so proxied /api/** requests keep their bodies intact.
if (LOCAL_AUTH) app.use(authRouter);
if (LOCAL_LEADS) app.use(leadsRouter);

// ── Local ad-generation pipeline (was: proxy to a Make.com webhook) ───
// Runs the campaign.md prompt directly against OpenAI/Gemini using the
// keys in .env and returns the finished ad copy + images synchronously.
app.post("/api/local-ads/generate", express.json({ limit: "10mb" }), async (req, res) => {
  const { ANSWERS, BRAND_COLORS, NUM_ADS, LOGO, AVATAR } = req.body ?? {};
  console.log(`[local-ads] generating ${NUM_ADS} ads locally...`);
  try {
    const ads = await generateLocalAds({
      answers: ANSWERS,
      logoUrl: LOGO || undefined,
      avatarUrl: AVATAR || undefined,
      brandColors: BRAND_COLORS,
      numAds: NUM_ADS,
    });
    res.status(200).json({ ads });
  } catch (err) {
    console.error("[local-ads] error:", err.message);
    res.status(502).json({ error: err.message });
  }
});

// ── JSON error handler for the local routes above (malformed JSON, body
// over the size limit, etc.) — Express would otherwise answer with an
// HTML error page that the SPA's req() helper cannot parse.
app.use((err, _req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err?.status || err?.statusCode || 500;
  const message = status === 413 ? "הבקשה גדולה מדי"
    : err?.type === "entity.parse.failed" ? "JSON לא תקין"
    : status >= 500 ? "שגיאת שרת" : (err?.message || "בקשה לא תקינה");
  if (status >= 500) console.error("[error]", err);
  res.status(status).json({ error: err?.type || "request_error", message });
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ── Local Facebook OAuth callback (was: redirect_uri pointing at a
// Make.com webhook, which exchanged the code + wrote to the old backend).
// Exchanges the code directly with Facebook. Note: Facebook requires
// redirect_uri to be a public HTTPS URL, so this only fires once the
// server itself is deployed publicly — see FB_OAUTH_REDIRECT_URI in
// .env.example. Persisting the resulting token against a client record
// requires a backend endpoint that doesn't exist in this frontend-only
// repo; forwards to FB_TOKEN_WEBHOOK_URL if set, otherwise just renders it.
app.get("/auth/facebook/callback", async (req, res) => {
  const { code, state, error, error_description } = req.query;
  // Everything echoed here is attacker-controllable (query string) and this
  // page shares the SPA's origin — so: no scripts allowed, plain text for
  // errors, HTML-escaped values on the success page.
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (error) {
    return res.status(400).type("text/plain").send(`Facebook OAuth error: ${String(error_description || error).slice(0, 300)}`);
  }
  if (!code) return res.status(400).type("text/plain").send("Missing ?code from Facebook redirect");
  const redirectUri = process.env.FB_OAUTH_REDIRECT_URI
    || `${req.protocol}://${req.get("host")}/auth/facebook/callback`;
  try {
    const token = await exchangeFacebookCode(String(code), redirectUri);
    const webhook = process.env.FB_TOKEN_WEBHOOK_URL;
    let forwarded = false;
    if (webhook) {
      forwarded = await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: String(state ?? ""), ...token }),
      }).then(r => r.ok).catch(err => { console.error("[fb-oauth] failed forwarding token to webhook:", err.message); return false; });
    }
    const safeState = escapeHtml(String(state ?? "").slice(0, 300));
    // The token itself is only shown when there is nowhere to forward it —
    // the manual-handling fallback the operator asked for.
    const tokenBlock = forwarded
      ? "<p>הטוקן נשלח ל-FB_TOKEN_WEBHOOK_URL.</p>"
      : `<p>הגדר FB_TOKEN_WEBHOOK_URL ב-.env כדי שהטוקן יישמר אוטומטית אצל הלקוח. בינתיים:</p>` +
        `<pre>${escapeHtml(JSON.stringify({ state: String(state ?? ""), ...token }, null, 2))}</pre>`;
    res.status(200).type("text/html").send(
      `<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8"><title>חיבור פייסבוק</title>` +
      `<body style="font-family:sans-serif;padding:24px"><p>חיבור פייסבוק הושלם.</p><p>state: <code>${safeState}</code></p>${tokenBlock}</body></html>`
    );
  } catch (err) {
    console.error("[fb-oauth] error:", err.message);
    res.status(502).type("text/plain").send("Facebook token exchange failed — see server log");
  }
});

// ── Generated ad images (from the local pipeline above) ──────────────
app.use("/generated", express.static(GENERATED_DIR, { maxAge: 0, etag: false }));

// ── Proxy all /api/* calls to the backend ─────────────────────────────
// Same-origin from the browser's perspective → no CORS, no token issues.
// Mount at "/" with pathFilter so the full /api/... path is preserved
// when forwarded — mounting at app.use("/api", ...) strips the prefix
// and the upstream 404s on /agents/login instead of /api/agents/login.
app.use(createProxyMiddleware({
  target: API_TARGET,
  changeOrigin: true,
  pathFilter: "/api/**",
  on: {
    proxyReq: (proxyReq, req) => {
      const fwd = req.headers["x-forwarded-for"];
      if (fwd) proxyReq.setHeader("X-Forwarded-For", fwd);
    },
    error: (err, _req, res) => {
      console.error("[proxy] upstream error:", err.message);
      if (res && !res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        // Don't echo err.message — it contains the internal API_TARGET host/port.
        res.end(JSON.stringify({ error: "bad_gateway", message: "השרת האחורי אינו זמין" }));
      }
    },
  },
}));

// ── Proxy /wow-beta/** to the backend (WOW BETA SOS pipeline), if it
// implements one — same configurable API_TARGET as the /api proxy above,
// no hardcoded host. Without this, the cpanel SPA fallback would catch
// /wow-beta/* and render the dashboard instead of forwarding it.
app.use(createProxyMiddleware({
  target: API_TARGET,
  changeOrigin: true,
  pathFilter: "/wow-beta/**",
  on: {
    error: (err, _req, res) => {
      console.error("[wow-beta-proxy] upstream error:", err.message);
      if (res && !res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        // Don't echo err.message — it contains the internal API_TARGET host/port.
        res.end(JSON.stringify({ error: "bad_gateway", message: "השרת האחורי אינו זמין" }));
      }
    },
  },
}));

// ── Static files (Vite output) ────────────────────────────────────────
// Hashed assets get a 1-year immutable cache; everything else is no-cache
// so HTML always points at the latest asset hashes after a redeploy.
app.use("/assets", express.static(path.join(dist, "assets"), {
  maxAge: "1y",
  immutable: true,
}));
app.use(express.static(dist, { maxAge: 0, etag: false }));

// ── SPA fallback — must be last ──────────────────────────────────────
app.use((_req, res) => {
  res.sendFile(path.join(dist, "index.html"));
});

app.listen(PORT, () => console.log(`cpanel proxy server listening on ${PORT}`));
