const axios = require("axios");
const { OpenAI } = require("openai");
const { DB } = require("../config/db");
const extractSiteContent = require("../utils/extractSiteContent");

const googleAIConfig = require("../config/google-ai.config");
const instagramConfig = require("../config/instagram.config");
const backblazeService = require("./backblaze.service");

const openai = new OpenAI({ apiKey: process.env.OpenAI_API_KEY });

/**
 * Validates the input data for post generation.
 * @param {Object} data
 * @returns {Array} errors
 */
const validatePostData = (data) => {
  const errors = [];
  if (!data.subject) errors.push("Missing 'subject'");
  if (!data.platform && !data.postType)
    errors.push("Missing 'platform' or 'postType'");
  return errors;
};

/**
 * Generates content using OpenAI.
 * Expected to return JSON with 'description' and 'gemini_prompt'.
 */
const generateContentOpenAI = async (jobId, prompt, images = []) => {
  try {
    console.log(`[${jobId}] [OpenAI] Starting text generation`);
    console.log(
      `[${jobId}] [OpenAI] System prompt length: ${instagramConfig.PROMPTS.GENERATE_POST_SYSTEM.length} chars`,
    );
    console.log(
      `[${jobId}] [OpenAI] User prompt length: ${prompt.length} chars`,
    );
    console.log(`[${jobId}] [OpenAI] Images attached: ${images.length}`);

    const messages = [
      {
        role: "system",
        content: "You are a creative social media manager. Output JSON only.",
      },
      {
        role: "user",
        content: [{ type: "text", text: prompt }],
      },
    ];

    if (images && images.length > 0) {
      images.forEach((img, idx) => {
        let base64Data = img.base64;
        let mimeType = img.mimeType || "image/png";

        // Parse IMTBuffer string if present
        if (
          typeof base64Data === "string" &&
          base64Data.startsWith("IMTBuffer")
        ) {
          try {
            const colonIndex = base64Data.indexOf(":");
            if (colonIndex !== -1) {
              let hexString = base64Data.substring(colonIndex + 1).trim();
              hexString = hexString.replace(/[^0-9a-fA-F]/g, "");

              if (hexString.length > 0) {
                const buffer = Buffer.from(hexString, "hex");
                base64Data = buffer.toString("base64");

                if (hexString.startsWith("89504E47")) {
                  mimeType = "image/png";
                } else if (hexString.startsWith("FFD8")) {
                  mimeType = "image/jpeg";
                }

                console.log(
                  `[${jobId}] [OpenAI] Parsed IMTBuffer ${idx}: ${hexString.length} hex -> ${base64Data.length} base64 chars`,
                );
              }
            }
          } catch (parseError) {
            console.error(
              `[${jobId}] [OpenAI] Error parsing IMTBuffer:`,
              parseError.message,
            );
          }
        }

        console.log(
          `[${jobId}] [OpenAI] Attaching image ${idx}: ${mimeType}, ${base64Data ? base64Data.length : 0} chars`,
        );

        messages[1].content.push({
          type: "image_url",
          image_url: {
            url: `data:${mimeType};base64,${base64Data}`,
          },
        });
      });
    }

    console.log(`[${jobId}] [OpenAI] Calling GPT-4o...`);
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: messages,
      response_format: { type: "json_object" },
    });

    const result = completion.choices[0].message.content;
    console.log(
      `[${jobId}] [OpenAI] ✅ Response received (${result.length} chars)`,
    );
    console.log(
      `[${jobId}] [OpenAI] Response preview: ${result.substring(0, 100)}...`,
    );

    return {
      content: result,
      usage: completion.usage,
      prompt: prompt,
      model: "gpt-4o",
    };
  } catch (error) {
    console.error(`[${jobId}] [OpenAI] ❌ Error:`, error.message);
    throw new Error("Failed to generate text with OpenAI");
  }
};

/**
 * Generates an image using Gemini (Imagen or Flash fallback).
 */
const fs = require("fs");
const path = require("path");
const generateImage = require("../utils/generateImage");

/**
 * Generates an image using Gemini (Imagen or Flash fallback).
 */
