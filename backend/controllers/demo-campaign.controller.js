const axios = require("axios");
const FormData = require("form-data");
const aiService = require("../services/ai.service");

const FB_VERSION = process.env.FACEBOOK_API_VERSION || "v23.0";
const FB_BASE = "https://graph.facebook.com";
const LANDING_URL = process.env.CAMPAIGN_LANDING_URL || "https://yourdomain.com/landing";

// ── GPT system prompt (from Make.com module 220) ──────────────────────────────
const ADSET_SYSTEM_PROMPT = `אתה מחולל JSON מדויק ליצירת Ad Set ב-Meta Ads API (Outcome-Driven).

קלט אפשרי (חלקי או מלא):

campaign_id: מחרוזת (חובה)
page_id: מחרוזת (חובה)

ages (אופציונלי):
age_min: מספר שלם
age_max: מספר שלם

location_ids:
0 (מספר) = כל ישראל
או מערך IDs של ערים (לדוגמה ["2420605","2420460"])

gender (אופציונלי):
0 / null / "" = אל תשלח genders
1 = גברים
2 = נשים
3 = כולם (שלח [1,2])

additional_targeting (אופציונלי):
אובייקט JSON תקין עם שדות טירגוט נוספים

מטרה
להחזיר אובייקט JSON אחד בלבד, תקין לחלוטין, בלי טקסט מסביב, בלי markdown, בלי הערות.

━━━━━━━━━━━━━━━━━━━━
חוקים קריטיים (חובה):
━━━━━━━━━━━━━━━━━━━━

החזר JSON אחד בלבד.

שדה אופציונלי שלא קיים / ריק / 0 — לא לכלול בכלל.

targeting חייב להיות אובייקט JSON.

שפות: תמיד כל השפות →
אסור לכלול locales בכלל.

━━━━━━━━━━━━━━━━━━━━
מיקומים
━━━━━━━━━━━━━━━━━━━━

location_ids = 0 →

"geo_locations": {
"countries": ["IL"]
}

location_ids = מערך →

"geo_locations": {
"cities": [
{ "key": "ID" },
{ "key": "ID" }
]
}

לפי הסדר שהתקבל.

━━━━━━━━━━━━━━━━━━━━
גילאים
━━━━━━━━━━━━━━━━━━━━

אם age_min קיים → כלול targeting.age_min

אם age_max קיים → כלול targeting.age_max

⚠ חוק Meta קריטי – Advantage+:

אם advantage_audience = 1
אסור לשלוח age_max קטן מ-65.

אם age_max קיים והוא קטן מ-65
וחוקי Advantage+ מחייבים advantage_audience = 1
אז:
יש לבטל advantage_audience (להגדיר ל-0)

אין להשאיר מצב שבו:
advantage_audience = 1
וגם age_max < 65

זה נחשב שגיאת API ויש למנוע זאת ברמת יצירת ה-JSON.

━━━━━━━━━━━━━━━━━━━━
מגדר
━━━━━━━━━━━━━━━━━━━━

1 → genders:[1]
2 → genders:[2]
3 → genders:[1,2]
0 / ריק → אל תכלול genders

━━━━━━━━━━━━━━━━━━━━
Advantage Audience – חובה
━━━━━━━━━━━━━━━━━━━━

בתוך targeting.targeting_automation:

אם location_ids = 0:

gender = 0 / ריק / 3 → advantage_audience = 1
gender = 1 או 2 → advantage_audience = 0

אם location_ids הוא מערך ערים → advantage_audience = 0

⚠ לאחר קביעת advantage_audience
יש לבדוק התאמה לחוק הגיל (age_max ≥ 65 או לא קיים).
במידת הצורך — לכבות Advantage+.

━━━━━━━━━━━━━━━━━━━━
additional_targeting
━━━━━━━━━━━━━━━━━━━━

אם קיים והוא אובייקט → למזג לתוך targeting

אם יש התנגשות:

הכללים הבנויים מנצחים:
geo_locations
age_min
age_max
genders
targeting_automation

━━━━━━━━━━━━━━━━━━━━

אין להוסיף locales בשום מצב

אסור לקבל או למזג מהקלט שום ערך שקשור לבידינג

━━━━━━━━━━━━━━━━━━━━
חובה
━━━━━━━━━━━━━━━━━━━━

להמציא שם לאד-סט:

קצר
ברור
בעברית
לא ריק

━━━━━━━━━━━━━━━━━━━━
פורמט פלט (להחזיר בדיוק כך, עם ערכים אמיתיים):
━━━━━━━━━━━━━━━━━━━━

{
"name": "<שם בעברית שהמצאת>",
"campaign_id": "<campaign_id>",
"billing_event": "IMPRESSIONS",
"optimization_goal": "LEAD_GENERATION",
"destination_type": "ON_AD",
"status": "PAUSED",
"promoted_object": { "page_id": "<page_id>" },
"targeting": {
"geo_locations": { ... },
"targeting_automation": {
"advantage_audience": 0 או 1
}
}
}

━━━━━━━━━━━━━━━━━━━━
חוק יציבות
━━━━━━━━━━━━━━━━━━━━

JSON תקין בלבד
מרכאות כפולות
בלי פסיקים מיותרים
בלי שום פלט מחוץ ל-JSON`;

