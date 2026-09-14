const { GoogleGenAI } = require("@google/genai");
const fs = require("fs");
const path = require("path");
const { DB } = require("../config/db");
const googleAIConfig = require("../config/google-ai.config");

class ImageGenerationService {
  constructor() {
    this.ai = new GoogleGenAI({
      apiKey: googleAIConfig.apiKey,
    });

    // יצירת תיקייה לשמירת תמונות אם לא קיימת
    this.imagesDir = path.join(__dirname, "..", "generated-images");
    if (!fs.existsSync(this.imagesDir)) {
      fs.mkdirSync(this.imagesDir, { recursive: true });
    }
  }

  async generateImage(description, options = {}) {
    try {
      const prompt = this._buildPrompt(description, options);

      const response = await this.ai.models.generateContent({
        model: googleAIConfig.model,
        contents: prompt,
      });

      const candidate = response.candidates[0];
      if (!candidate || !candidate.content || !candidate.content.parts) {
        throw new Error("Invalid response from Gemini API");
      }

      let imageData = null;
      let imageText = "";

      // חילוץ התמונה והטקסט
      for (const part of candidate.content.parts) {
        if (part.text) {
          imageText = part.text;
        } else if (part.inlineData) {
          imageData = part.inlineData.data;
        }
      }

      if (!imageData) {
        throw new Error("No image data received from Gemini API");
      }

      // שמירת התמונה
      const filename = `${Date.now()}-${this._sanitizeFilename(description)}.png`;
      const filepath = path.join(this.imagesDir, filename);
      const buffer = Buffer.from(imageData, "base64");
      fs.writeFileSync(filepath, buffer);

      // שמירת מידע על התמונה ב-MongoDB
      try {
        await DB.collection("images").insertOne({
          prompt: description,
          imageUrl: filepath,
          createdAt: new Date(),
        });
      } catch (dbError) {
        // מומלץ להוסיף לוגר לתיעוד השגיאה
        console.error("Failed to save image to database:", dbError);
        // אפשר להחליט אם להחזיר שגיאה או להמשיך
      }

      return {
        filename,
        filepath,
        description: imageText,
        size: buffer.length,
        createdAt: new Date().toISOString(),
      };
    } catch (error) {
      throw new Error(`Image generation failed: ${error.message}`);
    }
  }

  /**
   * בניית prompt לגנרציה
   */
  _buildPrompt(description, options) {
    let prompt = description;

    if (options.style) {
      prompt += ` in ${options.style} style`;
    }
    if (options.theme) {
      prompt += ` with a ${options.theme} theme`;
    }
    if (options.quality === "high") {
      prompt += ", high quality, professional photography";
    }

    return prompt;
  }

  /**
   * ניקוי שם קובץ
   */
  _sanitizeFilename(text) {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "-")
      .substring(0, 50);
  }
}

module.exports = new ImageGenerationService();
