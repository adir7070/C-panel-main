/**
 * WOW Organic Ads controller — 5 organic posts pipeline
 *   POST /clients/:phone/wow-organic/generate
 *   GET  /clients/:phone/wow-organic
 *   GET  /clients/:phone/wow-organic/status
 *   POST /clients/:phone/wow-organic/:postId/regenerate
 */

const multer = require("multer");
const { getDB } = require("../config/db");
const { clientGalleryRefs } = require("../utils/profileImages");
const {
  runOrganicAdsPipeline,
  regenerateSinglePost,
  generateCarouselPost,
  regenerateCarouselSlide,
  updatePostText,
  generatePostPromotionDescription,
  setManagerApprovalOnPost,
  setOrganicClientApprovalToken,
  getOrganicSessionByClientToken,
  setOrganicClientApprovalDecision,
  setPostImageFromUpload,
  getLatestSessionForPhone,
} = require("../services/wow-organic-ads.service");
const { notifyManagerOfClientDecision } = require("../services/wow-manager-notify.service");
const { autoBumpToSentToCreation } = require("../services/package-lifecycle.service");

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

function notifyManagerOnDecision(req, sess, decision, feedback) {
  const baseUrl = process.env.SERVER_BASE_URL || `${req.protocol}://${req.get("host")}`;
  const previewUrl = sess.clientApprovalToken ? `${baseUrl}/wow-organic-preview/${sess.clientApprovalToken}` : null;
  notifyManagerOfClientDecision({
    kind: "organic",
    decision,
    clientPhone: sess.phone,
    businessName: sess.brief?.businessName,
    feedback,
    previewUrl,
  }).catch(err => console.warn("[wow-organic] notifyManager failed:", err.message));
}

const organicImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
    cb(ok.includes(file.mimetype) ? null : new Error(`bad mime ${file.mimetype}`), ok.includes(file.mimetype));
  },
});
exports.organicImageUploadMw = organicImageUpload.single("image");

