const path = require("path");
const http = require("http");
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { Server } = require("socket.io");
const NODE_ENV = process.env.NODE_ENV || "development";
// Local dev reads .env.development. Production (Heroku) uses config vars only —
// never a .env file, so stale secrets can never fill in an unset variable.
if (NODE_ENV !== "production") {
  require("dotenv").config({ path: path.join(__dirname, ".env.development") });
}
console.log(`🌐 Environment: ${NODE_ENV}`);

// ── Memory: cap sharp's image cache + thread pool ──────────────────────────
// The heavy ad-image pipeline (gpt-image-2 → sharp resize/composite of 2MB+
// PNGs, several clients in parallel) was pushing the dyno over its memory
// quota (Heroku R14). sharp's libvips cache holds decoded pixel buffers in
// memory and its thread pool allocates per-thread scratch; disabling the cache
// and pinning concurrency to 1 trims both, for EVERY image path (WOW Ads,
// mobile HQ, contracts) without touching any pipeline code.
const sharp = require("sharp");
sharp.cache(false);
sharp.concurrency(1);

const { connectDB } = require("./config/db");
const { initializeIndexes } = require("./config/db-indexes");
const setupSocketManager = require("./socketManager");
const agentsController = require("./controllers/agents.controller");
const fileTypesController = require("./controllers/file-types.controller");

const app = express();

// Logger Middleware
app.use((req, res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();
});

// הגדרות בסיסיות
app.use(cors());
app.use(bodyParser.json({ limit: "50mb" }));
app.use(bodyParser.urlencoded({ extended: true, limit: "50mb" }));

// Behind Heroku's router: trust X-Forwarded-* so req.protocol is https.
app.set("trust proxy", 1);
app.disable("x-powered-by");

// ── Panel (the React app at the repo root): its own routes — leads
// pipeline, local ad generation, Facebook OAuth callback. Registered before
// the /api router so /api/leads/* is answered by the panel's leads module.
const panel = require("../server/panel.js");
panel.mountPanelRoutes(app);

// Apple App Site Association — required for iOS OTP domain-bound autofill
// iOS fetches this file to verify the app is associated with api.iconiqmedia.co.il
app.get("/.well-known/apple-app-site-association", (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.json({
    webcredentials: {
      apps: ["JFT2R3Q4MD.com.anonymous.untitled1"]
    }
  });
});

// Internal socket relay — receives events from peer server and emits locally
app.post('/api/internal/socket-relay', (req, res) => {
  const secret = req.headers['x-relay-secret'];
  if (!secret || secret !== process.env.INTERNAL_SECRET) return res.status(403).end();
  const { event, room, data } = req.body;
  if (!event || !room) return res.status(400).end();
  const io = req.app.get('io');
  if (io) io.to(room).emit(event, data);
  res.json({ ok: true });
});