const generateImageGemini = async (jobId, prompt) => {
  try {
    console.log(
      `[${jobId}] [Gemini] Using model: gemini-2.0-flash-exp-image-generation`,
    );

    const imageResult = await generateImage(prompt);

    const imagesDir = path.join(__dirname, "..", "generated-images");
    if (!fs.existsSync(imagesDir)) {
      fs.mkdirSync(imagesDir, { recursive: true });
    }

    const filename = `instagram-${Date.now()}.png`;
    const filepath = path.join(imagesDir, filename);

    fs.writeFileSync(filepath, imageResult.image.buffer);
    console.log(`[${jobId}] [Gemini] Image saved locally: ${filepath}`);

    return {
      image_path: filepath,
      image_filename: filename,
      buffer: imageResult.image.buffer,
      mime_type: imageResult.image.mimeType,
      note: "Image generated successfully and saved locally.",
    };
  } catch (error) {
    console.error(`[${jobId}] [Gemini] Error generating image:`, error.message);
    return { error: "Image generation failed", details: error.message };
  }
};

/**
 * Main function to generate a social media post.
 * @param {Object} data
 */
const generatePost = async (data) => {
  console.log("Starting post generation for:", data);

  // 1. Validate Input
  const errors = validatePostData(data);
  if (errors.length > 0) {
    throw new Error(`Validation failed: ${errors.join(", ")}`);
  }

  // Derive Platform if missing
  if (!data.platform && data.postType) {
    if (data.postType.toLowerCase().includes("instagram")) {
      data.platform = "Instagram";
    } else if (data.postType.toLowerCase().includes("facebook")) {
      data.platform = "Facebook";
    } else {
      data.platform = "Instagram"; // Default
    }
  }

  // Generate a random Job ID
  const jobId = Math.random().toString(36).substring(7);

  // Create Job in DB (Direct MongoDB Driver)
  try {
    if (DB.isInitialized()) {
      await DB.collection("instagram_jobs").insertOne({
        jobId: jobId,
        status: "pending",
        data: data,
        created_at: new Date(),
      });
    } else {
      console.warn("DB not connected, job not saved to DB.");
    }
  } catch (dbError) {
    console.error("Failed to create job in DB:", dbError);
  }

  backgroundProcess(jobId, data).catch((err) =>
    console.error(`Background job ${jobId} failed:`, err),
  );

  return {
    success: true,
    jobId: jobId,
    message: "Post generation started in background",
  };
};