function newSessionId() {
  return `worg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function buildBriefForClient(phone) {
  const profile = await getDB().collection("business_profiles").findOne({ phone });
  if (!profile) throw new Error("business_profile not found");

  const required = [];
  if (!profile.businessName)     required.push("businessName");
  if (!profile.categoryKey)      required.push("categoryKey");
  if (!profile.services?.length) required.push("services");
  if (required.length) {
    const err = new Error(`חסרים שדות באיפיון: ${required.join(", ")}`);
    err.code = "INCOMPLETE_PROFILE";
    throw err;
  }

  const services = (profile.services || [])
    .map(s => `${s.title}${s.description ? ` — ${s.description}` : ""}`)
    .join("; ");

  // Client photos: images[] + legacy generalImages[] (app uploads), deduped.
  // (fetchAssetBuffer decodes data:/http/proxy/bare refs downstream.)
  const safeImages = clientGalleryRefs(profile);

  /* Pass the structured services array (with imageUrl, promotion, campaignType,
     audience) so the planner can bind specific posts to specific services. */
  const servicesArr = Array.isArray(profile.services) ? profile.services : [];

  /* Per-slot linkage from the Characterization > Social planner. */
  const organicSlots = Array.isArray(profile.organicSlots) ? profile.organicSlots : [];

  return {
    businessName:    profile.businessName,
    businessField:   profile.categoryKey,
    about:           profile.about || "",
    services,
    servicesArr,
    organicSlots,
    avatar:          profile.avatar || null,
    targetAudience:  Array.isArray(profile.targetAudience) ? profile.targetAudience : [],
    // Ad language (2-letter code). Missing → Hebrew, so existing posts are unchanged.
    language:        profile.language || "he",
    designStyle:     profile.designStyle,
    preferredColors: profile.preferredColors || null,
    images:          safeImages,
  };
}

exports.generateOrganicAds = async (req, res) => {
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

    /* Pull the organic-ads quota AND active-package fingerprint —
       packageId tags the session so the products-history view groups
       this batch under the right purchase. */
    let quota = 5;
    let packageId = null;
    try {
      const user = await getDB().collection("users").findOne(
        { phone }, { projection: { activePackage: 1 } },
      );
      const ap = user?.activePackage;
      const organicAds = ap?.items?.organicAds;
      if (typeof organicAds === "number" && organicAds > 0) quota = organicAds;
      if (ap?.id && ap?.purchasedAt) {
        packageId = `pkg_${ap.id || "custom"}_${String(ap.purchasedAt).replace(/[:.]/g, "-")}`;
      }
    } catch (err) {
      console.warn(`[wow-organic-ads] could not read activePackage for ${phone}: ${err.message}`);
    }
    if (packageId) brief.packageId = packageId;

    const sessionId = newSessionId();
    autoBumpToSentToCreation(phone, "wow-organic-generate").catch(() => {});
    runOrganicAdsPipeline(sessionId, phone, brief, quota).catch(err =>
      console.error(`[wow-organic-ads] pipeline crashed for ${sessionId}:`, err)
    );
    res.json({ success: true, sessionId, status: "generating_texts", quota });
  } catch (err) {
    console.error("[wow-organic-ads] generate failed:", err);
    res.status(500).json({ error: err.message });
  }
};

exports.getOrganicAds = async (req, res) => {
  try {
    const { phone } = req.params;
    const [sess, sinceMs] = await Promise.all([
      getLatestSessionForPhone(phone),
      activePackageSinceMs(phone),
    ]);
    if (!sess || sessionPredatesActive(sess, sinceMs)) return res.json({ session: null });
    res.json({
      session: {
        sessionId:      sess.sessionId,
        status:         sess.status,
        totalPosts:     sess.totalPosts,
        completedCount: sess.completedCount,
        generatedPosts: sess.generatedPosts || [],
        error:          sess.error,
        createdAt:      sess.createdAt,
        updatedAt:      sess.updatedAt,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getOrganicAdsStatus = async (req, res) => {
  try {
    const { phone } = req.params;
    const [sess, sinceMs] = await Promise.all([
      getLatestSessionForPhone(phone),
      activePackageSinceMs(phone),
    ]);
    if (!sess || sessionPredatesActive(sess, sinceMs)) return res.json({ session: null });
    res.json({
      sessionId:      sess.sessionId,
      status:         sess.status,
      totalPosts:     sess.totalPosts,
      completedCount: sess.completedCount,
      hasImages:      (sess.generatedPosts || []).filter(p => p.imageUrl).length,
      error:          sess.error,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.regenerateOrganicPost = async (req, res) => {
  try {
    const { phone, postId } = req.params;
    const sess = await getLatestSessionForPhone(phone);
    if (!sess) return res.status(404).json({ error: "no session for this client" });
    const post = await regenerateSinglePost(sess.sessionId, postId);
    res.json({ success: true, post });
  } catch (err) {
    console.error("[wow-organic-ads] regenerate failed:", err);
    res.status(500).json({ error: err.message });
  }
};

/* ── Carousel — generate one carousel post on top of the existing 5 ──── */
exports.generateOrganicCarousel = async (req, res) => {
  try {
    const { phone } = req.params;
    const sess = await getLatestSessionForPhone(phone);
    if (!sess) return res.status(404).json({ error: "צריך לייצר 5 פוסטים אורגניים קודם" });
    const brief = sess.brief || await buildBriefForClient(phone);
    const post = await generateCarouselPost(sess.sessionId, phone, brief);
    res.json({ success: true, post });
  } catch (err) {
    console.error("[wow-organic-ads] carousel generate failed:", err);
    res.status(500).json({ error: err.message });
  }
};

exports.regenerateCarouselSlide = async (req, res) => {
  try {
    const { phone, postId, slideId } = req.params;
    const sess = await getLatestSessionForPhone(phone);
    if (!sess) return res.status(404).json({ error: "no session for this client" });
    const post = await regenerateCarouselSlide(sess.sessionId, postId, slideId);
    res.json({ success: true, post });
  } catch (err) {
    console.error("[wow-organic-ads] regenerate slide failed:", err);
    res.status(500).json({ error: err.message });
  }
};

/* ── POST /cpanel/clients/:phone/wow-organic/:postId/promotion-description ──
   Generate a rich Hebrew "promotion-ready" body for the organic post.
   Doesn't touch the image — just adds post.promotionDescription that
   the manager can copy into Instagram / Facebook when posting. */

exports.generateOrganicPromotionDescription = async (req, res) => {
  try {
    const { phone, postId } = req.params;
    const sess = await getLatestSessionForPhone(phone);
    if (!sess) return res.status(404).json({ error: "no session for this client" });
    const post = await generatePostPromotionDescription(sess.sessionId, postId, sess.brief);
    res.json({ success: true, post });
  } catch (err) {
    console.error("[wow-organic-ads] generate promotion description failed:", err);
    res.status(500).json({ error: err.message });
  }
};

/* ── PUT /cpanel/clients/:phone/wow-organic/:postId — edit text fields ── */

exports.updateOrganicPostText = async (req, res) => {
  try {
    const { phone, postId } = req.params;
    const { headline, description, cta } = req.body || {};
    const sess = await getLatestSessionForPhone(phone);
    if (!sess) return res.status(404).json({ error: "no session for this client" });
    const post = await updatePostText(sess.sessionId, postId, { headline, description, cta });
    res.json({ success: true, post });
  } catch (err) {
    console.error("[wow-organic-ads] update text failed:", err);
    res.status(500).json({ error: err.message });
  }
};

/* ── POST /cpanel/clients/:phone/wow-organic/:postId/approve ────────── */

exports.managerApprovePost = async (req, res) => {
  try {
    const { phone, postId } = req.params;
    const approved = req.body?.approved !== false;
    const sess = await getLatestSessionForPhone(phone);
    if (!sess) return res.status(404).json({ error: "no session for this client" });
    const post = await setManagerApprovalOnPost(sess.sessionId, postId, approved);
    res.json({ success: true, post });
  } catch (err) {
    console.error("[wow-organic-ads] approve failed:", err);
    res.status(500).json({ error: err.message });
  }
};

/* ── POST /cpanel/clients/:phone/wow-organic/:postId/image — upload ──── */

exports.uploadOrganicPostImage = async (req, res) => {
  try {
    const { phone, postId } = req.params;
    if (!req.file) return res.status(400).json({ error: "image file required (multipart 'image')" });
    const sess = await getLatestSessionForPhone(phone);
    if (!sess) return res.status(404).json({ error: "no session for this client" });
    const post = await setPostImageFromUpload(sess.sessionId, postId, req.file.buffer, req.file.mimetype);
    res.json({ success: true, post });
  } catch (err) {
    console.error("[wow-organic-ads] upload image failed:", err);
    res.status(500).json({ error: err.message });
  }
};

/* ── POST /cpanel/clients/:phone/wow-organic/send-approval ──────────── */

exports.sendOrganicForApproval = async (req, res) => {
  try {
    const { phone } = req.params;
    const sess = await getLatestSessionForPhone(phone);
    if (!sess) return res.status(404).json({ error: "no session for this client" });
    const approved = (sess.generatedPosts || []).filter(p =>
      p.managerApprovedAt && (p.imageUrl || (Array.isArray(p.slides) && p.slides.some(s => s.imageUrl)))
    );
    if (approved.length === 0) {
      return res.status(400).json({ error: "אין פוסטים מאושרים — אשר לפחות פוסט אחד קודם" });
    }

    const token = await setOrganicClientApprovalToken(sess.sessionId);
    const baseUrl = process.env.SERVER_BASE_URL || `${req.protocol}://${req.get("host")}`;
    const previewUrl = `${baseUrl}/wow-organic-preview/${token}`;

    const businessName = sess.brief?.businessName || "העסק שלך";
    const message =
      `שלום! 👋\n\n` +
      `הכנו עבורך ${approved.length} פוסטים אורגניים ל"${businessName}". ` +
      `אשמח אם תוכל/י לאשר אותם או לכתוב לנו אם משהו דורש שינוי.\n\n` +
      `📄 לתצוגה ואישור:\n${previewUrl}\n\n` +
      `תודה!`;

    const sentChannels = [];
    try { await require("../services/greenapi.service").sendMessage(phone, message); sentChannels.push("whatsapp"); }
    catch (e) { console.warn("[wow-organic] WhatsApp send failed:", e.message); }
    try { await require("../services/sms4free.service").sendSMS(phone, message); sentChannels.push("sms"); }
    catch (e) { console.warn("[wow-organic] SMS send failed:", e.message); }

    res.json({ success: true, token, previewUrl, approvedCount: approved.length, sentChannels });
  } catch (err) {
    console.error("[wow-organic-ads] send approval failed:", err);
    res.status(500).json({ error: err.message });
  }
};