// Internal DB sync — receives write operations from peer server and applies locally
app.post('/api/internal/db-sync', async (req, res) => {
  const secret = req.headers['x-relay-secret'];
  if (!secret || secret !== process.env.INTERNAL_SECRET) return res.status(403).end();
  const { operation, chatId, data } = req.body;
  if (!operation || !chatId) return res.status(400).end();

  const { DB } = require('./config/db');
  const chats = () => DB.collection('support_chats');

  try {
    if (operation === 'push_message') {
      await chats().updateOne(
        { _id: chatId, 'messages._id': { $ne: data.message._id } },
        { $push: { messages: data.message }, $set: { updated_at: new Date() } }
      );
    } else if (operation === 'push_merged_messages') {
      const msgs = data.messages || [];
      if (msgs.length > 0) {
        await chats().bulkWrite(
          msgs.map(msg => ({
            updateOne: {
              filter: { _id: chatId, 'messages._id': { $ne: msg._id } },
              update: { $push: { messages: msg } },
            },
          })),
          { ordered: false }
        );
      }
    } else if (operation === 'set_status') {
      await chats().updateOne(
        { _id: chatId },
        { $set: { status: data.status, updated_at: new Date() } }
      );
    } else if (operation === 'update_fields') {
      await chats().updateOne({ _id: chatId }, { $set: data.fields });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[DB-Sync] endpoint error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── WOW BETA — alternate ads pipeline (SOS fallback) ─────────────────────
// The wow-beta/ folder contains an unmodified copy of the standalone
// WOW project (Downloads/HTML AI/WOW). It runs as a child process on
// port 3001; we reverse-proxy /wow-beta/api/* and /wow-beta/uploads/*
// to it, and serve its built frontend dist at /wow-beta/. Managers reach
// it via a "WOW BETA ⚡" button on the C-panel ProductsTab when the
// regular pipeline produces unsatisfactory images.
(() => {
  // Kill-switch: DISABLE_WOW_BETA=true skips the whole mount. Needed for
  // local dev — spawnWowChild() below runs `lsof -ti:3001 | xargs kill -9`,
  // which would kill whatever else happens to be listening on 3001.
  if (process.env.DISABLE_WOW_BETA === "true") {
    console.log("⏸️  WOW BETA disabled via DISABLE_WOW_BETA=true");
    return;
  }
  const fs = require("fs");
  const { spawn } = require("child_process");
  const { createProxyMiddleware } = require("http-proxy-middleware");

  const wowBetaDir = path.join(__dirname, "wow-beta");
  const wowBackendDir = path.join(wowBetaDir, "backend");
  const wowFrontendDist = path.join(wowBetaDir, "frontend", "dist");

  if (!fs.existsSync(wowBackendDir)) {
    console.warn("[wow-beta] backend dir missing, skipping mount");
    return;
  }

  /* Spawn WOW backend as a child process. It serves /api/* on port 3001
     and writes to wow-beta/backend/data/* on the local filesystem. Pass
     through our env so it sees OPENAI_API_KEY / GEMINI_API_KEY.
     Track state so /wow-beta/__health can report it without depending
     on the child actually responding. */
  let wowChildState = {
    spawnedAt: new Date().toISOString(),
    exitCode:  null,
    lastStdout: null,
    lastStderr: null,
    restartCount: 0,
  };

  /* Kill any stale process still listening on port 3001. PM2 restarts
     iconiq but the previous spawned WOW child can outlive the kill
     signal (or get reparented to init) and keep holding the port —
     the new child then can't bind. fuser -k is the simplest Linux
     way to drop whatever's there; ignore failures (none of these are
     installed everywhere). */
  const freePort3001 = () => {
    const { execSync } = require("child_process");
    for (const cmd of [
      "fuser -k 3001/tcp",
      "lsof -ti:3001 | xargs -r kill -9",
      "ss -lptn 'sport = :3001' | awk '/pid=/ {gsub(/.*pid=/,\"\"); gsub(/,.*/,\"\"); print}' | xargs -r kill -9",
    ]) {
      try {
        execSync(cmd, { stdio: "ignore", timeout: 2000, shell: "/bin/sh" });
        return;   // First one that succeeds is enough
      } catch (_e) { /* try the next variant */ }
    }
  };

  const spawnWowChild = () => {
    freePort3001();
    /* Env-name aliasing — iconiq-server uses mixed-case `OpenAI_API_KEY`
       on its AWS .env, but the standalone WOW project reads the canonical
       all-caps `OPENAI_API_KEY`. Without this alias the child crashes on
       boot at `new OpenAI({ apiKey: process.env.OPENAI_API_KEY! })`.
       Falling back to the original casing means single-source-of-truth:
       admin only ever needs to set OpenAI_API_KEY in iconiq's .env. */
    /* Defensive aliasing — iconiq's AWS .env uses mixed-case names
       (OpenAI_API_KEY, Gemini_API_KEY?, …) while the standalone WOW
       project reads canonical all-caps. Without these aliases the
       child throws at module load. Single source of truth is iconiq's
       .env; we just normalize the casing for the child. */
    const childEnv = {
      ...process.env,
      PORT: "3001",
      OPENAI_API_KEY:    process.env.OPENAI_API_KEY    || process.env.OpenAI_API_KEY    || "",
      GEMINI_API_KEY:    process.env.GEMINI_API_KEY    || process.env.Gemini_API_KEY    || process.env.GOOGLE_AI_API_KEY || process.env.GOOGLE_API_KEY || "",
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || process.env.Anthropic_API_KEY || "",
    };
    const child = spawn("npx", ["tsx", "src/index.ts"], {
      cwd: wowBackendDir,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,   // Always use shell so npx on Linux resolves via PATH
    });
    child.stdout.on("data", (d) => {
      wowChildState.lastStdout = String(d).slice(-500);
      process.stdout.write(`[wow-beta] ${d}`);
    });
    child.stderr.on("data", (d) => {
      wowChildState.lastStderr = String(d).slice(-500);
      process.stderr.write(`[wow-beta] ${d}`);
    });
    child.on("exit", (code) => {
      wowChildState.exitCode = code;
      console.warn(`[wow-beta] child exited with code ${code}`);
      /* Auto-restart on crash, but cap to 5 restarts to prevent
         infinite loop on a permanent failure. */
      if (code !== 0 && wowChildState.restartCount < 5) {
        wowChildState.restartCount += 1;
        console.warn(`[wow-beta] auto-restarting (attempt ${wowChildState.restartCount}/5)…`);
        setTimeout(() => { wowChildState.exitCode = null; wowChild = spawnWowChild(); }, 2000);
      }
    });
    return child;
  };

  let wowChild = spawnWowChild();
  /* Tear down WOW child when iconiq shuts down so it doesn't linger
     after a dyno restart. */
  process.on("SIGTERM", () => { try { wowChild.kill(); } catch (_e) {} });
  process.on("exit",     () => { try { wowChild.kill(); } catch (_e) {} });

  /* Diagnostic endpoint — always responds, doesn't depend on the
     child being alive. Lets us tell from outside whether the child
     spawned, what it last said, and if/when it exited. */
  app.get("/wow-beta/__health", (_req, res) => {
    /* Report which env-name variants are populated so we can debug
       missing-API-key issues without exposing values. */
    const envCheck = (names) => Object.fromEntries(
      names.map(n => [n, process.env[n] ? "set" : "missing"]),
    );
    res.json({
      iconiqMount: "ok",
      child: {
        running:      wowChildState.exitCode === null,
        spawnedAt:    wowChildState.spawnedAt,
        exitCode:     wowChildState.exitCode,
        restartCount: wowChildState.restartCount,
        lastStdout:   wowChildState.lastStdout,
        lastStderr:   wowChildState.lastStderr,
      },
      hasFrontendDist: fs.existsSync(wowFrontendDist),
      cwd: wowBackendDir,
      pid: wowChild?.pid || null,
      env: envCheck([
        "OPENAI_API_KEY", "OpenAI_API_KEY",
        "GEMINI_API_KEY", "Gemini_API_KEY", "GOOGLE_AI_API_KEY", "GOOGLE_API_KEY",
        "ANTHROPIC_API_KEY", "Anthropic_API_KEY",
      ]),
    });
  });

  /* SLOW-ENDPOINT WRAPPER — runs BEFORE the generic proxy below.
     OpenAI chat-brief calls regularly exceed 60s. nginx (which fronts
     iconiq on the AWS box) has a default proxy_read_timeout of 60s and
     returns 504. We can't reach the nginx config to bump that timeout,
     so instead we stream "keep-alive" whitespace bytes to the client
     while we wait for WOW. nginx's read-timeout resets on every byte
     received from upstream, so as long as we keep dripping, no 504.
     JSON's grammar allows whitespace between tokens, so leading spaces
     don't break JSON.parse on the frontend.

     Applies to known-slow endpoints only; everything else falls through
     to the fast generic proxy below. */
  /* These regex match req.url AFTER express strips the
     `/wow-beta/api` mount path — so paths look like `/ai/chat/message`
     not `/api/ai/chat/message`. (Previous regex had /api/ baked in
     and never matched → keep-alive never ran → 504.) */
  const slowEndpointPatterns = [
    /^\/ai\/chat\/(start|message|finish)$/,
    /^\/ai\/edit/,
    /^\/ads\/[^/]+\/regenerate(-full|-all)?$/,
  ];
  app.use("/wow-beta/api", express.json({ limit: "10mb" }), async (req, res, next) => {
    const innerPath = req.url.split("?")[0];
    if (!slowEndpointPatterns.some(p => p.test(innerPath))) return next();

    /* Commit headers + first byte immediately so nginx starts seeing
       data. Chunked transfer keeps the connection open.

       CRITICAL: `X-Accel-Buffering: no` tells nginx not to buffer this
       response. Without it, nginx accumulates the heartbeat bytes in
       its proxy buffer and only flushes them when the buffer fills
       or the upstream closes — so the keep-alive bytes never reach
       the client during the wait, and the request hangs even though
       upstream is alive. Same header is used by all SSE endpoints. */
    res.status(200);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("X-Accel-Buffering", "no");
    res.setHeader("X-Wow-Keepalive", "on");
    res.flushHeaders?.();
    res.write(" ");
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(" ");
    }, 20_000);

    try {
      const upstreamUrl = "http://localhost:3001/api" + innerPath;
      const upstreamRes = await fetch(upstreamUrl, {
        method:  req.method,
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(req.body || {}),
      });
      const text = await upstreamRes.text();
      clearInterval(heartbeat);
      /* Upstream's status code is lost since we already committed 200
         to keep the stream alive — fold non-200s into a JSON error so
         the frontend's catch path still fires. */
      if (!upstreamRes.ok) {
        res.write(JSON.stringify({ error: "upstream_error", status: upstreamRes.status, body: text }));
      } else {
        res.write(text);
      }
      res.end();
    } catch (err) {
      clearInterval(heartbeat);
      res.write(JSON.stringify({ error: "proxy_failed", message: String(err?.message || err) }));
      res.end();
    }
  });

  /* Reverse-proxy api + uploads to the child. Express's app.use(path,...)
     strips the mount path before the proxy runs, so by the time
     pathRewrite sees the URL it's already /history, not /wow-beta/api/
     history. We use a function rewrite that prepends the prefix the
     child expects — keeps the child unaware it's mounted under
     /wow-beta/. Falls through here only for endpoints NOT matched by
     the slow-endpoint wrapper above. */
  app.use("/wow-beta/api", createProxyMiddleware({
    target: "http://localhost:3001",
    changeOrigin: true,
    pathRewrite: (p) => "/api" + p,
  }));
  app.use("/wow-beta/uploads", createProxyMiddleware({
    target: "http://localhost:3001",
    changeOrigin: true,
    pathRewrite: (p) => "/uploads" + p,
  }));

  /* Ensure the data dirs exist — WOW backend reads from them on first
     request (e.g. /api/history scans data/sessions) and errors if the
     dirs are missing. Pre-create so first run is clean. */
  const wowDataDir = path.join(wowBackendDir, "data");
  for (const sub of ["sessions", "briefs", "uploads", "templates", "examples"]) {
    fs.mkdirSync(path.join(wowDataDir, sub), { recursive: true });
  }

  /* Serve the built WOW frontend at /wow-beta/. SPA-fallback to
     index.html for client-side routes like /wow-beta/chat, /wow-beta/ads. */
  if (fs.existsSync(wowFrontendDist)) {
    app.use("/wow-beta", express.static(wowFrontendDist));
    app.get("/wow-beta/{*splat}", (_req, res) => {
      res.sendFile(path.join(wowFrontendDist, "index.html"));
    });
    console.log("[wow-beta] mounted at /wow-beta — child on :3001");
  } else {
    console.warn("[wow-beta] frontend dist missing — run `cd wow-beta/frontend && npm run build`");
  }
})();

// Routes
app.use("/api", require("./routes/api"));

// Public LP preview HTML page (no /api prefix — clients hit this directly)
app.get("/lp-preview/:token", require("./controllers/wow-lp.controller").publicPreviewHtml);

// Public WOW Ads preview HTML page (client approves the 10-ad set)
app.get("/wow-ads-preview/:token", require("./controllers/wow-ads.controller").publicAdsPreviewHtml);

// Public WOW Organic preview HTML page (client approves the organic posts)
app.get("/wow-organic-preview/:token", require("./controllers/wow-organic-ads.controller").publicOrganicPreviewHtml);

// Public webinar registration page (standalone link, no app required)
app.get("/webinar/:token", require("./controllers/partnerUpdates.controller").renderPublicWebinarPage);

// Web App (React/Vite - TEMP)
const webAppDist = path.join(__dirname, "public", "webApp", "dist");
app.use("/agent", express.static(webAppDist));
app.get("/agent/{*splat}", (req, res) => {
  res.sendFile(path.join(webAppDist, "index.html"));
});

// ── PDF contract page images ──────────────────────────────────────────────
// Serves from local disk when available; redirects to Backblaze when not.
// Heroku has ephemeral disk — files uploaded at runtime disappear on restart.
// Backblaze is the persistent store for all uploaded contract page images.
const PDF_PAGES_DIR = path.join(__dirname, "pdf", "pages");
const fs = require("fs");
app.get("/pdf-pages/:filename", async (req, res) => {
  const { filename } = req.params;
  // Basic safety check — no path traversal
  if (filename.includes("/") || filename.includes("..")) return res.status(400).end();

  const localPath = path.join(PDF_PAGES_DIR, filename);
  if (fs.existsSync(localPath)) {
    return res.sendFile(localPath);
  }

  // Not on local disk — proxy from Backblaze (bucket is private; redirect would 401)
  try {
    const { downloadImageByPath } = require("./services/backblaze.service");
    const result = await downloadImageByPath(`contract-pages/${filename}`);
    res.set("Content-Type", result.contentType || "image/png");
    res.set("Cache-Control", "public, max-age=3600");
    return res.send(result.buffer);
  } catch {
    // File not in B2 either
  }

  res.status(404).json({ error: `Page image not found: ${filename}` });
});

// ── Admin Dashboard ───────────────────────────────────────────────────────
const adminDashboardDist = path.join(__dirname, "public", "admin-dashboard", "dist");
app.use("/dashboard", express.static(adminDashboardDist));
app.get("/dashboard/{*splat}", (_req, res) => {
  res.sendFile(path.join(adminDashboardDist, "index.html"));
});
app.use("/api/admin", require("./routes/admin-dashboard.routes"));

// ── App Admin (appinfo) ───────────────────────────────────────────────────
const appAdminDist = path.join(__dirname, "public", "app-admin", "dist");
app.use("/appinfo", express.static(appAdminDist));
app.get("/appinfo/{*splat}", (_req, res) => {
  res.sendFile(path.join(appAdminDist, "index.html"));
});
app.use("/api/appinfo", require("./routes/app-admin.routes"));

// ── C-Panel — Account Manager Dashboard ──────────────────────────────────
const cpanelDist = path.join(__dirname, "public", "cpanel", "dist");
app.use("/cpanel", express.static(cpanelDist));
app.get("/cpanel/{*splat}", (req, res) => {
  res.sendFile(path.join(cpanelDist, "index.html"));
});

// ── WhoApp AI (React/Vite) — Customer + Worker SPAs ──────────────────────
const whoAppCustomerDist = path.join(__dirname, "public", "whoAppAi", "apps", "customer", "dist");
const whoAppWorkerDist = path.join(__dirname, "public", "whoAppAi", "apps", "worker", "dist");

app.use("/whoapp/c", express.static(whoAppCustomerDist));
app.get("/whoapp/c/{*splat}", (req, res) => {
  res.sendFile(path.join(whoAppCustomerDist, "index.html"));
});

app.use("/whoapp/w", express.static(whoAppWorkerDist));
app.get("/whoapp/w/{*splat}", (req, res) => {
  res.sendFile(path.join(whoAppWorkerDist, "index.html"));
});

app.get("/whoapp", (req, res) => res.redirect("/whoapp/c"));

// ── WhoApp AI API — embedded sub-app at /whoapp-api ──────────────────────
// Kill-switch: set DISABLE_WHOAPP=true (Heroku config var) to skip the entire
// WhoApp mount. Useful when Redis (which WhoApp's BullMQ workers require) is
// not available on the host — otherwise the workers spam the logs with
// ECONNREFUSED 127.0.0.1:6379 every 2 seconds.
if (process.env.DISABLE_WHOAPP === "true") {
  console.log("⏸️  WhoApp AI disabled via DISABLE_WHOAPP=true");
} else {
  (async () => {
    // mount.mjs calls process.exit(1) on env-validation failure.
    // Intercept it so a bad WhoApp config can't crash the main server.
    const _origExit = process.exit;
    process.exit = (code) => {
      throw new Error(`process.exit(${code}) intercepted during WhoApp mount`);
    };
    try {
      const mountPath = path.join(__dirname, "public", "whoAppAi", "apps", "server", "dist", "mount.mjs");
      const { createWhoAppRouter, attachWhoAppSockets, startWhoAppBackground } =
        await import("file://" + mountPath);
      const whoAppRouter = await createWhoAppRouter();
      app.use("/whoapp-api", whoAppRouter);
      console.log("🤖 WhoApp API mounted at /whoapp-api");
      app.set("whoapp:attachSockets", attachWhoAppSockets);
      app.set("whoapp:startBackground", startWhoAppBackground);
    } catch (err) {
      console.error("⚠️ WhoApp AI mount failed (non-fatal):", err.message);
    } finally {
      process.exit = _origExit;
    }
  })();
}

// WhatsApp click tracker script — drop-in for landing pages.
// Cache for 1 hour; loaded from many landing pages on every page view.
app.get("/wa-tracker.js", (req, res) => {
  res.set("Content-Type", "application/javascript; charset=utf-8");
  res.set("Cache-Control", "public, max-age=3600, must-revalidate");
  res.sendFile(path.join(__dirname, "public", "wa-tracker.js"));
});

// דף הנציג (Agent Panel)
app.get("/app/agent", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "agent.html"));
});

