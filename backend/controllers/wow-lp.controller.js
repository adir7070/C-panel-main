/**
 * WOW Landing Page controller
 *
 *   Cpanel-protected (under /api/cpanel):
 *     POST  /clients/:phone/wow-lp/generate           — start pipeline
 *     GET   /clients/:phone/wow-lp                    — fetch latest session
 *     GET   /clients/:phone/wow-lp/status             — quick polling
 *     PATCH /clients/:phone/wow-lp                    — apply field-level edits
 *     POST  /clients/:phone/wow-lp/regenerate-image   — regenerate single image
 *     POST  /clients/:phone/wow-lp/send-approval      — generate token + return public link
 *
 *   Public (no auth) — under /api/wow-lp:
 *     GET  /preview/:token                            — return LP json for client preview
 *     POST /preview/:token/approve                    — client approves
 *     POST /preview/:token/reject                     — client rejects (with feedback)
 */

const multer = require("multer");
const { getDB } = require("../config/db");
const {
  runLpPipeline,
  runLpPipelineV2,
  regenerateImage,
  uploadCustomImage,
  setSectionImageFromUrl,
  applyTextPatch,
  getLatestSessionForPhone,
  setApprovalToken,
  getSessionByApprovalToken,
  setApprovalDecision,
} = require("../services/wow-lp.service");
const { pickTemplate } = require("../services/wow-lp-v2.service");
const { autoBumpToSentToCreation } = require("../services/package-lifecycle.service");
const { notifyManagerOfClientDecision } = require("../services/wow-manager-notify.service");

/* Same scope-to-active-package helpers as in wow-ads.controller.js. */
async function activePackageSinceMs(phone) {
  try {
    const u = await getDB().collection("users").findOne(
      { phone },
      { projection: { activePackage: 1 } },
    );
    const t = u?.activePackage?.purchasedAt;
    if (!t) return null;
    const ms = typeof t === "string" ? Date.parse(t) : new Date(t).getTime();
    return Number.isFinite(ms) ? ms : null;
  } catch (_e) { return null; }
}
function sessionPredatesActive(sess, sinceMs) {
  if (!sinceMs || !sess?.createdAt) return false;
  const t = new Date(sess.createdAt).getTime();
  return Number.isFinite(t) && t < sinceMs;
}

const lpImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error(`Invalid type: ${file.mimetype}`));
  },
});
exports.lpImageUploadMw = lpImageUpload.single("image");

