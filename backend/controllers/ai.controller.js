const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DB } = require("../config/db");
const generateImage = require("../utils/generateImage");
const axios = require("axios");
const googleAIConfig = require("../config/google-ai.config");
const { textAgent, imageAgent } = require("../ai-agents/gemini");
const prompts = require("../utils/aiSystemPrompt.json");
const backblazeService = require("../services/backblaze.service");
const aiService = require("../services/ai.service");
const extractSiteContent = require("../utils/extractSiteContent");
const { SYSTEM_PROMPT: ASSISTANT_SYSTEM_PROMPT } = require("../utils/prompts/ai-questions-assistant");
const { SYSTEM_PROMPT: LOGO_SYSTEM_PROMPT } = require("../utils/prompts/ai-questions-logo");

const SERVER_BASE_URL_AI = process.env.BASE_URL || "https://api.iconiqmedia.co.il";
const { log } = require("console");

/**
 * יצירת הודעת WhatsApp ראשונה ללקוח מנתוני Lead
 * תומך בנתונים מ-Facebook Leads API
 * @route POST /api/ai/whatsapp-lead-message
 */
exports.generateWhatsAppLeadMessage = async (req, res) => {
  try {
    const { lead_id, name, phone, answers = {}, field_data = [] } = req.body;

    // Validate required fields
    if (!name || !phone) {
      return res.status(400).json({
        error: "Missing required fields: name and phone",
      });
    }

    // Parse field_data into a more usable format
    const formattedFields = {};
    if (Array.isArray(field_data)) {
      field_data.forEach((field) => {
        formattedFields[field.name] = field.values?.[0] || "";
      });
    }

    // Extract campaign and ad info from answers or request
    const campaignName =
      answers?.campaign_name || req.body?.campaign_name || "קמפיין";
    const adName = answers?.ad_name || req.body?.ad_name || "";
    const city = formattedFields?.city || "";
    const service =
      formattedFields?.["איזה_שירות_אתם_צריכים_כרגע?"] ||
      formattedFields?.service ||
      "";

    // הכנת הפרומפט מהקובץ
    const systemPrompt = prompts.gemini.whatsapp_lead_first_message_prompt;

    // בניית ה-input המלא עם כל המידע
    const enrichedData = {
      name,
      phone,
      city,
      service,
      campaign: campaignName,
      ad: adName,
      lead_id,
      timestamp: answers?.created_time || new Date().toISOString(),
    };

    const userInput = JSON.stringify(enrichedData, null, 2);
    const fullPrompt = systemPrompt.replace("{{`1`}}", userInput);

    // שימוש בסוכן הטקסט
    const result = await textAgent.generate(fullPrompt, {
      temperature: 0.8,
      maxTokens: 500,
    });

    // Save to database
    try {
      // Save lead info
      const leadData = {
        lead_id: lead_id || `lead-${Date.now()}`,
        name,
        phone,
        city,
        service,
        campaign: campaignName,
        ad: adName,
        answers,
        field_data: formattedFields,
        whatsapp_message: result.text,
        created_at: new Date(),
        status: "pending",
      };

      await DB.collection("leads").insertOne(leadData);

      // Save to customers collection (dedicated customer database)
      const customerData = {
        lead_id: lead_id || `lead-${Date.now()}`,
        name,
        phone,
        email: formattedFields?.email || "", // if available
        city,
        service,
        campaign: campaignName,
        ad: adName,
        source: "facebook_leads",
        contact_info: {
          phone,
          email: formattedFields?.email || null,
          city,
        },
        preferences: {
          service_needed: service,
          campaign_source: campaignName,
        },
        interaction: {
          whatsapp_message_sent: result.text,
          first_contact_at: new Date(),
          status: "first_contact_sent",
        },
        metadata: answers,
        created_at: new Date(),
        updated_at: new Date(),
      };

      await DB.collection("customers").insertOne(customerData);

      // Also upsert user in users collection
      await DB.collection("users").updateOne(
        { phone },
        {
          $set: {
            name,
            phone,
            lead_id: lead_id || `lead-${Date.now()}`,
            city,
            service,
            campaign: campaignName,
            updated_at: new Date(),
          },
          $setOnInsert: {
            created_at: new Date(),
          },
        },
        { upsert: true },
      );
    } catch (dbError) {
      console.error("Database save error:", dbError.message);
      // Continue even if DB save fails
    }

    // Send WhatsApp message
    let whatsappSent = false;
    let whatsappError = null;
    try {
      const greenAPIService = require("../services/greenapi.service");
      await greenAPIService.sendMessage(phone, result.text);
      whatsappSent = true;
      console.log(`✅ WhatsApp message sent to ${phone}`);

      // Update lead status to 'sent'
      try {
        await DB.collection("leads").updateOne(
          { lead_id: lead_id || `lead-${Date.now()}` },
          { $set: { status: "sent", sent_at: new Date() } },
        );
      } catch (updateError) {
        console.error("Failed to update lead status:", updateError.message);
      }
    } catch (smsError) {
      console.error("❌ Failed to send WhatsApp message:", smsError.message);
      whatsappError = smsError.message;
    }

    return res.status(200).json({
      success: true,
      message: result.text,
      whatsappSent,
      whatsappError: whatsappError || null,
      leadData: {
        lead_id: lead_id || `lead-${Date.now()}`,
        name,
        phone,
        city,
        service,
        campaign: campaignName,
        ad: adName,
      },
      tokensUsed: result.tokensUsed,
    });
  } catch (error) {
    console.error("Error generating WhatsApp message:", error);
    return res.status(500).json({
      error: "Server Error",
      message: error.message,
    });
  }
};

/**
 * יצירת הודעת WhatsApp לליד - ללא שליחה
 * מקבל נתוני ליד ומחזיר את ההודעה שנוצרה בלבד
 * @route POST /api/ai/lead-message
 */
exports.generateLeadMessage = async (req, res) => {
  try {
    const {
      name,
      phone,
      email,
      created_at_iso,
      campaign_title,
      adset_title,
      ad_title,
      answers = [],
    } = req.body;

    if (!name || !phone) {
      return res.status(400).json({
        error: "Missing required fields: name and phone",
      });
    }

    const leadInput = JSON.stringify(
      {
        name,
        phone,
        email,
        created_at_iso,
        campaign_title,
        adset_title,
        ad_title,
        answers,
      },
      null,
      2,
    );

    const systemPrompt = prompts.gemini.whatsapp_lead_first_message_prompt;
    const fullPrompt = systemPrompt.replace("{{`1`}}", leadInput);

    const result = await textAgent.generate(fullPrompt, {
      temperature: 0.8,
      maxTokens: 500,
    });

    return res.status(200).json({
      success: true,
      message: result.text,
    });
  } catch (error) {
    console.error("Error generating lead message:", error);
    return res.status(500).json({
      error: "Server Error",
      message: error.message,
    });
  }
};

/**
 * יצירת תוכן טקסטואלי כללי
 * @route POST /api/ai/generate-text
 */
exports.generateText = async (req, res) => {
  try {
    const { prompt, temperature = 0.7, maxTokens = 1024 } = req.body;

    if (!prompt) {
      return res.status(400).json({
        error: "Missing required field: prompt",
      });
    }

    const result = await textAgent.generate(prompt, {
      temperature,
      maxTokens,
    });

    return res.status(200).json({
      success: true,
      text: result.text,
      tokensUsed: result.tokensUsed,
      prompt: result.prompt,
    });
  } catch (error) {
    console.error("Error generating text:", error);
    return res.status(500).json({
      error: "Server Error",
      message: error.message,
    });
  }
};

/**
 * צ'אט עם AI
 * @route POST /api/ai/chat
 */
exports.chat = async (req, res) => {
  try {
    const { message, history = [] } = req.body;

    if (!message) {
      return res.status(400).json({
        error: "Missing required field: message",
      });
    }

    const result = await textAgent.chat(message, history);

    return res.status(200).json({
      success: true,
      response: result.text,
      role: result.role,
    });
  } catch (error) {
    console.error("Error in chat:", error);
    return res.status(500).json({
      error: "Server Error",
      message: error.message,
    });
  }
};

/**
 * חישוב מחיר תמונה על בסיס פרמטרים
 */
const calculatePrice = (params) => {
  const {
    basePrice = 100,
    quantity = 1,
    premium = false,
    customMultiplier = 1,
  } = params;

  let price = basePrice * quantity * customMultiplier;

  if (premium) {
    price *= 1.5;
  }

  return Math.round(price * 100) / 100;
};

/**
 * שליחת webhook עם מידע על התמונה שנוצרה
 */
const sendWebhook = async (imageData) => {
  if (!googleAIConfig.webhookUrl) return { success: false, error: "webhook_not_configured" };
  try {
    const response = await axios.post(googleAIConfig.webhookUrl, imageData);
    return { success: true, data: response.data };
  } catch (error) {
    console.error("Webhook error:", error.message);
    return { success: false, error: error.message };
  }
};

/**
 * ניקוי ערך לשימוש ב-HTTP header - מסיר תווים לא חוקיים
 */
const sanitizeHeaderValue = (value) => {
  if (!value) return "";
  return String(value)
    .replace(/[\x00-\x1F\x7F-\x9F]/g, " ") // הסרת כל תווי הבקרה
    .replace(/[^\x20-\x7E ]/g, "") // הסרת תווים לא-ASCII
    .replace(/\s+/g, " ") // איחוד רווחים מרובים לרווח בודד
    .trim()
    .substring(0, 200); // הגבלת אורך ל-200 תווים
};

/**
 * יצירת תמונה חדשה - מחזיר את התמונה ישירות
 * @route POST /api/ai/images/create
 */
