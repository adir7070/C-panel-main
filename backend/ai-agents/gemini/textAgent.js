const { GoogleGenAI } = require("@google/genai");
const googleAIConfig = require("../../config/google-ai.config");

const MODEL = "gemini-2.5-flash";

/**
 * יצירת TextAgent עם API Key
 * @param {string} apiKey - API Key ל-Google AI
 * @returns {Object} אובייקט עם מתודות generate ו-chat
 */
const ai = new GoogleGenAI({ apiKey: googleAIConfig.apiKey });

const generate = async (prompt, options = {}) => {
  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: [
        {
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        temperature: options.temperature || 0.7,
        maxOutputTokens: options.maxTokens || 1024,
      },
    });

    if (!response.candidates?.[0]?.content?.parts) {
      throw new Error("Invalid response from Gemini");
    }

    const parts = response.candidates[0].content.parts;
    let text = "";

    for (const part of parts) {
      if (part.text) {
        text += part.text;
      }
    }

    if (!text) {
      throw new Error("No text content received");
    }

    return {
      text,
      prompt,
      model: MODEL,
      tokensUsed: response.usageMetadata?.totalTokenCount || 0,
    };
  } catch (error) {
    console.log({ error });

    throw new Error(`Text generation failed: ${error.message}`);
  }
};

/**
 * שיחה עם הסוכן (מתאים לצ'אט בוטים)
 * @param {string} message - ההודעה
 * @param {Array} history - היסטוריית שיחה (אופציונלי)
 * @returns {Promise<Object>} התשובה
 */
const chat = async (message, history = []) => {
  try {
    const contents = [
      ...history.map((msg) => ({
        role: msg.role,
        parts: [{ text: msg.text }],
      })),
      {
        role: "user",
        parts: [{ text: message }],
      },
    ];

    const response = await ai.models.generateContent({
      model: MODEL,
      contents,
    });

    const text = response.candidates[0].content.parts[0].text;

    return {
      text,
      role: "assistant",
    };
  } catch (error) {
    throw new Error(`Chat failed: ${error.message}`);
  }
};

module.exports = { generate, chat };
