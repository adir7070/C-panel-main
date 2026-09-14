const { DB } = require("../config/db");
const aiService = require("../services/ai.service");
const backblaze = require("../services/backblaze.service");

const SERVER_BASE_URL = process.env.BASE_URL || "https://api.iconiqmedia.co.il";

const adBriefs = () => DB.collection("ad_briefs");
const adPlans = () => DB.collection("ad_plans");

const normalizePhone = (phone) => {
  let p = String(phone).trim().replace(/\s+/g, "");
  if (p.startsWith("+972")) p = "0" + p.slice(4);
  else if (p.startsWith("972")) p = "0" + p.slice(3);
  return p;
};

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `אתה מומחה קריאייטיב ברמה של משרד פרסום פרימיום.

אני נותן לך מידע שנאסף מלקוח דרך שאלון עומק.
המטרה שלך היא לייצר סדרת מודעות (2 עד 10, לפי מה שאציין) שכל אחת מהן שונה לחלוטין בגישה, בזווית ובמסר.

❗ חשוב מאוד:
- תחזיר רק JSON תקין בפורמט: { "ads": [...] }
- בלי הסברים
- בלי טקסט נוסף
- בלי הערות
- רק אובייקט עם שדה "ads" שמכיל מערך

---

🎯 מטרה:
ליצור מודעות שעוצרות גלילה, מרגישות אמיתיות, לא גנריות, ומבוססות רגש + כאב + רצון + בידול.

---

📦 מבנה JSON לכל מודעה:
{
  "title": "...",
  "body": "...",
  "cta": "...",
  "address": "...",
  "image_design": "..."
}

---

📌 חוקים קריטיים:

1. title:
- קצר, חזק, עוצר גלילה
- לא גנרי
- לא "מבצע" / "הכי טוב"
- חייב לעורר רגש או סקרנות

2. body:
- 2–4 שורות
- משלב כאב + פתרון + ערך
- כתיבה טבעית, אנושית
- לא טקסט מכירתי גנרי

3. cta:
- קצר מאוד (2–4 מילים)
- מותאם למטרה (וואטסאפ / לידים / שיחה)

4. address:
- אם אין מידע → השאר מחרוזת ריקה ""

5. image_design:
- תיאור מאוד מפורט של איך התמונה צריכה להיראות
- כולל:
  - סוג צילום (מאקרו / לייפסטייל / סטודיו)
  - תאורה
  - צבעים
  - קומפוזיציה
  - תחושה (יוקרה / דרמה / חום וכו)
- חייב להיות מספיק מדויק כדי לייצר תמונה ברמה גבוהה

---

🧠 אסטרטגיה:
כל מודעה חייבת להיות בזווית שונה:

לדוגמה:
- כאב (problem)
- תוצאה (dream outcome)
- לפני/אחרי
- הוכחה
- יוקרה
- FOMO
- רגש
- פתרון מהיר

❗ אסור לחזור על אותה זווית פעמיים

---

🚫 איסורים:
- לא לכתוב "שירות מקצועי"
- לא "הכי טוב"
- לא טקסטים גנריים
- לא לחזור על ניסוחים`;

// ─── Build user message from brief ───────────────────────────────────────────

function buildUserMessage(brief, numAds) {
  const lines = ["📥 הנה המידע מהלקוח:"];

  if (brief.answers && typeof brief.answers === "object") {
    Object.entries(brief.answers).forEach(([questionId, answer]) => {
      if (answer && answer.raw) {
        lines.push(`${questionId}: ${answer.raw}`);
      }
    });
  }

  if (brief.brandColors && brief.brandColors.length > 0) {
    lines.push(`צבעי מותג: ${brief.brandColors.join(", ")}`);
  }

  if (brief.websiteUrl) {
    lines.push(`אתר אינטרנט: ${brief.websiteUrl}`);
  }

  lines.push("");
  lines.push(`📊 מספר מודעות לייצור: ${numAds}`);
  lines.push("");
  lines.push(`📤 הפלט: אובייקט JSON עם שדה "ads" שמכיל בדיוק ${numAds} אובייקטים.`);
  lines.push("אם אין לך מספיק מידע – תשתמש בהיגיון שיווקי ולא תשאיר שדות ריקים (חוץ מכתובת).");
  lines.push("תייצר מודעות ברמה גבוהה מאוד, כאילו כל אחת מהן עולה אלפי שקלים לקריאייטיב.");

  return lines.join("\n");
}

