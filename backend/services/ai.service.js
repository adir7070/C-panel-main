const { OpenAI } = require("openai");

const openai = new OpenAI({
  apiKey: process.env.OpenAI_API_KEY,
});

/**
 * Generates text using OpenAI GPT-4o.
 * @param {string} systemPrompt - The system instruction.
 * @param {string} userPrompt - The user input.
 * @returns {Promise<Object>} Parsed JSON response from the model.
 */
/**
 * Generates plain text using OpenAI GPT-4o (no JSON formatting).
 * @param {string} systemPrompt - The system instruction.
 * @param {string} userPrompt - The user input.
 * @returns {Promise<string>} Raw text response from the model.
 */
exports.generateRawText = async (systemPrompt, userPrompt) => {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    const content = completion.choices[0].message.content;
    if (!content) {
      throw new Error("Empty response from OpenAI");
    }

    return content.trim();
  } catch (error) {
    console.error("Error generating raw text with OpenAI:", error);
    throw new Error("Failed to generate text");
  }
};

/**
 * Generates a text prompt using GPT-4o Vision — accepts optional image references
 * (URLs or base64 data URIs) alongside the text input.
 * @param {string} systemPrompt
 * @param {string} userText
 * @param {string[]} imageRefs - array of URLs or data URIs (e.g. "data:image/jpeg;base64,...")
 */
exports.generateRawTextWithImages = async (systemPrompt, userText, imageRefs = []) => {
  try {
    const userContent = [
      { type: "text", text: userText },
      ...imageRefs
        .filter(Boolean)
        .slice(0, 3) // max 3 reference images to keep cost/latency reasonable
        .map((ref) => ({
          type: "image_url",
          image_url: { url: ref, detail: "low" },
        })),
    ];

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      max_tokens: 1200,
    });

    const content = completion.choices[0].message.content;
    if (!content) throw new Error("Empty response from OpenAI");
    return content.trim();
  } catch (error) {
    console.error("Error in generateRawTextWithImages:", error.message);
    // Fall back to text-only if vision fails
    return exports.generateRawText(systemPrompt, userText);
  }
};

exports.generateAdCopy = async (systemPrompt, userPrompt) => {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o", // Using gpt-4o as it's the current flashship for this type of task
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" }, // Enforce JSON output which is crucial for this pipeline
    });

    const content = completion.choices[0].message.content;
    if (!content) {
      throw new Error("Empty response from OpenAI");
    }

    return JSON.parse(content);
  } catch (error) {
    console.error("Error generating ad copy with OpenAI:", error);
    throw new Error("Failed to generate ad copy");
  }
};

/**
 * Generates demo ad copy in Hebrew using OpenAI GPT-4o.
 * Supports optional vision input via imageUrl.
 * @param {Object} payload - { service, goal, context: { headline, body } }
 * @param {string|null} imageUrl - Optional image URL for vision analysis
 * @returns {Promise<Object>} Parsed JSON: { title, body, description }
 */
/**
 * Rephrases a support message in a professional, customer-service tone.
 * @param {string} text - The original message text.
 * @returns {Promise<string>} Rephrased message.
 */
