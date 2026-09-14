const { DB } = require("../config/db");
const { OpenAI } = require("openai");
const { imageAgent } = require("../ai-agents/gemini");
const backblazeService = require("./backblaze.service");

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OpenAI_API_KEY,
});

/**
 * Main background processing function for ad creative generation
 * @param {string} jobId - Unique job identifier
 * @param {Object} inputData - Input data containing all creative parameters
 * @param {string} baseUrl - Base URL for image access (e.g., http://localhost:3900 or https://api.iconiqmedia.co.il)
 */
exports.processAdCreativeJob = async (jobId, inputData, baseUrl) => {
  try {
    const { service, phone } = inputData;

    console.log(`[AdCreative] Processing job ${jobId} for service: ${service}`);

    // Update status to processing
    await DB.collection("ad_creative_jobs").updateOne(
      { jobId },
      {
        $set: {
          status: false, // still not finished
          statusType: "processing",
          updatedAt: new Date(),
        },
      },
    );

    // Step 1: Generate 6 ad creatives with OpenAI
    const creatives = await generateAdCreativesWithOpenAI(inputData);

    console.log(
      `[AdCreative] Generated ${creatives.length} creatives with OpenAI`,
    );

    // Step 2: Generate images for each creative and upload to B2
    const results = [];
    for (let i = 0; i < creatives.length; i++) {
      const creative = creatives[i];
      console.log(`[AdCreative] Generating image ${i + 1}/${creatives.length}`);

      try {
        // Generate image with Gemini using the existing imageAgent
        const imageResult = await imageAgent.generate(creative.promt);

        // Upload to Backblaze B2
        const timestamp = Date.now();
        const filename = `${timestamp}-${i}.png`;
        const fullPath = `post/${phone}/${filename}`;

        const uploadResult = await backblazeService.uploadImage(
          fullPath,
          imageResult.buffer,
          "image/png",
        );

        console.log(
          `[AdCreative] Uploaded image ${i + 1} to B2: ${uploadResult.publicUrl}`,
        );

        // Build image URL through our server instead of direct B2 URL
        const imageUrl = `${baseUrl}/api/img/${fullPath}`;

        // Add to results
        results.push({
          url: imageUrl,
          desc: creative.desc,
        });
      } catch (imageError) {
        console.error(
          `[AdCreative] Error generating/uploading image ${i + 1}:`,
          imageError,
        );
        // Continue with other images even if one fails
        results.push({
          url: null,
          desc: creative.desc,
          error: imageError.message,
        });
      }
    }

    // Step 3: Update job status to completed
    await DB.collection("ad_creative_jobs").updateOne(
      { jobId },
      {
        $set: {
          status: true, // finished
          statusType: "completed",
          data: results,
          updatedAt: new Date(),
        },
      },
    );

    console.log(
      `[AdCreative] Job ${jobId} completed with ${results.length} results`,
    );
  } catch (error) {
    console.error(`[AdCreative] Job ${jobId} failed:`, error);

    // Update job status to failed
    await DB.collection("ad_creative_jobs").updateOne(
      { jobId },
      {
        $set: {
          status: true, // finished (even though failed)
          statusType: "failed",
          error: error.message,
          updatedAt: new Date(),
        },
      },
    );
  }
};

/**
 * Generate 6 ad creatives using OpenAI GPT
 * @param {Object} inputData - All creative parameters
 * @returns {Promise<Array>} Array of 6 objects with promt and desc fields
 */
/**
 * Helper: Extract creatives array from OpenAI response
 */
function extractCreativesArray(parsed) {
  // Try common key names
  const possibleKeys = [
    "creatives",
    "data",
    "ads",
    "results",
    "items",
    "posts",
  ];

  // First, check if it's already an array
  if (Array.isArray(parsed)) {
    return parsed;
  }

  // Check known keys
  for (const key of possibleKeys) {
    if (parsed[key] && Array.isArray(parsed[key])) {
      return parsed[key];
    }
  }

  // Try to find any array in the response
  const values = Object.values(parsed);
  const firstArray = values.find((v) => Array.isArray(v));
  if (firstArray) {
    return firstArray;
  }

  return null;
}

/**
 * Helper: Validate creative object structure
 */
function validateCreative(creative, index) {
  if (!creative.promt || typeof creative.promt !== "string") {
    throw new Error(`Creative ${index + 1}: missing or invalid 'promt' field`);
  }
  if (!creative.desc || typeof creative.desc !== "string") {
    throw new Error(`Creative ${index + 1}: missing or invalid 'desc' field`);
  }
  return true;
}

