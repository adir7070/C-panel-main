module.exports = {
  apiKey: process.env.GOOGLE_AI_API_KEY,
  model: "gemini-3-pro-image-preview",
  // No default: the old Make.com hook belonged to Iconiq. Unset = no webhook.
  webhookUrl: process.env.WEBHOOK_URL || null,
};