exports.createImage = async (req, res) => {
  console.log("createImage");

  try {
    const {
      description,
      name,
      params = {},
      prompt = "",
      saveToFile = false,
      site,
    } = req.body;

    if (!description) {
      return res.status(400).json({
        error: "Missing required field: description",
      });
    }

    const siteContext = site ? await extractSiteContent(site) : "";
    const enrichedPrompt = siteContext
      ? `${prompt}\n\nהקשר מאתר העסק:\n${siteContext}`
      : prompt;

    const imageResult = await generateImage(description, enrichedPrompt);

    let savedFile = null;
    if (saveToFile) {
      const imagesDir = path.join(__dirname, "..", "generated-images");
      if (!fs.existsSync(imagesDir)) {
        fs.mkdirSync(imagesDir, { recursive: true });
      }

      const filename = `${Date.now()}-${description
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "-")
        .substring(0, 50)}.png`;
      const filepath = path.join(imagesDir, filename);
      fs.writeFileSync(filepath, imageResult.image.buffer);

      savedFile = { filename, filepath };
    }

    const price = calculatePrice(params);

    const imageData = {
      name: name || "Generated Image",
      description,
      price,
      imageText: imageResult.text,
      prompt: imageResult.prompt,
      params,
      createdAt: new Date().toISOString(),
    };

    const webhookResult = await sendWebhook(imageData);

    res.set({
      "Content-Type": "image/png",
      "Content-Length": imageResult.image.size,
      "X-Image-Name": sanitizeHeaderValue(name || "Generated Image"),
      "X-Image-Price": price.toString(),
      "X-Image-Description": sanitizeHeaderValue(description),
      "X-Webhook-Status": webhookResult.success ? "success" : "failed",
    });

    return res.status(201).send(imageResult.image.buffer);
  } catch (error) {
    console.error("Error creating image:", error);
    return res.status(500).json({
      error: "Server Error",
      message: error.message,
    });
  }
};

/**
 * יצירת תמונה - מחזיר JSON עם מטא-דאטה ותמונה בפורמט base64
 * @route POST /api/ai/images/create-with-metadata
 */
exports.createImageWithMetadata = async (req, res) => {
  try {
    const {
      description,
      name,
      params = {},
      prompt = "",
      saveToFile = false,
      site,
    } = req.body;

    if (!description) {
      return res.status(400).json({
        error: "Missing required field: description",
      });
    }

    const siteContext = site ? await extractSiteContent(site) : "";
    const enrichedPrompt = siteContext
      ? `${prompt}\n\nהקשר מאתר העסק:\n${siteContext}`
      : prompt;

    const imageResult = await generateImage(description, enrichedPrompt);

    let savedFile = null;
    if (saveToFile) {
      const imagesDir = path.join(__dirname, "..", "generated-images");
      if (!fs.existsSync(imagesDir)) {
        fs.mkdirSync(imagesDir, { recursive: true });
      }

      const filename = `${Date.now()}-${description
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "-")
        .substring(0, 50)}.png`;
      const filepath = path.join(imagesDir, filename);
      fs.writeFileSync(filepath, imageResult.image.buffer);

      savedFile = { filename, filepath };
    }

    const price = calculatePrice(params);

    const imageData = {
      name: name || "Generated Image",
      description,
      price,
      image: imageResult.image.base64,
      imageSize: imageResult.image.size,
      imageMimeType: imageResult.image.mimeType,
      savedFile: savedFile,
      imageText: imageResult.text,
      prompt: imageResult.prompt,
      params,
      createdAt: new Date().toISOString(),
    };

    const webhookResult = await sendWebhook(imageData);

    return res.status(201).json({
      success: true,
      image: imageData,
      webhook: webhookResult,
      message: "Image created successfully",
    });
  } catch (error) {
    console.error("Error creating image:", error);
    return res.status(500).json({
      error: "Server Error",
      message: error.message,
    });
  }
};

/**
 * קבלת רשימת תמונות שנוצרו
 * @route GET /api/ai/images
 */
exports.getImages = async (req, res) => {
  try {
    const fs = require("fs");
    const path = require("path");

    const imagesDir = path.join(__dirname, "..", "generated-images");

    if (!fs.existsSync(imagesDir)) {
      return res.json({ images: [] });
    }

    const files = fs.readdirSync(imagesDir);
    const images = files.map((file) => ({
      filename: file,
      filepath: path.join(imagesDir, file),
      createdAt: fs.statSync(path.join(imagesDir, file)).birthtime,
    }));

    return res.json({ images });
  } catch (error) {
    console.error("Error getting images:", error);
    return res.status(500).json({ error: "Server Error" });
  }
};

async function processImageBatch(jobId, qaPairs, siteContext = "") {
  try {
    const siteSection = siteContext
      ? `\n\n    Business website context (use to align style and tone):\n    ${siteContext}`
      : "";

    // 1. Create a prompt for the text agent to generate image prompts
    const systemPrompt = `You are an expert creative assistant. Your task is to transform a list of question-and-answer pairs into a series of creative prompts for an AI image generator.

    For each Q&A pair, you will generate a corresponding object with two fields:
    1.  "image_prompt": A detailed, artistic, and descriptive prompt suitable for a model like DALL-E 3 or Midjourney. This should capture the essence of the Q&A.
    2.  "description": A short, user-friendly description of the resulting image concept.

    You must respond ONLY with a valid JSON array of these objects. Do not include any other text, explanations, or markdown formatting.${siteSection}

    Now, process the following data:
    ${JSON.stringify(qaPairs, null, 2)}
    `;

    // 2. Generate the structured data (prompts and descriptions)
    const textResult = await textAgent.generate(systemPrompt, {
      temperature: 0.7,
      maxTokens: 2048,
    });

    let imageTasks;
    try {
      // The model might return the JSON inside a markdown block
      const cleanedJsonString = textResult.text
        .replace(/```json\n|```/g, "")
        .trim();
      imageTasks = JSON.parse(cleanedJsonString);
      if (!Array.isArray(imageTasks)) {
        throw new Error("AI did not return a valid JSON array.");
      }
    } catch (parseError) {
      console.error("Failed to parse text agent response:", textResult.text);
      throw new Error(
        `Failed to parse AI response for prompts. Error: ${parseError.message}`,
      );
    }

    // 3. Generate images for each task
    const imageGenerationPromises = imageTasks.map(async (task) => {
      if (!task.image_prompt || !task.description) {
        console.warn("Skipping invalid task from text agent:", task);
        return null; // Or some error object
      }
      const imageResult = await imageAgent.generate(task.image_prompt);
      return {
        description: task.description,
        image_base64: imageResult.base64,
        mime_type: imageResult.mimeType,
      };
    });

    const finalResults = (await Promise.all(imageGenerationPromises)).filter(
      (r) => r !== null,
    );

    // 4. Update the job in the database as completed
    await DB.collection("image_batch_jobs").updateOne(
      { jobId },
      {
        $set: {
          status: "completed",
          result: finalResults,
          updatedAt: new Date(),
        },
      },
    );
    console.log(`✅ Job ${jobId} completed successfully.`);
  } catch (error) {
    console.error(`❌ Error processing job ${jobId}:`, error);
    // Update the job as failed
    await DB.collection("image_batch_jobs").updateOne(
      { jobId },
      {
        $set: {
          status: "failed",
          error: error.message,
          updatedAt: new Date(),
        },
      },
    );
  }
}

/**
 * יצירת Job ליצירת תמונות על בסיס שאלות ותשובות
 * @route POST /api/ai/image-batch/create
 */
exports.createImageBatchJob = async (req, res) => {
  try {
    // Support both: raw array (legacy) or { answers: [...], site: "..." }
    let qaPairs, site;
    if (Array.isArray(req.body)) {
      qaPairs = req.body;
      site = null;
    } else {
      qaPairs = req.body.answers || req.body.qaPairs;
      site = req.body.site || null;
    }

    if (!Array.isArray(qaPairs) || qaPairs.length === 0) {
      return res.status(400).json({
        error:
          "Request body must be a non-empty array of question/answer objects.",
      });
    }

    for (const item of qaPairs) {
      if (!item.question || !item.answer) {
        return res.status(400).json({
          error:
            "Each object in the array must have 'question' and 'answer' properties.",
        });
      }
    }

    const siteContext = site ? await extractSiteContent(site) : "";

    const jobId = crypto.randomBytes(16).toString("hex");

    await DB.collection("image_batch_jobs").insertOne({
      jobId,
      status: "pending",
      createdAt: new Date(),
      updatedAt: new Date(),
      input: qaPairs,
    });

    processImageBatch(jobId, qaPairs, siteContext);

    return res.status(202).json({
      message: "Job accepted for processing.",
      jobId: jobId,
      statusUrl: `/api/ai/image-batch/status/${jobId}`,
    });
  } catch (error) {
    console.error("Error creating image batch job:", error);
    return res
      .status(500)
      .json({ error: "Server Error", message: error.message });
  }
};

/**
 * קבלת סטטוס ותוצאה של Job
 * @route GET /api/ai/image-batch/status/:jobId
 */
exports.getImageBatchJobStatus = async (req, res) => {
  try {
    const { jobId } = req.params;

    if (!jobId) {
      return res.status(400).json({ error: "Job ID is required." });
    }

    const job = await DB.collection("image_batch_jobs").findOne(
      { jobId },
      { projection: { input: 0 } },
    );

    if (!job) {
      return res.status(404).json({ error: "Job not found." });
    }

    return res.status(200).json(job);
  } catch (error) {
    console.error("Error getting job status:", error);
    return res
      .status(500)
      .json({ error: "Server Error", message: error.message });
  }
};

/**
 * Generate Ad Creative (without Image)
 * @route POST /api/ai/ad-creative/generate
 * @description Creates a job to generate 6 ad creatives with images
 */
