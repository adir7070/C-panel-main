const express = require("express");
const router = express.Router();
const aiController = require("../controllers/ai.controller");

/**
 * @swagger
 * /api/ai/marketing-weather:
 *
 */
router.post("/spy", aiController.makespy);

/**
 * @swagger
 * /api/ai/whatsapp-lead-message:
 *   post:
 *     summary: Generate a WhatsApp first message from lead data and send it
 *     description: Uses Gemini AI to generate a personalized first WhatsApp message based on Facebook Lead data, then sends it via Green API.
 *     tags: [AI]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, phone]
 *             properties:
 *               lead_id:       { type: string, example: "lead_abc123" }
 *               name:          { type: string, example: "ישראל ישראלי" }
 *               phone:         { type: string, example: "972501234567" }
 *               campaign_name: { type: string, example: "שירותי אינסטלציה" }
 *               ad_name:       { type: string, example: "מודעה 1" }
 *               field_data:
 *                 type: array
 *                 description: Facebook lead form answers
 *                 items:
 *                   type: object
 *                   properties:
 *                     name:   { type: string, example: "city" }
 *                     values: { type: array, items: { type: string }, example: ["תל אביב"] }
 *     responses:
 *       200:
 *         description: Message generated and sent
 *       400:
 *         description: Missing name or phone
 *       500:
 *         description: Server error
 */
router.post("/whatsapp-lead-message", aiController.generateWhatsAppLeadMessage);

/**
 * @swagger
 * /api/ai/lead-message:
 *   post:
 *     summary: Generate a WhatsApp message from lead data (no sending)
 *     description: Same as whatsapp-lead-message but returns the generated text only — does not send.
 *     tags: [AI]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, phone]
 *             properties:
 *               lead_id:       { type: string }
 *               name:          { type: string, example: "ישראל ישראלי" }
 *               phone:         { type: string, example: "972501234567" }
 *               campaign_name: { type: string }
 *               ad_name:       { type: string }
 *               field_data:    { type: array, items: { type: object } }
 *     responses:
 *       200:
 *         description: Generated message text
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string }
 *       400:
 *         description: Missing required fields
 */
router.post("/lead-message", aiController.generateLeadMessage);

/**
 * @swagger
 * /api/ai/generate-text:
 *   post:
 *     summary: Generate general text content with AI
 *     tags: [AI]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               prompt:      { type: string, example: "כתוב פוסט לפייסבוק על שירותי אינסטלציה" }
 *               temperature: { type: number, example: 0.7 }
 *               maxTokens:   { type: integer, example: 500 }
 *     responses:
 *       200:
 *         description: Generated text
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 text: { type: string }
 */
router.post("/generate-text", aiController.generateText);

/**
 * @swagger
 * /api/ai/chat:
 *   post:
 *     summary: Chat with AI (multi-turn conversation)
 *     tags: [AI]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               message:
 *                 type: string
 *                 example: "מה הכלים הטובים ביותר לפרסום בפייסבוק?"
 *               history:
 *                 type: array
 *                 description: Previous conversation turns
 *                 items:
 *                   type: object
 *                   properties:
 *                     role:    { type: string, enum: [user, assistant] }
 *                     content: { type: string }
 *     responses:
 *       200:
 *         description: AI reply
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 reply: { type: string }
 */
router.post("/chat", aiController.chat);

/**
 * @swagger
 * /api/ai/images/create:
 *   post:
 *     summary: Generate an image with AI (returns image directly)
 *     tags: [AI]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               prompt: { type: string, example: "תמונה של שרברב מקצועי בעבודה, סגנון מודרני" }
 *     responses:
 *       200:
 *         description: Image file (PNG/JPEG)
 *         content:
 *           image/png:
 *             schema:
 *               type: string
 *               format: binary
 */
router.post("/images/create", aiController.createImage);

/**
 * @swagger
 * /api/ai/images/create-with-metadata:
 *   post:
 *     summary: Generate an image with AI (returns JSON with base64 + metadata)
 *     tags: [AI]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               prompt: { type: string, example: "תמונה של שרברב מקצועי בעבודה" }
 *     responses:
 *       200:
 *         description: Image metadata and base64 data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 base64:      { type: string, description: "Base64-encoded image" }
 *                 contentType: { type: string, example: "image/png" }
 *                 fileName:    { type: string }
 *                 url:         { type: string, format: uri }
 */
router.post(
  "/images/create-with-metadata",
  aiController.createImageWithMetadata,
);

/**
 * @swagger
 * /api/ai/images:
 *   get:
 *     summary: Get list of generated images
 *     tags: [AI]
 *     responses:
 *       200:
 *         description: List of image records
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 images:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       fileName:    { type: string }
 *                       url:         { type: string }
 *                       created_at:  { type: string, format: date-time }
 */
router.get("/images", aiController.getImages);

