const createImageAgent = require("./imageAgent");
const createTextAgent = require("./textAgent");
const googleAIConfig = require("../../config/google-ai.config");

/**
 * ייצוא מרכזי של סוכני Gemini
 * שימוש פשוט: const { imageAgent, textAgent } = require('./ai-agents/gemini');
 */

// יצירת instances של הסוכנים עם API Key
const imageAgent = createImageAgent(googleAIConfig.apiKey);
const textAgent = createTextAgent;

module.exports = {
  imageAgent,
  textAgent,
  createImageAgent, // אם צריך ליצור instance חדש
  createTextAgent, // אם צריך ליצור instance חדש
};