exports.generateAdCreative = async (req, res) => {
  try {
    const { phone, token, actId, payload, isDemo, imageUrl, site } = req.body;

    console.log("[generateAdCreative] 📨 Incoming request:", {
      phone: phone || "⚠️ missing",
      hasToken: !!token,
      actId: actId || "⚠️ missing",
      isDemo: isDemo ?? false,
      service: payload?.service || "⚠️ missing",
      goal: payload?.goal || "",
      hasSite: !!site,
      hasImageUrl: !!imageUrl,
    });

    const siteContext = site ? await extractSiteContent(site) : "";

    // --- DEMO MODE BRANCH ---
    if (isDemo === true) {
      if (!payload) {
        return res.status(400).json({ error: "Missing payload object" });
      }
      console.log("🧪 [generateAdCreative] Demo mode: skipping Facebook logic");
      const aiService = require("../services/ai.service");
      const result = await aiService.generateDemoAdCopy(
        payload,
        imageUrl || null,
        siteContext,
      );
      return res.status(200).json({
        title: result.title || "",
        body: result.body || "",
        description: result.description || "",
      });
    }
    // --- END DEMO MODE BRANCH ---

    if (!payload) {
      return res.status(400).json({ error: "Missing payload object" });
    }

    const { service, goal } = payload;

    if (!service || !phone) {
      console.error("[generateAdCreative] ❌ Missing service or phone:", { service, phone });
      return res.status(400).json({
        error: "Missing required fields",
        required: ["service", "phone"],
      });
    }

    if (!token || !actId) {
      console.error("[generateAdCreative] ❌ Missing token or actId:", { hasToken: !!token, actId });
      return res.status(400).json({
        error: "Missing required fields",
        required: ["token", "actId"],
      });
    }

    console.log("[generateAdCreative] 📡 Fetching ads from Facebook for actId:", actId);
    const facebookService = require("../services/facebook.service");
    const ads = await facebookService.getAds(actId, token);
    console.log(`[generateAdCreative] ✅ Fetched ${ads.length} ads from Facebook`);

    if (!ads || ads.length === 0) {
      return res.status(404).json({ error: "No ads found for this account" });
    }

    const adsWithCreative = ads.filter((ad) => ad?.creative?.object_story_spec);
    console.log(`   → ${adsWithCreative.length} ads with creative`);

    const adsWithInsights = await Promise.all(
      adsWithCreative.map(async (ad) => {
        const insights = await facebookService.getInsights(ad.id, token).catch(() => null);
        return { ...ad, insights: insights || {} };
      }),
    );

    const adScoring = require("../utils/adScoring");
    const adsWithScores = adsWithInsights.map((ad) => {
      const adData = {
        ...ad,
        impressions: ad.insights?.impressions || 0,
        spend: ad.insights?.spend || 0,
        clicks: ad.insights?.clicks || 0,
        inline_link_clicks: ad.insights?.inline_link_clicks || 0,
        actions: ad.insights?.actions || [],
        quality_ranking: ad.insights?.quality_ranking || "UNKNOWN",
      };
      return { ...adData, score: adScoring.scoreAd(adData, 20) };
    });

    const filteredAds = adsWithScores.filter((ad) => ad.score >= 60);
    const sortedAds = [...adsWithScores].sort((a, b) => b.score - a.score);
    const top3Ads =
      filteredAds.length >= 3
        ? filteredAds.sort((a, b) => b.score - a.score).slice(0, 3)
        : sortedAds.slice(0, 3);

    console.log(
      `✅ Top ${top3Ads.length} ads (${filteredAds.length} met score ≥ 60):`,
      top3Ads.map((a) => `${a.id}:${a.score}`).join(", "),
    );

    const aiService = require("../services/ai.service");
    const prompts = require("../utils/adCopyPrompts");

    const jobData = {
      service,
      goal: goal || "",
      adsJson: top3Ads.map((ad) => ({
        id: ad.id,
        name: ad.name,
        score: ad.score,
        creative: ad.creative || {},
        insights: {
          impressions: ad.impressions,
          spend: ad.spend,
          clicks: ad.clicks,
          inline_link_clicks: ad.inline_link_clicks,
          quality_ranking: ad.quality_ranking,
        },
      })),
    };

    let adCreativeUserPrompt = prompts.constructUserPrompt(jobData);
    if (siteContext) {
      adCreativeUserPrompt += `\n\nהקשר מאתר העסק:\n${siteContext}`;
    }

    const generatedCopy = await aiService.generateAdCopy(
      prompts.copywriterSystemPrompt,
      adCreativeUserPrompt,
    );

    console.log("✅ Generated ad copy");

    return res.status(200).json({
      title: generatedCopy.title || "",
      body: generatedCopy.body || "",
    });
  } catch (error) {
    console.error("❌ Error in generateAdCreative:", error);
    return res.status(500).json({
      error: "Internal Server Error",
      message: error.message,
    });
  }
};

/**
 * Generate Ad Creative V2
 * @route POST /api/ai/ad-creative/v2/generate
 * @query  debug=true  — include pipeline metrics in response
 */
exports.generateAdCreativeV2 = async (req, res) => {
  const { randomUUID } = require("crypto");
  const requestId = randomUUID();

  try {
    const { phone, token, actId, payload, imageUrl, site, isDemo } = req.body;
    const debugMode = req.query.debug === "true";

    console.log(JSON.stringify({
      level: "INFO", requestId, step: "request_received",
      phone: phone || "missing", hasToken: !!token, actId: actId || "missing",
      isDemo: !!isDemo, hasSite: !!site, hasImageUrl: !!imageUrl, debugMode,
    }));

    if (!phone) {
      return res.status(400).json({ requestId, error: "Missing required fields", required: ["phone"] });
    }

    // ── Demo mode — skip Facebook entirely, use vision-based demo copy ───────
    if (isDemo === true) {
      const aiService = require("../services/ai.service");
      const siteContext = site ? await extractSiteContent(site) : "";
      const result = await aiService.generateDemoAdCopy(payload || {}, imageUrl || null, siteContext);
      return res.status(200).json({
        requestId,
        variations: [{
          angle: "general",
          hook: result.title || "",
          title: result.title || "",
          body: result.body || "",
          cta: result.description || "",
        }],
      });
    }
    // ─────────────────────────────────────────────────────────────────────────

    if (!token || !actId) {
      return res.status(400).json({ requestId, error: "Missing required fields", required: ["token", "actId"] });
    }

    const { runAdCreativeV2Pipeline } = require("../services/adCreativeV2.pipeline");
    const result = await runAdCreativeV2Pipeline({ requestId, token, actId, phone, payload, imageUrl, site });

    const { _metrics, ...publicResult } = result;

    const response = { requestId, ...publicResult };

    if (debugMode) {
      response.debug = {
        timings: _metrics.timings,
        retries: _metrics.ai.totalRetries,
        fallbacksUsed: _metrics.failures.fallbacksUsed,
        validationFailures: _metrics.failures.validationFailures,
        parseFailures: _metrics.failures.parseFailures,
        ai: {
          totalInputTokens: _metrics.ai.totalInputTokens,
          totalOutputTokens: _metrics.ai.totalOutputTokens,
          totalCostUsd: _metrics.ai.totalCostUsd,
          calls: _metrics.ai.calls,
        },
        creativeIntelligence: result.creativeAnalysis || null,
        strategySignals: result.strategy || null,
        variationReasoning: (result.variations || []).map((v) => ({
          angle: v.angle,
          whyThisWorks: v.whyThisWorks || null,
        })),
        ...(_metrics.mediaDebug && { media: _metrics.mediaDebug }),
        ...(_metrics.videoDebug && { video: _metrics.videoDebug }),
        ...(_metrics.copyQualityDebug && { copyQuality: _metrics.copyQualityDebug }),
      };
    }

    return res.status(200).json(response);
  } catch (error) {
    console.error(JSON.stringify({ level: "ERROR", requestId, step: "controller", error: error.message }));
    return res.status(500).json({ requestId, error: "Internal Server Error", message: error.message });
  }
};

/**
 * Get Ad Creative Job Status
 * @route GET /api/ai/ad-creative/status/:jobId
 * @description Gets the status and result of an ad creative job
 */
exports.getAdCreativeStatus = async (req, res) => {
  try {
    const { jobId } = req.params;

    if (!jobId) {
      return res.status(400).json({
        error: "Job ID is required",
      });
    }

    // Find job in database
    const job = await DB.collection("ad_creative_jobs").findOne({ jobId });

    if (!job) {
      return res.status(404).json({
        error: "Job not found",
        jobId,
      });
    }

    // Return job status
    return res.status(200).json({
      jobId: job.jobId,
      status: job.status, // boolean: true = finished, false = not finished
      statusType: job.statusType, // string: pending, processing, completed, failed
      data: job.data || null,
      error: job.error || null,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    });
  } catch (error) {
    console.error("❌ Error getting ad creative job status:", error);
    return res.status(500).json({
      error: "Failed to get job status",
      message: error.message,
    });
  }
};

/**
 * Regenerate Ad Creative - עריכת תמונה קיימת לפי בקשת המשתמש
 * @route POST /api/ai/regenerate-creative
 */