function newSessionId() {
  return `wlp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function buildBriefForClient(phone) {
  const profile = await getDB().collection("business_profiles").findOne({ phone });
  if (!profile) throw new Error("business_profile not found");

  const required = [];
  if (!profile.businessName)     required.push("businessName");
  if (!profile.categoryKey)      required.push("categoryKey");
  if (!profile.services?.length) required.push("services");
  if (!profile.pageGoal)         required.push("pageGoal");
  if (!profile.targetAudience?.length) required.push("targetAudience");
  if (required.length) {
    const err = new Error(`חסרים שדות באיפיון: ${required.join(", ")}`);
    err.code = "INCOMPLETE_PROFILE";
    throw err;
  }

  const services = (profile.services || [])
    .map(s => `${s.title}${s.description ? `: ${s.description}` : ""}`)
    .join("; ");

  /* Normalize the logo to a URL that resolves both in the cpanel preview
     iframe AND on the deployed Netlify page:
       - data: URLs → dropped (huge base64 blobs that balloon the prompt).
       - absolute http(s) or /api/ paths → kept as-is.
       - bare B2 path / filename (how some profiles store it) → wrapped as
         /api/img?url=… so it actually loads (a bare "abc.png" src 404s on
         both the preview and Netlify — exactly the broken-logo symptom). */
  const rawLogo = typeof profile.logoUrl === "string" ? profile.logoUrl.trim() : "";
  let safeLogo = null;
  if (rawLogo && rawLogo.startsWith("data:")) {
    console.warn(`[wow-lp] dropping data: URL logo for ${phone} (size=${rawLogo.length}).`);
  } else if (/^https?:\/\//i.test(rawLogo) || rawLogo.startsWith("/api/")) {
    safeLogo = rawLogo;
  } else if (rawLogo) {
    safeLogo = `/api/img?url=${encodeURIComponent(rawLogo.replace(/^\/+/, ""))}`;
  }

  /* Business contact phone shown on the page. Prefer an explicit
     businessPhone from the characterization; fall back to the client's own
     phone (the account phone) so the LP always has a real number to inject —
     the phone placeholders are filled deterministically in the v2 service,
     not by the AI. */
  const contactPhone = profile.businessPhone || phone;

  const subNiche = profile.subCategoryCustom
    || (Array.isArray(profile.subCategoryKeys)
          ? profile.subCategoryKeys.filter(k => k && k !== "other_input").join(", ")
          : "");

  return {
    businessName:    profile.businessName,
    businessShortName: profile.businessShortName || profile.businessName,
    industry:        profile.categoryKey,
    businessField:   profile.categoryKey,
    businessNiche:   subNiche,
    /* Real domain content from the characterization — the v2 text + image
       stages anchor every value on these. Without them the AI has nothing
       to ground on and falls back to the template's original industry. */
    about:           profile.about || "",
    services:        services,
    promotion:       profile.promotion || "",
    targetAudience:  Array.isArray(profile.targetAudience) ? profile.targetAudience.join(", ") : "",
    /* Contact details — flow into footer / contact / tel: / wa.me slots. */
    phone:           contactPhone,
    businessPhone:   contactPhone,
    email:           profile.email || "",
    address:         profile.address || "",
    websiteUrl:      profile.websiteUrl || "",
    socialLinks:     profile.socialLinks || null,
    primaryGoal:     profile.pageGoal,
    keyOffer:        profile.promotion || services || profile.about || profile.businessName,
    brandTone:       profile.designStyle || "professional",
    designStyle:     profile.designStyle,
    callToActionText: profile.pageGoal === "leads"       ? "השאר פרטים" :
                      profile.pageGoal === "sales"       ? "להזמנה" :
                      profile.pageGoal === "appointment" ? "קבע תור" :
                      profile.pageGoal === "contact"     ? "צור קשר" :
                      "פרטים נוספים",
    preferredColors: profile.preferredColors || null,
    logo:            safeLogo,
    /* NOTE: intentionally NOT passing the client's uploaded images here.
       The v2 image stage treats any usable image URL as "already done" and
       SKIPS Gemini generation for that slot (isUsableImageValue). Feeding
       the characterization photos in made the LP reuse those files instead
       of generating fresh editorial images — which broke image generation.
       Accurate images come from generating against services/about (below)
       + the destination-aware Director, not from reusing uploads. */
  };
}

/* ── Cpanel endpoints ───────────────────────────────────────────────── */

exports.generateLp = async (req, res) => {
  try {
    const { phone } = req.params;
    let brief;
    try { brief = await buildBriefForClient(phone); }
    catch (err) {
      if (err.code === "INCOMPLETE_PROFILE") {
        return res.status(400).json({ error: err.message, code: "INCOMPLETE_PROFILE" });
      }
      throw err;
    }

    /* Tag the LP session with the active-package fingerprint so the
       products-history view can attribute the LP to the right purchase. */
    try {
      const user = await getDB().collection("users").findOne(
        { phone }, { projection: { activePackage: 1 } },
      );
      const ap = user?.activePackage;
      if (ap?.id && ap?.purchasedAt) {
        brief.packageId = `pkg_${ap.id || "custom"}_${String(ap.purchasedAt).replace(/[:.]/g, "-")}`;
      }
    } catch (err) {
      console.warn(`[wow-lp] could not read activePackage for ${phone}: ${err.message}`);
    }

    const sessionId = newSessionId();
    autoBumpToSentToCreation(phone, "wow-lp-generate").catch(() => {});

    /* v2 always wins: pickTemplate now returns a sentinel ("auto")
       meaning the AI will pick a template inside the v2 service per
       brief. v1 stays in the codebase as a safety net but isn't
       routed to from generate anymore.

       The optional `template` field in the request body forces a
       specific template (one of the 11 in services/wow-lp-templates/),
       bypassing the AI picker. Used by the cpanel UI when the manager
       wants to override the AI's choice. */
    void pickTemplate;
    const forceTemplate = req.body?.template || null;
    runLpPipelineV2(sessionId, phone, brief, forceTemplate).catch(err =>
      console.error(`[wow-lp] v2 pipeline crashed for ${sessionId}:`, err)
    );

    res.json({ success: true, sessionId, status: "generating_content", engine: "v2", forcedTemplate: forceTemplate });
  } catch (err) {
    console.error("[wow-lp] generate failed:", err);
    res.status(500).json({ error: err.message });
  }
};

exports.getLp = async (req, res) => {
  try {
    const { phone } = req.params;
    const [sess, sinceMs] = await Promise.all([
      getLatestSessionForPhone(phone),
      activePackageSinceMs(phone),
    ]);
    if (!sess || sessionPredatesActive(sess, sinceMs)) return res.json({ session: null });
    res.json({ session: sanitizeSession(sess) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/* POST /api/cpanel/clients/:phone/wow-lp/render-v2
   Renders the LP using the new template-driven engine
   (services/wow-lp-v2.service.js + services/wow-lp-templates/*).
   Persists the resulting HTML onto the active session so all the
   existing surfaces (preview, send-for-approval, deploy-to-netlify)
   work without further changes.

   Body: { template?: string }  // optional override; otherwise picked
                                // from brief.businessField
   Returns: { success, sessionId, templateName, htmlLength, keys: {
     text, src, href } } */
exports.renderLpV2 = async (req, res) => {
  try {
    const { phone } = req.params;
    const force = req.body?.template;

    const sess = await getLatestSessionForPhone(phone);
    if (!sess) return res.status(404).json({ error: "אין session דף נחיתה ללקוח הזה" });

    /* Reuse the brief the existing pipeline built — same shape, same
       images, same brand. If the session doesn't carry a brief (e.g.
       legacy), fall back to buildBriefForClient. */
    let brief = sess.brief;
    if (!brief) {
      try { brief = await buildBriefForClient(phone); }
      catch (err) { return res.status(400).json({ error: err.message }); }
    }

    const v2 = require("../services/wow-lp-v2.service");
    const result = await v2.renderLandingPageV2({ brief, template: force });

    /* Store on the session so the existing preview / send-for-approval /
       deploy-to-netlify endpoints pick it up automatically. */
    await require("../services/wow-lp.service").updateSessionFields(sess.sessionId, {
      html: result.html,
      lpV2: {
        templateName:     result.templateName,
        renderedAt:       new Date(),
        placeholderCount: result.placeholders.length,
        valueCount:       Object.keys(result.values || {}).length,
      },
    });

    res.json({
      success:          true,
      sessionId:        sess.sessionId,
      templateName:     result.templateName,
      htmlLength:       result.html.length,
      placeholderCount: result.placeholders.length,
      valueCount:       Object.keys(result.values || {}).length,
    });
  } catch (err) {
    console.error("[wow-lp] renderLpV2:", err.message);
    res.status(500).json({ error: err.message || "ייצור v2 נכשל" });
  }
};

/* POST /api/cpanel/clients/:phone/wow-lp/deploy-netlify
   "🚀 פרסם ל-Netlify" button on the WowLpPanel.
   Takes the current LP HTML out of the session and publishes it to
   Netlify as a 1-file static site. Returns the public URL the
   manager can hand to the customer.

   Idempotent — once a site is created for a phone we cache its
   site_id on the session and re-deploy to the same site on every
   subsequent click (so the URL stays stable across content edits).

   Requires NETLIFY_API_TOKEN env var on Heroku. The token must have
   `sites:write` + `deploys:write` scope. Per-agency token (one for
   all clients) — not per-client. */
exports.deployLpToNetlify = async (req, res) => {
  try {
    const { phone } = req.params;
    const NETLIFY_TOKEN = process.env.NETLIFY_API_TOKEN;
    if (!NETLIFY_TOKEN) {
      return res.status(500).json({ error: "Netlify לא מוגדר בשרת — חסר NETLIFY_API_TOKEN" });
    }

    const [sess, sinceMs] = await Promise.all([
      getLatestSessionForPhone(phone),
      activePackageSinceMs(phone),
    ]);
    if (!sess || sessionPredatesActive(sess, sinceMs)) {
      return res.status(404).json({ error: "אין דף נחיתה ללקוח הזה" });
    }
    if (typeof sess.html !== "string" || !sess.html.trim()) {
      return res.status(400).json({ error: "דף הנחיתה עוד לא הופק" });
    }

    /* Rewrite /api/img?url=... references to absolute URLs so the
       deployed page can still load images proxied through the API
       server (Backblaze + Drive paths). Netlify doesn't know how to
       resolve relative /api paths — the page would render with
       broken images otherwise. */
    const apiOrigin = (process.env.BASE_URL || "https://api.iconiqmedia.co.il").replace(/\/$/, "");
    const html = sess.html.replace(/(src|href)="\/api\//g, `$1="${apiOrigin}/api/`);

    const fetch = global.fetch || ((...args) => import("node-fetch").then(({ default: f }) => f(...args)));
    const archiver = require("archiver");
    const { PassThrough } = require("stream");

    /* Reuse the previously-created site if we have one cached on the
       session — keeps the URL stable across redeploys. */
    let siteId = sess.netlifySiteId || null;
    let siteUrl = sess.netlifySiteUrl || null;

    if (!siteId) {
      /* Site name: lowercase slug of businessName + last-4 of phone +
         4-char random suffix. Netlify only accepts [a-z0-9-]; falls
         back to phone-only when the businessName has no Latin chars. */
      const rawName = String(sess.brief?.businessName || sess.brief?.businessShortName || "").toLowerCase();
      const slug = rawName.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "client";
      const last4 = String(phone).slice(-4);
      const suffix = Math.random().toString(36).slice(2, 6);
      const siteName = `iconiq-${slug || "lp"}-${last4}-${suffix}`;

      const siteResp = await fetch("https://api.netlify.com/api/v1/sites", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${NETLIFY_TOKEN}`,
        },
        body: JSON.stringify({ name: siteName }),
      });
      const siteData = await siteResp.json().catch(() => ({}));
      if (!siteResp.ok || !siteData.id) {
        return res.status(500).json({
          error: "יצירת אתר ב-Netlify נכשלה",
          netlifyError: siteData.message || siteData.error || `HTTP ${siteResp.status}`,
        });
      }
      siteId  = siteData.id;
      siteUrl = siteData.ssl_url || siteData.url;
    }

    /* Build the deploy zip in-memory: index.html + (placeholder)
       _redirects so SPA-like routes 404 cleanly. Future: also bundle
       referenced /api/img assets so Netlify serves them directly
       instead of proxying through the API. */
    const archive = archiver("zip");
    const sink = new PassThrough();
    const chunks = [];
    sink.on("data", c => chunks.push(c));
    const zipDone = new Promise((resolve, reject) => {
      sink.on("end", () => resolve(Buffer.concat(chunks)));
      sink.on("error", reject);
      archive.on("error", reject);
    });
    archive.pipe(sink);
    archive.append(html, { name: "index.html" });
    archive.append("# Netlify\n/* /index.html 200\n", { name: "_redirects" });
    archive.finalize();
    const zipBuf = await zipDone;

    const deployResp = await fetch(`https://api.netlify.com/api/v1/sites/${siteId}/deploys`, {
      method: "POST",
      headers: {
        "Content-Type": "application/zip",
        Authorization: `Bearer ${NETLIFY_TOKEN}`,
      },
      body: zipBuf,
    });
    const deployData = await deployResp.json().catch(() => ({}));
    if (!deployResp.ok) {
      return res.status(500).json({
        error: "פריסת Netlify נכשלה",
        netlifyError: deployData.message || deployData.error || `HTTP ${deployResp.status}`,
      });
    }

    /* Persist the site identifier so the next deploy lands on the
       same URL. The deploy URL refreshes per deploy; we surface the
       site's stable URL to the manager. */
    const liveUrl = siteUrl || deployData.ssl_url || deployData.url;
    await require("../services/wow-lp.service").updateSessionFields(sess.sessionId, {
      netlifySiteId:    siteId,
      netlifySiteUrl:   liveUrl,
      netlifyDeployId:  deployData.id,
      netlifyDeployedAt: new Date(),
    }).catch(e => console.warn("[wow-lp] persist netlify ids failed:", e.message));

    res.json({
      success:    true,
      siteId,
      url:        liveUrl,
      deployId:   deployData.id,
      deployedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[wow-lp] deployLpToNetlify:", err.message);
    res.status(500).json({ error: err.message || "פריסת Netlify נכשלה" });
  }
};

exports.getLpStatus = async (req, res) => {
  try {
    const { phone } = req.params;
    const [sess, sinceMs] = await Promise.all([
      getLatestSessionForPhone(phone),
      activePackageSinceMs(phone),
    ]);
    if (!sess || sessionPredatesActive(sess, sinceMs)) return res.json({ session: null });
    res.json({
      sessionId:        sess.sessionId,
      status:           sess.status,
      totalImages:      sess.totalImages,
      completedImages:  sess.completedImages,
      approvalStatus:   sess.approvalStatus,
      error:            sess.error,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.patchLp = async (req, res) => {
  try {
    const { phone }   = req.params;
    const { patches } = req.body;
    const sess = await getLatestSessionForPhone(phone);
    if (!sess) return res.status(404).json({ error: "no session" });
    const updated = await applyTextPatch(sess.sessionId, patches || []);
    res.json({ session: sanitizeSession(updated) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.uploadLpImage = async (req, res) => {
  try {
    const { phone } = req.params;
    const section = req.body?.section;
    if (!section)   return res.status(400).json({ error: "section required" });
    if (!req.file)  return res.status(400).json({ error: "image file required (multipart 'image')" });
    const sess = await getLatestSessionForPhone(phone);
    if (!sess) return res.status(404).json({ error: "no session" });
    const result = await uploadCustomImage(sess.sessionId, section, req.file.buffer, req.file.mimetype);
    res.json({ success: true, image: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.regenerateLpImage = async (req, res) => {
  try {
    const { phone } = req.params;
    const { section } = req.body;
    if (!section) return res.status(400).json({ error: "section required" });
    const sess = await getLatestSessionForPhone(phone);
    if (!sess) return res.status(404).json({ error: "no session" });
    const result = await regenerateImage(sess.sessionId, section);
    res.json({ success: true, image: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.setLpSectionImage = async (req, res) => {
  try {
    const { phone } = req.params;
    const { section, imageUrl } = req.body || {};
    if (!section)  return res.status(400).json({ error: "section required" });
    if (!imageUrl) return res.status(400).json({ error: "imageUrl required" });
    const sess = await getLatestSessionForPhone(phone);
    if (!sess) return res.status(404).json({ error: "no session" });
    const result = await setSectionImageFromUrl(sess.sessionId, section, imageUrl);
    res.json({ success: true, image: result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

exports.sendForApproval = async (req, res) => {
  try {
    const { phone } = req.params;
    const sess = await getLatestSessionForPhone(phone);
    if (!sess) return res.status(404).json({ error: "no session" });
    if (sess.status !== "done") return res.status(400).json({ error: "LP not ready yet" });
    const token = await setApprovalToken(sess.sessionId);
    const baseUrl = process.env.SERVER_BASE_URL || `${req.protocol}://${req.get("host")}`;
    const previewUrl = `${baseUrl}/lp-preview/${token}`;

    const businessName = sess.brief?.businessName || "העסק שלך";
    const message =
      `שלום! 👋\n\n` +
      `הכנו עבורך טיוטה של דף נחיתה ל"${businessName}". ` +
      `אשמח אם תוכל/י לאשר אותה או לכתוב לנו אם משהו דורש שינוי.\n\n` +
      `📄 לתצוגה ואישור:\n${previewUrl}\n\n` +
      `תודה!`;

    /* Send via WhatsApp (Green API) + SMS as fallback — both non-fatal */
    let sentChannels = [];
    try {
      const greenApi = require("../services/greenapi.service");
      await greenApi.sendMessage(phone, message);
      sentChannels.push("whatsapp");
    } catch (e) {
      console.warn("[wow-lp] WhatsApp send failed:", e.message);
    }
    try {
      const { sendSMS } = require("../services/sms4free.service");
      await sendSMS(phone, message);
      sentChannels.push("sms");
    } catch (e) {
      console.warn("[wow-lp] SMS send failed:", e.message);
    }

    res.json({ success: true, token, previewUrl, sentChannels });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/* ── Public LP preview HTML page ────────────────────────────────────── */
/* Serves a standalone HTML page at GET /lp-preview/:token (no auth).
   The page renders the LP from session data + approve/reject buttons. */
exports.publicPreviewHtml = async (req, res) => {
  try {
    const { token } = req.params;
    const sess = await require("../services/wow-lp.service").getSessionByApprovalToken(token);
    if (!sess) {
      res.status(404).set("Content-Type", "text/html; charset=utf-8").send(notFoundHtml());
      return;
    }
    const html = renderPreviewPage(sess, token);
    res.set("Content-Type", "text/html; charset=utf-8").send(html);
  } catch (err) {
    res.status(500).set("Content-Type", "text/html; charset=utf-8")
      .send(`<h1>שגיאה</h1><p>${escapeHtml(err.message || "שגיאה")}</p>`);
  }
};

/* ── HTML render helpers ────────────────────────────────────────────── */

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function notFoundHtml() {
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">
<title>הקישור לא תקף</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font-family:Heebo,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f8fafc;color:#0b1430;text-align:center;padding:20px}div{max-width:420px}h1{font-size:28px;margin:0 0 12px;font-weight:800}p{color:#64748b;line-height:1.6}</style>
</head><body><div><h1>הקישור לא תקף או פג תוקף</h1><p>צור קשר עם מנהל התיק שלך לקבלת קישור חדש.</p></div></body></html>`;
}

/* Serve the stored WOW HTML (utils/wow-lp-template) when present, injecting the
   approval bar + its styles + approve/reject JS at serve-time so the bar always
   reflects the live approvalStatus. Falls back to the legacy renderer for
   sessions generated before the template engine existed. */
function renderPreviewPage(sess, token) {
  if (sess && typeof sess.html === "string" && sess.html.length > 0) {
    const block = buildApprovalBlock(sess, token);
    return sess.html.includes("</body>")
      ? sess.html.replace("</body>", `${block}\n</body>`)
      : sess.html + block;
  }
  return renderLpPreviewHtml(sess, token);
}

/* Approval bar markup + styles + client JS, self-contained so it can be grafted
   onto the template-engine HTML (which has no .lp-* approval styles of its own). */
function buildApprovalBlock(sess, token) {
  const alreadyResponded = sess.approvalStatus === "approved" || sess.approvalStatus === "rejected";
  const approvalHtml = alreadyResponded ? `
    <div class="lp-approval-done lp-approval-${sess.approvalStatus}">
      ${sess.approvalStatus === "approved"
        ? `<strong>✓ אישרת את הדף — תודה!</strong> ניצור איתך קשר בקרוב להמשך התהליך.`
        : `<strong>✗ העברת בקשה לשינויים</strong>${sess.clientFeedback ? ` — "${escapeHtml(sess.clientFeedback)}"` : ""} — מנהל התיק יחזור אליך.`}
    </div>` : `
    <div class="lp-approval-bar" id="approvalBar">
      <div class="lp-approval-text"><strong>טיוטה לאישור</strong> · בדוק את הדף ואשר אם הוא מתאים, או שלח שינויים</div>
      <div class="lp-approval-actions">
        <button class="lp-btn-approve" onclick="approveLp()">✓ אני מאשר</button>
        <button class="lp-btn-reject"  onclick="rejectLp()">✗ דרוש שינויים</button>
      </div>
    </div>`;

  return `<style>
body{padding-bottom:92px}
.lp-approval-bar{position:fixed;bottom:0;left:0;right:0;background:#fff;border-top:1px solid rgba(0,0,0,.10);padding:14px 24px;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;box-shadow:0 -8px 24px -8px rgba(0,0,0,.12);z-index:100}
.lp-approval-text{font-size:14px;color:#0b1430;flex:1;min-width:200px}
.lp-approval-actions{display:flex;gap:10px}
.lp-btn-approve,.lp-btn-reject{padding:10px 22px;border-radius:12px;font-size:14px;font-weight:700;border:none;cursor:pointer;transition:transform 180ms}
.lp-btn-approve{background:#10b981;color:#fff}
.lp-btn-reject{background:transparent;color:#ef4444;border:1.5px solid #ef4444}
.lp-btn-approve:hover,.lp-btn-reject:hover{transform:translateY(-1px)}
.lp-approval-done{position:fixed;bottom:0;left:0;right:0;padding:18px 24px;text-align:center;font-size:14px;z-index:100;box-shadow:0 -8px 24px -8px rgba(0,0,0,.12)}
.lp-approval-approved{background:#ecfdf5;color:#065f46;border-top:2px solid #10b981}
.lp-approval-rejected{background:#fef2f2;color:#991b1b;border-top:2px solid #ef4444}
</style>
${approvalHtml}
<script>
const TOKEN = ${JSON.stringify(token)};
const API   = ${JSON.stringify(req_apiBase())};
async function approveLp(){
  if(!confirm("לאשר את הדף? אחרי האישור לא ניתן לשנות."))return;
  const b=document.querySelectorAll(".lp-btn-approve,.lp-btn-reject");b.forEach(x=>x.disabled=true);
  try{const r=await fetch(API+"/wow-lp/preview/"+encodeURIComponent(TOKEN)+"/approve",{method:"POST"});if(!r.ok)throw 0;location.reload();}
  catch(e){alert("שגיאה — נסה שוב");b.forEach(x=>x.disabled=false);}
}
async function rejectLp(){
  const f=prompt("מה צריך לשנות? (נשלח למנהל תיק)");if(f===null)return;
  const b=document.querySelectorAll(".lp-btn-approve,.lp-btn-reject");b.forEach(x=>x.disabled=true);
  try{const r=await fetch(API+"/wow-lp/preview/"+encodeURIComponent(TOKEN)+"/reject",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({feedback:f})});if(!r.ok)throw 0;location.reload();}
  catch(e){alert("שגיאה — נסה שוב");b.forEach(x=>x.disabled=false);}
}
</script>`;
}

function renderLpPreviewHtml(sess, token) {
  const lp = sess.landing_page || {};
  const t = sess.design_theme || {};
  const images = sess.images || [];
  const heroImg     = images.find(i => i.section === "hero")?.url;
  const aboutImg    = images.find(i => i.section === "about")?.url;
  const finalCtaImg = images.find(i => i.section === "final_cta")?.url;

  const primary    = t.primaryColor    || "#1E3A8A";
  const secondary  = t.secondaryColor  || "#06B6D4";
  const accent     = t.accentColor     || "#10B981";
  const headingC   = t.headingColor    || secondary;
  const bodyC      = t.bodyColor       || "#4b5563";
  const pageBg     = t.pageBgColor     || "#ffffff";
  const sectionBg  = t.sectionBgColor  || secondary;
  const radius     = t.radius != null ? t.radius : 12;
  const fontFamily = t.fontFamily      || "Heebo";
  const overlayOp  = t.overlayOpacity != null ? t.overlayOpacity : 0.45;

  const businessName = sess.brief?.businessName || "העסק שלך";
  const clientLogoUrl = typeof sess.brief?.logo === "string" && sess.brief.logo && !sess.brief.logo.startsWith("data:")
    ? sess.brief.logo
    : null;
  const sectionOrder = Array.isArray(t.sectionOrder) && t.sectionOrder.length
    ? t.sectionOrder
    : ["hero", "about", "services", "why_us", "process", "testimonials", "faq", "final_cta"];
  const hidden = Array.isArray(t.hiddenSections) ? t.hiddenSections : [];

  /* per-section renderers */
  const renderers = {
    hero: () => `
      <section class="lp-hero" style="${heroImg ? "" : "padding:96px 32px;"}">
        ${heroImg ? `<img class="lp-hero-bg" src="${escapeHtml(heroImg)}" style="opacity:${1 - overlayOp}" />` : ""}
        <div class="lp-hero-inner ${heroImg ? "lp-hero-overlay" : ""}">
          <h1 class="lp-display">${escapeHtml(lp.hero?.headline || "")}</h1>
          <p class="lp-lead">${escapeHtml(lp.hero?.subheadline || "")}</p>
          <div class="lp-cta-row">
            <a class="lp-btn lp-btn-primary" href="#contact">${escapeHtml(lp.hero?.ctaText || "צור קשר")}</a>
            ${lp.hero?.ctaSubtext ? `<span class="lp-cta-sub">${escapeHtml(lp.hero.ctaSubtext)}</span>` : ""}
          </div>
        </div>
      </section>`,

    about: () => !lp.about ? "" : `
      <section class="lp-section">
        <div class="lp-container">
          <p class="lp-eyebrow" style="color:${accent}">אודות</p>
          <div class="lp-about-grid ${aboutImg ? "with-img" : ""}">
            <div>
              <h2 class="lp-h2">${escapeHtml(lp.about.heading || "")}</h2>
              <p class="lp-body">${escapeHtml(lp.about.body || "").replace(/\n/g, "<br>")}</p>
            </div>
            ${aboutImg ? `<div class="lp-img-wrap"><img src="${escapeHtml(aboutImg)}" /></div>` : ""}
          </div>
        </div>
      </section>`,

    services: () => !lp.services?.items?.length ? "" : `
      <section class="lp-section">
        <div class="lp-container">
          <p class="lp-eyebrow" style="color:${accent}">שירותים</p>
          <h2 class="lp-h2">${escapeHtml(lp.services.heading || "")}</h2>
          <div class="lp-services-grid">
            ${lp.services.items.map((s, i) => `
              <div class="lp-service-card">
                <span class="lp-service-bg-num">${String(i + 1).padStart(2, "0")}</span>
                <div class="lp-service-icon">${escapeHtml(s.icon || "📌")}</div>
                <span class="lp-service-num">0${i + 1}</span>
                <h4 class="lp-h4">${escapeHtml(s.title || "")}</h4>
                <p class="lp-body-sm">${escapeHtml(s.description || "")}</p>
              </div>
            `).join("")}
          </div>
        </div>
      </section>`,

    why_us: () => !lp.why_us?.points?.length ? "" : `
      <section class="lp-section">
        <div class="lp-container">
          <p class="lp-eyebrow" style="color:${accent}">למה אנחנו</p>
          <h2 class="lp-h2">${escapeHtml(lp.why_us.heading || "")}</h2>
          <div class="lp-grid-4">
            ${lp.why_us.points.map((p, i) => `
              <div>
                <div class="lp-num-big" style="color:${secondary}">0${i + 1}</div>
                <h4 class="lp-h4">${escapeHtml(p.title || "")}</h4>
                <p class="lp-body-sm">${escapeHtml(p.description || "")}</p>
              </div>
            `).join("")}
          </div>
        </div>
      </section>`,

    process: () => !lp.process?.steps?.length ? "" : `
      <section class="lp-section" style="background:${secondary}08">
        <div class="lp-container">
          <p class="lp-eyebrow" style="color:${accent}">תהליך</p>
          <h2 class="lp-h2">${escapeHtml(lp.process.heading || "")}</h2>
          <div class="lp-grid-4">
            ${lp.process.steps.map((s, i) => `
              <div class="lp-step">
                <div class="lp-step-badge">${escapeHtml(String(s.step ?? i + 1))}</div>
                <h4 class="lp-h4">${escapeHtml(s.title || "")}</h4>
                <p class="lp-body-sm">${escapeHtml(s.description || "")}</p>
              </div>
            `).join("")}
          </div>
        </div>
      </section>`,

    testimonials: () => !lp.testimonials?.items?.length ? "" : `
      <section class="lp-section lp-dark">
        <div class="lp-container">
          <p class="lp-eyebrow" style="color:${accent}">המלצות</p>
          <h2 class="lp-h2 lp-h2-light">${escapeHtml(lp.testimonials.heading || "")}</h2>
          <div class="lp-grid-3">
            ${lp.testimonials.items.map(t => `
              <div class="lp-quote">
                <p class="lp-quote-text">"${escapeHtml(t.quote || "")}"</p>
                <div class="lp-quote-author">
                  <div class="lp-avatar">${escapeHtml((t.name || "?").charAt(0))}</div>
                  <div><div class="lp-author-name">${escapeHtml(t.name || "")}</div><div class="lp-author-role">${escapeHtml(t.role || "")}</div></div>
                </div>
              </div>
            `).join("")}
          </div>
        </div>
      </section>`,

    faq: () => !lp.faq?.items?.length ? "" : `
      <section class="lp-section">
        <div class="lp-container">
          <p class="lp-eyebrow" style="color:${accent}">שאלות נפוצות</p>
          <h2 class="lp-h2">${escapeHtml(lp.faq.heading || "")}</h2>
          <div class="lp-faq">
            ${lp.faq.items.map(q => `
              <details class="lp-faq-item">
                <summary>${escapeHtml(q.question || "")}<span class="lp-chevron">▾</span></summary>
                <p>${escapeHtml(q.answer || "")}</p>
              </details>
            `).join("")}
          </div>
        </div>
      </section>`,

    final_cta: () => !lp.final_cta ? "" : `
      <section class="lp-final-cta" id="contact">
        ${finalCtaImg ? `<img class="lp-cta-bg" src="${escapeHtml(finalCtaImg)}" style="opacity:${1 - overlayOp}" />` : ""}
        <div class="lp-cta-inner">
          <h2 class="lp-h1-final">${escapeHtml(lp.final_cta.heading || "")}</h2>
          <p class="lp-lead">${escapeHtml(lp.final_cta.subheading || "")}</p>
          <a href="#" class="lp-btn lp-btn-final">${escapeHtml(lp.final_cta.ctaText || "")}</a>
        </div>
      </section>`,
  };

  const sectionsHtml = sectionOrder
    .filter(k => !hidden.includes(k))
    .map(k => renderers[k] ? renderers[k]() : "")
    .join("");

  /* Header — prefer the actual client logo image when available */
  const headerLogoMarkup = clientLogoUrl
    ? `<img class="lp-logo-img" src="${escapeHtml(clientLogoUrl)}" alt="${escapeHtml(businessName)}" />`
    : `<div class="lp-logo">${escapeHtml(lp.header?.logoText || businessName)}</div>`;
  const headerHtml = lp.header ? `
    <header class="lp-header">
      <div class="lp-container lp-header-inner">
        ${headerLogoMarkup}
        <nav class="lp-nav">
          ${(lp.header.navItems || []).map(n => `<a href="${escapeHtml(n.href || "#")}">${escapeHtml(n.label || "")}</a>`).join("")}
        </nav>
        <a href="#contact" class="lp-btn lp-btn-primary lp-btn-sm">${escapeHtml(lp.header.ctaText || "צור קשר")}</a>
      </div>
    </header>` : "";

  /* Footer — same logo image, smaller variant */
  const footerLogoMarkup = clientLogoUrl
    ? `<img class="lp-footer-logo-img" src="${escapeHtml(clientLogoUrl)}" alt="${escapeHtml(businessName)}" />`
    : `<div class="lp-footer-logo">${escapeHtml(lp.header?.logoText || businessName)}</div>`;
  const footerHtml = lp.footer ? `
    <footer class="lp-footer">
      <div class="lp-container lp-footer-grid">
        <div>
          ${footerLogoMarkup}
          <p class="lp-footer-tagline">${escapeHtml(lp.footer.tagline || "")}</p>
        </div>
        <div>
          <div class="lp-footer-h">צור קשר</div>
          ${lp.footer.contactPhone ? `<div dir="ltr">${escapeHtml(lp.footer.contactPhone)}</div>` : ""}
          ${lp.footer.contactEmail ? `<div dir="ltr">${escapeHtml(lp.footer.contactEmail)}</div>` : ""}
        </div>
        <div>
          <div class="lp-footer-h">פרטים</div>
          ${lp.footer.address ? `<div>${escapeHtml(lp.footer.address)}</div>` : ""}
          ${lp.footer.hours ? `<div>${escapeHtml(lp.footer.hours)}</div>` : ""}
        </div>
      </div>
      <div class="lp-footer-bottom">${escapeHtml(lp.footer.copyright || "© " + new Date().getFullYear())}</div>
    </footer>` : "";

  const alreadyResponded = sess.approvalStatus === "approved" || sess.approvalStatus === "rejected";

  /* Approval bar (sticky) */
  const approvalHtml = alreadyResponded ? `
    <div class="lp-approval-done lp-approval-${sess.approvalStatus}">
      ${sess.approvalStatus === "approved"
        ? `<strong>✓ אישרת את הדף — תודה!</strong> ניצור איתך קשר בקרוב להמשך התהליך.`
        : `<strong>✗ העברת בקשה לשינויים</strong>${sess.clientFeedback ? ` — "${escapeHtml(sess.clientFeedback)}"` : ""} — מנהל התיק יחזור אליך.`}
    </div>` : `
    <div class="lp-approval-bar" id="approvalBar">
      <div class="lp-approval-text">
        <strong>טיוטה לאישור</strong> · בדוק את הדף ואשר אם הוא מתאים, או שלח שינויים
      </div>
      <div class="lp-approval-actions">
        <button class="lp-btn-approve" onclick="approveLp()">✓ אני מאשר</button>
        <button class="lp-btn-reject"  onclick="rejectLp()">✗ דרוש שינויים</button>
      </div>
    </div>`;

  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(businessName)} · תצוגה מקדימה</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=${encodeURIComponent(fontFamily)}:wght@400;500;700;800;900&display=swap" rel="stylesheet">
<style>
:root{
  --primary:${primary}; --secondary:${secondary}; --accent:${accent};
  --heading:${headingC}; --body:${bodyC}; --page-bg:${pageBg}; --section-bg:${sectionBg};
  --radius:${radius}px;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  font-family:'${fontFamily}',Heebo,Inter,system-ui,sans-serif;
  background:var(--page-bg); color:var(--body);
  font-size:16px; line-height:1.6;
  padding-bottom: 96px;
}
.lp-container{max-width:1200px;margin:0 auto;padding:0 32px}
.lp-eyebrow{font-size:11px;font-weight:800;letter-spacing:0.18em;text-transform:uppercase;margin:0 0 12px}
.lp-h2{font-size:36px;font-weight:800;line-height:1.15;letter-spacing:-0.02em;color:var(--heading);margin:0 0 32px}
.lp-h2-light{color:#fff}
.lp-h4{font-size:18px;font-weight:800;color:var(--heading);margin:8px 0}
.lp-body{font-size:16px;line-height:1.7;max-width:640px}
.lp-body-sm{font-size:14px;line-height:1.6;opacity:0.85;margin-top:6px}
.lp-display{font-size:clamp(40px,6vw,68px);font-weight:800;line-height:1.05;letter-spacing:-0.025em;margin:0 0 20px;color:var(--heading)}
.lp-lead{font-size:18px;line-height:1.55;max-width:640px;margin:0}

/* Header */
.lp-header{padding:14px 0;border-bottom:1px solid rgba(0,0,0,0.06);background:var(--page-bg);position:sticky;top:0;z-index:50}
.lp-header-inner{display:flex;align-items:center;justify-content:space-between;gap:24px}
.lp-logo{padding:6px 14px;background:var(--primary);color:#fff;border-radius:8px;font-size:14px;font-weight:800;letter-spacing:0.5px}
.lp-logo-img{height:42px;width:auto;max-width:180px;object-fit:contain;display:block}
.lp-nav{display:flex;gap:28px}
.lp-nav a{color:var(--body);font-size:14px;font-weight:600;text-decoration:none;opacity:0.78}
.lp-nav a:hover{opacity:1}

/* Buttons */
.lp-btn{display:inline-block;padding:14px 32px;font-weight:700;font-size:16px;text-decoration:none;border:none;cursor:pointer;border-radius:var(--radius);transition:transform 200ms,opacity 200ms}
.lp-btn-sm{padding:8px 18px;font-size:13px}
.lp-btn-primary{background:var(--primary);color:#fff}
.lp-btn-primary:hover{transform:translateY(-1px);opacity:0.92}
.lp-btn-final{background:#fff;color:var(--primary);font-weight:800}
.lp-cta-row{margin-top:24px;display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.lp-cta-sub{font-size:13px;opacity:0.75}

/* Hero */
.lp-hero{position:relative;overflow:hidden;background:#000}
.lp-hero-bg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.lp-hero-inner{position:relative;padding:96px 32px;max-width:1200px;margin:0 auto}
.lp-hero-overlay{color:#fff;text-shadow:0 2px 18px rgba(0,0,0,0.5)}
.lp-hero-overlay .lp-display{color:#fff}
.lp-hero-overlay .lp-lead{color:#fff;opacity:0.95}

/* Sections */
.lp-section{padding:80px 0;border-top:1px solid rgba(0,0,0,0.06)}
.lp-dark{background:var(--section-bg);color:#fff;border-top:none}
.lp-dark .lp-body-sm{color:#fff;opacity:0.78}

/* About */
.lp-about-grid{display:grid;grid-template-columns:1fr;gap:48px;align-items:center}
.lp-about-grid.with-img{grid-template-columns:1fr 1fr}
.lp-img-wrap{aspect-ratio:4/5;border-radius:var(--radius);overflow:hidden}
.lp-img-wrap img{width:100%;height:100%;object-fit:cover;display:block}

/* Services */
.lp-services-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px}
.lp-service-card{background:#f8f9fa;border:1px solid rgba(0,0,0,0.06);border-radius:var(--radius);padding:24px;position:relative;overflow:hidden}
.lp-service-bg-num{position:absolute;top:-10px;left:-8px;font-size:96px;font-weight:900;color:var(--primary);opacity:0.05;line-height:1}
.lp-service-icon{width:48px;height:48px;border-radius:calc(var(--radius) * 0.8);background:color-mix(in srgb, var(--primary) 15%, transparent);color:var(--primary);display:flex;align-items:center;justify-content:center;font-size:24px;margin-bottom:14px;position:relative}
.lp-service-num{font-size:11px;font-weight:800;color:var(--accent);letter-spacing:0.12em;position:relative}

/* Grids */
.lp-grid-3{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:20px}
.lp-grid-4{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:28px}

/* Why us */
.lp-num-big{font-size:32px;font-weight:800;margin-bottom:8px}

/* Process */
.lp-step{position:relative;padding-top:56px}
.lp-step-badge{position:absolute;top:0;inset-inline-start:0;width:44px;height:44px;border-radius:50%;background:var(--primary);color:#fff;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:800;box-shadow:0 8px 18px -6px color-mix(in srgb, var(--primary) 50%, transparent)}

/* Testimonials */
.lp-quote{background:rgba(255,255,255,0.06);padding:24px;border-radius:var(--radius);border:1px solid rgba(255,255,255,0.10);backdrop-filter:blur(8px)}
.lp-quote-text{font-size:16px;line-height:1.6;font-style:italic;margin:0}
.lp-quote-author{margin-top:16px;display:flex;align-items:center;gap:10px}
.lp-avatar{width:36px;height:36px;border-radius:50%;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800}
.lp-author-name{font-weight:700}
.lp-author-role{font-size:12px;opacity:0.7}

/* FAQ */
.lp-faq{max-width:800px}
.lp-faq-item{border-bottom:1px solid rgba(0,0,0,0.10);padding:16px 0}
.lp-faq-item summary{cursor:pointer;display:flex;align-items:center;justify-content:space-between;font-size:16px;font-weight:700;color:var(--primary);list-style:none}
.lp-faq-item summary::-webkit-details-marker{display:none}
.lp-chevron{transition:transform 200ms;color:var(--primary);opacity:0.6}
.lp-faq-item[open] .lp-chevron{transform:rotate(180deg)}
.lp-faq-item p{margin:10px 0 0;font-size:14px;line-height:1.7;opacity:0.85}

/* Final CTA */
.lp-final-cta{position:relative;padding:96px 32px;text-align:center;background:linear-gradient(135deg,var(--primary),var(--secondary));color:#fff;overflow:hidden}
.lp-cta-bg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;mix-blend-mode:overlay}
.lp-cta-inner{position:relative;max-width:1200px;margin:0 auto}
.lp-h1-final{font-size:42px;font-weight:800;margin:0;letter-spacing:-0.01em}

/* Footer */
.lp-footer{padding:32px;background:#0b1430;color:#fff}
.lp-footer-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:28px;margin-bottom:24px}
.lp-footer-logo{font-size:16px;font-weight:800;color:#fff;margin-bottom:8px}
.lp-footer-logo-img{height:48px;width:auto;max-width:200px;object-fit:contain;display:block;margin-bottom:12px}
.lp-footer-tagline{font-size:13px;opacity:0.65;line-height:1.6;margin:0}
.lp-footer-h{font-size:11px;font-weight:800;opacity:0.6;letter-spacing:0.12em;text-transform:uppercase;margin-bottom:10px}
.lp-footer div{font-size:13px;opacity:0.85;margin-bottom:4px}
.lp-footer-bottom{border-top:1px solid rgba(255,255,255,0.1);padding-top:16px;font-size:11px;opacity:0.5;text-align:center}

/* Approval bar (sticky bottom) */
.lp-approval-bar{
  position:fixed;bottom:0;left:0;right:0;
  background:#fff;border-top:1px solid rgba(0,0,0,0.10);
  padding:14px 24px;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;
  box-shadow:0 -8px 24px -8px rgba(0,0,0,0.12);z-index:100;
}
.lp-approval-text{font-size:14px;color:#0b1430;flex:1;min-width:200px}
.lp-approval-actions{display:flex;gap:10px}
.lp-btn-approve,.lp-btn-reject{padding:10px 22px;border-radius:var(--radius);font-size:14px;font-weight:700;border:none;cursor:pointer;transition:transform 180ms}
.lp-btn-approve{background:#10b981;color:#fff}
.lp-btn-reject{background:transparent;color:#ef4444;border:1.5px solid #ef4444}
.lp-btn-approve:hover,.lp-btn-reject:hover{transform:translateY(-1px)}
.lp-approval-done{position:fixed;bottom:0;left:0;right:0;padding:18px 24px;text-align:center;font-size:14px;z-index:100;box-shadow:0 -8px 24px -8px rgba(0,0,0,0.12)}
.lp-approval-approved{background:#ecfdf5;color:#065f46;border-top:2px solid #10b981}
.lp-approval-rejected{background:#fef2f2;color:#991b1b;border-top:2px solid #ef4444}

@media (max-width:720px){
  .lp-nav{display:none}
  .lp-h2{font-size:28px}
  .lp-display{font-size:36px}
  .lp-about-grid.with-img{grid-template-columns:1fr}
  .lp-hero-inner{padding:64px 24px}
  .lp-section{padding:56px 0}
}
</style>
</head>
<body>
${headerHtml}
${sectionsHtml}
${footerHtml}
${approvalHtml}
<script>
const TOKEN = ${JSON.stringify(token)};
const API   = ${JSON.stringify(req_apiBase())};

async function approveLp() {
  if (!confirm("לאשר את הדף? אחרי האישור לא ניתן לשנות.")) return;
  const btns = document.querySelectorAll(".lp-btn-approve,.lp-btn-reject");
  btns.forEach(b => b.disabled = true);
  try {
    const r = await fetch(API + "/wow-lp/preview/" + encodeURIComponent(TOKEN) + "/approve", { method: "POST" });
    if (!r.ok) throw new Error("שגיאה");
    location.reload();
  } catch (e) {
    alert("שגיאה — נסה שוב");
    btns.forEach(b => b.disabled = false);
  }
}

async function rejectLp() {
  const feedback = prompt("מה צריך לשנות? (נשלח למנהל תיק)");
  if (feedback === null) return;
  const btns = document.querySelectorAll(".lp-btn-approve,.lp-btn-reject");
  btns.forEach(b => b.disabled = true);
  try {
    const r = await fetch(API + "/wow-lp/preview/" + encodeURIComponent(TOKEN) + "/reject", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feedback }),
    });
    if (!r.ok) throw new Error("שגיאה");
    location.reload();
  } catch (e) {
    alert("שגיאה — נסה שוב");
    btns.forEach(b => b.disabled = false);
  }
}
</script>
</body>
</html>`;
}

function req_apiBase() { return "/api"; }

/* ── Public preview endpoints ──────────────────────────────────────── */

exports.publicPreview = async (req, res) => {
  try {
    const { token } = req.params;
    const sess = await getSessionByApprovalToken(token);
    if (!sess) return res.status(404).json({ error: "preview not found or expired" });
    res.json({
      session: {
        landing_page:   sess.landing_page,
        brand_strategy: sess.brand_strategy,
        design_theme:   sess.design_theme,
        images:         sess.images || [],
        approvalStatus: sess.approvalStatus,
        businessName:   sess.brief?.businessName,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.publicApprove = async (req, res) => {
  try {
    const { token } = req.params;
    const sess = await getSessionByApprovalToken(token);
    await setApprovalDecision(token, "approved");
    if (sess) notifyLpManagerOnDecision(req, sess, "approved");
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.publicReject = async (req, res) => {
  try {
    const { token } = req.params;
    const { feedback } = req.body;
    const sess = await getSessionByApprovalToken(token);
    await setApprovalDecision(token, "rejected", feedback);
    if (sess) notifyLpManagerOnDecision(req, sess, "rejected", feedback);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

function notifyLpManagerOnDecision(req, sess, decision, feedback) {
  const baseUrl = process.env.SERVER_BASE_URL || `${req.protocol}://${req.get("host")}`;
  const previewUrl = sess.approvalToken ? `${baseUrl}/lp-preview/${sess.approvalToken}` : null;
  notifyManagerOfClientDecision({
    kind: "lp",
    decision,
    clientPhone: sess.phone,
    businessName: sess.brief?.businessName,
    feedback,
    previewUrl,
  }).catch(err => console.warn("[wow-lp] notifyManager failed:", err.message));
}

/* ──────────────────────────────────────────────────────────────────── */

function sanitizeSession(sess) {
  if (!sess) return null;
  return {
    sessionId:       sess.sessionId,
    status:          sess.status,
    brand_strategy:  sess.brand_strategy,
    landing_page:    sess.landing_page,
    design_theme:    sess.design_theme,
    images:          sess.images || [],
    totalImages:     sess.totalImages,
    completedImages: sess.completedImages,
    approvalStatus:  sess.approvalStatus,
    approvalToken:   sess.approvalToken,
    sentForApprovalAt: sess.sentForApprovalAt,
    clientResponseAt:  sess.clientResponseAt,
    clientFeedback:    sess.clientFeedback,
    error:           sess.error,
    createdAt:       sess.createdAt,
    updatedAt:       sess.updatedAt,
    /* v2 engine fields — html is the fully-rendered template, the
       cpanel renders it via V2Preview iframe (srcDoc=html). Without
       these, v2 sessions show as blank because there's no
       landing_page tree for the legacy LpPreview to consume. */
    html:           sess.html,
    templateName:   sess.templateName,
    engine:         sess.engine,
    v2:             sess.v2,
    /* Netlify deploy cache — surfaced to the panel so the manager
       sees the live URL + last-deployed timestamp without an extra
       round trip. */
    netlifySiteId:     sess.netlifySiteId     || null,
    netlifySiteUrl:    sess.netlifySiteUrl    || null,
    netlifyDeployId:   sess.netlifyDeployId   || null,
    netlifyDeployedAt: sess.netlifyDeployedAt || null,
  };
}
