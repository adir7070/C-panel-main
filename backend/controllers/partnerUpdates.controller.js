const multer = require("multer");
const { DB } = require("../config/db");
const backblaze = require("../services/backblaze.service");
const { ObjectId } = require("mongodb");

const SERVER_BASE_URL = process.env.BASE_URL || "https://api.iconiqmedia.co.il";

const upload = multer({ storage: multer.memoryStorage() });

const col = () => DB.collection("partner_updates");
const submissionsCol = () => DB.collection("partner_update_submissions");
const settingsCol = () => DB.collection("partner_updates_settings");

const SETTINGS_ID = "global";

function generatePublicToken() {
  return `wb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

async function getEnabledSetting() {
  const doc = await settingsCol().findOne({ _id: SETTINGS_ID });
  return doc ? !!doc.enabled : true;
}

// GET /api/partner-updates/settings  (admin)
const getSettings = async (req, res) => {
  try {
    const enabled = await getEnabledSetting();
    return res.json({ enabled });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// PATCH /api/partner-updates/settings  (admin)
const updateSettings = async (req, res) => {
  try {
    const { enabled } = req.body;
    await settingsCol().updateOne(
      { _id: SETTINGS_ID },
      { $set: { enabled: !!enabled } },
      { upsert: true }
    );
    return res.json({ success: true, enabled: !!enabled });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// GET /api/partner-updates/active?phone=XXX  (app — kept for backwards compat)
const getActiveUpdates = async (req, res) => {
  try {
    const enabled = await getEnabledSetting();
    if (!enabled) return res.json({ updates: [], enabled: false });

    const { phone } = req.query;
    const updates = await col().find({ is_active: true }).sort({ created_at: -1 }).toArray();

    const webinarIds = updates.map((u) => u.webinar_id).filter(Boolean);
    let registeredSet = new Set();
    if (phone && webinarIds.length > 0) {
      const subs = await submissionsCol()
        .find({ account_phone: phone, webinar_id: { $in: webinarIds } }, { projection: { webinar_id: 1 } })
        .toArray();
      registeredSet = new Set(subs.map((s) => s.webinar_id));
    }

    const result = updates.map((u) => ({
      id: u._id.toString(),
      title: u.title,
      image_url: u.image_url,
      has_form: !!u.has_form,
      webinar_id: u.webinar_id || null,
      webinar_date: u.webinar_date ? u.webinar_date.toISOString() : null,
      description: u.description || null,
      is_registered: u.webinar_id ? registeredSet.has(u.webinar_id) : false,
    }));

    return res.json({ updates: result, enabled: true });
  } catch (error) {
    console.error("[PartnerUpdates] getActiveUpdates error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
};

// POST /api/partner-updates/submit-form  (app — kept for backwards compat)
const submitForm = async (req, res) => {
  try {
    const { webinar_id, name, phone, email, notes, account_phone, fb_page_id, fb_page_token, page_name } = req.body;
    if (!webinar_id || !name || !phone) {
      return res.status(400).json({ success: false, error: "webinar_id, name, phone required" });
    }
    await submissionsCol().insertOne({
      webinar_id,
      name,
      phone,
      email: email || null,
      notes: notes || null,
      account_phone: account_phone || null,
      fb_page_id: fb_page_id || null,
      fb_page_token: fb_page_token || null,
      page_name: page_name || null,
      submitted_at: new Date(),
    });
    return res.json({ success: true });
  } catch (error) {
    console.error("[PartnerUpdates] submitForm error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
};

// POST /api/partner-updates  (admin — multipart/form-data)
const createUpdate = [
  upload.single("image"),
  async (req, res) => {
    try {
      const { title, webinar_id, webinar_date, description, has_form } = req.body;
      if (!title) {
        return res.status(400).json({ success: false, error: "title required" });
      }

      let image_url = null;
      if (req.file) {
        const ext = req.file.originalname.split(".").pop().toLowerCase() || "jpg";
        const fileName = `partner-updates/${Date.now()}.${ext}`;
        await backblaze.uploadImage(fileName, req.file.buffer, req.file.mimetype);
        image_url = `${SERVER_BASE_URL}/api/img?url=${encodeURIComponent(fileName)}`;
      }

      const publicToken = generatePublicToken();
      const resolvedWebinarId = webinar_id && webinar_id.trim() ? webinar_id.trim() : publicToken;

      const doc = {
        title,
        image_url,
        webinar_id: resolvedWebinarId,
        webinar_date: webinar_date ? new Date(webinar_date) : null,
        description: description || null,
        has_form: has_form === "true" || has_form === true,
        is_active: true,
        publicToken,
        created_at: new Date(),
      };

      const result = await col().insertOne(doc);
      return res.json({
        success: true,
        id: result.insertedId.toString(),
        publicToken,
        publicUrl: `${SERVER_BASE_URL}/webinar/${publicToken}`,
      });
    } catch (error) {
      console.error("[PartnerUpdates] createUpdate error:", error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  },
];

// PATCH /api/partner-updates/:id/toggle  (admin)
const toggleActive = async (req, res) => {
  try {
    const { id } = req.params;
    const doc = await col().findOne({ _id: new ObjectId(id) });
    if (!doc) return res.status(404).json({ success: false, error: "not found" });
    await col().updateOne({ _id: new ObjectId(id) }, { $set: { is_active: !doc.is_active } });
    return res.json({ success: true, is_active: !doc.is_active });
  } catch (error) {
    console.error("[PartnerUpdates] toggleActive error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
};

// DELETE /api/partner-updates/:id  (admin)
const deleteUpdate = async (req, res) => {
  try {
    const { id } = req.params;
    await col().deleteOne({ _id: new ObjectId(id) });
    return res.json({ success: true });
  } catch (error) {
    console.error("[PartnerUpdates] deleteUpdate error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
};

// GET /api/partner-updates  (admin — all updates, with lazy token migration)
const getAllUpdates = async (req, res) => {
  try {
    const updates = await col().find({}).sort({ created_at: -1 }).toArray();

    // Lazy migration: ensure every record has a publicToken and a webinar_id
    const migrations = [];
    for (const u of updates) {
      const patch = {};
      if (!u.publicToken) patch.publicToken = generatePublicToken();
      if (!u.webinar_id) patch.webinar_id = patch.publicToken || u.publicToken;
      if (Object.keys(patch).length > 0) {
        migrations.push(
          col().updateOne({ _id: u._id }, { $set: patch }).then(() => Object.assign(u, patch))
        );
      }
    }
    if (migrations.length > 0) await Promise.all(migrations);

    return res.json({ updates });
  } catch (error) {
    console.error("[PartnerUpdates] getAllUpdates error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
};

// GET /api/partner-updates/:id/submissions  (admin)
const getSubmissions = async (req, res) => {
  try {
    const { id } = req.params;
    const doc = await col().findOne({ _id: new ObjectId(id) });
    if (!doc) return res.status(404).json({ success: false, error: "not found" });

    const subs = await submissionsCol()
      .find({ webinar_id: doc.webinar_id })
      .sort({ submitted_at: -1 })
      .toArray();

    return res.json({ submissions: subs });
  } catch (error) {
    console.error("[PartnerUpdates] getSubmissions error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
};

// GET /api/partner-updates/public/:token  (no auth — returns webinar details for public page)
const getPublicWebinar = async (req, res) => {
  try {
    const { token } = req.params;
    const doc = await col().findOne({ publicToken: token });
    if (!doc) return res.status(404).json({ error: "not found" });
    if (!doc.is_active) return res.status(403).json({ error: "inactive" });
    return res.json({
      title: doc.title,
      description: doc.description || null,
      image_url: doc.image_url || null,
      has_form: !!doc.has_form,
      webinar_date: doc.webinar_date ? doc.webinar_date.toISOString() : null,
    });
  } catch (error) {
    console.error("[PartnerUpdates] getPublicWebinar error:", error.message);
    res.status(500).json({ error: error.message });
  }
};

// POST /api/partner-updates/public/:token/register  (no auth — submit registration)
const submitPublicRegistration = async (req, res) => {
  try {
    const { token } = req.params;
    const { name, phone } = req.body;

    if (!name || !name.trim() || !phone || !phone.trim()) {
      return res.status(400).json({ error: "name and phone required" });
    }

    const doc = await col().findOne({ publicToken: token });
    if (!doc) return res.status(404).json({ error: "not found" });
    if (!doc.is_active) return res.status(403).json({ error: "inactive" });

    const existing = await submissionsCol().findOne({ webinar_id: doc.webinar_id, phone: phone.trim() });
    if (existing) return res.status(409).json({ alreadyRegistered: true });

    await submissionsCol().insertOne({
      webinar_id: doc.webinar_id,
      name: name.trim(),
      phone: phone.trim(),
      email: null,
      notes: null,
      account_phone: null,
      fb_page_id: null,
      fb_page_token: null,
      page_name: null,
      submitted_at: new Date(),
    });

    return res.json({ success: true });
  } catch (error) {
    console.error("[PartnerUpdates] submitPublicRegistration error:", error.message);
    res.status(500).json({ error: error.message });
  }
};

// GET /webinar/:token  (public HTML page — called from server.js)
const renderPublicWebinarPage = async (req, res) => {
  try {
    const { token } = req.params;
    const doc = await col().findOne({ publicToken: token });

    if (!doc) {
      return res.status(404).send(buildErrorPage("הוובינר לא נמצא", "הקישור שקיבלת אינו תקין."));
    }
    if (!doc.is_active) {
      return res.status(200).send(buildErrorPage("הרישום סגור", "הרישום לוובינר זה אינו פעיל כרגע."));
    }

    let webinarDateStr = null;
    if (doc.webinar_date) {
      const d = new Date(doc.webinar_date);
      const datePart = d.toLocaleDateString("he-IL", { day: "2-digit", month: "2-digit", year: "numeric" });
      const timePart = d.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
      webinarDateStr = `${datePart} | ${timePart}`;
    }

    const imageHtml = doc.image_url
      ? `<div class="hero-img"><img src="${escHtml(doc.image_url)}" alt="${escHtml(doc.title)}" /></div>`
      : "";

    const dateHtml = webinarDateStr
      ? `<div class="webinar-date">📅 ${escHtml(webinarDateStr)}</div>`
      : "";

    const descHtml = doc.description
      ? `<p class="description">${escHtml(doc.description).replace(/\n/g, "<br>")}</p>`
      : "";

    const html = `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escHtml(doc.title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;600;700;800&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Heebo', sans-serif;
      background: #f4f6fb;
      color: #1a202c;
      min-height: 100vh;
      direction: rtl;
    }
    .page {
      max-width: 560px;
      margin: 0 auto;
      background: #fff;
      min-height: 100vh;
      box-shadow: 0 0 40px rgba(0,0,0,.08);
    }
    .hero-img {
      width: 100%;
      background: #e8eaf6;
    }
    .hero-img img {
      width: 100%;
      max-height: 340px;
      object-fit: cover;
      display: block;
    }
    .content {
      padding: 28px 24px 40px;
    }
    h1 {
      font-size: 26px;
      font-weight: 800;
      line-height: 1.3;
      color: #1a202c;
      margin-bottom: 10px;
    }
    .webinar-date {
      font-size: 14px;
      font-weight: 600;
      color: #6366f1;
      margin-bottom: 14px;
    }
    .description {
      font-size: 15px;
      color: #4a5568;
      line-height: 1.7;
      margin-bottom: 28px;
    }
    .register-btn {
      display: block;
      width: 100%;
      padding: 16px;
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      color: #fff;
      font-size: 17px;
      font-weight: 700;
      border: none;
      border-radius: 14px;
      cursor: pointer;
      text-align: center;
      letter-spacing: .3px;
      transition: opacity .2s, transform .1s;
    }
    .register-btn:hover { opacity: .93; }
    .register-btn:active { transform: scale(.98); }
    .register-btn:disabled { opacity: .6; cursor: not-allowed; }

    .form-section {
      margin-top: 20px;
      display: none;
    }
    .form-section.visible { display: block; }

    .field { margin-bottom: 14px; }
    .field label {
      display: block;
      font-size: 13px;
      font-weight: 600;
      color: #374151;
      margin-bottom: 5px;
    }
    .field input {
      width: 100%;
      padding: 12px 14px;
      border: 1.5px solid #d1d5db;
      border-radius: 10px;
      font-size: 15px;
      font-family: 'Heebo', sans-serif;
      color: #1a202c;
      outline: none;
      transition: border-color .15s;
      direction: rtl;
    }
    .field input:focus { border-color: #6366f1; }

    .submit-btn {
      display: block;
      width: 100%;
      padding: 14px;
      background: #059669;
      color: #fff;
      font-size: 16px;
      font-weight: 700;
      border: none;
      border-radius: 12px;
      cursor: pointer;
      margin-top: 6px;
      font-family: 'Heebo', sans-serif;
      transition: opacity .2s;
    }
    .submit-btn:hover { opacity: .9; }
    .submit-btn:disabled { opacity: .6; cursor: not-allowed; }

    .err-msg {
      color: #dc2626;
      font-size: 13px;
      margin-top: 8px;
      display: none;
    }
    .err-msg.visible { display: block; }

    .success-box {
      text-align: center;
      padding: 40px 20px;
      display: none;
    }
    .success-box.visible { display: block; }
    .success-icon { font-size: 56px; margin-bottom: 16px; }
    .success-title { font-size: 22px; font-weight: 800; color: #059669; margin-bottom: 8px; }
    .success-sub { font-size: 15px; color: #6b7280; }

    .already-box {
      text-align: center;
      padding: 40px 20px;
      display: none;
    }
    .already-box.visible { display: block; }
    .already-icon { font-size: 48px; margin-bottom: 16px; }
    .already-title { font-size: 20px; font-weight: 700; color: #f59e0b; margin-bottom: 8px; }
    .already-sub { font-size: 15px; color: #6b7280; }
  </style>
</head>
<body>
  <div class="page">
    ${imageHtml}
    <div class="content" id="mainContent">
      <h1>${escHtml(doc.title)}</h1>
      ${dateHtml}
      ${descHtml}

      <button class="register-btn" id="registerBtn" onclick="showForm()">הירשם עכשיו</button>

      <div class="form-section" id="formSection">
        <div class="field">
          <label for="nameInput">שם מלא *</label>
          <input type="text" id="nameInput" placeholder="הכנס שם מלא" autocomplete="name" />
        </div>
        <div class="field">
          <label for="phoneInput">מספר טלפון *</label>
          <input type="tel" id="phoneInput" placeholder="05X-XXXXXXX" autocomplete="tel" />
        </div>
        <div class="err-msg" id="errMsg"></div>
        <button class="submit-btn" id="submitBtn" onclick="submitReg()">שלח הרשמה</button>
      </div>

      <div class="success-box" id="successBox">
        <div class="success-icon">✅</div>
        <div class="success-title">נרשמת בהצלחה!</div>
        <div class="success-sub">תודה, פרטיך נקלטו במערכת.</div>
      </div>

      <div class="already-box" id="alreadyBox">
        <div class="already-icon">⚠️</div>
        <div class="already-title">כבר נרשמת לוובינר זה</div>
        <div class="already-sub">המספר שהזנת כבר קיים ברשימת הרשומים.</div>
      </div>
    </div>
  </div>

  <script>
    var TOKEN = '${token}';

    function showForm() {
      document.getElementById('registerBtn').style.display = 'none';
      document.getElementById('formSection').classList.add('visible');
      document.getElementById('nameInput').focus();
    }

    function setErr(msg) {
      var el = document.getElementById('errMsg');
      el.textContent = msg;
      el.classList.toggle('visible', !!msg);
    }

    function submitReg() {
      var name = document.getElementById('nameInput').value.trim();
      var phone = document.getElementById('phoneInput').value.trim();
      if (!name) { setErr('נא להזין שם מלא'); return; }
      if (!phone) { setErr('נא להזין מספר טלפון'); return; }
      setErr('');

      var btn = document.getElementById('submitBtn');
      btn.disabled = true;
      btn.textContent = 'שולח...';

      fetch('/api/partner-updates/public/' + TOKEN + '/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, phone: phone }),
      })
      .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, status: r.status, data: d }; }); })
      .then(function(res) {
        btn.disabled = false;
        btn.textContent = 'שלח הרשמה';
        if (res.status === 409) {
          document.getElementById('formSection').style.display = 'none';
          document.getElementById('alreadyBox').classList.add('visible');
        } else if (res.ok) {
          document.getElementById('formSection').style.display = 'none';
          document.getElementById('successBox').classList.add('visible');
        } else {
          setErr('שגיאה בשרת, נסה שוב');
        }
      })
      .catch(function() {
        btn.disabled = false;
        btn.textContent = 'שלח הרשמה';
        setErr('שגיאת תקשורת, נסה שוב');
      });
    }

    document.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        var fs = document.getElementById('formSection');
        if (fs && fs.classList.contains('visible')) submitReg();
      }
    });
  </script>