exports.regenerateCreative = async (req, res) => {
  const requestId = `reg_${Date.now()}`;
  const startTime = Date.now();

  console.log(`\n${"=".repeat(60)}`);
  console.log(`[RegenerateCreative] 🚀 START  | requestId: ${requestId}`);
  console.log(`[RegenerateCreative] 📥 Input received:`);
  console.log(`   phone             : ${req.body.phone || "❌ MISSING"}`);
  console.log(
    `   original_image_url: ${req.body.original_image_url || "❌ MISSING"}`,
  );
  console.log(
    `   edit_request      : ${req.body.edit_request || "❌ MISSING"}`,
  );
  console.log(`${"=".repeat(60)}`);

  try {
    const { phone, original_image_url, edit_request, site } = req.body;

    if (!phone || !original_image_url || !edit_request) {
      console.warn(
        `[RegenerateCreative] ⚠️  Validation failed — missing fields`,
      );
      return res.status(400).json({
        error:
          "Missing required fields: phone, original_image_url, edit_request",
      });
    }

    // ── שלב 1: הורדת התמונה המקורית ───────────────────────────
    console.log(
      `\n[RegenerateCreative] 📥 STEP 1 — Downloading original image`,
    );
    console.log(`   URL: ${original_image_url}`);

    const imageResponse = await axios.get(original_image_url, {
      responseType: "arraybuffer",
      timeout: 30000,
    });

    const imageBuffer = Buffer.from(imageResponse.data);
    const imageBase64 = imageBuffer.toString("base64");
    const contentType = imageResponse.headers["content-type"] || "image/png";

    console.log(`   ✅ Downloaded successfully`);
    console.log(`   Size       : ${(imageBuffer.length / 1024).toFixed(1)} KB`);
    console.log(`   Content-Type: ${contentType}`);
    console.log(`   Base64 length: ${imageBase64.length} chars`);

    // ── שלב 2: עריכה עם imageAgent.edit() ─────────────────────
    console.log(`\n[RegenerateCreative] 🤖 STEP 2 — Editing with Gemini`);
    console.log(`   Edit request: "${edit_request}"`);

    const siteContext = site ? await extractSiteContent(site) : "";
    const enrichedEditRequest = siteContext
      ? `${edit_request}\n\nהקשר מאתר העסק (לשמירה על סגנון):\n${siteContext}`
      : edit_request;

    const geminiStart = Date.now();
    const edited = await imageAgent.edit(
      imageBase64,
      contentType,
      enrichedEditRequest,
    );
    const geminiMs = Date.now() - geminiStart;

    // ── שלב 3: העלאה ל-Backblaze ───────────────────────────────
    console.log(`\n[RegenerateCreative] ☁️  STEP 3 — Uploading to Backblaze`);
    const ext = edited.mimeType.split("/")[1] || "png";
    const filePath = `profile/${phone}/${Date.now()}.${ext}`;

    const b2Start = Date.now();
    const uploadResult = await backblazeService.uploadImage(
      filePath,
      edited.buffer,
      edited.mimeType,
    );
    const b2Ms = Date.now() - b2Start;

    // ── proxy URL ───────────────────────────────────────────────
    const proxyUrl = `${req.protocol}://${req.get("host")}/api/img?url=${filePath}`;

    // ── סיום ───────────────────────────────────────────────────
    const totalMs = Date.now() - startTime;

    return res.status(200).json({
      success: true,
      image_url: proxyUrl,
      url: proxyUrl,
    });
  } catch (error) {
    const totalMs = Date.now() - startTime;
    console.error(
      `\n[RegenerateCreative] ❌ ERROR | requestId: ${requestId} | after ${totalMs}ms`,
    );
    console.error(`   message: ${error.message}`);
    if (error.stack) console.error(`   stack:\n${error.stack}`);
    console.log(`${"=".repeat(60)}\n`);
    return res.status(500).json({
      error: "Server Error",
      message: error.message,
    });
  }
};

exports.makespy = async (req, res) => {
  try {
    const {
      phone,
      count,
      notes,
      status,
      image,
    } = req.body;

    if (!name || !phone) {
      return res.status(400).json({
        error: "Missing required fields: name and phone",
      });
    }

    const leadInput = JSON.stringify(
      {
        phone,
        count,
        notes,
        status,
        image,
      },
      null,
      2,
    );
    log("יש הצליח להגיע", leadInput);
 return res.status(200).json({
   success: true
   });

    const systemPrompt = prompts.gemini.whatsapp_lead_first_message_prompt;
    const fullPrompt = systemPrompt.replace("{{`1`}}", leadInput);

    const result = await textAgent.generate(fullPrompt, {
      temperature: 0.8,
      maxTokens: 500,
    });

    return res.status(200).json({
      success: true,
      message: result.text,
    });
  } catch (error) {
    console.error("Error generating lead message:", error);
    return res.status(500).json({
      error: "Server Error",
      message: error.message,
    });
  }
};

/**
 * Generate Ad Copy
 * @route POST /api/ai/generate-copy
 * @description Fetches Facebook ads, scores them, and generates new copy using OpenAI GPT-4
 */
exports.generateCopy = async (req, res) => {
  try {
    const { token, actId, payload, site } = req.body;

    // Step 1: Validate request
    if (!token || !actId || !payload) {
      return res.status(400).json({
        error: "Missing required fields",
        required: ["token", "actId", "payload"],
      });
    }

    if (!payload.service || !payload.goal) {
      return res.status(400).json({
        error: "Missing required payload fields",
        required: ["payload.service", "payload.goal"],
      });
    }

    // Step 2: Fetch all ads from Facebook (Module 5)
    const facebookService = require("../services/facebook.service");
    const ads = await facebookService.getAds(actId, token);

    if (!ads || ads.length === 0) {
      return res.status(404).json({
        error: "No ads found for this account",
        actId,
      });
    }

    console.log(`✅ Fetched ${ads.length} ads from Facebook`);

    // Step 3: Fetch insights for each ad (Module 10) - using Promise.all for concurrency
    const adsWithInsights = await Promise.all(
      ads.map(async (ad) => {
        const insights = await facebookService.getInsights(ad.id, token).catch(() => null);
        return {
          ...ad,
          insights: insights || {},
        };
      }),
    );

    console.log(`✅ Fetched insights for all ads`);

    // Step 4: Score each ad (Module 13) - using the scoring algorithm
    const adScoring = require("../utils/adScoring");
    const TARGET_CPL = 20; // As specified in the manifest

    const adsWithScores = adsWithInsights.map((ad) => {
      // Flatten insights into the ad object for scoring
      const adData = {
        ...ad,
        impressions: ad.insights?.impressions || 0,
        spend: ad.insights?.spend || 0,
        clicks: ad.insights?.clicks || 0,
        inline_link_clicks: ad.insights?.inline_link_clicks || 0,
        actions: ad.insights?.actions || [],
        quality_ranking: ad.insights?.quality_ranking || "UNKNOWN",
        conversion_rate_ranking:
          ad.insights?.conversion_rate_ranking || "UNKNOWN",
        engagement_rate_ranking:
          ad.insights?.engagement_rate_ranking || "UNKNOWN",
      };

      const score = adScoring.scoreAd(adData, TARGET_CPL);
      return {
        ...adData,
        score,
      };
    });

    console.log(`✅ Scored all ads`);

    // Step 5: Filter and sort (Module 19 & 13)
    // Filter ads with score >= 60, sort by score descending, take top 3
    const filteredAds = adsWithScores.filter((ad) => ad.score >= 60);
    const sortedAds = [...adsWithScores].sort((a, b) => b.score - a.score);

    // Take top 3 from filtered if available, otherwise top 3 from all sorted
    const top3Ads =
      filteredAds.length >= 3
        ? filteredAds.sort((a, b) => b.score - a.score).slice(0, 3)
        : sortedAds.slice(0, 3);

    console.log(
      `✅ Selected top ${top3Ads.length} ads (${filteredAds.length} ads met score >= 60 criteria)`,
    );

    // Step 6: Prepare data for OpenAI (Module 26)
    const aiService = require("../services/ai.service");
    const prompts = require("../utils/adCopyPrompts");

    // Construct the job data with top ads in the format expected by the prompt
    const jobData = {
      service: payload.service,
      goal: payload.goal,
      adsJson: top3Ads.map((ad) => ({
        id: ad.id,
        name: ad.name,
        score: ad.score,
        creative: ad.creative || {},
        insights: {
          impressions: ad.impressions,
          spend: ad.spend,
          clicks: ad.clicks,
          inline_link_clicks: ad.inline_link_clicks,
          quality_ranking: ad.quality_ranking,
          conversion_rate_ranking: ad.conversion_rate_ranking,
          engagement_rate_ranking: ad.engagement_rate_ranking,
        },
      })),
    };

    // Generate the copy using OpenAI
    const systemPrompt = prompts.copywriterSystemPrompt;
    const siteContext = site ? await extractSiteContent(site) : "";
    let userPrompt = prompts.constructUserPrompt(jobData);
    if (siteContext) userPrompt += `\n\nהקשר מאתר העסק:\n${siteContext}`;

    const generatedCopy = await aiService.generateAdCopy(
      systemPrompt,
      userPrompt,
    );
    console.log({ generatedCopy });

    console.log(`✅ Generated ad copy with OpenAI`);

    // Step 7: Return response (Module 38)
    return res.status(200).json({
      title: generatedCopy.title || "",
      body: generatedCopy.body || "",
      description: generatedCopy.title || "", // Duplicate of title as per manifest
      metadata: {
        ads_analyzed: ads.length,
        ads_with_score_gte_60: filteredAds.length,
        top_ads_used: top3Ads.length,
        top_ads: top3Ads.map((ad) => ({
          id: ad.id,
          name: ad.name,
          score: ad.score,
        })),
      },
    });
  } catch (error) {
    console.error("❌ Error generating copy:", error);
    return res.status(500).json({
      error: "Failed to generate ad copy",
      message: error.message,
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
    });
  }
};

/**
 * ניסוח מחדש של הודעה בסגנון שירות לקוחות מקצועי
 * @route POST /api/ai/rephrase-message
 */
exports.rephraseMessage = async (req, res) => {
  try {
    const { text } = req.body;
    if (!text?.trim()) {
      return res.status(400).json({ error: "Missing required field: text" });
    }
    const rephrased = await aiService.rephraseMessage(text);
    return res.status(200).json({ success: true, text: rephrased });
  } catch (error) {
    console.error("Error rephrasing message:", error);
    return res
      .status(500)
      .json({ error: "Server Error", message: error.message });
  }
};

/**
 * Generate Avatar - יצירת אווטר אישי על בסיס תמונה או שאלון
 * @route POST /api/ai/avatar/create
 *
 * mode="photo":          imageBase64 + mimeType + style  →  imageAgent.edit()
 * mode="questionnaire":  answers + style                 →  GPT prompt → imageAgent.generate()
 */