/**
 * @swagger
 * /api/ai/image-batch/create:
 *   post:
 *     summary: Start a batch image generation job from Q&A data
 *     description: Async — returns a jobId. Poll /image-batch/status/:jobId for results.
 *     tags: [AI]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               answers:
 *                 type: object
 *                 description: Q&A data used to generate image prompts
 *                 example: { service: "אינסטלציה", style: "מודרני" }
 *               count:
 *                 type: integer
 *                 description: Number of images to generate
 *                 example: 5
 *     responses:
 *       200:
 *         description: Job started
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 jobId:  { type: string }
 *                 status: { type: string, example: "pending" }
 */
router.post("/image-batch/create", aiController.createImageBatchJob);

/**
 * @swagger
 * /api/ai/image-batch/status/{jobId}:
 *   get:
 *     summary: Get image batch job status and results
 *     tags: [AI]
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Job status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 jobId:   { type: string }
 *                 status:  { type: string, enum: [pending, processing, completed, failed] }
 *                 images:  { type: array, items: { type: object } }
 *                 error:   { type: string, nullable: true }
 */
router.get("/image-batch/status/:jobId", aiController.getImageBatchJobStatus);

/**
 * @swagger
 * /api/ai/generate-copy:
 *   post:
 *     summary: Generate ad copy from top Facebook ads
 *     description: Uses leading Facebook ad examples to generate optimized ad copy (headline + body + CTA).
 *     tags: [AI]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               service:   { type: string, example: "אינסטלציה" }
 *               location:  { type: string, example: "תל אביב" }
 *               tone:      { type: string, example: "מקצועי ואמין" }
 *               examples:
 *                 type: array
 *                 description: Reference ads from Facebook (optional)
 *                 items:
 *                   type: object
 *                   properties:
 *                     headline: { type: string }
 *                     body:     { type: string }
 *     responses:
 *       200:
 *         description: Generated ad copy
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 headline:    { type: string }
 *                 body:        { type: string }
 *                 description: { type: string }
 *                 cta:         { type: string }
 */
router.post("/generate-copy", aiController.generateCopy);

/**
 * @swagger
 * /api/ai/regenerate-creative:
 *   post:
 *     summary: Regenerate an ad creative image based on user edit request
 *     description: Downloads the original image, sends it to Gemini with edit instructions (spelling mistakes ignored), uploads the result to storage, and returns the new image URL.
 *     tags: [AI]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [phone, original_image_url, edit_request]
 *             properties:
 *               phone:              { type: string, example: "0501234567" }
 *               original_image_url: { type: string, format: uri, example: "https://example.com/image.jpg" }
 *               edit_request:       { type: string, example: "שנה את הצבע לכחול" }
 *     responses:
 *       200:
 *         description: New image generated and uploaded
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:   { type: boolean }
 *                 image_url: { type: string, format: uri }
 *                 url:       { type: string, format: uri }
 *       400:
 *         description: Missing required fields
 *       500:
 *         description: Server error
 */
router.post("/regenerate-creative", aiController.regenerateCreative);

/**
 * @swagger
 * /api/ai/ad-creative/generate:
 *   post:
 *     summary: Start an ad creative generation job (text + images)
 *     description: Async — generates ad copy AND matching images. Returns jobId. Poll /ad-creative/status/:jobId.
 *     tags: [AI]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               service:  { type: string, example: "אינסטלציה" }
 *               location: { type: string, example: "תל אביב" }
 *               count:    { type: integer, example: 3, description: "Number of ad variations to generate" }
 *     responses:
 *       200:
 *         description: Job started
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 jobId:  { type: string }
 *                 status: { type: string, example: "pending" }
 */
router.post("/ad-creative/generate", aiController.generateAdCreative);
router.post("/ad-creative/v2/generate", aiController.generateAdCreativeV2);

/**
 * @swagger
 * /api/ai/ad-creative/status/{jobId}:
 *   get:
 *     summary: Get ad creative generation job status and results
 *     tags: [AI]
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Job status and generated creatives
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 jobId:     { type: string }
 *                 status:    { type: string, enum: [pending, processing, completed, failed] }
 *                 creatives:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       headline:   { type: string }
 *                       body:       { type: string }
 *                       image_url:  { type: string }
 *                 error:    { type: string, nullable: true }
 */
router.get("/ad-creative/status/:jobId", aiController.getAdCreativeStatus);

/**
 * @swagger
 * /api/ai/logo/create:
 *   post:
 *     summary: Generate a logo image for a business
 *     description: Uses GPT-4o to build an image-generation prompt from brand questionnaire data, then generates the logo with Gemini, uploads it to Backblaze, and returns a proxy URL.
 *     tags: [AI]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [BUSINESS_NAME, BUSINESS_DESCRIPTION, BRAND_VIBE, COLOR_PREFERENCES, AVOID_LIST]
 *             properties:
 *               BUSINESS_NAME:
 *                 type: string
 *                 example: "מוסך כרמל"
 *               BUSINESS_DESCRIPTION:
 *                 type: string
 *                 example: "מוסך לרכבים פרטיים ומסחריים"
 *               BRAND_VIBE:
 *                 type: string
 *                 example: "מקצועי, אמין, טכנולוגי"
 *               COLOR_PREFERENCES:
 *                 type: string
 *                 example: "כחול כהה, כסף"
 *               AVOID_LIST:
 *                 type: string
 *                 example: "אדום, ורוד, פרפרים"
 *     responses:
 *       200:
 *         description: Logo generated and uploaded successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 url:
 *                   type: string
 *                   format: uri
 *                   description: Proxy URL of the generated logo
 *       400:
 *         description: Missing required fields
 *       500:
 *         description: Server error
 */