const backgroundProcess = async (jobId, data) => {
  console.log(`Job ${jobId} Background processing started`);

  try {
    if (DB.isInitialized())
      await DB.collection("instagram_jobs").updateOne(
        { jobId },
        { $set: { status: "processing" } }
      );

    // --- Step 1: Storage Preparation (Backblaze) ---
    let storageDetails = {};
    const phone = data.phone;

    // --- Step 2: Facebook Context ---
    const pageId = data.pageId;
    const token = data.token;
    let brandProfileJson = "{}";
    let facebookContentAnalysisJson = "[]";
    // Parsing omitted for brevity

    // --- Step 3: Prepare Prompt ---
    const userAnswers = {
      subject: data.subject,
      postType: data.postType,
      valueType: data.valueType,
      customerStage: data.customerStage,
      tone: data.tone,
      hook: data.hook,
      cta: data.cta,
      postCount: data.postCount,
      phone: data.phone,
      pageid: data.pageId,
      logo: data.logo,
      image_to_add: data.image_to_add,
    };

    // Handle Input Images for OpenAI Vision
    const imageParts = [];
    if (data.logo && data.logo.data) {
      let base64Data = data.logo.data;
      if (
        typeof base64Data === "string" &&
        base64Data.startsWith("IMTBuffer")
      ) {
        // cleaning logic if needed
      }
      imageParts.push({
        base64: base64Data,
        mimeType: data.logo.mime || "image/png",
      });
      userAnswers.image_0 = "image_0";
    }

    // --- Site Context ---
    const siteContext = data.site ? await extractSiteContent(data.site) : "";

    console.log(`[${jobId}] [OpenAI] Step 2: Preparing prompt...`);
    const finalPrompt = `
${instagramConfig.PROMPTS.GENERATE_POST_SYSTEM}

Input Data:
brand_profile_json: ${brandProfileJson}
facebook_content_analysis_json: ${facebookContentAnalysisJson}
user_answers: ${JSON.stringify(userAnswers)}${siteContext ? `\nsite_context: ${siteContext}` : ""}
`;

    // --- Step 3: Text Generation (OpenAI) ---
    console.log(`[${jobId}] █ Step 3: Generating text with OpenAI...`);
    const openAIResult = await generateContentOpenAI(
      jobId,
      finalPrompt,
      imageParts,
    );
    let parsedResult = {};
    try {
      parsedResult = JSON.parse(openAIResult.content);
      console.log(`[${jobId}] [OpenAI] Parsed JSON successfully`);
      console.log(
        `[${jobId}] 📝 OpenAI result keys:`,
        Object.keys(parsedResult),
      );
    } catch (e) {
      console.warn(
        `[${jobId}] [OpenAI] ⚠️ JSON Parse failed, using raw response`,
      );
      parsedResult = { raw: openAIResult.content };
    }
    // --- Step 4: Image Generation (Gemini) ---
    console.log(`[${jobId}] █ Step 4: Preparing for image generation...`);
    let imageResult = null;
    let geminiDetails = {};

    if (parsedResult.gemini_prompt) {
      console.log(
        `[${jobId}] [Gemini] Prompt received from OpenAI (${parsedResult.gemini_prompt.length} chars)`,
      );
      console.log(
        `[${jobId}] [Gemini] Full prompt to Gemini:`,
        parsedResult.gemini_prompt,
      );
      console.log(
        `[${jobId}] [Gemini] Description text (Hebrew):`,
        parsedResult.description,
      );
      geminiDetails.prompt = parsedResult.gemini_prompt;

      try {
        console.log(`[${jobId}] [Gemini] Calling generateImageGemini...`);
        imageResult = await generateImageGemini(
          jobId,
          parsedResult.gemini_prompt,
        );
        geminiDetails.success = true;

        console.log(
          `[${jobId}] 🖼️ Image result keys:`,
          Object.keys(imageResult),
        );
        console.log(`[${jobId}] 🖼️ Has buffer:`, !!imageResult.buffer);
        console.log(`[${jobId}] 🖼️ Buffer length:`, imageResult.buffer?.length);
        console.log(`[${jobId}] 🖼️ Filename:`, imageResult.image_filename);

        if (imageResult && !imageResult.error) {
          console.log(`[${jobId}] [Gemini] ✅ Image generated successfully`);

          // --- Step 5: Upload to Backblaze ---
          if (imageResult.buffer && phone) {
            console.log(`[${jobId}] █ Step 5: Uploading image to Backblaze...`);
            console.log(
              `[${jobId}] 📤 Upload params - Phone: "${phone}", Filename: "${imageResult.image_filename}"`,
            );
            try {
              const fullPath = `post/${phone}/${imageResult.image_filename}`;
              const uploadResult = await backblazeService.uploadImage(
                fullPath,
                imageResult.buffer,
                imageResult.mime_type,
              );

              storageDetails.fileId = uploadResult.fileId;
              storageDetails.fileName = uploadResult.fileName;
              storageDetails.publicUrl = uploadResult.publicUrl;
              storageDetails.contentUrl = uploadResult.contentUrl;

              console.log(
                `[${jobId}] [Backblaze] ✅ Uploaded file: ${uploadResult.fileName}`,
              );
              console.log(
                `[${jobId}] [Backblaze] Public URL: ${uploadResult.publicUrl}`,
              );
            } catch (uploadErr) {
              console.error(
                `[${jobId}] [Backblaze] ❌ Upload failed:`,
                uploadErr.message,
              );
              console.error(`[${jobId}] [Backblaze] Full error:`, uploadErr);
              storageDetails.uploadError = uploadErr.message;
            }
          } else if (!phone) {
            console.log(
              `[${jobId}] [Backblaze] ⚠️ No phone number, skipping upload`,
            );
            console.log(`[${jobId}] [Backblaze] Phone value:`, phone);
          }
        } else {
          console.error(
            `[${jobId}] [Gemini] ❌ Image generation returned error:`,
            imageResult?.error,
          );
          geminiDetails.error = imageResult?.error || "Unknown error";
          geminiDetails.details = imageResult?.details;
        }
      } catch (geminiErr) {
        console.error(
          `[${jobId}] [Gemini] ❌ Exception during image generation:`,
          geminiErr.message,
        );
        geminiDetails.error = geminiErr.message;
      }
    } else {
      console.log(
        `[${jobId}] [Gemini] No gemini_prompt in OpenAI response, skipping image generation`,
      );
    }

    // --- Step 6: Save Results ---
    console.log(`[${jobId}] █ Step 6: Saving results to database...`);
    if (DB.isInitialized()) {
      await DB.collection("instagram_jobs").updateOne(
        { jobId },
        {
          $set: {
            status: "completed",
            completed_at: new Date(),
            result: parsedResult,
            openai_details: {
              model: openAIResult.model,
              usage: openAIResult.usage,
              prompt_length: openAIResult.prompt.length,
            },
            gemini_details: geminiDetails,
            storage_details: storageDetails,
            generated_image: imageResult
              ? {
                  image_path: imageResult.image_path,
                  image_filename: imageResult.image_filename,
                  mime_type: imageResult.mime_type,
                  note: imageResult.note,
                  error: imageResult.error,
                  details: imageResult.details,
                }
              : null,
          },
        },
      );
      console.log(`[${jobId}] ✅ Job completed successfully`);
    }
  } catch (error) {
    console.error(`[${jobId}] Background Process Error:`, error);
    if (DB.isInitialized()) {
      await DB.collection("instagram_jobs").updateOne(
        { jobId },
        {
          $set: {
            status: "failed",
            error: error.message,
          },
        },
      );
    }
  }
};