exports.generateAvatar = async (req, res) => {
  const requestId = `avatar_${Date.now()}`;
  const startTime = Date.now();

  console.log(`\n${"=".repeat(60)}`);
  console.log(`[GenerateAvatar] 🚀 START | requestId: ${requestId}`);

  try {
    const {
      phone,
      mode,
      style = "cartoon",
      imageBase64,
      mimeType,
      answers = {},
      count = 1,
      realPhotoBase64,
      realPhotoMimeType,
      inspirationBase64,
      inspirationMimeType,
    } = req.body;

    if (!phone || !mode) {
      return res
        .status(400)
        .json({ error: "Missing required fields: phone, mode" });
    }
    if (mode === "photo" && (!imageBase64 || !mimeType)) {
      return res
        .status(400)
        .json({ error: "mode=photo requires: imageBase64, mimeType" });
    }
    if (
      mode === "questionnaire" &&
      (!answers || Object.keys(answers).length === 0)
    ) {
      return res
        .status(400)
        .json({ error: "mode=questionnaire requires: answers object" });
    }

    const numAvatars = Math.min(Math.max(parseInt(count) || 1, 1), 4);

    // ── מיפוי סגנון לתיאור באנגלית ──────────────────────────────
    const styleMap = {
      cartoon: "cartoon character, colorful, friendly, rounded shapes",
      realistic: "photorealistic portrait, high detail, natural lighting",
      "semi-realistic":
        "semi-realistic portrait, smooth skin, enhanced features, beauty retouching",
      "3d": "3D rendered character, Pixar/Disney style, high-quality render",
      vector: "flat vector illustration, clean lines, minimal style",
      anime: "anime / manga style, Japanese animation, expressive eyes",
      pixel: "pixel art character, retro 8-bit style, grid-based",
      mascot: "brand mascot character, professional illustration, bold colors",
    };
    const styleDesc = styleMap[style] || styleMap.cartoon;

    // ── בניית פרומפט לשאלון (פעם אחת, משותף לכל הוריאציות) ────
    let questionnairePrompt = null;
    if (mode === "questionnaire") {
      console.log(
        `[GenerateAvatar] 📝 Building questionnaire prompt, style: ${style}`,
      );
      const {
        visualStyle,
        basedOn,
        age,
        gender,
        skinColor,
        hair,
        extraDetails,
        energy,
        clothingStyle,
      } = answers;

      const systemPromptGPT =
        `You are a professional prompt engineer for AI image generation. ` +
        `Your task: given avatar questionnaire answers, write a single detailed English image-generation prompt ` +
        `for Gemini that will produce a high-quality avatar/character image. ` +
        `Be descriptive, specific, and artistic. Return ONLY the prompt text — no explanations.`;

      const userContent =
        `Style: ${styleDesc}\n` +
        `Visual style chosen: ${visualStyle || style}\n` +
        `Based on: ${basedOn || "a fictional character"}\n` +
        `Age: ${age || "unspecified"}\n` +
        `Gender: ${gender || "unspecified"}\n` +
        `Skin color: ${skinColor || "unspecified"}\n` +
        `Hair: ${hair || "unspecified"}\n` +
        `Extra details (beard, glasses, tattoos): ${extraDetails || "none"}\n` +
        `Energy / personality: ${energy || "neutral"}\n` +
        `Clothing style: ${clothingStyle || "casual"}\n` +
        `Framing: FULL BODY — show the complete character from head to toe, standing pose\n` +
        `Background: COMPLETELY TRANSPARENT / NO BACKGROUND — PNG format, pure alpha channel, nothing behind the character\n` +
        `\nGenerate a compelling Gemini image prompt for this avatar.`;

      questionnairePrompt = await aiService.generateRawText(
        systemPromptGPT,
        userContent,
      );
      console.log(
        `[GenerateAvatar] ✅ Base prompt ready (${questionnairePrompt.length} chars)`,
      );
    }

    // ── יצירת כל האווטרים במקביל ────────────────────────────────
    console.log(
      `[GenerateAvatar] 🎨 Generating ${numAvatars} avatar(s) in parallel`,
    );

    const photoInstructions =
      `Transform this photo into a high-quality avatar in the following style: ${styleDesc}. ` +
      `Keep the person's likeness, face shape, hair color, and key features recognizable. ` +
      `Result should be a clean portrait avatar suitable for a profile picture. ` +
      `Square format, centered face, transparent or clean background preferred.`;

    const variationHints = [
      "",
      " Slightly different lighting angle and expression.",
      " Alternative color palette variation.",
      " Different pose or background composition.",
    ];

    const generateOne = async (index) => {
      const hint = variationHints[index] || "";
      let imageResult;

      if (mode === "photo") {
        imageResult = await imageAgent.edit(
          imageBase64,
          mimeType,
          photoInstructions + hint,
        );
      } else if (
        mode === "questionnaire" &&
        realPhotoBase64 &&
        realPhotoMimeType
      ) {
        // תמונה ריאלית — שומרים על מאפייני הדמות האמיתית, ממירים לסגנון הנבחר
        const realPhotoInstructions =
          "IMPORTANT: The provided image is a real photo of the person to create the avatar from.\n" +
          "Your task:\n" +
          "1. REPLICATE their facial features, hair color/style, skin tone, eye color, and distinctive characteristics as accurately as possible\n" +
          "2. Transform them into this artistic style: " +
          styleDesc +
          "\n" +
          "3. Follow the full avatar specification below:\n\n" +
          questionnairePrompt +
          "\n\nThe final avatar MUST be recognizable as the same person from the photo, rendered in the requested style." +
          hint;
        imageResult = await imageAgent.edit(
          realPhotoBase64,
          realPhotoMimeType,
          realPhotoInstructions,
        );
      } else if (
        mode === "questionnaire" &&
        inspirationBase64 &&
        inspirationMimeType
      ) {
        // תמונת השראה — משמשת לסגנון ויזואלי בלבד, לא מעתיקים את הדמות
        const inspirationInstructions =
          questionnairePrompt +
          "\n\nIMPORTANT: A reference image is provided for VISUAL STYLE INSPIRATION ONLY. " +
          "Extract its art style, color palette, lighting, and mood. " +
          "Create a COMPLETELY NEW avatar character based on the questionnaire description above, " +
          "inspired by the visual aesthetic of the reference image. " +
          "Do NOT copy the person, face, or content from the reference image." +
          hint;
        imageResult = await imageAgent.edit(
          inspirationBase64,
          inspirationMimeType,
          inspirationInstructions,
        );
      } else {
        const variantPrompt = questionnairePrompt + hint;
        imageResult = await imageAgent.generate(variantPrompt);
      }

      const ext = (imageResult.mimeType || "image/png").split("/")[1] || "png";
      const filePath = `avatar/${phone}/${Date.now()}_${index}.${ext}`;

      await backblazeService.uploadImage(
        filePath,
        imageResult.buffer,
        imageResult.mimeType || "image/png",
      );
      console.log(
        `[GenerateAvatar] ✅ [${index + 1}/${numAvatars}] Uploaded: ${filePath}`,
      );

      return filePath;
    };

    const filePaths = await Promise.all(
      Array.from({ length: numAvatars }, (_, i) => generateOne(i)),
    );

    const host = `${req.protocol}://${req.get("host")}`;
    const urls = filePaths.map((fp) => `${host}/api/img?url=${fp}`);
    const totalMs = Date.now() - startTime;

    console.log(
      `[GenerateAvatar] ✅ DONE | ${numAvatars} avatars | ${totalMs}ms`,
    );
    console.log(`${"=".repeat(60)}\n`);

    return res.status(200).json({ success: true, urls, url: urls[0] });
  } catch (error) {
    const totalMs = Date.now() - startTime;
    console.error(
      `[GenerateAvatar] ❌ ERROR | ${totalMs}ms | ${error.message}`,
    );
    if (error.stack) console.error(error.stack);
    console.log(`${"=".repeat(60)}\n`);
    return res
      .status(500)
      .json({ error: "Server Error", message: error.message });
  }
};

/**
 * List Avatar Gallery - רשימת אווטרים שמורים לפי טלפון
 * @route GET /api/ai/avatar/list/:phone
 */
exports.listAvatars = async (req, res) => {
  try {
    const { phone } = req.params;
    if (!phone) return res.status(400).json({ error: "Missing phone" });

    const files = await backblazeService.listClientAvatars(phone);
    const host = `${req.protocol}://${req.get("host")}`;
    const urls = files
      .sort((a, b) => b.uploadedAt - a.uploadedAt)
      .map((f) => `${host}/api/img?url=${encodeURIComponent(f.fileName)}`);

    return res.status(200).json({ success: true, urls });
  } catch (error) {
    console.error("[ListAvatars] ❌", error.message);
    return res
      .status(500)
      .json({ error: "Server Error", message: error.message });
  }
};

/**
 * Delete Avatar - מחיקת אווטר יחיד מ-Backblaze
 * @route DELETE /api/ai/avatar/delete
 * body: { phone, fileName }   — fileName = Backblaze path, e.g. "avatar/05.../file.png"
 */
exports.deleteAvatar = async (req, res) => {
  try {
    const { phone, fileName } = req.body;
    if (!phone || !fileName) {
      return res.status(400).json({ error: "Missing phone or fileName" });
    }

    const result = await backblazeService.deleteAvatarFile(phone, fileName);
    return res.status(200).json(result);
  } catch (error) {
    console.error("[DeleteAvatar] ❌", error.message);
    return res
      .status(500)
      .json({ error: "Server Error", message: error.message });
  }
};

/**
 * Generate Logo - יצירת לוגו לעסק על בסיס שאלון מיתוג
 * @route POST /api/ai/logo/create
 */