/**
 * POST /api/campaign/create-demo
 *
 * Mirrors the Make.com "יצירת קמפיין דמו" scenario exactly:
 *
 * Route 1 – adspixels: GET existing pixels for the account, create one if none exists
 * Route 2 – leadgen form: create a lead form on the page with fixed fields
 * Route 3 – campaign flow:
 *   1. Create Campaign (OUTCOME_LEADS, PAUSED)
 *   2. GPT → ad-set JSON (targeting, name, etc.)
 *   3. Create Ad Set
 *   4. For each ad: download image → upload to adimages → create creative → create ad
 *   5. Respond with campaign creation data
 */
exports.createDemoCampaign = async (req, res) => {
  const body = req.body; // {{3}} in Make.com — full webhook payload
  const {
    token,
    page_token,
    page_id,
    act_id,
    campaign_name,
    daily_budget,
    ads,
  } = body;

  if (!token || !page_id || !act_id) {
    return res.status(400).json({ error: "Missing required fields: token, page_id, act_id" });
  }

  const act = `act_${String(act_id).replace(/^act_/, "")}`;
  // Make.com appends "00" as string: {{3.daily_budget}}00
  // e.g. budget=50 → "5000" (agorot)
  const budgetStr = `${parseInt(daily_budget) || 50}00`;

  try {
    // ── Route 1: adspixels (module 197–203) ──────────────────────────────────
    console.log(`[demo-campaign] 🔍 Checking adspixels for ${act}`);
    let pixelId = null;
    try {
      const pixelsRes = await axios.get(
        `${FB_BASE}/v19.0/${act}/adspixels`,
        { params: { access_token: token } },
      );
      const existingPixels = pixelsRes.data?.data || [];

      if (existingPixels.length > 0) {
        // Module 203: pixel exists → use existing ID
        pixelId = existingPixels[0].id;
        console.log(`[demo-campaign] ✅ Using existing pixel: ${pixelId}`);
      } else {
        // Module 200: no pixel → create one named "ניסיון"
        const createPixelRes = await axios.post(
          `${FB_BASE}/v19.0/${act}/adspixels`,
          new URLSearchParams({ name: "ניסיון", access_token: token }).toString(),
          { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
        );
        pixelId = createPixelRes.data?.data?.id || createPixelRes.data?.id;
        console.log(`[demo-campaign] ✅ Created new pixel: ${pixelId}`);
      }
    } catch (e) {
      console.warn(`[demo-campaign] ⚠️  adspixels step failed (non-fatal): ${e.message}`);
    }

    // ── Route 2: leadgen form (module 216–218) ────────────────────────────────
    console.log(`[demo-campaign] 📋 Creating lead form on page ${page_id}`);
    let leadFormId = null;
    try {
      const now = new Date().toISOString();
      const formFields = new URLSearchParams();
      formFields.append("name", `טופס לידים - ${now}`);
      formFields.append("locale", "he_IL");
      formFields.append("status", "ACTIVE");
      formFields.append("privacy_policy", JSON.stringify({ url: "https://example.com/privacy", link_text: "מדיניות פרטיות" }));
      formFields.append("questions", JSON.stringify([{ type: "FULL_NAME" }, { type: "PHONE" }, { type: "CITY" }]));
      formFields.append("follow_up_action_url", LANDING_URL);
      formFields.append("thank_you_page", JSON.stringify({
        title: "תודה!",
        body: "הפרטים נקלטו. אפשר לעבור לאתר ולהתרשם מהעבודות והמחירים.",
        button_text: "לאתר שלנו",
        button_type: "VIEW_WEBSITE",
        website_url: LANDING_URL,
      }));
      formFields.append("description", "השאירו פרטים ונחזור בהקדם");

      const pageAccessToken = page_token || token;
      const formRes = await axios.post(
        `${FB_BASE}/${FB_VERSION}/${page_id}/leadgen_forms`,
        formFields.toString(),
        { headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Bearer ${pageAccessToken}` } },
      );
      leadFormId = formRes.data?.id;
      console.log(`[demo-campaign] ✅ Lead form created: ${leadFormId}`);
    } catch (e) {
      console.warn(`[demo-campaign] ⚠️  Lead form creation failed (non-fatal): ${e.message}`);
    }

    if (!leadFormId) {
      return res.status(400).json({ error: "לא ניתן ליצור טופס לידים. יש לוודא שה-Page Token תקין ושיש הרשאת pages_manage_ads." });
    }

    // ── Route 3: campaign + adset + ads (modules 219–240) ───────────────────

    // Module 233: Create Campaign
    console.log(`[demo-campaign] 🚀 Creating campaign "${campaign_name}"`);
    const campRes = await axios.post(
      `${FB_BASE}/v19.0/${act}/campaigns`,
      JSON.stringify({
        name: campaign_name,
        objective: "OUTCOME_LEADS",
        status: "PAUSED",
        special_ad_categories: [],
        campaign_budget_optimization: true,
        bid_strategy: "LOWEST_COST_WITHOUT_CAP",
        daily_budget: budgetStr,
      }),
      {
        params: { access_token: token },
        headers: { "Content-Type": "application/json" },
      },
    );
    const campaignData = campRes.data; // {{233.data}}
    const campaignId = campaignData.id;
    console.log(`[demo-campaign] ✅ Campaign created: ${campaignId}`);

    // Module 220: GPT → ad-set JSON
    // Input mirrors exactly what Make.com sends: full body + page id + campaign id
    const gptUserPrompt =
      `זה הגייסון יש שם גם פרטים לא חשובים אבל שתדע \n` +
      `${JSON.stringify(body)}\n` +
      `page id = ${page_id}\n` +
      `campaign id = ${JSON.stringify(campaignData)}`;

    console.log(`[demo-campaign] 🤖 Calling GPT to build ad-set payload`);
    const gptRaw = await aiService.generateRawText(ADSET_SYSTEM_PROMPT, gptUserPrompt);

    // Extract JSON from GPT output (same as other controllers)
    const jsonMatch = gptRaw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("GPT response contains no JSON object for ad set");
    const adSetBody = JSON.parse(jsonMatch[0]); // {{220.result}} parsed

    // Module 221: POST adsets using GPT output
    console.log(`[demo-campaign] 📋 Creating ad set`);
    const adSetRes = await axios.post(
      `${FB_BASE}/v19.0/${act}/adsets`,
      JSON.stringify(adSetBody),
      {
        params: { access_token: token },
        headers: { "Content-Type": "application/json" },
      },
    );
    const adSetId = adSetRes.data.id; // {{223.id}} after ParseJSON
    console.log(`[demo-campaign] ✅ Ad set created: ${adSetId}`);

    // Modules 224–230: iterate over ads array (BasicFeeder)
    const adsArray = Array.isArray(ads) ? ads : [];
    for (let i = 0; i < adsArray.length; i++) {
      const ad = adsArray[i]; // {{224.*}}
      console.log(`[demo-campaign] 🎨 Processing ad ${i + 1}/${adsArray.length}: "${ad.headline}"`);

      // Module 225: GET image file
      let imageBuffer = null;
      let imageMimeType = "image/jpeg";
      if (ad.image_url) {
        try {
          const imgRes = await axios.get(ad.image_url, { responseType: "arraybuffer", timeout: 30000 });
          imageBuffer = Buffer.from(imgRes.data);
          imageMimeType = imgRes.headers["content-type"]?.split(";")[0] || "image/jpeg";
        } catch (e) {
          console.warn(`[demo-campaign] ⚠️  Image download failed for ad ${i + 1}: ${e.message}`);
        }
      }

      let imageHash = null;
      if (imageBuffer) {
        // Module 226: POST adimages (multipart, key = {{225.fileName}})
        const form = new FormData();
        form.append("new.jpg", imageBuffer, { filename: "new.jpg", contentType: imageMimeType });
        form.append("access_token", token);

        const imgUploadRes = await axios.post(
          `${FB_BASE}/v19.0/${act}/adimages`,
          form,
          { headers: form.getHeaders() },
        );
        // Module 227: ParseJSON → {{227.images.`new.jpg`.hash}}
        const images = imgUploadRes.data?.images || {};
        imageHash = Object.values(images)[0]?.hash || null;
        console.log(`[demo-campaign]  ↳ Image uploaded, hash: ${imageHash}`);
      }

      // Module 228: POST adcreatives
      // object_story_spec uses: page_id, message (newlines preserved), headline, name (description), image_hash, lead_gen_form_id ({{219.id_froma}})
      const objectStorySpec = {
        page_id,
        link_data: {
          link: LANDING_URL,
          message: (ad.message || "").replace(/\n/g, "\n"),
          name: ad.headline || "",
          description: ad.name || "",
          ...(imageHash ? { image_hash: imageHash } : {}),
          call_to_action: {
            type: "LEARN_MORE",
            ...(leadFormId ? { value: { lead_gen_form_id: leadFormId } } : {}),
          },
        },
      };

      const creativeFields = new URLSearchParams({
        name: ad.headline || `Creative ${i + 1}`,
        object_story_spec: JSON.stringify(objectStorySpec),
        access_token: token,
      });

      const creativeRes = await axios.post(
        `${FB_BASE}/${FB_VERSION}/${act}/adcreatives`,
        creativeFields.toString(),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
      );
      // Module 229: ParseJSON → {{229.id}}
      const creativeId = creativeRes.data.id;
      console.log(`[demo-campaign]  ↳ Creative created: ${creativeId}`);

      // Module 230: POST ads
      const adFields = new URLSearchParams({
        name: ad.headline || `Ad ${i + 1}`,
        adset_id: adSetId,
        creative: JSON.stringify({ creative_id: creativeId }),
        status: "PAUSED",
        access_token: token,
      });

      const adRes = await axios.post(
        `${FB_BASE}/v19.0/${act}/ads`,
        adFields.toString(),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
      );
      console.log(`[demo-campaign]  ↳ Ad created: ${adRes.data.id}`);
    }

    // Module 240: WebhookRespond with {{233.data}} (campaign creation response)
    console.log(`[demo-campaign] ✅ Done — campaign ${campaignId} with ${adsArray.length} ads`);
    return res.json(campaignData);

  } catch (err) {
    const fbError = err.response?.data?.error;
    console.error("[demo-campaign] ❌ Error:", fbError || err.message);
    return res.status(500).json({
      error: fbError?.message || err.message,
      fb_error: fbError || null,
    });
  }
};