// --- Helper Functions ---

const postToFacebook = async (content, imageUrl) => {
  // Placeholder
};

// IGAF/IGQA tokens use the direct Instagram API base, otherwise Graph API
const getIgBase = (token) =>
  token.startsWith("IGAF") || token.startsWith("IGQA")
    ? "https://graph.instagram.com/v21.0"
    : `https://graph.facebook.com/${process.env.FACEBOOK_API_VERSION || "v23.0"}`;

// Publish a container with retry for error 9007 (media not ready)
const publishWithRetry = async (base, igId, creationId, token, maxRetries = 5) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await axios.post(`${base}/${igId}/media_publish`, null, {
        params: { creation_id: creationId, access_token: token },
      });
      return res.data.id;
    } catch (err) {
      const code = err.response?.data?.error?.code;
      if (code === 9007 && attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      throw err;
    }
  }
};

// Fetch permalink after publish
const getPermalink = async (base, mediaId, token) => {
  try {
    const res = await axios.get(`${base}/${mediaId}`, {
      params: { fields: "permalink", access_token: token },
    });
    return res.data.permalink || null;
  } catch {
    return null;
  }
};

/**
 * Publish a single photo to Instagram via Graph API.
 * 3-step flow: create container → publish (with retry) → fetch permalink
 */
const publishPhoto = async (token, igId, imageUrl, caption) => {
  const base = getIgBase(token);

  const container = await axios.post(`${base}/${igId}/media`, null, {
    params: { image_url: imageUrl, caption, access_token: token },
  });
  const creationId = container.data.id;

  const postId = await publishWithRetry(base, igId, creationId, token);
  const permalink = await getPermalink(base, postId, token);

  return { postId, permalink };
};

/**
 * Publish a carousel (up to 10 images) to Instagram via Graph API.
 * Step 1: create item containers → Step 2: create carousel container → Step 3: publish with retry
 */
const publishCarousel = async (token, igId, imageUrls, caption) => {
  const base = getIgBase(token);

  const childIds = await Promise.all(
    imageUrls.map((url) =>
      axios
        .post(`${base}/${igId}/media`, null, {
          params: { image_url: url, is_carousel_item: true, access_token: token },
        })
        .then((r) => r.data.id)
    )
  );

  const carousel = await axios.post(`${base}/${igId}/media`, null, {
    params: {
      media_type: "CAROUSEL",
      children: childIds.join(","),
      caption,
      access_token: token,
    },
  });

  const postId = await publishWithRetry(base, igId, carousel.data.id, token);
  const permalink = await getPermalink(base, postId, token);

  return { postId, permalink };
};

const getJob = async (jobId) => {
  if (!DB.isInitialized()) return null;
  return await DB.collection("instagram_jobs").findOne({ jobId: jobId });
};

module.exports = {
  generatePost,
  generateContentOpenAI,
  generateImageGemini,
  postToFacebook,
  publishPhoto,
  publishCarousel,
  getJob,
};