exports.generateLogo = async (req, res) => {
  const requestId = `logo_${Date.now()}`;
  const startTime = Date.now();

  console.log(`\n${"=".repeat(60)}`);
  console.log(`[GenerateLogo] 🚀 START | requestId: ${requestId}`);

  try {
    const {
      BUSINESS_NAME,
      BUSINESS_DESCRIPTION,
      BRAND_VIBE,
      COLOR_PREFERENCES,
      AVOID_LIST,
      phone,
      site,
    } = req.body;

    if (
      !BUSINESS_NAME ||
      !BUSINESS_DESCRIPTION ||
      !BRAND_VIBE ||
      !COLOR_PREFERENCES ||
      !AVOID_LIST ||
      !phone
    ) {
      return res.status(400).json({
        error:
          "Missing required fields: BUSINESS_NAME, BUSINESS_DESCRIPTION, BRAND_VIBE, COLOR_PREFERENCES, AVOID_LIST, phone",
      });
    }

    // ── שלב 1: בניית הפרומפט ל-ChatGPT ────────────────────────
    console.log(`[GenerateLogo] 🤖 STEP 1 — Building ChatGPT prompt`);

    const systemPrompt = prompts.openai.logo_prompt;

    const siteContext = site ? await extractSiteContent(site) : "";
    const siteSection = siteContext ? ` site_context: ${siteContext}` : "";

    const userContent =
      `INPUT_START ` +
      `business_name: ${BUSINESS_NAME} ` +
      `business_description: ${BUSINESS_DESCRIPTION} ` +
      `brand_vibe: ${BRAND_VIBE} ` +
      `color_preferences: ${COLOR_PREFERENCES} ` +
      `avoid_list: ${AVOID_LIST} ` +
      `INPUT_END${siteSection}`;

    // ── שלב 2: קריאה ל-ChatGPT לקבלת פרומפט לתמונה ────────────
    console.log(`[GenerateLogo] 🤖 STEP 2 — Calling ChatGPT for image prompt`);
    const imagePrompt = await aiService.generateRawText(
      systemPrompt,
      userContent,
    );
    console.log(
      `[GenerateLogo] ✅ Image prompt received (${imagePrompt.length} chars)`,
    );

    // ── שלב 3: יצירת תמונה עם Gemini ───────────────────────────
    console.log(`[GenerateLogo] 🎨 STEP 3 — Generating image with Gemini`);
    const imageResult = await imageAgent.generate(imagePrompt);
    console.log(
      `[GenerateLogo] ✅ Image generated, size: ${imageResult.size} bytes`,
    );

    // ── שלב 4: העלאה ל-Backblaze ───────────────────────────────
    console.log(`[GenerateLogo] ☁️  STEP 4 — Uploading to Backblaze`);
    const timestamp = Date.now();
    const filePath = `post/${phone}/${timestamp}.png`;

    await backblazeService.uploadImage(
      filePath,
      imageResult.buffer,
      imageResult.mimeType,
    );
    console.log(`[GenerateLogo] ✅ Uploaded to Backblaze: ${filePath}`);

    // ── proxy URL ───────────────────────────────────────────────
    const proxyUrl = `${req.protocol}://${req.get("host")}/api/img?url=${filePath}`;
    const totalMs = Date.now() - startTime;

    console.log(`[GenerateLogo] ✅ DONE | ${totalMs}ms | url: ${proxyUrl}`);
    console.log(`${"=".repeat(60)}\n`);

    return res.status(200).json({
      success: true,
      url: proxyUrl,
    });
  } catch (error) {
    const totalMs = Date.now() - startTime;
    console.error(
      `[GenerateLogo] ❌ ERROR | requestId: ${requestId} | after ${totalMs}ms`,
    );
    console.error(`   message: ${error.message}`);
    if (error.stack) console.error(`   stack:\n${error.stack}`);
    console.log(`${"=".repeat(60)}\n`);
    return res.status(500).json({
      error: "Server Error",
      message: error.message,
    });
  }
};

// ─────────────────────────────────────────────
// ─── Generate Logo V2 ─────────────────────────────────────────────────────────
/**
 * Generate Logo V2 - יצירת לוגו עם פרומפט מבריף מלא
 * @route POST /api/ai/logo/v2/create
 */
exports.generateLogoV2 = async (req, res) => {
  const requestId = `logo_v2_${Date.now()}`;
  const startTime = Date.now();

  console.log(`\n${"=".repeat(60)}`);
  console.log(`[GenerateLogoV2] 🚀 START | requestId: ${requestId}`);

  try {
    const {
      business_name,
      industry,
      slogan,
      design_style,
      brand_vibe,
      emotion,
      logo_type,
      colors,
      idea,
      phone,
    } = req.body;

    if (!business_name) {
      return res.status(400).json({ error: "Missing required field: business_name" });
    }

    const safePhone = phone || "unknown";

    // ── שלב 1: בניית הפרומפט ל-ChatGPT ────────────────────────
    console.log(`[GenerateLogoV2] 🤖 STEP 1 — Building ChatGPT prompt`);

    const systemPrompt = prompts.openai.logo_v2_prompt;

    const userContent = systemPrompt
      .replace("{{business_name}}", business_name || "")
      .replace("{{industry}}", industry || "")
      .replace("{{slogan}}", slogan || "")
      .replace("{{design_style}}", design_style || "")
      .replace("{{brand_vibe}}", brand_vibe || "")
      .replace("{{emotion}}", emotion || "")
      .replace("{{logo_type}}", logo_type || "")
      .replace("{{colors}}", colors || "")
      .replace("{{idea}}", idea || "");

    // ── שלב 2: קריאה ל-ChatGPT ─────────────────────────────────
    console.log(`[GenerateLogoV2] 🤖 STEP 2 — Calling ChatGPT for image prompt`);
    const rawResponse = await aiService.generateRawText(
      "You are a JSON generator. Return only valid JSON.",
      userContent,
    );
    console.log(`[GenerateLogoV2] ✅ ChatGPT response received (${rawResponse.length} chars)`);

    console.log(`[GenerateLogoV2] 📄 Raw ChatGPT response:\n${rawResponse}`);

    let imagePrompt;
    try {
      const cleaned = rawResponse
        .replace(/```json\s*/gi, "")
        .replace(/```\s*/g, "")
        .trim();
      const parsed = JSON.parse(cleaned);
      imagePrompt = parsed.nano_banana_prompt;
      if (!imagePrompt) throw new Error("nano_banana_prompt missing from response");
    } catch (parseError) {
      console.error(`[GenerateLogoV2] ❌ Failed to parse ChatGPT JSON: ${parseError.message}`);
      // fallback: use the raw response as the image prompt directly
      imagePrompt = rawResponse.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
      console.warn(`[GenerateLogoV2] ⚠️ Using raw response as image prompt (fallback)`);
    }
    // ── enforce no-white-logo constraint ───────────────────────────
    imagePrompt = imagePrompt +
      " CRITICAL: the logo must NOT be white or near-white. Use vivid, saturated, clearly visible colors." +
      " The background of the canvas must be transparent or pure white — the logo itself must have strong, dark, or rich color contrast against white.";
    console.log(`[GenerateLogoV2] ✅ Image prompt (${imagePrompt.length} chars): ${imagePrompt.slice(0, 120)}...`);

    // ── שלב 3: יצירת תמונה עם Gemini ───────────────────────────
    console.log(`[GenerateLogoV2] 🎨 STEP 3 — Generating image with Gemini`);
    const imageResult = await imageAgent.generate(imagePrompt);
    console.log(`[GenerateLogoV2] ✅ Image generated, size: ${imageResult.size} bytes`);

    // ── שלב 4: העלאה ל-Backblaze ───────────────────────────────
    console.log(`[GenerateLogoV2] ☁️  STEP 4 — Uploading to Backblaze`);
    const timestamp = Date.now();
    const filePath = `logos/${safePhone}/${timestamp}.png`;

    await backblazeService.uploadImage(
      filePath,
      imageResult.buffer,
      imageResult.mimeType,
    );
    console.log(`[GenerateLogoV2] ✅ Uploaded to Backblaze: ${filePath}`);

    const proxyUrl = `${req.protocol}://${req.get("host")}/api/img?url=${filePath}`;
    const totalMs = Date.now() - startTime;

    console.log(`[GenerateLogoV2] ✅ DONE | ${totalMs}ms | url: ${proxyUrl}`);
    console.log(`${"=".repeat(60)}\n`);

    return res.status(200).json({
      success: true,
      url: proxyUrl,
    });
  } catch (error) {
    const totalMs = Date.now() - startTime;
    console.error(`[GenerateLogoV2] ❌ ERROR | requestId: ${requestId} | after ${totalMs}ms`);
    console.error(`   message: ${error.message}`);
    if (error.stack) console.error(`   stack:\n${error.stack}`);
    console.log(`${"=".repeat(60)}\n`);
    return res.status(500).json({ error: "Server Error", message: error.message });
  }
};

// ─────────────────────────────────────────────
// ─── Facebook Account Summary Helper ──────────────────────────────────────────

const FB_GRAPH = "https://graph.facebook.com/v23.0";

