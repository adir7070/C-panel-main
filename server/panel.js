import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { generateLocalAds, GENERATED_DIR } from "./localAdsPipeline.js";
import { exchangeFacebookCode } from "./facebookOAuth.js";
import { requireAuth } from "./auth.js";
import { leadsRouter } from "./leads.js";

/* The panel's server code runs inside the backend process: backend/server.js
   requires this file and calls the two hooks below. Express answers in
   registration order, so:
   - mountPanelRoutes goes BEFORE the backend's /api router, so the panel's
     /api/leads/* win over backend/routes/leads.routes.js;
   - mountPanelSpa goes AFTER every backend route: the built SPA, a JSON 404
     for unknown /api paths, and the index.html fallback for client routes. */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function mountPanelRoutes(app) {
  if (!process.env.LEADS_INTAKE_KEY) console.warn("[panel] LEADS_INTAKE_KEY is not set — POST /api/leads/intake is OPEN to anyone");

  // ── Leads pipeline (/api/leads/*) ─────────────────────────────────────
  app.use(leadsRouter);

  // ── Local ad-generation pipeline ─────────────────────────────────────
  // Runs the campaign.md prompt directly against OpenAI/Gemini and returns
  // the finished ad copy + images synchronously.
  app.post("/api/local-ads/generate", requireAuth, async (req, res) => {
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

  // ── Facebook OAuth callback ──────────────────────────────────────────
  // Exchanges the code directly with Facebook. Facebook requires
  // redirect_uri to be a public HTTPS URL — see FB_OAUTH_REDIRECT_URI in
  // .env.example. Forwards the token to FB_TOKEN_WEBHOOK_URL if set,
  // otherwise just renders it.
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
        : `<p>הגדר FB_TOKEN_WEBHOOK_URL כדי שהטוקן יישמר אוטומטית אצל הלקוח. בינתיים:</p>` +
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
}

export function mountPanelSpa(app) {
  // Unknown /api paths answer JSON, never the SPA's index.html.
  app.use("/api", (_req, res) => res.status(404).json({ error: "not_found", message: "הנתיב לא קיים" }));

  // JSON errors for /api (malformed JSON, body over the size limit, …) —
  // the SPA's req() helper can't parse Express's HTML error page.
  app.use("/api", (err, _req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err?.status || err?.statusCode || 500;
    const message = status === 413 ? "הבקשה גדולה מדי"
      : err?.type === "entity.parse.failed" ? "JSON לא תקין"
      : status >= 500 ? "שגיאת שרת" : (err?.message || "בקשה לא תקינה");
    if (status >= 500) console.error("[error]", err);
    res.status(status).json({ error: err?.type || "request_error", message });
  });

  if (!fs.existsSync(path.join(DIST, "index.html"))) {
    console.warn("[panel] dist/ is not built — the SPA is not served here (`npm run build`, or `npm run dev` for Vite)");
    return;
  }
  // Hashed assets get a 1-year immutable cache; everything else is no-cache
  // so HTML always points at the latest asset hashes after a redeploy.
  app.use("/assets", express.static(path.join(DIST, "assets"), { maxAge: "1y", immutable: true }));
  app.use(express.static(DIST, { maxAge: 0, etag: false }));
  // Client-side routes (/clients/…, the Cardcom return page, /products-review/…)
  app.get(/^(?!\/(?:api|socket\.io|wow-beta|whoapp-api)(?:\/|$)).*/, (_req, res) => {
    res.sendFile(path.join(DIST, "index.html"));
  });
}
