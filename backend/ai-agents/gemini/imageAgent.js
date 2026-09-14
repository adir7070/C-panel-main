const { GoogleGenerativeAI } = require("@google/generative-ai");

const MODEL = "gemini-3-pro-image-preview";

/**
 * יצירת ImageAgent עם API Key
 * @param {string} apiKey - API Key ל-Google AI
 * @returns {Object} אובייקט עם מתודת generate
 */
const createImageAgent = (apiKey) => {
  const genAI = new GoogleGenerativeAI(apiKey);

  /**
   * יצירת תמונה מטקסט
   * @param {string} prompt - התיאור של התמונה
   * @returns {Promise<Object>} תמונה כ-Buffer ו-base64
   */
  const generate = async (prompt) => {
    try {
      console.log("🎨 [ImageAgent] Starting image generation");
      console.log("🎨 [ImageAgent] Model:", MODEL);
      console.log(
        "🎨 [ImageAgent] Prompt gemini:",
        prompt.substring(0, 200) + "...",
      );

      const model = genAI.getGenerativeModel({ model: MODEL });

      console.log("🎨 [ImageAgent] Calling generateContent...");
      const result = await model.generateContent(prompt);
      const response = await result.response;

      // DEBUG: לוג המבנה המלא
      console.log("🔍 [ImageAgent] Full response keys:", Object.keys(response));
      console.log(
        "🔍 [ImageAgent] Candidates count:",
        response.candidates?.length,
      );

      if (response.candidates && response.candidates.length > 0) {
        const candidate = response.candidates[0];
        console.log("🔍 [ImageAgent] Candidate keys:", Object.keys(candidate));
        console.log(
          "🔍 [ImageAgent] Content keys:",
          Object.keys(candidate.content || {}),
        );

        if (candidate.content?.parts) {
          console.log(
            "🔍 [ImageAgent] Parts count:",
            candidate.content.parts.length,
          );
          candidate.content.parts.forEach((part, i) => {
            console.log(`🔍 [ImageAgent] Part ${i} keys:`, Object.keys(part));
            if (part.text) {
              console.log(
                `🔍 [ImageAgent] Part ${i} text preview:`,
                part.text.substring(0, 100),
              );
            }
            if (part.inlineData) {
              console.log(
                `🔍 [ImageAgent] Part ${i} has inlineData! Type:`,
                part.inlineData.mimeType,
              );
              console.log(
                `🔍 [ImageAgent] Part ${i} data length:`,
                part.inlineData.data?.length || 0,
              );
            }
          });
        }
      }

      // וולידציה
      if (!response.candidates?.[0]?.content?.parts) {
        console.error("❌ [ImageAgent] Invalid response structure");
        throw new Error("Invalid response from Gemini");
      }

      // חילוץ התמונה
      const parts = response.candidates[0].content.parts;
      let imageData = null;
      let description = "";

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (part.text) {
          description = part.text;
        }
        if (part.inlineData) {
          imageData = part.inlineData.data;
          console.log("✅ [ImageAgent] Found inlineData in part", i);
        }
      }

      if (!imageData) {
        console.error("❌ [ImageAgent] No image data found!");
        console.error(
          "❌ [ImageAgent] Response structure:",
          JSON.stringify(response, null, 2),
        );
        throw new Error("No image data received (Model returned text instead)");
      }

      const buffer = Buffer.from(imageData, "base64");
      console.log(
        "✅ [ImageAgent] Image generated successfully, size:",
        buffer.length,
      );

      return {
        buffer,
        base64: imageData,
        size: buffer.length,
        mimeType: "image/png",
        description,
      };
    } catch (error) {
      console.error("❌ [ImageAgent] Error:", error.message);
      if (error.stack) {
        console.error("❌ [ImageAgent] Stack:", error.stack);
      }
      throw new Error(`Image generation failed: ${error.message}`);
    }
  };

  /**
   * עריכת תמונה קיימת לפי הנחיית משתמש
   * @param {string} imageBase64   - התמונה המקורית בפורמט base64
   * @param {string} mimeType      - סוג הקובץ (image/jpeg, image/png...)
   * @param {string} instructions  - בקשת השינוי מהמשתמש (מתעלם משגיאות כתיב)
   * @returns {Promise<{ buffer, base64, size, mimeType, description }>}
   */
  const edit = async (imageBase64, mimeType, instructions) => {
    try {
      console.log(`✏️  [ImageAgent.edit] instructions: "${instructions}"`);
      console.log(`✏️  [ImageAgent.edit] mimeType: ${mimeType}`);

      const model = genAI.getGenerativeModel({ model: MODEL });

      const prompt =
        `אתה עורך תמונות מקצועי לקריאייטיב פרסומי. התמונה המצורפת היא קריאייטיב קיים.` +
        `\n\nבקשת הלקוח: "${instructions}"` +
        `\n\nהנחיות:` +
        `\n- התעלם לחלוטין משגיאות כתיב ואיות — הבן את הכוונה` +
        `\n- בצע את השינויים שהלקוח ביקש (טקסט, צבע, עיצוב, מיקום וכו')` +
        `\n- שמור על סגנון ואיכות הקריאייטיב המקורי` +
        `\n- החזר תמונה ברזולוציה מלאה ובאיכות גבוהה`;

      console.log(
        `✏️  [ImageAgent.edit] Calling generateContent with image + prompt...`,
      );
      const result = await model.generateContent([
        { inlineData: { mimeType, data: imageBase64 } },
        prompt,
      ]);
      const response = await result.response;

      console.log(
        `🔍 [ImageAgent.edit] Candidates: ${response.candidates?.length}`,
      );

      if (!response.candidates?.[0]?.content?.parts) {
        console.error("❌ [ImageAgent.edit] Invalid response structure");
        throw new Error("Invalid response from Gemini");
      }

      const parts = response.candidates[0].content.parts;
      let imageData = null;
      let description = "";

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (part.text) description = part.text;
        if (part.inlineData) {
          imageData = part.inlineData.data;
          console.log(
            `✅ [ImageAgent.edit] Found inlineData in part[${i}], type: ${part.inlineData.mimeType}`,
          );
        }
      }

      if (!imageData) {
        console.error("❌ [ImageAgent.edit] No image data found in response");
        throw new Error("No image data received from Gemini");
      }

      const buffer = Buffer.from(imageData, "base64");
      const resultMimeType =
        response.candidates[0].content.parts.find((p) => p.inlineData)
          ?.inlineData?.mimeType || "image/png";

      console.log(`✅ [ImageAgent.edit] Done. size: ${buffer.length} bytes`);

      return {
        buffer,
        base64: imageData,
        size: buffer.length,
        mimeType: resultMimeType,
        description,
      };
    } catch (error) {
      console.error("❌ [ImageAgent.edit] Error:", error.message);
      if (error.stack)
        console.error("❌ [ImageAgent.edit] Stack:", error.stack);
      throw new Error(`Image edit failed: ${error.message}`);
    }
  };

  /**
   * יצירת תמונה חדשה מריבוי תמונות קיימות (לוגו + אווטאר + תמונת בסיס וכו')
   * @param {Array<{ base64: string, mimeType: string }>} imageParts - תמונות הקלט
   * @param {string} systemInstruction - הנחיית המערכת (פרומפט + ניתוח אתר)
   * @returns {Promise<{ buffer, base64, size, mimeType, description }>}
   */
  const editWithAssets = async (imageParts, systemInstruction, userMessage) => {
    try {
      console.log(
        `🖼️ [ImageAgent.editWithAssets] ${imageParts.length} image parts, system: "${systemInstruction.substring(0, 80)}..."`,
      );

      const model = genAI.getGenerativeModel({
        model: MODEL,
        systemInstruction,
      });

      const contentParts = [];
      if (userMessage) {
        contentParts.push({ text: userMessage });
      }
      imageParts.forEach((p) => {
        contentParts.push({ inlineData: { mimeType: p.mimeType, data: p.base64 } });
      });

      const result = await model.generateContent({
        contents: [{ role: "user", parts: contentParts }],
      });
      const response = await result.response;

      if (!response.candidates?.[0]?.content?.parts) {
        throw new Error("Invalid response from Gemini");
      }

      const responseParts = response.candidates[0].content.parts;
      let imageData = null;
      let description = "";

      for (const part of responseParts) {
        if (part.text) description = part.text;
        if (part.inlineData) {
          imageData = part.inlineData.data;
        }
      }

      if (!imageData) {
        throw new Error("No image data received from Gemini");
      }

      const buffer = Buffer.from(imageData, "base64");
      const resultMimeType =
        responseParts.find((p) => p.inlineData)?.inlineData?.mimeType ||
        "image/png";

      console.log(
        `✅ [ImageAgent.editWithAssets] Done. size: ${buffer.length} bytes`,
      );

      return {
        buffer,
        base64: imageData,
        size: buffer.length,
        mimeType: resultMimeType,
        description,
      };
    } catch (error) {
      console.error("❌ [ImageAgent.editWithAssets] Error:", error.message);
      throw new Error(`Image edit with assets failed: ${error.message}`);
    }
  };

  return {
    generate,
    edit,
    editWithAssets,
  };
};

module.exports = createImageAgent;
