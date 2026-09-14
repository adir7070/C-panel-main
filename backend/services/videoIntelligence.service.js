/**
 * Video Intelligence Service — V2 Ad Creative Pipeline
 *
 * Extracts persuasion-level marketing intelligence from ad videos:
 *   1. Download video buffer (axios)
 *   2. Upload to Gemini Files API → visual analysis
 *   3. Upload to OpenAI Whisper → raw transcript
 *   4. Synthesize via GPT-4o-mini → unified creativeAnalysis (persuasion schema)
 *
 * Returns { creativeAnalysis, videoDebug, durationMs }
 * creativeAnalysis matches the same schema as image path (adCreativeV2.schema.js)
 */

const axios = require("axios");
const { GoogleGenAI } = require("@google/genai");
const { OpenAI } = require("openai");

const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_AI_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OpenAI_API_KEY });

const MAX_VIDEO_BYTES = 50 * 1024 * 1024; // 50MB hard cap
const DOWNLOAD_TIMEOUT_MS = 30_000;

// ─── Step 1: Download ─────────────────────────────────────────────────────────

async function downloadVideoBuffer(videoUrl) {
  const response = await axios.get(videoUrl, {
    responseType: "arraybuffer",
    timeout: DOWNLOAD_TIMEOUT_MS,
    maxContentLength: MAX_VIDEO_BYTES,
  });
  const buf = Buffer.from(response.data);
  const mimeType = response.headers["content-type"]?.split(";")[0] || "video/mp4";
  return { buf, mimeType };
}

// ─── Step 2: Visual Analysis via Gemini Files API ────────────────────────────

const GEMINI_VISION_PROMPT = `You are a senior Meta ads media buyer analyzing a video ad creative.

Return ONLY valid JSON. Focus on marketing signals, not generic description.

{
  "visualSummary": "2-3 sentence marketing summary of what this video communicates",
  "creativeStyle": "ugc|polished|talking_head|product_demo|before_after|lifestyle|animated",
  "hookType": "question|bold_statement|problem|shock|social_proof|curiosity|transformation",
  "detectedTextOverlays": ["array of any text visible in the video"],
  "emotionalSignals": ["emotions conveyed: urgency, trust, aspiration, fear, excitement, etc."],
  "productVisibility": "high|medium|low",
  "ctaVisible": true,
  "beforeAfterPresent": false,
  "luxuryVsCasual": "luxury|premium|mid|casual|ugc",
  "targetAudienceSignals": ["visual signals about who this ad targets"],
  "keyMarketingMoments": ["list of key moments: e.g. 'testimonial at 0:03', 'price reveal at 0:08'"],
  "setting": "where it happens / visual environment",
  "people": "who appears and what they seem to represent"
}`;

async function analyzeVideoWithGemini(buf, mimeType, log) {
  log.info({ step: "gemini_upload_start", sizeKb: Math.round(buf.length / 1024) });

  const uploadResponse = await ai.files.upload({
    file: new Blob([buf], { type: mimeType }),
    config: { mimeType, displayName: `ad-video-${Date.now()}` },
  });

  const fileUri = uploadResponse.uri;
  log.info({ step: "gemini_file_uploaded", fileUri: fileUri?.substring(0, 60) });

  let fileState = uploadResponse.state;
  let attempts = 0;
  while (fileState !== "ACTIVE" && attempts < 20) {
    await new Promise((r) => setTimeout(r, 3000));
    const fileInfo = await ai.files.get({ name: uploadResponse.name });
    fileState = fileInfo.state;
    attempts++;
    log.info({ step: "gemini_file_poll", state: fileState, attempt: attempts });
  }

  if (fileState !== "ACTIVE") {
    throw new Error(`Gemini file processing timed out (state: ${fileState})`);
  }

  const result = await ai.models.generateContent({
    model: "gemini-2.0-flash",
    contents: [
      {
        role: "user",
        parts: [
          { text: GEMINI_VISION_PROMPT },
          { fileData: { mimeType, fileUri } },
          { text: "Analyze this ad video and return the JSON." },
        ],
      },
    ],
    generationConfig: { responseMimeType: "application/json" },
  });

  const raw = result.candidates?.[0]?.content?.parts?.[0]?.text || "";
  log.info({ step: "gemini_upload_done", rawPreview: raw.substring(0, 150) });

  // Cleanup file from Gemini (async, don't await)
  ai.files.delete({ name: uploadResponse.name }).catch(() => {});

  return extractJsonFromModelText(raw, log);
}