// דף בדיקת דומיין
app.get("/app/domain", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "domain.html"));
});


// דף חיבור WhatsApp (QR code)
app.get("/wa/connect/:id", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "wa-connect.html"));
});

// WA Panel (admin dashboard)
app.use(
  "/wa/panel",
  express.static(path.join(__dirname, "public", "wa-panel")),
);
app.get("/wa/panel/session/:id", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "wa-panel", "session.html"));
});

// Facebook Payment Dialog page — opens FB.ui ads_payment for a given ad account
app.get("/facebook-payment", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "facebook-payment.html"));
});

// Dev tool — manual card tokenization + injection (development only)
app.get("/card-tokenizer", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "card-tokenizer.html"));
});

// Fireberry embedded ads-review widget — loaded inside an iframe on
// the customer record. URL: /fireberry-ads-review?recordId={{record_id}}
//
// Fireberry doesn't reliably substitute merge fields in iframe src
// attributes, so we also try the Referer header — when Fireberry loads
// our iframe, the browser may send the parent page URL with it (requires
// referrerpolicy="unsafe-url" on the iframe for the full path). The
// parent URL pattern is /app/record/{objectType}/{recordId} which we
// match here. If found, we inject the recordId into a small inline
// script so the widget can pick it up without doing regex itself.
app.get("/fireberry-ads-review", (req, res) => {
  const fs = require("fs");
  const referer = req.headers.referer || req.headers.referrer || "";
  const m = referer.match(/\/app\/record\/\d+\/([A-Za-z0-9-]{8,})/);
  const recordId = m ? m[1] : null;

  const htmlPath = path.join(__dirname, "public", "fireberry-ads-review.html");
  let html = fs.readFileSync(htmlPath, "utf-8");

  // ALWAYS inject diagnostic info so the widget can show what we received,
  // even when extraction failed. Helps debug whether the issue is missing
  // Referer (Fireberry stripped referrerpolicy) or our regex (path mismatch).
  const diag = {
    referer,
    refererHasPath: /\/app\/record\//.test(referer),
    extractedRecordId: recordId,
    userAgent: req.headers["user-agent"] || "",
  };
  let inject = `<script>window.__SERVER_DIAG = ${JSON.stringify(diag)};</script>`;
  if (recordId) {
    inject += `<script>window.__INJECTED_RECORD_ID = ${JSON.stringify(recordId)};</script>`;
  }
  html = html.replace("</head>", inject + "</head>");

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

// Mobile onboarding — choose-your-manager screen, served as a static
// page so the mobile app can WebView it with `?phone=05XXXXXXXX`.
app.get("/choose-manager", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "choose-manager.html"));
});