</body>
</html>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(html);
  } catch (error) {
    console.error("[PartnerUpdates] renderPublicWebinarPage error:", error.message);
    return res.status(500).send(buildErrorPage("שגיאה", "אירעה שגיאה בטעינת הדף."));
  }
};

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildErrorPage(title, message) {
  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escHtml(title)}</title>
  <link href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;700&display=swap" rel="stylesheet">
  <style>
    body { font-family: 'Heebo', sans-serif; background: #f4f6fb; display: flex; align-items: center; justify-content: center; min-height: 100vh; direction: rtl; }
    .box { background: #fff; border-radius: 16px; padding: 48px 32px; text-align: center; max-width: 360px; box-shadow: 0 4px 24px rgba(0,0,0,.08); }
    .icon { font-size: 48px; margin-bottom: 16px; }
    h1 { font-size: 22px; font-weight: 700; margin-bottom: 10px; color: #1a202c; }
    p { font-size: 15px; color: #6b7280; }
  </style>
</head>
<body>
  <div class="box">
    <div class="icon">🔒</div>
    <h1>${escHtml(title)}</h1>
    <p>${escHtml(message)}</p>
  </div>
</body>
</html>`;
}

module.exports = {
  getSettings,
  updateSettings,
  getActiveUpdates,
  submitForm,
  createUpdate,
  toggleActive,
  deleteUpdate,
  getAllUpdates,
  getSubmissions,
  getPublicWebinar,
  submitPublicRegistration,
  renderPublicWebinarPage,
};