// ─────────────────────────────────────────────
// POST /api/ad-plan/generate
// Body: { phone, numAds }
// ─────────────────────────────────────────────
exports.generatePlan = async (req, res) => {
  try {
    const { phone: rawPhone, numAds: rawNumAds, sessionId } = req.body;

    if (!rawPhone) {
      return res.status(400).json({ error: "phone is required" });
    }

    const phone = normalizePhone(rawPhone);
    const numAds = Math.min(10, Math.max(2, parseInt(rawNumAds) || 5));
    const briefQuery = sessionId ? { phone, sessionId } : { phone };

    // Fetch brief
    const brief = await adBriefs().findOne(briefQuery);
    if (!brief) {
      return res.status(404).json({ error: "Brief not found for this phone" });
    }

    // Build prompts
    const userMessage = buildUserMessage(brief, numAds);

    console.log(`🤖 [AdPlan] Generating ${numAds} ads for phone=${phone}${sessionId ? `, session=${sessionId}` : ""}`);

    // Call GPT-4o via ai.service
    const rawText = await aiService.generateAdCopy(SYSTEM_PROMPT, userMessage);

    // Extract ads array
    let ads = [];
    if (rawText && rawText.ads && Array.isArray(rawText.ads)) {
      ads = rawText.ads;
    } else if (Array.isArray(rawText)) {
      ads = rawText;
    } else {
      throw new Error("Unexpected GPT response format");
    }

    const now = new Date();
    const planQuery = sessionId ? { phone, sessionId } : { phone };

    // Upsert into ad_plans
    await adPlans().findOneAndUpdate(
      planQuery,
      {
        $set: {
          numAds,
          briefSnapshot: {
            answers: brief.answers || {},
            brandColors: brief.brandColors || [],
            websiteUrl: brief.websiteUrl || "",
            logoBase64: brief.logoBase64 || null,
            logoUrl: brief.logoUrl || null,
            selectedAvatar: brief.selectedAvatar || null,
          },
          originalPlan: ads,
          editedPlan: null,
          status: "generated",
          updatedAt: now,
        },
        $setOnInsert: { phone, ...(sessionId && { sessionId }), createdAt: now },
      },
      { upsert: true }
    );

    console.log(`✅ [AdPlan] Generated ${ads.length} ads for phone=${phone}`);
    res.json({ success: true, plan: ads });
  } catch (error) {
    console.error("❌ [AdPlan] generatePlan error:", error.message);
    res.status(500).json({ error: "Failed to generate plan", details: error.message });
  }
};

// ─────────────────────────────────────────────
// POST /api/ad-plan/save
// Body: { phone, editedPlan: [...] }
// ─────────────────────────────────────────────
exports.savePlan = async (req, res) => {
  try {
    const { phone: rawPhone, editedPlan, sessionId } = req.body;

    if (!rawPhone || !Array.isArray(editedPlan)) {
      return res.status(400).json({ error: "phone and editedPlan[] are required" });
    }

    const phone = normalizePhone(rawPhone);
    const now = new Date();
    const query = sessionId ? { phone, sessionId } : { phone };

    await adPlans().findOneAndUpdate(
      query,
      {
        $set: { editedPlan, status: "approved", updatedAt: now },
        $setOnInsert: { phone, ...(sessionId && { sessionId }), createdAt: now },
      },
      { upsert: true }
    );

    console.log(`✅ [AdPlan] Plan approved for phone=${phone}, ${editedPlan.length} ads`);
    res.json({ success: true });
  } catch (error) {
    console.error("❌ [AdPlan] savePlan error:", error.message);
    res.status(500).json({ error: "Failed to save plan", details: error.message });
  }
};

// ─────────────────────────────────────────────
// GET /api/ad-plan/by-phone/:phone
// ─────────────────────────────────────────────
exports.getByPhone = async (req, res) => {
  try {
    const phone = normalizePhone(req.params.phone);
    const { sessionId } = req.query;
    const query = sessionId ? { phone, sessionId } : { phone };
    const plan = await adPlans().findOne(query);

    if (!plan) {
      return res.status(404).json({ error: "Plan not found" });
    }

    console.log(`✅ [AdPlan] Plan fetched for phone=${phone}`);
    res.json({
      success: true,
      data: {
        originalPlan: plan.originalPlan,
        editedPlan: plan.editedPlan,
        status: plan.status,
        numAds: plan.numAds,
      },
    });
  } catch (error) {
    console.error("❌ [AdPlan] getByPhone error:", error.message);
    res.status(500).json({ error: "Failed to fetch plan", details: error.message });
  }
};

// ─────────────────────────────────────────────
// POST /api/ad-plan/upload-image
// Body: { phone, adIndex, imageBase64, mimeType? }
// Uploads a reference image to uploads/{phone}/ad-ref-{adIndex}-{ts}.jpg
// Returns: { success, url }
// ─────────────────────────────────────────────
exports.uploadAdImage = async (req, res) => {
  try {
    const { phone: rawPhone, adIndex, imageBase64, mimeType = "image/jpeg" } = req.body;
    if (!rawPhone || !imageBase64 || adIndex === undefined) {
      return res.status(400).json({ error: "phone, adIndex, and imageBase64 are required" });
    }

    const phone = normalizePhone(rawPhone);
    const ext = mimeType.split("/")[1]?.split("+")[0] || "jpg";
    const filePath = `uploads/${phone}/ad-ref-${adIndex}-${Date.now()}.${ext}`;
    const raw = imageBase64.replace(/^data:image\/\w+;base64,/, "");
    const buf = Buffer.from(raw, "base64");

    await backblaze.uploadImage(filePath, buf, mimeType);

    const url = `${SERVER_BASE_URL}/api/img?url=${encodeURIComponent(filePath)}`;
    console.log(`✅ [AdPlan] Reference image uploaded for phone=${phone}, adIndex=${adIndex} → ${url}`);
    res.json({ success: true, url });
  } catch (error) {
    console.error("❌ [AdPlan] uploadAdImage error:", error.message);
    res.status(500).json({ error: "Failed to upload image", details: error.message });
  }
};