router.post("/logo/create", aiController.generateLogo);
router.post("/logo/v2/create", aiController.generateLogoV2);

/**
 * @swagger
 * /api/ai/rephrase-message:
 *   post:
 *     summary: Rephrase a support message in a professional customer-service tone
 *     tags: [AI]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [text]
 *             properties:
 *               text: { type: string, example: "אני כועס שעוד לא קיבלתי תשובה!" }
 *     responses:
 *       200:
 *         description: Rephrased message
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 text: { type: string }
 */
router.post("/rephrase-message", aiController.rephraseMessage);

/**
 * @swagger
 * /api/ai/avatar/create:
 *   post:
 *     summary: Generate a personal avatar (photo-based or questionnaire-based)
 *     description: >
 *       Two modes:
 *       1. **photo** — edit the user's uploaded photo into an avatar style.
 *       2. **questionnaire** — build an avatar from descriptive answers.
 *       The result is uploaded to Backblaze and a proxy URL is returned.
 *     tags: [AI]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [phone, mode]
 *             properties:
 *               phone:       { type: string, example: "0501234567" }
 *               mode:        { type: string, enum: [photo, questionnaire] }
 *               style:       { type: string, example: "cartoon", description: "Avatar art style" }
 *               imageBase64: { type: string, description: "Required when mode=photo — base64 of the source image" }
 *               mimeType:    { type: string, example: "image/jpeg", description: "MIME type of imageBase64" }
 *               answers:
 *                 type: object
 *                 description: Required when mode=questionnaire
 *                 properties:
 *                   visualStyle:     { type: string }
 *                   basedOn:         { type: string }
 *                   age:             { type: string }
 *                   gender:          { type: string }
 *                   skinColor:       { type: string }
 *                   hair:            { type: string }
 *                   extraDetails:    { type: string }
 *                   energy:          { type: string }
 *                   clothingStyle:   { type: string }
 *                   framing:         { type: string }
 *                   background:      { type: string }
 *     responses:
 *       200:
 *         description: Avatar generated and uploaded
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:   { type: boolean }
 *                 url:       { type: string, format: uri }
 *       400:
 *         description: Missing required fields
 *       500:
 *         description: Server error
 */
router.post("/avatar/create", aiController.generateAvatar);

/**
 * @swagger
 * /api/ai/avatar/list/{phone}:
 *   get:
 *     summary: Get list of saved avatars for a phone number
 *     tags: [AI]
 *     parameters:
 *       - in: path
 *         name: phone
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: List of avatar URLs
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 urls:    { type: array, items: { type: string, format: uri } }
 */
router.get("/avatar/list/:phone", aiController.listAvatars);

/**
 * @swagger
 * /api/ai/avatar/delete:
 *   delete:
 *     summary: Delete a single avatar file (validated by phone ownership)
 *     tags: [AI]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [phone, fileName]
 *             properties:
 *               phone:    { type: string }
 *               fileName: { type: string, example: "avatar/05.../1234_0.png" }
 *     responses:
 *       200:
 *         description: Avatar deleted
 *       400:
 *         description: Missing phone or fileName
 *       500:
 *         description: Server error or file not found
 */
router.delete("/avatar/delete", aiController.deleteAvatar);

/**
 * @swagger
 * /api/ai/marketing-weather:
 *   post:
 *     summary: Get marketing weather forecast for a business category
 *     description: Analyzes current market conditions using Google Trends and GPT-4o web search, returns a weather metaphor (sunny/partly_cloudy/cloudy/rainy/stormy) with Hebrew description and recommendation.
 *     tags: [AI]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [phone]
 *             properties:
 *               phone: { type: string, example: "0501234567" }
 *     responses:
 *       200:
 *         description: Marketing weather forecast
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     weather_type: { type: string, enum: [sunny, partly_cloudy, cloudy, rainy, stormy] }
 *                     title_he: { type: string, example: "שמשי" }
 *                     description: { type: string }
 *                     recommendation: { type: string }
 *                     service: { type: string }
 *                     generated_at: { type: number }
 *       400:
 *         description: Missing phone
 */
router.post("/marketing-weather", aiController.getMarketingWeather);

// POST /api/ai/assistant — עוזר AI לשאלות + יצירת לוגואים
router.post("/assistant", aiController.aiAssistant);

module.exports = router;