function extractJsonFromModelText(text, log) {
  let cleaned = (text || "").trim();
  let hadMarkdownFence = false;
  if (cleaned.startsWith("```")) {
    hadMarkdownFence = true;
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  }
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end !== -1) cleaned = cleaned.substring(start, end + 1);
  log.info({ step: "gemini_json_extracted", hadMarkdownFence, chars: cleaned.length });
  return JSON.parse(cleaned);
}

// ─── Step 3: Transcription via OpenAI Whisper ────────────────────────────────

async function transcribeWithWhisper(buf, mimeType, log) {
  log.info({ step: "whisper_start", sizeKb: Math.round(buf.length / 1024) });

  const ext = mimeType.includes("mp4") ? "mp4" : mimeType.includes("mov") ? "mov" : "mp4";
  const file = new File([buf], `video.${ext}`, { type: mimeType });

  try {
    const transcription = await openai.audio.transcriptions.create({
      file,
      model: "whisper-1",
      language: "he",
      response_format: "text",
    });
    const rawTranscript = (transcription || "").trim();
    log.info({ step: "whisper_done", chars: rawTranscript.length, preview: rawTranscript.substring(0, 100) });
    return rawTranscript;
  } catch (err) {
    log.warn({ step: "whisper_done", event: "failed", error: err.message });
    return "";
  }
}

// ─── Step 3.5: Transcript cleanup + offer extraction ─────────────────────────

const CLEANUP_AND_OFFER_PROMPT = `אתה מומחה לתיקון שגיאות תמלול עברי ולחילוץ פרטי הצעות שיווקיות.

קיבלת תמליל גולמי מ-Whisper של וידאו מודעה בעברית, וניתוח ויזואלי מ-Gemini.

בצע שתי משימות:

משימה 1 — נקה את התמליל:
• תקן שגיאות תמלול נפוצות (החלפה פונטית, מספרים שגויים).
• דוגמאות: "גלידים" → "לידים", "מפצע" → "מבצע", "400 דברים ו-9 שקלים" → "449 שקלים".
• אל תנסח מחדש. שמור על מה שנאמר בדיוק.
• אם לא בטוח — השאר את המקור.

משימה 2 — חלץ פרטי ההצעה:
• חלץ פרטים קונקרטיים בלבד. אל תמציא.
• אם משהו לא ברור — השאר מחרוזת ריקה.
• includedItems: רשימה של כל פריט/שירות שהוזכר כחלק מהחבילה.
• price: המחיר המדויק כפי שנאמר (לא פרשנות).
• deadline: הביטוי המדויק של הדדליין (כגון "מחר זה נגמר").
• rawEvidence: ציטוטים ישירים מהתמליל שמוכיחים את ההצעה.

החזר JSON בלבד:
{
  "cleanedTranscript": "התמליל לאחר תיקון",
  "offerExtracted": {
    "mainOffer": "שם המוצר/שירות המדויק",
    "includedItems": ["פריט 1", "פריט 2"],
    "price": "מחיר מדויק או ריק",
    "deadline": "ביטוי דדליין מדויק או ריק",
    "targetCustomer": "למי זה מיועד",
    "primaryPromise": "התועלת/ההבטחה המרכזית",
    "ctaFromVideo": "ביטוי ה-CTA המדויק מהווידאו",
    "rawEvidence": ["ציטוט 1", "ציטוט 2", "ציטוט 3"]
  }
}`;