app.get("/googlec860fcf865a99884.html", (req, res) => {
  res.sendFile(path.join(__dirname, "googlec860fcf865a99884.html"));
});

// Public self-serve webinar packages page — a client enters their phone and
// buys their personal packages (Cardcom), just like in the app. Link to share:
// https://api.iconiqmedia.co.il/packages
app.get("/packages", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "packages.html"));
});

// ── Panel SPA: built dist/, JSON 404 for unknown /api paths, index.html
// fallback for client routes. Must stay after every other route.
panel.mountPanelSpa(app);

// יצירת שרת HTTP + Socket.io
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  maxHttpBufferSize: 10 * 1024 * 1024, // 10MB — handles large all_sessions payloads
});

setupSocketManager(io);
app.set("io", io); // expose io to controllers via req.app.get('io')

// WOW manager-notification service — needs io to emit real-time client-response events
try {
  require("./services/wow-manager-notify.service").setIo(io);
} catch (err) {
  console.error("[Startup] wow-manager-notify setIo:", err.message);
}

// Attach WhoApp sockets + background tasks once io exists
setTimeout(() => {
  const attachSockets = app.get("whoapp:attachSockets");
  const startBg = app.get("whoapp:startBackground");
  if (attachSockets) { try { attachSockets(io); } catch (e) { console.error("[WhoApp] attachSockets:", e.message); } }
  if (startBg) { try { startBg(); } catch (e) { console.error("[WhoApp] startBackground:", e.message); } }
}, 1000);