async function fetchFbAccountSummary({
  userToken,
  adAccountId,
  pageId,
  pageToken,
}) {
  if (!userToken || !adAccountId) return { available: false };

  try {
    const now = new Date();
    const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const until = now.toISOString().slice(0, 10);

    const [campaignsRes, insightsRes, formsRes] = await Promise.allSettled([
      // Active campaigns
      axios.get(`${FB_GRAPH}/${adAccountId}/campaigns`, {
        params: {
          access_token: userToken,
          fields: "id,name,status,daily_budget",
          effective_status: '["ACTIVE"]',
          limit: 100,
        },
      }),
      // Account insights (last 7 days)
      axios.get(`${FB_GRAPH}/${adAccountId}/insights`, {
        params: {
          access_token: userToken,
          fields: "spend,impressions,clicks,actions",
          time_range: JSON.stringify({ since, until }),
        },
      }),
      // Lead forms (only if pageToken is available)
      pageId && pageToken
        ? axios.get(`${FB_GRAPH}/${pageId}/leadgen_forms`, {
            params: { access_token: pageToken, fields: "id,name", limit: 100 },
          })
        : Promise.resolve(null),
    ]);

    const summary = {
      available: true,
      activeCampaigns: 0,
      totalDailyBudget: 0,
      spend7d: 0,
      impressions7d: 0,
      clicks7d: 0,
      leads7d: 0,
      leadFormsCount: 0,
    };

    // Parse campaigns
    if (campaignsRes.status === "fulfilled" && campaignsRes.value?.data?.data) {
      const campaigns = campaignsRes.value.data.data;
      summary.activeCampaigns = campaigns.length;
      summary.totalDailyBudget = campaigns.reduce(
        (sum, c) => sum + parseFloat(c.daily_budget || 0) / 100,
        0,
      );
    }

    // Parse insights
    if (
      insightsRes.status === "fulfilled" &&
      insightsRes.value?.data?.data?.[0]
    ) {
      const ins = insightsRes.value.data.data[0];
      summary.spend7d = parseFloat(ins.spend || 0);
      summary.impressions7d = parseInt(ins.impressions || 0, 10);
      summary.clicks7d = parseInt(ins.clicks || 0, 10);
      const leadAction = (ins.actions || []).find(
        (a) =>
          a.action_type === "lead" ||
          a.action_type === "onsite_conversion.lead_grouped",
      );
      if (leadAction) summary.leads7d = parseInt(leadAction.value || 0, 10);
    }

    // Parse lead forms
    if (formsRes.status === "fulfilled" && formsRes.value?.data?.data) {
      summary.leadFormsCount = formsRes.value.data.data.length;
    }

    console.log(
      `[MarketingWeather] 📊 FB summary: ${summary.activeCampaigns} campaigns, ₪${summary.spend7d} spend, ${summary.leads7d} leads`,
    );
    return summary;
  } catch (err) {
    console.warn("[MarketingWeather] ⚠️ FB summary error:", err.message);
    return { available: false };
  }
}