async function generateAdCreativesWithOpenAI(inputData) {
  const systemPrompt = `אתה Creative Ads Designer למודעות ממומנות בפייסבוק ואינסטגרם העובד עם מודל Nano Banana

בכל ריצה אתה מקבל שאלות ותשובות מובנות על שירות אחד בלבד

המטרה שלך היא להחזיר JSON עם מערך בשם creatives
המערך חייב להכיל בדיוק 6 אובייקטים

כל אובייקט במערך חייב להכיל שני שדות בלבד
promt
desc

━━━━━━━━━━
כללי פלט מחייבים
━━━━━━━━━━

הפלט חייב להיות JSON תקני בלבד
ללא טקסט לפני או אחרי
ללא הסברים
ללא הערות

━━━━━━━━━━
promt
━━━━━━━━━━

promt
חייב להיות
באנגלית בלבד
בשורה אחת בלבד

הוא מיועד למודל Nano Banana
וצריך לייצר תמונת מודעה בגודל 1080x1080

המודעה חייבת לכלול
טקסט בעברית RTL
מינימום מלל
מסר מרכזי אחד בלבד
כותרת קצרה ועוצרת גלילה

הכותרת חייבת להיות האלמנט החזותי הדומיננטי ביותר
טיפוגרפיה עברית מודרנית ונקייה
משקל גופן כבד
ניגודיות גבוהה
ריווח מושלם
פריסת RTL מדויקת

ללא סימני פיסוק
ללא אימוגים
ללא עומס טקסט

העיצוב חייב להיות
מאוד יפה
מאוד מוקפד
מאוד מסחרי
מאוד אינסטגרמי
ריאליסטי ועדכני

כל תמונה חייבת להיות שונה ויזואלית וברעיון שלה
זווית אחרת
תחושה אחרת
קומפוזיציה אחרת

אך כולן חייבות להרגיש שייכות לאותו קמפיין ולאותו אד סט

דיוק נושאי מוחלט
אם מדובר בישראל אז רק ישראל
אם מדובר במיקום אז רק מיקום רלוונטי
אם מדובר בשירות אז רק סצנות אמיתיות מהעולם האמיתי
לעולם אין לערבב אלמנטים לא קשורים

אם קיימת כתובת עסק פיזית
יש לשלב אותה בתחתית המודעה בצורה טבעית ועדינה

יש למקם לוגו פעם אחת בלבד
לא דומיננטי
עדיפות לפינה עליונה או תחתונה

יש להציג CTA ככפתור ברור
עם ניגודיות חזקה
ללא סמלים
וללא אימוגים

━━━━━━━━━━
desc
━━━━━━━━━━

desc
חייב להיות בעברית
קצר
ברור
ומשלים את התמונה

אסור לו לחזור על הטקסט שמופיע בתמונה
הוא חייב להעמיק או לחדד את המסר
ולגרום לרצון לפעול

━━━━━━━━━━
איסורים מוחלטים
━━━━━━━━━━

אין תיבות
אין רשימות
אין מספור
אין מירכאות
אין גרש
אין קו נטוי

━━━━━━━━━━
סיכום מטרה
━━━━━━━━━━

הפלט הוא
מערך JSON עם 6 אובייקטים
כל אובייקט מייצג מודעה אחת
6 תמונות וואו
מינימום מלל
מקסימום רגש ועיצוב
קריאייטיב שנראה יקר מקצועי וממיר

חובת מבנה הפלט (קריטי)

הפלט שאתה מחזיר חייב להיות אך ורק במבנה הבא
בדיוק כך
ללא שינוי שמות
ללא הוספת שדות

המבנה היחיד המותר הוא json כזה של ה

{
  "creatives": [
    {
      "promt": "string",
      "desc": "string"
    },
    {
      "promt": "string",
      "desc": "string"
    },
    {
      "promt": "string",
      "desc": "string"
    },
    {
      "promt": "string",
      "desc": "string"
    },
    {
      "promt": "string",
      "desc": "string"
    },
    {
      "promt": "string",
      "desc": "string"
    }
  ]
}`;

  const {
    service,
    targetAudience,
    painPoint,
    result,
    differentiator,
    visualStyle,
    brandColors,
    promotions,
    businessAddress,
    callToActionType,
  } = inputData;

  // Build JSON string with all available fields
  const dataObject = {
    service: service || "",
    targetAudience: targetAudience || "",
    painPoint: painPoint || "",
    result: result || "",
    differentiator: differentiator || "",
    visualStyle: visualStyle || [],
    brandColors: brandColors || "",
    promotions: promotions || "",
    businessAddress: businessAddress || "",
    callToActionType: callToActionType || "",
  };

  const userPrompt = `זה הגגיסון של השאלות והתשובות
${JSON.stringify(dataObject, null, 2)}`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o", // Using the latest GPT-4 model
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    response_format: { type: "json_object" },
    temperature: 0.8,
  });

  const content = completion.choices[0].message.content;
  if (!content) {
    throw new Error("Empty response from OpenAI");
  }

  // Parse the response using helper function
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (parseError) {
    console.error("[AdCreative] Failed to parse OpenAI response:", content);
    throw new Error(`Failed to parse OpenAI response: ${parseError.message}`);
  }

  // Debug: Log the parsed structure
  console.log(
    "[AdCreative] OpenAI response structure:",
    JSON.stringify(parsed, null, 2).substring(0, 500),
  );

  // Extract creatives array using helper function
  const creatives = extractCreativesArray(parsed);

  if (!creatives) {
    console.error(
      "[AdCreative] Could not find array in response. Keys:",
      Object.keys(parsed),
    );
    console.error(
      "[AdCreative] Full response:",
      JSON.stringify(parsed, null, 2),
    );
    throw new Error(
      "OpenAI response does not contain a valid array of creatives",
    );
  }

  // Validate we have exactly 6 creatives
  if (creatives.length !== 6) {
    console.warn(
      `[AdCreative] Expected 6 creatives but got ${creatives.length}`,
    );
  }

  if (creatives.length === 0) {
    throw new Error("OpenAI returned an empty array of creatives");
  }

  // Validate each creative using helper function
  for (let i = 0; i < creatives.length; i++) {
    validateCreative(creatives[i], i);
  }

  console.log(`[AdCreative] Successfully validated ${creatives.length} creatives`);
  return creatives;
}

// Note: processAdCreativeJob is already exported via exports.processAdCreativeJob above
// Only export internal helper functions here if needed
module.exports.generateAdCreativesWithOpenAI = generateAdCreativesWithOpenAI;