require("./jobs/indexCron")(io);

// ──── Boot: listen first (so Heroku sees the port), then connect DB ────
async function boot() {
  // Bind to the port immediately — Heroku requires this within 60s
  const PORT = process.env.PORT || 3900;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, () => {
      server.removeListener("error", reject);
      console.log(`=================================`);
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`💬 Socket.io (chat) active`);
      console.log(`🖥️  Agent panel: /agent`);
      console.log(`=================================`);
      resolve();
    });
  });

  try {
    await connectDB();
  } catch (err) {
    console.error("Failed to connect to database:", err);
  }

  // Seed / init (non-fatal – server stays up even if one fails)
  try {
    initializeIndexes();
  } catch (e) {
    console.error("[Startup] initializeIndexes:", e.message);
  }
  /* Automatic client WhatsApp messages — welcome / איפיון הושלם / התוצרים מוכנים. */
  try {
    require("./services/client-notify.service").startWorker();
  } catch (e) {
    console.error("[Startup] client-notify worker:", e.message);
  }
  try {
    agentsController.initAdmin();
  } catch (e) {
    console.error("[Startup] initAdmin:", e.message);
  }

  /* Products catalog — seed the BillingTab defaults if collection is empty.
     Must run AFTER connectDB() (the controller's eager call may have fired
     before the DB was ready). */
  try {
    await require("./services/cpanel-products.service").seedDefaults();
  } catch (e) {
    console.error("[Startup] cpanel-products seedDefaults:", e.message);
  }
  try {
    await require("./services/cpanel-products.service").refreshSocialDefaults();
  } catch (e) {
    console.error("[Startup] cpanel-products refreshSocialDefaults:", e.message);
  }
  try {
    await require("./services/cpanel-products.service").deactivateAppCoinsFromCpanel();
  } catch (e) {
    console.error("[Startup] cpanel-products deactivateAppCoinsFromCpanel:", e.message);
  }

  try {
    require("./services/meeting-statuses.service").seedDefaultStatuses();
  } catch (e) {
    console.error("[Startup] seedDefaultStatuses:", e.message);
  }
  try {
    require("./services/google-drive.service").reloadOAuthClient();
  } catch (e) {
    console.error("[Startup] reloadOAuthClient:", e.message);
  }

  // ── WhatsApp Marketing infrastructure ────────────────────────────────────
  try {
    await require("./services/marketing/dynamic-config.service").seedDefaults();
  } catch (e) {
    console.error("[Startup] WA DynamicConfig seedDefaults:", e.message);
  }
  try {
    await require("./services/marketing/wa-queue.service").ensureIndexes();
  } catch (e) {
    console.error("[Startup] WA Queue ensureIndexes:", e.message);
  }
  try {
    await require("./services/wa-health-log.service").ensureIndexes();
  } catch (e) {
    console.error("[Startup] WA HealthLog ensureIndexes:", e.message);
  }
  try {
    await require("./services/wa-clicks.service").ensureIndexes();
  } catch (e) {
    console.error("[Startup] WA Clicks ensureIndexes:", e.message);
  }
  try {
    const worker = require("./services/marketing/wa-worker.service");
    const mktSession = require("./services/marketing/wa-marketing-session.service");

    // Subscribe to Kill Switch emergencies — forward to Socket.io admin room
    mktSession.onEmergency((payload) => {
      console.error("[KillSwitch] Emergency:", payload);
      io.to("admin").emit("wa_marketing_emergency", payload);
    });

    worker.start();
    console.log("📤 WA Marketing worker started");
  } catch (e) {
    console.error("[Startup] WA Worker:", e.message);
  }

  try {
    require("./cron/publish-creatives.cron").startPublishCron();
  } catch (e) {
    console.error("[Startup] PublishCron:", e.message);
  }

  try {
    require("./cron/account-manager.cron").startAccountManagerCron();
  } catch (e) {
    console.error("[Startup] AcctMgrCron:", e.message);
  }

  /* WOW Ads resume — scan for sessions interrupted by the previous restart
     (Heroku push, dyno cycle, crash). The pipeline is idempotent per-step:
     ads with imageUrl get skipped, prompts get reused, only the missing
     work runs. Fire-and-forget so the resume work doesn't delay startup. */
  try {
    require("./services/wow-ads.service")
      .resumeStuckAdsSessions()
      .catch(e => console.error("[Startup] wow-ads resume scanner:", e.message));
  } catch (e) {
    console.error("[Startup] wow-ads resume:", e.message);
  }

  /* WOW Ads auto-retry watchdog — webinar safety net. Genuine failures
     (e.g. OpenAI 429 out-of-credit) don't self-heal via the resume scanner;
     this periodic sweep re-tries them up to 3× with a cooldown, so a
     mid-webinar credit top-up recovers every stuck campaign automatically. */
  try {
    require("./services/wow-ads.service").startAdsRetryWatchdog(60e3);
  } catch (e) {
    console.error("[Startup] wow-ads retry watchdog:", e.message);
  }

  /* Webinar subscription renewal — monthly $300 charge sweep for the
     "חבילת וובינר" plan. GATED: runs DRY (charges nothing, just logs) unless
     env SUBSCRIPTION_RENEWAL_ENABLED=true, so the billing job can be verified
     before it ever touches a real card. First renewal is ~30 days out. */
  try {
    require("./services/webinar-subscription.service").startRenewalWatchdog(6 * 3600e3);
  } catch (e) {
    console.error("[Startup] webinar subscription watchdog:", e.message);
  }

  /* App subscription tiers (REGULAR/PRO/VIP) — monthly coin RESET + recurring
     charge sweep. Grandfathered (free) clients refresh their quota with no
     charge, even in DRY-RUN; paid tiers only charge when
     SUBSCRIPTION_RENEWAL_ENABLED=true. */
  try {
    require("./services/tier-subscription.service").startTierRenewalWatchdog(6 * 3600e3);
  } catch (e) {
    console.error("[Startup] tier subscription watchdog:", e.message);
  }
  try {
    require("./services/wow-organic-ads.service")
      .resumeStuckOrganicAdsSessions()
      .catch(e => console.error("[Startup] wow-organic-ads resume scanner:", e.message));
  } catch (e) {
    console.error("[Startup] wow-organic-ads resume:", e.message);
  }
  try {
    require("./services/wow-lp.service")
      .resumeStuckLpSessions()
      .catch(e => console.error("[Startup] wow-lp resume scanner:", e.message));
  } catch (e) {
    console.error("[Startup] wow-lp resume:", e.message);
  }

  // Restore WhatsApp sessions only in production after a short delay.
  // The delay gives WhatsApp's servers time to detect the previous TCP connection
  // died before the new one arrives — preventing code 440 (connectionReplaced).
  if (NODE_ENV === "production") {
    try {
      const { restoreSessions } = require("./services/wa-session.service");
      console.log("[WA] Waiting 5s before restoring sessions (anti-440 delay)...");
      await new Promise((r) => setTimeout(r, 5000));
      await restoreSessions(io);
    } catch (err) {
      console.error("[WA] Startup session restore failed:", err.message);
    }
  } else {
    console.log(`[WA] Skipping session restore in ${NODE_ENV}`);
  }

  // BillPilot job queue — Agenda (MongoDB-backed)
  try {
    const { initBpJobs } = require("./jobs/bp-jobs");
    await initBpJobs();
    console.log("✦ BillPilot job queue started");
  } catch (e) {
    console.error("[Startup] BillPilot jobs:", e.message);
  }

  // WOW pipeline job queue — register runners + resume any stuck jobs
  try {
    const pipelineRunner = require("./services/wow/pipeline-runner.service");
    const jobService = require("./services/wow/job.service");
    pipelineRunner.register();
    // Delay resume slightly to let indexes finish
    setTimeout(() => {
      jobService.resumePendingJobs().catch((err) =>
        console.error("[wow/jobs] resume failed:", err.message),
      );
    }, 3000);
    console.log("✦ WOW job queue registered");
  } catch (e) {
    console.error("[Startup] WOW job queue:", e.message);
  }
}