async function cleanupAndExtractOffer(rawTranscript, visualData, log) {
  if (!rawTranscript || rawTranscript.length < 5) {
    log.info({ step: "transcript_cleanup_skip", reason: "empty_transcript" });
    return {
      cleanedTranscript: rawTranscript || "",
      offerExtracted: {
        mainOffer: visualData?.visualSummary || "",
        includedItems: [],
        price: "",
        deadline: "",
        targetCustomer: "",
        primaryPromise: "",
        ctaFromVideo: "",
        rawEvidence: [],
      },
    };
  }

  log.info({ step: "transcript_cleanup_start", rawChars: rawTranscript.length });

  const userContent = [
    `GEMINI VISUAL ANALYSIS (for context):\n${JSON.stringify({ visualSummary: visualData?.visualSummary, creativeStyle: visualData?.creativeStyle, detectedTextOverlays: visualData?.detectedTextOverlays }, null, 2)}`,
    `\nRAW WHISPER TRANSCRIPT:\n${rawTranscript}`,
  ].join("\n");

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: CLEANUP_AND_OFFER_PROMPT },
      { role: "user", content: userContent },
    ],
    response_format: { type: "json_object" },
    max_tokens: 800,
  });

  const raw = completion.choices[0].message.content || "{}";
  const result = JSON.parse(raw);

  log.info({
    step: "transcript_cleanup_done",
    cleanedChars: result.cleanedTranscript?.length ?? 0,
    hasOffer: !!(result.offerExtracted?.mainOffer),
    includedItemsCount: result.offerExtracted?.includedItems?.length ?? 0,
    hasPrice: !!(result.offerExtracted?.price),
    hasDeadline: !!(result.offerExtracted?.deadline),
  });

  return {
    cleanedTranscript: result.cleanedTranscript || rawTranscript,
    offerExtracted: result.offerExtracted || { mainOffer: "", includedItems: [], price: "", deadline: "", targetCustomer: "", primaryPromise: "", ctaFromVideo: "", rawEvidence: [] },
  };
}

// ─── Step 4: Synthesize into unified persuasion schema ────────────────────────

