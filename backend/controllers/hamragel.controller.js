const axios = require("axios");
const { OpenAI } = require("openai");
const { imageAgent } = require("../ai-agents/gemini");
const { uploadImage } = require("../services/backblaze.service");
const { buildAnalysisPrompt } = require("../utils/prompts/hamragel-analysis");
const { buildGeneratePrompt } = require("../utils/prompts/hamragel-generate");

const openai = new OpenAI({ apiKey: process.env.OpenAI_API_KEY });

// הערה המצורפת לכל פרומפט שנשלח לגמיני
const GEMINI_SUFFIX =
  "\nשים לב כשאתה יוצר את המלל על התמונה - אז תצור אותו בלי סימני פסיק !!!" +
  "\nCRITICAL: Generate a VERTICAL PORTRAIT image only. Aspect ratio MUST be 4:5 portrait (1080x1350px). Taller than wide. Do NOT generate landscape or square images.";

/**
 * POST /api/ai/hamragel
 *
 * Body:
 *   status          {string}  "new" | "ok"
 *   image           {string}  base64 של תמונת המתחרה
 *   phone           {string}  מספר טלפון (לנתיב B2)
 *   count           {number}  כמה תמונות לייצר (רלוונטי ל-"ok")
 *   notes           {string}  הערות אופציונליות
 *   website         {string}  URL של אתר המתחרה (אופציונלי)
 *   success_reason  {string}  תוצאת שלב 1 (רלוונטי ל-"ok")
 *   eye_grabbers    {string}  תוצאת שלב 1 (רלוונטי ל-"ok")
 *   winning_changes {string}  תוצאת שלב 1 (רלוונטי ל-"ok")
 */
exports.run = async (req, res) => {
  const {
    status,
    image,
    phone,
    count = 1,
    notes = "",
    website = "",
    success_reason = "",
    eye_grabbers = "",
    winning_changes = "",
  } = req.body;

  if (!status || !image) {
    return res.status(400).json({ success: false, error: "status ו-image הם שדות חובה" });
  }

  try {
    // ── שלב 1: ניתוח בלבד ──────────────────────────────────────────────────
    if (status === "new") {
      console.log("[המרגל] 🕵️ שלב 1 — ניתוח מודעת מתחרה");

      // שליפת HTML אם סופק אתר
      const html = await fetchHtml(website);

      const systemPrompt = buildAnalysisPrompt({ notes, count, html });

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: `data:image/jpeg;base64,${image}` },
              },
            ],
          },
        ],
        response_format: { type: "json_object" },
      });

      const raw = completion.choices[0].message.content;
      const analysis = JSON.parse(raw);

      console.log("[המרגל] ✅ ניתוח הושלם");
      return res.json({ success: true, ...analysis });
    }

    // ── שלב 2: יצירת מודעות ────────────────────────────────────────────────
    if (status === "ok") {
      console.log(`[המרגל] 🎨 שלב 2 — יצירת ${count} מודעות`);

      // שליפת HTML אם סופק אתר
      const html = await fetchHtml(website);

      const systemPrompt = buildGeneratePrompt({
        notes,
        count,
        html,
        success_reason,
        eye_grabbers,
        winning_changes,
      });

      // GPT יוצר מערך פרומפטים לגמיני
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: `data:image/jpeg;base64,${image}` },
              },
            ],
          },
        ],
        response_format: { type: "json_object" },
      });

      const raw = completion.choices[0].message.content;
      const parsed = JSON.parse(raw);
      const prompts = parsed.posts || [];

      if (!prompts.length) {
        throw new Error("GPT לא החזיר פרומפטים תקינים");
      }

      console.log(`[המרגל] 📋 התקבלו ${prompts.length} פרומפטים מ-GPT`);

      // יצירת תמונות ועליית לB2 — סידרתית כדי לא לחרוג ממגבלות ה-API
      const timestamp = Date.now();
      const imageUrls = [];

      for (let i = 0; i < prompts.length; i++) {
        const promt = prompts[i].promt || prompts[i].prompt || "";
        if (!promt) {
          console.warn(`[המרגל] ⚠️ פרומפט ${i + 1} ריק, מדלג`);
          continue;
        }

        console.log(`[המרגל] 🖼️ יוצר תמונה ${i + 1}/${prompts.length}`);

        const geminiPrompt = promt + GEMINI_SUFFIX;
        const imageResult = await imageAgent.generate(geminiPrompt);

        const filePath = `post/${phone}/${timestamp}-${i + 1}.png`;
        const uploaded = await uploadImage(filePath, imageResult.buffer, "image/png");

        imageUrls.push(uploaded.publicUrl);
        console.log(`[המרגל] ✅ תמונה ${i + 1} הועלתה: ${uploaded.publicUrl}`);
      }

      console.log(`[המרגל] 🏁 הסתיים — ${imageUrls.length} תמונות`);
      return res.json({ success: true, images: imageUrls });
    }

    return res.status(400).json({ success: false, error: `status לא מוכר: ${status}` });
  } catch (err) {
    console.error("[המרגל] ❌ שגיאה:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * שליפת HTML של אתר — מחזיר מחרוזת ריקה אם הURL לא סופק או השליפה נכשלה
 */
async function fetchHtml(url) {
  if (!url) return "";
  try {
    const response = await axios.get(url, {
      timeout: 10000,
      headers: { "Accept-Encoding": "gzip" },
    });
    return typeof response.data === "string" ? response.data : "";
  } catch (err) {
    console.warn(`[המרגל] ⚠️ לא הצלחתי לשלוף HTML מ-${url}: ${err.message}`);
    return "";
  }
}