boot().catch((err) => {
  console.error("❌ Fatal startup error:", err.message);
  process.exit(1);
});

// ──── Graceful shutdown ────────────────────────────────────────────────────────
// On SIGTERM / SIGINT (server restart, deploy, PM2 reload):
//   1. Stop the marketing worker
//   2. Close Baileys sockets WITHOUT logout — auth keys stay valid in DB
//   3. Keep DB status as "connected" so restoreSessions reconnects on next boot
//   4. Exit
//
// On next startup: restoreSessions() reconnects all sessions automatically.
// No QR re-scan needed. A 5-second delay before restore gives WA time to
// detect the old TCP connection died before the new one arrives (prevents 440).
async function shutdown(signal) {
  console.log(`\n[Server] ${signal} received — shutting down gracefully...`);

  // Stop the marketing worker first (no new jobs)
  try {
    require("./services/marketing/wa-worker.service").stop();
  } catch {}

  // Preserve sockets for automatic restore only in production.
  if (NODE_ENV === "production") {
    try {
      const waService = require("./services/wa-session.service");
      const activeSessions = [...waService.sessions.keys()];
      console.log(`[Server] Closing ${activeSessions.length} WhatsApp socket(s) (auth keys preserved)...`);

      for (const sessionId of activeSessions) {
        try {
          const entry = waService.sessions.get(sessionId);
          if (entry?.socket) entry.socket.end();
          console.log(`[Server] Session ${sessionId} socket closed.`);
        } catch (err) {
          console.error(`[Server] Error closing session ${sessionId}:`, err.message);
        }
      }
      // DO NOT update DB status — keep "connected" so restoreSessions picks them up
      waService.sessions.clear();
    } catch (err) {
      console.error("[Server] Error during WA shutdown:", err.message);
    }
  } else {
    console.log(`[Server] Skipping WA session preservation in ${NODE_ENV}`);
  }

  // Close HTTP server — force-drop keep-alive connections so port is released immediately
  server.closeAllConnections?.();
  server.close(() => {
    console.log("[Server] HTTP server closed. Sessions will auto-reconnect on next boot.");
    process.exit(0);
  });

  // Force exit after 8s if something hangs
  setTimeout(() => {
    console.error("[Server] Forced exit after timeout.");
    process.exit(1);
  }, 8000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));

// Top-level safety net — log unhandled errors instead of crashing the dyno.
// Without this, e.g. a brief MongoDB connectivity blip during a background
// poll (agenda, cron) bubbles up as an unhandled rejection and exits the
// process. We'd rather keep serving requests with degraded background work.
process.on("unhandledRejection", (reason) => {
  console.error("[Process] unhandledRejection:", reason?.message || reason);
});
process.on("uncaughtException", (err) => {
  console.error("[Process] uncaughtException:", err?.message || err, err?.stack);
});