// Marketing Weather Forecast + Daily Tasks
// Analyzes market conditions for a user's business category
// using Google Trends + Facebook data + GPT-4o with web search
// @route POST /api/ai/marketing-weather
// ─────────────────────────────────────────────
exports.getMarketingWeather = async (req, res) => {
  const startTime = Date.now();

  try {
    const {
      phone,
      userToken,
      adAccountId,
      pageId,
      pageToken,
      locale = "he",
    } = req.body;
    if (!phone) {
      return res.status(400).json({ error: "phone is required" });
    }

    // 1. Normalize phone & look up client brief for business category
    let p = String(phone).trim().replace(/\s+/g, "");
    if (p.startsWith("+972")) p = "0" + p.slice(4);
    else if (p.startsWith("972")) p = "0" + p.slice(3);

    const briefs = DB.collection("client_briefs");
    const brief = await briefs.findOne({ phone: p });
    const service =
      brief?.answers?.service || brief?.answers?.businessType || "";

    console.log(
      `[MarketingWeather] 🌤️ phone: ${p} | service: "${service}" | locale: ${locale}`,
    );

    const { OpenAI } = require("openai");
    const openai = new OpenAI({ apiKey: process.env.OpenAI_API_KEY });

    // 2. Cache setup — Hebrew cache is always the source of truth
    const now = new Date();
    const hourBucket = Math.floor(now.getHours() / 3);
    const baseKey = (service || "__general__") + "_" + (adAccountId || "noact");
    const heKey = baseKey; // Hebrew cache key (no suffix)
    const localeKey = locale === "he" ? baseKey : `${baseKey}_${locale}`;
    const cache = DB.collection("marketing_weather_cache");

    // Helper to save a document to cache — expires_at is inherited from Hebrew source when translating
    const saveToCache = (
      key,
      fields,
      expiresAt = new Date(now.getTime() + 3 * 60 * 60 * 1000),
    ) =>
      cache.updateOne(
        { service: key, hour_bucket: hourBucket },
        {
          $set: {
            ...fields,
            service_display: service || "כללי",
            generated_at: now,
            expires_at: expiresAt,
          },
        },
        { upsert: true },
      );

    // Helper to format a cache doc as API response
    const formatCached = (doc) => ({
      success: true,
      data: {
        weather_type: doc.weather_type,
        title_he: doc.title_he,
        description: doc.description,
        recommendation: doc.recommendation,
        tasks: doc.tasks || [],
        service: doc.service_display,
        generated_at: doc.generated_at.getTime(),
      },
    });

    // 3. Check locale cache first (fast path for returning users)
    if (locale !== "he") {
      const localeCached = await cache.findOne({
        service: localeKey,
        hour_bucket: hourBucket,
        expires_at: { $gt: now },
      });
      if (localeCached) {
        console.log(
          `[MarketingWeather] ✅ Cache hit (${locale}) | ${Date.now() - startTime}ms`,
        );
        return res.json(formatCached(localeCached));
      }
    }

    // 4. Check Hebrew cache (always the source)
    const heCached = await cache.findOne({
      service: heKey,
      hour_bucket: hourBucket,
      expires_at: { $gt: now },
    });

    let heResult; // { weather_type, title_he, description, recommendation, tasks }

    if (heCached) {
      console.log(
        `[MarketingWeather] ✅ Cache hit (he) | ${Date.now() - startTime}ms`,
      );
      heResult = heCached;
    } else {
      // 5. Generate Hebrew forecast via GPT-4o + web search
      const googleTrends = require("google-trends-api");
      const keyword = service || "שיווק דיגיטלי";

      let trendsData = "לא זמין";
      let fbData = { available: false };

      const [trendsResult, fbResult] = await Promise.allSettled([
        (async () => {
          try {
            const [interestRaw, relatedRaw] = await Promise.allSettled([
              googleTrends.interestOverTime({
                keyword,
                startTime: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
                geo: "IL",
                hl: "he",
              }),
              googleTrends.relatedQueries({ keyword, geo: "IL", hl: "he" }),
            ]);
            const parts = [];
            if (interestRaw.status === "fulfilled") {
              try {
                const interestJson = JSON.parse(interestRaw.value);
                const timeline = interestJson?.default?.timelineData || [];
                const recent = timeline.slice(-7);
                const values = recent.map((t) => t.value?.[0] ?? 0);
                const avg = values.length
                  ? Math.round(
                      values.reduce((a, b) => a + b, 0) / values.length,
                    )
                  : 0;
                const trend =
                  values.length >= 2
                    ? values[values.length - 1] > values[0]
                      ? "עולה"
                      : values[values.length - 1] < values[0]
                        ? "יורד"
                        : "יציב"
                    : "לא ידוע";
                parts.push(
                  `עניין ממוצע (7 ימים אחרונים): ${avg}/100, מגמה: ${trend}`,
                );
              } catch (_) {}
            }
            if (relatedRaw.status === "fulfilled") {
              try {
                const relatedJson = JSON.parse(relatedRaw.value);
                const top5 = (
                  relatedJson?.default?.rankedList?.[0]?.rankedKeyword || []
                )
                  .slice(0, 5)
                  .map((q) => q.query)
                  .join(", ");
                if (top5) parts.push(`חיפושים קשורים פופולריים: ${top5}`);
              } catch (_) {}
            }
            return parts.length ? parts.join("\n") : "לא זמין";
          } catch (err) {
            console.warn(
              "[MarketingWeather] ⚠️ Google Trends error:",
              err.message,
            );
            return "לא זמין";
          }
        })(),
        fetchFbAccountSummary({ userToken, adAccountId, pageId, pageToken }),
      ]);

      if (trendsResult.status === "fulfilled") trendsData = trendsResult.value;
      if (fbResult.status === "fulfilled") fbData = fbResult.value;

      const dayNames = [
        "ראשון",
        "שני",
        "שלישי",
        "רביעי",
        "חמישי",
        "שישי",
        "שבת",
      ];
      const dateStr = now.toLocaleDateString("he-IL");
      const fbSection = fbData.available
        ? `\nנתוני חשבון פייסבוק:\n- קמפיינים פעילים: ${fbData.activeCampaigns}\n- תקציב יומי כולל: ₪${fbData.totalDailyBudget}\n- הוצאה ב-7 ימים: ₪${fbData.spend7d}\n- חשיפות ב-7 ימים: ${fbData.impressions7d}\n- קליקים ב-7 ימים: ${fbData.clicks7d}\n- לידים ב-7 ימים: ${fbData.leads7d}\n- טפסי לידים: ${fbData.leadFormsCount}`
        : "\nנתוני פייסבוק: לא זמינים";

      const systemPrompt = `אתה אנליסט שיווק דיגיטלי מומחה לשוק הישראלי.
תפקידך לנתח את מצב השוק הנוכחי עבור קטגוריית עסק מסוימת ולהחזיר "תחזית מזג אוויר שיווקי".

5 סוגי מזג אוויר שיווקי:

1. **שמשי (sunny)** — השוק רותח ובתנועה. יש ביקוש גבוה, לקוחות פעילים, עונת שיא. הזמן לסגור עסקאות.
2. **מעונן חלקית (partly_cloudy)** — השוק יציב ובתנועה. יש הזדמנויות למי שפועל נכון. תקופה טובה לשמור על קצב קבוע.
3. **מעונן (cloudy)** — השוק שקט יחסית. צריך לייצר עניין ולא לחכות שיגיע לבד. תקופה ליצירת תוכן וערך.
4. **גשום (rainy)** — ירידה בפעילות. פחות ביקוש ויותר הססנות. תקופה לחזק הצעות ולהפעיל מבצעים.
5. **סוער (stormy)** — תחרות גבוהה ורעש חזק בשוק. קשה לבלוט. תקופה להיות יצירתיים ולהגביר נוכחות.

התחשב ב:
- סוג העסק/שירות
- נתוני Google Trends (אם זמינים)
- נתוני חשבון הפייסבוק של המשתמש (אם זמינים)
- יום בשבוע ושעה (ישראל)
- עונתיות (חגים, חופשת קיץ, תקופות שיא)
- מגמות כלליות בשיווק דיגיטלי בישראל

חפש באינטרנט מידע עדכני על מגמות בשוק הישראלי עבור הקטגוריה הנתונה.

בנוסף לתחזית, צור בדיוק 3 משימות יומיות קצרות ואקטיביות עבור בעל העסק.
כל משימה = משפט אחד קצר בעברית, פעולה ישימה שאפשר לעשות היום.
המשימות צריכות להיות מגוונות ומותאמות לנתוני החשבון (אם זמינים).
אם יש נתוני פייסבוק — השתמש במספרים האמיתיים (למשל: "לענות ל-5 לידים שממתינים", "להגדיל תקציב ב-₪20 בקמפיין הפעיל").

החזר JSON בלבד (ללא markdown) בפורמט הבא:
{
  "weather_type": "sunny|partly_cloudy|cloudy|rainy|stormy",
  "title_he": "השם בעברית (למשל: שמשי, מעונן חלקית, מעונן, גשום, סוער)",
  "description": "תיאור קצר של מצב השוק (משפט עד שניים)",
  "recommendation": "המלצה פרקטית לבעל העסק (משפט עד שניים)",
  "tasks": [
    { "id": 1, "text": "משימה ראשונה" },
    { "id": 2, "text": "משימה שנייה" },
    { "id": 3, "text": "משימה שלישית" }
  ]
}`;

      const userPrompt = `קטגוריית עסק: ${service || "עסק כללי"}
תאריך: ${dateStr}, יום ${dayNames[now.getDay()]}, שעה ${now.getHours()}:00
נתוני Google Trends (ישראל): ${trendsData}${fbSection}

נתח את מצב השוק עכשיו והחזר את התחזית + 3 משימות יומיות.`;

      console.log("[MarketingWeather] 🤖 Generating Hebrew forecast...");
      const completion = await openai.responses.create({
        model: "gpt-4o",
        input: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        tools: [{ type: "web_search_preview" }],
      });

      const raw = completion.output_text;
      if (!raw) throw new Error("Empty response from OpenAI");

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (_) {
        const match = raw.match(/\{[\s\S]*\}/);
        if (match) parsed = JSON.parse(match[0]);
        else throw new Error("Failed to parse GPT response as JSON");
      }

      const { weather_type, title_he, description, recommendation } = parsed;
      if (!weather_type || !title_he || !description || !recommendation) {
        throw new Error("Missing required fields in GPT response");
      }

      const validTypes = [
        "sunny",
        "partly_cloudy",
        "cloudy",
        "rainy",
        "stormy",
      ];
      const finalType = validTypes.includes(weather_type)
        ? weather_type
        : "partly_cloudy";
      const tasks =
        Array.isArray(parsed.tasks) && parsed.tasks.length === 3
          ? parsed.tasks
          : [
              { id: 1, text: "לבדוק ולענות להודעות שממתינות" },
              { id: 2, text: "לפרסם תוכן חדש ברשתות החברתיות" },
              { id: 3, text: "לבדוק ביצועי מודעות ולבצע אופטימיזציה" },
            ];

      heResult = {
        weather_type: finalType,
        title_he,
        description,
        recommendation,
        tasks,
      };
      await saveToCache(heKey, heResult);

      try {
        await cache.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
      } catch (_) {}
      console.log(
        `[MarketingWeather] ✅ Hebrew generated | ${Date.now() - startTime}ms | weather: ${finalType}`,
      );
    }

    // 6. If Hebrew requested — return as-is
    if (locale === "he") {
      return res.json({
        success: true,
        data: {
          weather_type: heResult.weather_type,
          title_he: heResult.title_he,
          description: heResult.description,
          recommendation: heResult.recommendation,
          tasks: heResult.tasks || [],
          service: service || "כללי",
          generated_at: heResult.generated_at
            ? heResult.generated_at.getTime()
            : now.getTime(),
        },
      });
    }

    // 7. Translate Hebrew result to requested locale
    console.log(`[MarketingWeather] 🌍 Translating to ${locale}...`);
    const localeNames = {
      en: "English",
      fr: "French",
      ar: "Arabic",
      ru: "Russian",
      es: "Spanish",
    };
    const targetLanguage = localeNames[locale] || locale;
    const translatePrompt = `Translate the following JSON fields from Hebrew to ${targetLanguage}.
Keep the exact JSON structure. Only translate the text values of: title_he, description, recommendation, and each task's text.
Do not translate weather_type or id fields. Return JSON only (no markdown).

${JSON.stringify({ title_he: heResult.title_he, description: heResult.description, recommendation: heResult.recommendation, tasks: heResult.tasks })}`;

    const translation = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: translatePrompt }],
      temperature: 0.1,
    });

    let translated;
    try {
      const tRaw = translation.choices[0].message.content;
      translated = JSON.parse(tRaw);
    } catch (_) {
      const tRaw = translation.choices[0].message.content;
      const match = tRaw.match(/\{[\s\S]*\}/);
      translated = match ? JSON.parse(match[0]) : null;
    }

    // Fallback to Hebrew if translation fails
    if (!translated) translated = heResult;

    const localeResult = {
      weather_type: heResult.weather_type,
      title_he: translated.title_he || heResult.title_he,
      description: translated.description || heResult.description,
      recommendation: translated.recommendation || heResult.recommendation,
      tasks: translated.tasks || heResult.tasks,
    };

    // Sync expiry with Hebrew cache so both expire together
    const heExpiresAt =
      heCached?.expires_at ?? new Date(now.getTime() + 3 * 60 * 60 * 1000);
    await saveToCache(localeKey, localeResult, heExpiresAt);
    console.log(
      `[MarketingWeather] ✅ Translated to ${locale} | ${Date.now() - startTime}ms`,
    );

    return res.json({
      success: true,
      data: {
        ...localeResult,
        service: service || "כללי",
        generated_at: now.getTime(),
      },
    });
  } catch (error) {
    const totalMs = Date.now() - startTime;
    console.error(
      `[MarketingWeather] ❌ Error after ${totalMs}ms:`,
      error.message,
    );

    return res.json({
      success: true,
      data: {
        weather_type: "partly_cloudy",
        title_he: "מעונן חלקית",
        description: "השוק יציב ובתנועה - יש הזדמנויות למי שפועל נכון",
        recommendation:
          "לשמור על פעילות קבועה, לחדד מסרים ולחזק נוכחות בסושיאל",
        tasks: [
          { id: 1, text: "לבדוק ולענות להודעות שממתינות" },
          { id: 2, text: "לפרסם תוכן חדש ברשתות החברתיות" },
          { id: 3, text: "לבדוק ביצועי מודעות ולבצע אופטימיזציה" },
        ],
        service: "כללי",
        generated_at: Date.now(),
      },
    });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ai/assistant
// עוזר AI לשאלות — שתי מסלולים לפי requested_question:
//   "generate_logo" → GPT-4o מייצר 3 פרומפטים → Gemini מייצר 3 לוגואים → מערך URLs
//   אחרת          → GPT-4o ממלא שדה בטופס → { response: "..." }
// ─────────────────────────────────────────────────────────────────────────────
exports.aiAssistant = async (req, res) => {
  try {
    const { questions, requested_question, requested_answer = "" } = req.body;

    if (!questions || !requested_question) {
      return res.status(400).json({ error: "questions ו-requested_question הם שדות חובה" });
    }

    const bodyJson = JSON.stringify(req.body, null, 2);

    // ── Route: יצירת לוגואים ──────────────────────────────────────────────────
    if (requested_question === "generate_logo") {
      console.log("[aiAssistant] 🎨 Logo generation flow");

      // שלב 1: GPT-4o מייצר 3 פרומפטים לתמונה
      const rawPrompts = await aiService.generateRawText(LOGO_SYSTEM_PROMPT, bodyJson);

      let imagePrompts;
      try {
        // GPT מחזיר JSON array של [{imagePrompt: "..."}, ...]
        const cleaned = rawPrompts.trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
        imagePrompts = JSON.parse(cleaned);
      } catch (e) {
        console.error("[aiAssistant] ❌ Failed to parse logo prompts:", rawPrompts);
        return res.status(500).json({ error: "Failed to parse logo prompts from GPT" });
      }

      if (!Array.isArray(imagePrompts) || !imagePrompts.length) {
        return res.status(500).json({ error: "GPT did not return valid logo prompts" });
      }

      console.log(`[aiAssistant] 📋 Got ${imagePrompts.length} logo prompts`);

      // שלב 2: Gemini מייצר תמונה לכל פרומפט (סידרתי כדי לא לחרוג ממגבלות)
      const timestamp = Date.now();
      const urls = [];

      for (let i = 0; i < imagePrompts.length; i++) {
        const prompt = imagePrompts[i]?.imagePrompt || imagePrompts[i]?.prompt || "";
        if (!prompt) {
          console.warn(`[aiAssistant] ⚠️ Empty prompt at index ${i}, skipping`);
          continue;
        }

        console.log(`[aiAssistant] 🖼️ Generating logo ${i + 1}/${imagePrompts.length}`);

        const imageResult = await imageAgent.generate(prompt);
        const filePath = `logos/generated/${timestamp}-${i + 1}.png`;
        await backblazeService.uploadImage(filePath, imageResult.buffer, "image/png");

        const proxyUrl = `${SERVER_BASE_URL_AI}/api/img?url=${encodeURIComponent(filePath)}`;
        urls.push({ url: proxyUrl });
        console.log(`[aiAssistant] ✅ Logo ${i + 1} ready: ${proxyUrl}`);
      }

      return res.json(urls);
    }

    // ── Route: מילוי שדה בטופס ────────────────────────────────────────────────
    console.log(`[aiAssistant] 📝 Field assistant flow — field: "${requested_question}"`);

    const rawResponse = await aiService.generateRawText(ASSISTANT_SYSTEM_PROMPT, bodyJson);

    let parsed;
    try {
      const cleaned = rawResponse.trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
      parsed = JSON.parse(cleaned);
    } catch (e) {
      // אם GPT החזיר טקסט ישיר במקום JSON — נעטוף אותו
      parsed = { response: rawResponse.trim() };
    }

    return res.json(parsed);

  } catch (err) {
    console.error("[aiAssistant] ❌ Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
};