/* ── Public preview HTML (no auth) ──────────────────────────────────── */

exports.publicOrganicPreviewHtml = async (req, res) => {
  try {
    const { token } = req.params;
    const sess = await getOrganicSessionByClientToken(token);
    if (!sess) {
      res.status(404).set("Content-Type", "text/html; charset=utf-8").send(notFoundHtml());
      return;
    }
    res.set("Content-Type", "text/html; charset=utf-8").send(renderOrganicPreviewHtml(sess, token));
  } catch (err) {
    res.status(500).set("Content-Type", "text/html; charset=utf-8")
      .send(`<h1>שגיאה</h1><p>${escapeHtml(err.message || "שגיאה")}</p>`);
  }
};

exports.publicOrganicApprove = async (req, res) => {
  try {
    const { token } = req.params;
    const sess = await getOrganicSessionByClientToken(token);
    if (!sess) return res.status(404).json({ error: "invalid token" });
    if (sess.clientApprovalStatus === "approved" || sess.clientApprovalStatus === "rejected") {
      return res.status(400).json({ error: "already responded" });
    }
    await setOrganicClientApprovalDecision(token, "approved");
    notifyManagerOnDecision(req, sess, "approved");
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.publicOrganicReject = async (req, res) => {
  try {
    const { token } = req.params;
    const feedback = (req.body?.feedback || "").trim().slice(0, 1000);
    const sess = await getOrganicSessionByClientToken(token);
    if (!sess) return res.status(404).json({ error: "invalid token" });
    if (sess.clientApprovalStatus === "approved" || sess.clientApprovalStatus === "rejected") {
      return res.status(400).json({ error: "already responded" });
    }
    await setOrganicClientApprovalDecision(token, "rejected", feedback);
    notifyManagerOnDecision(req, sess, "rejected", feedback);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

/* ── HTML helpers ───────────────────────────────────────────────────── */

function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function notFoundHtml() {
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">
<title>הקישור לא תקף</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:Heebo,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f8fafc;color:#0b1430;text-align:center;padding:20px}h1{font-size:28px;margin:0 0 12px;font-weight:800}p{color:#64748b;line-height:1.6}</style>
</head><body><div><h1>הקישור לא תקף או פג תוקף</h1><p>צור קשר עם מנהל התיק לקבלת קישור חדש.</p></div></body></html>`;
}

function renderOrganicPreviewHtml(sess, token) {
  const businessName = sess.brief?.businessName || "העסק שלך";
  const posts = (sess.generatedPosts || []).filter(p =>
    p.managerApprovedAt && (p.imageUrl || (Array.isArray(p.slides) && p.slides.some(s => s.imageUrl)))
  );
  const responded = sess.clientApprovalStatus === "approved" || sess.clientApprovalStatus === "rejected";

  const postsMarkup = posts.map(p => {
    const slides = Array.isArray(p.slides) ? p.slides.filter(s => s.imageUrl) : [];
    const isCarousel = slides.length > 0;
    return `
    <article class="post">
      ${isCarousel
        ? `<div class="carousel-strip">${slides.map((s, i) => `<img src="${escapeHtml(s.imageUrl)}" alt="slide ${i + 1}" loading="lazy" />`).join("")}</div>
           <span class="carousel-badge">🎠 ${slides.length} שקופיות</span>`
        : `<img src="${escapeHtml(p.imageUrl)}" alt="post ${p.id}" loading="lazy" />`}
      <div class="post-body">
        <h3>${escapeHtml(p.headline || "")}</h3>
        <p>${escapeHtml(p.description || "")}</p>
        ${p.cta ? `<span class="cta">↳ ${escapeHtml(p.cta)}</span>` : ""}
      </div>
    </article>`;
  }).join("");

  const responseBar = responded ? `
    <div class="resp-done resp-${escapeHtml(sess.clientApprovalStatus)}">
      ${sess.clientApprovalStatus === "approved"
        ? `<strong>✓ אישרת את הפוסטים — תודה!</strong> ניצור איתך קשר בקרוב.`
        : `<strong>✗ העברת בקשה לשינויים</strong>${sess.clientFeedback ? ` — "${escapeHtml(sess.clientFeedback)}"` : ""} — מנהל התיק יחזור אליך.`}
    </div>` : `
    <div class="actions">
      <button id="approve-btn" class="btn btn-ok">אשר את כל הפוסטים</button>
      <button id="reject-btn"  class="btn btn-no">בקשה לשינויים</button>
    </div>
    <div id="reject-form" class="reject-form" hidden>
      <textarea id="reject-text" placeholder="מה לשנות?" rows="4"></textarea>
      <div class="actions">
        <button id="reject-send" class="btn btn-no">שלח</button>
        <button id="reject-cancel" class="btn btn-quiet">ביטול</button>
      </div>
    </div>`;

  return `<!doctype html><html lang="he" dir="rtl"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>אישור פוסטים אורגניים — ${escapeHtml(businessName)}</title>
<style>
:root{--ink:#0b1430;--ink-2:#475569;--brand:#1E3A8A;--ok:#059669;--no:#dc2626;--rule:#e2e8f0}
*{box-sizing:border-box}
body{font-family:Heebo,system-ui,sans-serif;margin:0;background:#f8fafc;color:var(--ink);line-height:1.55}
header{padding:24px 16px;background:#fff;border-bottom:1px solid var(--rule);text-align:center}
header h1{margin:0;font-size:22px;font-weight:800}
header p{margin:6px 0 0;color:var(--ink-2);font-size:14px}
main{padding:20px 16px;max-width:1080px;margin:0 auto}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px}
.post{position:relative;background:#fff;border:1px solid var(--rule);border-radius:14px;overflow:hidden;display:flex;flex-direction:column}
.post img{width:100%;aspect-ratio:1/1;object-fit:cover;display:block}
.post-body{padding:14px}
.post-body h3{margin:0 0 6px;font-size:15px;font-weight:800}
.post-body p{margin:0 0 8px;font-size:13px;color:var(--ink-2)}
.post-body .cta{display:inline-block;font-size:11px;color:var(--ink-2);font-style:italic}
.carousel-strip{display:flex;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none}
.carousel-strip::-webkit-scrollbar{display:none}
.carousel-strip img{flex:none;width:100%;scroll-snap-align:start}
.carousel-badge{position:absolute;top:10px;right:10px;font-size:10px;font-weight:800;padding:4px 10px;background:rgba(124,58,237,0.92);color:#fff;border-radius:999px}
.actions{display:flex;gap:10px;justify-content:center;margin:24px 0;flex-wrap:wrap}
.btn{padding:14px 28px;border:0;border-radius:999px;font-size:15px;font-weight:800;cursor:pointer;font-family:inherit}
.btn-ok{background:var(--ok);color:#fff}
.btn-no{background:var(--no);color:#fff}
.btn-quiet{background:#fff;color:var(--ink);border:1px solid var(--rule)}
.reject-form{max-width:520px;margin:0 auto 24px;padding:16px;background:#fff;border:1px solid var(--rule);border-radius:14px}
.reject-form textarea{width:100%;padding:12px;border:1px solid var(--rule);border-radius:10px;font-family:inherit;font-size:14px;resize:vertical}
.resp-done{max-width:560px;margin:24px auto;padding:18px 22px;border-radius:14px;text-align:center;font-size:15px;line-height:1.6}
.resp-approved{background:#ecfdf5;color:#065f46;border:1px solid #a7f3d0}
.resp-rejected{background:#fef2f2;color:#991b1b;border:1px solid #fecaca}
</style></head><body>
<header>
  <h1>פוסטים אורגניים — ${escapeHtml(businessName)}</h1>
  <p>בדוק את הפוסטים ולחץ על אחת האפשרויות למטה</p>
</header>
<main>
  <div class="grid">${postsMarkup || "<p style='text-align:center;color:#64748b'>אין פוסטים מאושרים לתצוגה.</p>"}</div>
  ${responseBar}
</main>
<script>
(function(){
  var token = ${JSON.stringify(token)};
  var approveBtn = document.getElementById('approve-btn');
  var rejectBtn  = document.getElementById('reject-btn');
  var rejForm    = document.getElementById('reject-form');
  var rejText    = document.getElementById('reject-text');
  var rejSend    = document.getElementById('reject-send');
  var rejCancel  = document.getElementById('reject-cancel');
  function post(path, body){
    return fetch(path, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body || {}) })
      .then(function(r){ return r.json().then(function(j){ return r.ok ? j : Promise.reject(j); }); });
  }
  if (approveBtn) approveBtn.addEventListener('click', function(){
    approveBtn.disabled = true; approveBtn.textContent = 'שולח...';
    post('/api/wow-organic-preview/' + token + '/approve').then(function(){ location.reload(); })
      .catch(function(e){ alert((e && e.error) || 'שגיאה'); approveBtn.disabled = false; approveBtn.textContent = 'אשר את כל הפוסטים'; });
  });
  if (rejectBtn) rejectBtn.addEventListener('click', function(){ rejForm.hidden = false; });
  if (rejCancel) rejCancel.addEventListener('click', function(){ rejForm.hidden = true; });
  if (rejSend) rejSend.addEventListener('click', function(){
    rejSend.disabled = true; rejSend.textContent = 'שולח...';
    post('/api/wow-organic-preview/' + token + '/reject', { feedback: rejText.value }).then(function(){ location.reload(); })
      .catch(function(e){ alert((e && e.error) || 'שגיאה'); rejSend.disabled = false; rejSend.textContent = 'שלח'; });
  });
})();
</script>
</body></html>`;
}