exports.rephraseMessage = async (text, options = {}) => {
  const {
    tone = "professional",
    channel = "whatsapp",
    intent = "refine",
    length = "similar",
    preserveEmoji = true,
    strictPreserve = true,
  } = options;

  const systemPrompt = `
אתה מנוע שכתוב מקצועי להודעות שירות לקוחות בעברית.

מטרתך:
לקבל הודעת מקור ולשכתב אותה כך שתהיה מקצועית, מנומסת, שירותית, ברורה ואמפתית, תוך שמירה מלאה על המשמעות, הכוונה, רמת הישירות והמידע המקורי.

הגדרות למשימה:
- רמת טון: ${tone}
- ערוץ תקשורת: ${channel}
- מטרת השכתוב: ${intent}
- אורך רצוי: ${length}
- שמירת אימוג'ים: ${preserveEmoji ? "כן" : "לא"}
- שמירה מחמירה על המקור: ${strictPreserve ? "כן" : "לא"}

כללי ליבה מחייבים:
1. אל תוסיף מידע חדש בשום מצב.
2. אל תשמיט מידע מהותי.
3. אל תשנה את הבקשה, העמדה, העובדות או ההתחייבויות שמופיעות בהודעה המקורית.
4. אל תיצור התנצלות, פיצוי, הבטחה, התחייבות, ריכוך יתר או ניסוח שיווקי אם הם לא הופיעו במקור.
5. אם ההודעה כבר מנוסחת היטב — בצע שיפור מינימלי בלבד.
6. אם ההודעה בוטה, כועסת, תוקפנית, מאשימה, לא סבלנית או לא מקצועית — רכך את הטון אך שמור על אותה כוונה מעשית.
7. שמור על ניסוח טבעי, אנושי, ברור ולא רובוטי.

כללי טון:
- אם tone הוא soft → העדף ניסוח עדין, מכיל ורגוע.
- אם tone הוא professional → העדף איזון בין שירותיות, מקצועיות ובהירות.
- אם tone הוא firm → העדף ניסוח אסרטיבי, ברור ומכבד, בלי תוקפנות.

כללי אורך:
- אם length הוא short → קצר ככל האפשר בלי לפגוע במסר.
- אם length הוא similar → שמור על אורך דומה ככל האפשר.
- אם length הוא polished → אפשר ללטש מעט גם אם ההודעה תתארך קצת.

כללי ערוץ:
- אם channel הוא whatsapp → שמור על ניסוח טבעי, זורם, אנושי ולא רשמי מדי.
- אם channel הוא email → שמור על ניסוח מסודר, מעט יותר פורמלי.
- אם channel הוא sms/chat → שמור על ניסוח קצר, ברור וישיר.

שימור מדויק:
- שמור בדיוק על כל שם, מספר, מחיר, תאריך, שעה, כתובת, קישור, אימייל, מספר טלפון, קוד, מזהה, placeholder, משתנה טכני, שם מערכת, שם קובץ, טקסט במרכאות, URL, token, field name או ערך דינמי.
- אל תשנה פורמט של נתונים טכניים.
- אל תתרגם מונחים טכניים אם הם הופיעו כפי שהם.

אימוג'ים:
- אם preserveEmoji הוא כן → שמור אימוג'ים רק אם הם מתאימים לטון המקצועי ואינם פוגעים בבהירות.
- אם preserveEmoji הוא לא → הסר אימוג'ים רק אם אין בכך פגיעה במשמעות.

הנחיות החלטה:
- אם יש אגרסיביות → המר לאסרטיביות מכבדת.
- אם יש חדות מיותרת → המר לבהירות עניינית.
- אם יש בלבול → סדר את המשפטים בלי לשנות את התוכן.
- אם יש שפה מדוברת מדי → הפוך אותה לטבעית אך מקצועית.
- אם ההודעה כבר טובה → בצע מינימום שינויים.

ולידציה פנימית חובה לפני החזרת הפלט:
בדוק בשקט:
1. האם נשמרה אותה משמעות בדיוק?
2. האם כל העובדות והפרטים נשמרו ללא שינוי?
3. האם לא נוסף שום מידע חדש?
4. האם הטון כעת תואם את tone?
5. האם האורך תואם את length?
6. האם הסגנון מתאים ל-channel?
7. האם ההודעה נשמעת טבעית ולא מלאכותית?
8. האם הפלט כולל רק את ההודעה עצמה, ללא הקדמה או הסבר?

אם משהו נכשל — תקן ורק אז החזר תשובה.

פלט:
- החזר רק את ההודעה המשוכתבת
- ללא מרכאות
- ללא כותרת
- ללא הסברים
- בעברית בלבד
`;

  const userPrompt = `שכתב את ההודעה הבאה בהתאם לכללים:\n\n${text}`;

  return exports.generateRawText(systemPrompt, userPrompt);
};

exports.generateDemoAdCopy = async (payload, imageUrl, siteContext = "") => {
  try {
    const systemPrompt =
      "אתה קופירייטר מומחה לפרסום בפייסבוק ואינסטגרם בעברית. כתוב פרסומת קצרה וממירה.";

    const service = payload.service || "";
    const goal = payload.goal || "";
    const headline = payload.context?.headline || "";
    const bodyText = payload.context?.body || "";

    const siteSection = siteContext
      ? `\n\nהקשר מאתר העסק (השתמש כדי להתאים טון וסגנון):\n${siteContext}`
      : "";

    const baseUserText = `כתוב מודעת פייסבוק עבור:
שירות/מוצר: ${service}
מטרת המודעה: ${goal}
כותרת קיימת (לשפר): ${headline}
טקסט קיים (לשפר): ${bodyText}${siteSection}

החזר JSON בלבד ללא markdown, בפורמט:
{"title": "...", "body": "...", "description": "..."}`;

    let imageDescription = "";

    if (imageUrl) {
      // Step 1 — Analyze the image with GPT-4o vision
      const analysisCompletion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "תאר את התמונה הזו: מה נראה בה? מה הסגנון הוויזואלי? מה הצבעים הדומיננטיים? מה האווירה הכללית? כתוב תיאור קצר בעברית.",
              },
              { type: "image_url", image_url: { url: imageUrl } },
            ],
          },
        ],
      });
      imageDescription = analysisCompletion.choices[0].message.content || "";
      console.log("🖼️ Image analysis:", imageDescription);
    }

    // Step 2 — Generate ad copy (text-only, using image analysis if available)
    const userText = imageDescription
      ? `${baseUserText}\n\nניתוח הוויזואל של התמונה:\n${imageDescription}\n\nכתוב בהתאם לסגנון הוויזואלי המתואר לעיל.`
      : baseUserText;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userText },
      ],
      response_format: { type: "json_object" },
    });

    const content = completion.choices[0].message.content;
    if (!content) throw new Error("Empty response from OpenAI");

    return JSON.parse(content);
  } catch (error) {
    console.error("Error generating demo ad copy with OpenAI:", error);
    throw new Error("Failed to generate demo ad copy");
  }
};