const SYNTHESIS_SYSTEM_PROMPT = `אתה Senior Performance Creative Strategist. קיבלת ניתוח ויזואלי של וידאו מ-Gemini ותמליל מ-Whisper.

המשימה: לסנתז את שני המקורות לאינטליגנציה שיווקית עמוקה — לא לתאר, לחלץ שכנוע.

כללים:
1. החזר JSON תקין בלבד. כל ערכי הטקסט בעברית. Enum values באנגלית.
2. אל תהיה גנרי. אין "unknown" כשיש סיגנל ברור.
3. הסק פסיכולוגיה ספציפית מהסיגנלים — גם כשלא מפורש.
4. תמצת את התמליל — אל תעתיק. חלץ מסרים שיווקיים ממנו.

OUTPUT FORMAT:
{
  "creativeFormat": "video",
  "creativeArchetype": "ugc_testimonial|founder_story|product_showcase|before_after|problem_solution|offer_ad|authority_expert|lifestyle_aspiration|educational|unknown",

  "surface": {
    "visualSummary": "תיאור שיווקי קצר של מה שנראה ומה הוא מתקשר",
    "spokenSummary": "תמצית מה שנאמר בוידאו — מסרים מרכזיים בלבד",
    "onScreenText": ["טקסטים חשובים על מסך בלבד"],
    "visibleProductOrService": "מה המוצר/שירות הנראה",
    "setting": "איפה מצולם / הסביבה",
    "people": "מי מופיע ומה הם מייצגים"
  },

  "positioning": {
    "perceivedPriceLevel": "budget|mid|premium|luxury|unknown",
    "brandArchetype": "expert|friend|premium_authority|local_business|transformer|entertainer|caregiver|unknown",
    "communicationStyle": "soft|direct|aggressive|premium|educational|emotional|casual",
    "trustLevel": "low|medium|high",
    "reasonToBelieve": "ראיית האמינות העיקרית — מה גורם לאנשים להאמין"
  },

  "psychology": {
    "corePain": "הכאב הראשי הספציפי",
    "hiddenFear": "הפחד העמוק מאחורי הכאב",
    "mainFrustration": "התסכול היומיומי",
    "dreamOutcome": "מה הקהל ממש רוצה",
    "desiredIdentity": "מי הקהל רוצה להיות/להרגיש",
    "mainObjection": "מה יעצור אותם",
    "beliefShiftNeeded": "איזה אמונה צריכה להשתנות"
  },

  "conversionDrivers": {
    "primaryDriver": "fear|aspiration|status|convenience|trust|urgency|curiosity|relief|belonging|control",
    "secondaryDriver": "fear|aspiration|status|convenience|trust|urgency|curiosity|relief|belonging|control",
    "urgencyStrength": 1,
    "trustStrength": 1,
    "desireStrength": 1,
    "painIntensity": 1,
    "curiosityGap": "השאלה שמניעה להמשיך לקרוא"
  },

  "hookMechanism": {
    "type": "problem|question|bold_claim|contrarian|before_after|secret|mistake|social_proof|offer|story",
    "specificHookIdea": "רעיון הוק חד ספציפי לקופי",
    "scrollStopper": "הביטוי שיעצור את הגלילה"
  },

  "storyStructure": {
    "openingPattern": "איך הוידאו נפתח שיווקית",
    "conflict": "מה הקונפליקט",
    "turningPoint": "מה משתנה / הפתרון",
    "resolution": "איזו תוצאה מובטחת",
    "ctaTransition": "איך לעבור לפעולה"
  },

  "audience": {
    "specificAudience": "תיאור ספציפי בעברית של הקהל",
    "awarenessLevel": "unaware|problem_aware|solution_aware|product_aware|most_aware",
    "marketSophistication": "low|medium|high",
    "languageStyle": "simple|street|premium|professional|emotional|young|religious|local",
    "painPoints": ["כאבים ספציפיים שהוזכרו"],
    "desires": ["רצונות ספציפיים"],
    "objections": ["התנגדויות אפשריות"]
  },

  "copyGuidance": {
    "recommendedAngles": ["3-5 זוויות חדות"],
    "phrasesToUse": ["ביטויים שמדברים לקהל זה"],
    "phrasesToAvoid": ["ביטויים גנריים להימנע מהם"],
    "toneInstructions": "הוראות טון מדויקות",
    "ctaRecommendation": "ה-CTA הטוב ביותר"
  }
}

SCORING: 1=חלש מאוד | 5=בינוני | 10=חזק מאוד`;

async function synthesizeCreativeAnalysis(visualData, cleanedTranscript, log) {
  log.info({ step: "synthesis_start", hasTranscript: !!cleanedTranscript, transcriptLen: cleanedTranscript?.length ?? 0 });

  const userContent = [
    `GEMINI VISUAL ANALYSIS:\n${JSON.stringify(visualData, null, 2)}`,
    cleanedTranscript
      ? `\nTRANSCRIPT (cleaned, ${cleanedTranscript.length} chars):\n${cleanedTranscript.substring(0, 1200)}`
      : "\nNO TRANSCRIPT (silent video or transcription failed)",
    "\nSynthesize into the persuasion schema. Return JSON only.",
  ].join("\n");

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: SYNTHESIS_SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ],
    response_format: { type: "json_object" },
    max_tokens: 1500,
  });

  const raw = completion.choices[0].message.content || "{}";
  log.info({ step: "synthesis_done", rawPreview: raw.substring(0, 150) });

  return JSON.parse(raw);
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * @param {string} videoUrl
 * @param {Object} log - structured logger (createLogger instance)
 * @returns {Promise<{ creativeAnalysis: Object, offerExtracted: Object, cleanedTranscript: string, videoDebug: Object, durationMs: number }>}
 */
