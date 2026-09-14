const { imageAgent } = require("../ai-agents/gemini");

/**
 * פונקציית עזר ליצירת תמונה - משתמשת בסוכן Gemini
 * @param {string} content - התוכן/טקסט הבסיסי
 * @param {string} prompt - הפרומפט הנוסף (אופציונלי)
 * @returns {Promise<Object>} אובייקט עם נתוני התמונה
 */
const generateImage = async (content, prompt = "") => {
  try {
    console.log("🎨 [Gemini] Starting image generation");
    
    // בניית הפרומפט המלא
    let fullPrompt = content;
    if (prompt) {
      fullPrompt = `${content}. ${prompt}`;
    }

    console.log("🎨 [Gemini] Prompt:", fullPrompt.substring(0, 200) + "...");

    // שימוש בסוכן התמונות
    const result = await imageAgent.generate(fullPrompt);

    console.log("✅ [Gemini] Image generated successfully");

    // החזרת התשובה בפורמט אחיד
    return {
      success: true,
      image: {
        buffer: result.buffer,
        base64: result.base64,
        size: result.size,
        mimeType: result.mimeType,
      },
      text: result.description,
      prompt: fullPrompt,
      generatedAt: new Date().toISOString(),
    };
  } catch (error) {
    console.error("❌ [Gemini] Error:", error.message);
    throw new Error(`Image generation failed: ${error.message}`);
  }
};

module.exports = generateImage;