async function extractVideoIntelligence(videoUrl, log) {
  const start = Date.now();

  const videoDebug = {
    isVideo: true,
    sourceUrl: videoUrl,
    downloadOk: false,
    fileSizeMb: 0,
    mimeType: null,
    geminiStatus: "skipped",
    whisperStatus: "skipped",
    rawTranscript: "",
    cleanedTranscript: "",
    transcriptLength: 0,
    visualSummary: "",
    marketingUnderstanding: {},
  };

  log.info({ step: "video_download_start", videoUrl: videoUrl.substring(0, 80) });

  let buf, mimeType;
  try {
    ({ buf, mimeType } = await downloadVideoBuffer(videoUrl));
    videoDebug.downloadOk = true;
    videoDebug.fileSizeMb = Math.round((buf.length / (1024 * 1024)) * 100) / 100;
    videoDebug.mimeType = mimeType;
    log.info({ step: "video_download_done", fileSizeMb: videoDebug.fileSizeMb, mimeType });
  } catch (err) {
    log.error({ step: "video_download_done", error: err.message });
    const durationMs = Date.now() - start;
    return { creativeAnalysis: null, offerExtracted: null, cleanedTranscript: "", videoDebug, durationMs };
  }

  // Step 2+3 in parallel: Gemini visual analysis + Whisper transcription
  const [visualData, rawTranscript] = await Promise.all([
    analyzeVideoWithGemini(buf, mimeType, log)
      .then((result) => { videoDebug.geminiStatus = "success"; return result; })
      .catch((err) => {
        log.error({ step: "gemini_analysis_done", error: err.message });
        videoDebug.geminiStatus = "failed";
        return {};
      }),
    transcribeWithWhisper(buf, mimeType, log)
      .then((transcript) => {
        videoDebug.whisperStatus = "success";
        videoDebug.rawTranscript = transcript;
        videoDebug.transcriptLength = transcript.length;
        return transcript;
      })
      .catch((err) => {
        log.error({ step: "whisper_done", error: err.message });
        videoDebug.whisperStatus = "failed";
        return "";
      }),
  ]);

  log.info({ step: "av_analysis_done", geminiStatus: videoDebug.geminiStatus, whisperStatus: videoDebug.whisperStatus });

  // Step 3.5: Transcript cleanup + offer extraction (sequential — needs transcript)
  let cleanedTranscript = rawTranscript;
  let offerExtracted = null;
  try {
    const cleanupResult = await cleanupAndExtractOffer(rawTranscript, visualData, log);
    cleanedTranscript = cleanupResult.cleanedTranscript;
    offerExtracted = cleanupResult.offerExtracted;
    videoDebug.cleanedTranscript = cleanedTranscript;
  } catch (err) {
    log.error({ step: "transcript_cleanup_done", error: err.message });
    videoDebug.cleanedTranscript = rawTranscript;
  }

  // Step 4: Synthesize creativeAnalysis from visual + cleaned transcript
  let creativeAnalysis = null;
  try {
    creativeAnalysis = await synthesizeCreativeAnalysis(visualData, cleanedTranscript, log);
    creativeAnalysis.creativeFormat = "video";

    videoDebug.visualSummary = creativeAnalysis.surface?.visualSummary || "";
    videoDebug.marketingUnderstanding = {
      creativeArchetype: creativeAnalysis.creativeArchetype,
      corePain: creativeAnalysis.psychology?.corePain,
      dreamOutcome: creativeAnalysis.psychology?.dreamOutcome,
      primaryDriver: creativeAnalysis.conversionDrivers?.primaryDriver,
      painIntensity: creativeAnalysis.conversionDrivers?.painIntensity,
      desireStrength: creativeAnalysis.conversionDrivers?.desireStrength,
      specificHookIdea: creativeAnalysis.hookMechanism?.specificHookIdea,
      scrollStopper: creativeAnalysis.hookMechanism?.scrollStopper,
      spokenSummary: creativeAnalysis.surface?.spokenSummary,
      toneInstructions: creativeAnalysis.copyGuidance?.toneInstructions,
      recommendedAngles: creativeAnalysis.copyGuidance?.recommendedAngles,
    };
  } catch (err) {
    log.error({ step: "synthesis_done", error: err.message });
  }

  const durationMs = Date.now() - start;
  log.info({ step: "video_intelligence_done", durationMs, hasAnalysis: !!creativeAnalysis, hasOffer: !!offerExtracted?.mainOffer });

  return { creativeAnalysis, offerExtracted, cleanedTranscript, videoDebug, durationMs };
}

module.exports = { extractVideoIntelligence };
