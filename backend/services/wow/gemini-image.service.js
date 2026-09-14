const { GoogleGenAI, Modality } = require("@google/genai");
const OpenAI = require("openai");
const sharp = require("sharp");
const crypto = require("crypto");
const path = require("path");
const backblazeService = require("../backblaze.service");

const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_AI_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OpenAI_API_KEY });

/**
 * Step 1: OpenAI writes an expert image prompt (like CampaignMaster's nanobanana.service)
 * This is the key to better images — AI writes better prompts than hardcoded templates
 */
const generateSmartImagePrompt = async (
  fieldEn,
  businessName,
  role,
  sizeDesc,
  aspect,
  services,
  about,
  designStyle,
) => {
  const prompt = `You are an expert commercial photographer and art director.
Write ONE single-line English prompt for an AI image generator (Gemini) to create a stunning photograph.

Business: "${businessName}" — a ${fieldEn} business.
${services ? `Services: ${services}` : ''}
${about ? `About: ${about}` : ''}
Image role: ${role} (${sizeDesc})
Aspect ratio: ${aspect}
Design style of the website: ${designStyle}

Rules:
- Single line, no quotes, no newlines
- Describe a realistic, professional photograph — NOT illustration, NOT cartoon
- The subject MUST be directly related to ${fieldEn}
- Bright, well-lit, warm, inviting — commercial photography quality
- NO text, NO words, NO logos in the image
- Include specific details: lighting direction, color palette, composition, mood
- Match the "${designStyle}" design aesthetic in color grading and mood`;

  try {
    // Use gpt-5 responses API — same as CampaignMaster ads (higher quality)
    const r = await openai.responses.create({
      model: 'gpt-5',
      input: prompt,
    });
    const result = (r.output_text || '').replace(/\s+/g, ' ').trim();
    console.log(`✦ [SmartPrompt] ${role}: ${result.substring(0, 80)}...`);
    return result;
  } catch (err) {
    console.error('[SmartPrompt] gpt-5 failed, trying gpt-4o:', err);
    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: prompt }],
        max_completion_tokens: 200,
      });
      return (response.choices[0]?.message?.content || '').replace(/\s+/g, ' ').trim();
    } catch {
      return `Professional photograph for a ${fieldEn} business, ${sizeDesc}, ${aspect}, bright natural lighting, commercial quality, no text no logos`;
    }
  }
};

// גדלי תמונה לפי תפקיד
const SIZE_HINTS = {
  'hero-bg':  { desc: 'wide banner background', aspect: 'landscape 16:9' },
  'hero-img': { desc: 'hero section image', aspect: 'landscape 3:2' },
  'about-img': { desc: 'about section portrait', aspect: 'square 1:1' },
  'p1-img': { desc: 'product showcase', aspect: 'portrait 3:4' },
  'p2-img': { desc: 'product showcase', aspect: 'portrait 3:4' },
  'p3-img': { desc: 'product showcase', aspect: 'portrait 3:4' },
  'p4-img': { desc: 'product showcase', aspect: 'portrait 3:4' },
  't1-img': { desc: 'person portrait headshot', aspect: 'square 1:1' },
  't2-img': { desc: 'person portrait headshot', aspect: 'square 1:1' },
  't3-img': { desc: 'person portrait headshot', aspect: 'square 1:1' },
  'bl1-img': { desc: 'blog article cover', aspect: 'landscape 16:9' },
  'bl2-img': { desc: 'blog article cover', aspect: 'landscape 16:9' },
  'bl3-img': { desc: 'blog article cover', aspect: 'landscape 16:9' },
  'g1-img': { desc: 'gallery photo', aspect: 'landscape 4:3' },
  'g2-img': { desc: 'gallery photo', aspect: 'landscape 4:3' },
  'g3-img': { desc: 'gallery photo', aspect: 'landscape 4:3' },
  'team1-img': { desc: 'team member portrait', aspect: 'portrait 3:4' },
  'team2-img': { desc: 'team member portrait', aspect: 'portrait 3:4' },
  'team3-img': { desc: 'team member portrait', aspect: 'portrait 3:4' },
};

function getImageRole(key) {
  if (key.startsWith('hero')) return 'hero/banner';
  if (key.startsWith('about')) return 'about section';
  if (key.startsWith('bl') || key.startsWith('blog')) return 'blog';
  if (key.match(/^t\d+-img/)) return 'testimonial person';
  if (key.startsWith('team')) return 'team member';
  if (key.startsWith('g')) return 'gallery';
  if (key.startsWith('p')) return 'product';
  if (key.startsWith('d')) return 'destination/location';
  if (key.startsWith('tr')) return 'treatment/service';
  return 'general';
}

/**
 * יוצר תמונה עם Gemini על פי תחום העסק ותפקיד התמונה
 */
const generateImage = async (
  businessField,
  businessName,
  imageKey,
  sessionId,
  briefContext,
) => {
  const role = getImageRole(imageKey);
  const sizeHint = SIZE_HINTS[imageKey] || { desc: 'website section image', aspect: 'landscape 16:9' };
  const aspect = briefContext?.aspectHint || sizeHint.aspect;

  // Translate business field to English for better image generation
  const FIELD_EN = {
    'טיפוח ויופי': 'beauty salon and skincare', 'סלון יופי': 'beauty salon',
    'קוסמטיקה': 'cosmetics and beauty', 'טיפולי פנים': 'facial treatments',
    'עיצוב אופנה': 'fashion design studio', 'אופנה': 'high fashion editorial',
    'גינון': 'landscaping and garden design', 'גינון ונוף': 'landscaping',
    'מסעדה': 'restaurant and fine dining', 'בית קפה': 'cafe', 'קייטרינג': 'catering',
    'עורך דין': 'law firm', 'נדלן': 'real estate', 'ביטוח': 'insurance',
    'כושר': 'fitness and gym', 'יוגה': 'yoga studio', 'ספא': 'spa and wellness',
    'רפואה': 'medical clinic', 'רופא שיניים': 'dental clinic',
    'תיירות': 'tourism and travel', 'סוכן נסיעות': 'travel agency',
    'טכנולוגיה': 'technology', 'הייטק': 'tech startup',
    'חינוך': 'education', 'צילום': 'photography studio',
    'עיצוב פנים': 'interior design', 'אדריכלות': 'architecture',
    'מגזין': 'fashion and culture magazine editorial', 'מגזין דיגיטלי': 'digital fashion magazine',
    'בר': 'cocktail bar and lounge', 'בר קוקטיילים': 'luxury cocktail bar',
    'מלון': 'luxury hotel', 'אירועים': 'events and celebrations',
    'חתונות': 'weddings', 'פרחים': 'flower shop and floral design',
    'תכשיטים': 'jewelry', 'שעונים': 'luxury watches',
    'מוזיקה': 'music studio', 'DJ': 'DJ and music events',
    'עוגות': 'cake design and pastry', 'קונדיטוריה': 'pastry and bakery',
    'בגדים': 'clothing and fashion retail', 'נעליים': 'shoe design',
  };
  // Try exact match, then partial match, then use businessName as hint
  const fieldEn = FIELD_EN[businessField]
    || Object.entries(FIELD_EN).find(([k]) => businessField.includes(k))?.[1]
    || Object.entries(FIELD_EN).find(([k]) => k.includes(businessField))?.[1]
    || `${businessField} (${businessName})`;

  // Step 1: OpenAI writes expert image prompt (2-step method from CampaignMaster)
  const prompt = await generateSmartImagePrompt(
    fieldEn,
    businessName,
    role,
    sizeHint.desc,
    aspect,
    briefContext?.services?.substring(0, 150) || '',
    briefContext?.about?.substring(0, 120) || '',
    briefContext?.designStyle || 'modern',
  );

  try {
    const response = await ai.models.generateContent({
      model: process.env.GEMINI_IMAGE_MODEL || 'gemini-3-pro-image-preview',
      contents: prompt,
      config: {
        responseModalities: [Modality.IMAGE, Modality.TEXT],
      },
    });

    // חילוץ התמונה מהתשובה
    const parts = response.candidates?.[0]?.content?.parts;
    if (!parts) throw new Error('No response parts');

    for (const part of parts) {
      if (part.inlineData) {
        const imageData = part.inlineData.data;

        if (typeof imageData === 'string') {
          const rawBuffer = Buffer.from(imageData, 'base64');
          const filename = `${imageKey}-${Date.now()}.webp`;
          let finalBuffer;
          try {
            const isHero = imageKey.startsWith('hero');
            finalBuffer = await sharp(rawBuffer)
              .resize(isHero ? 1920 : 1200, isHero ? 1080 : 800, { fit: 'inside', withoutEnlargement: true })
              .webp({ quality: isHero ? 90 : 82 })
              .toBuffer();
          } catch {
            // fallback — save raw if sharp fails
            finalBuffer = rawBuffer;
          }
          const upload = await backblazeService.uploadImage(
            `wow/generated/${sessionId}/${filename}`,
            finalBuffer,
            'image/webp',
          );
          return upload.publicUrl;
        }
      }
    }

    throw new Error('No image data in response');
  } catch (err) {
    console.error(`Gemini image generation failed for ${imageKey}:`, err);
    throw err;
  }
};

/**
 * מסיר רקע מלוגו דרך Gemini — מחזיר URL ל-PNG נקי
 * אם נכשל, מחזיר null בשקט (fallback ללוגו המקורי)
 */
const removeLogoBackground = async (logoPath) => {
  try {
    // logoPath is a Backblaze path like wow/briefs/<briefId>/<filename>
    const { buffer: fileBuffer } = await backblazeService.downloadImageByPath(logoPath);
    const ext = path.extname(logoPath).toLowerCase().replace('.', '') || 'png';
    const mimeType = ext === 'jpg' ? 'image/jpeg' : ext === 'svg' ? 'image/svg+xml' : `image/${ext}`;
    const base64 = fileBuffer.toString('base64');

    const response = await ai.models.generateContent({
      model: process.env.GEMINI_IMAGE_MODEL || 'gemini-3-pro-image-preview',
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType, data: base64 } },
            {
              text: 'Remove the background from this logo image completely. Keep only the main logo/brand mark subject with a transparent background. Return the result as a PNG image with transparent background. Do not add any background color.',
            },
          ],
        },
      ],
      config: { responseModalities: [Modality.IMAGE, Modality.TEXT] },
    });

    const parts = response.candidates?.[0]?.content?.parts;
    if (!parts) return null;

    for (const part of parts) {
      if (part.inlineData) {
        const rawBuffer = Buffer.from(part.inlineData.data, 'base64');
        // sharp מוודא שזה PNG עם alpha channel
        const pngBuffer = await sharp(rawBuffer).png().toBuffer();
        const outName = path.basename(logoPath).replace(/\.[^.]+$/, '_nobg.png');
        const outPath = `${path.posix.dirname(logoPath)}/${outName}`;
        const upload = await backblazeService.uploadImage(outPath, pngBuffer, 'image/png');
        console.log(`✦ [LogoBgRemoval] Saved: ${upload.publicUrl}`);
        return upload.publicUrl;
      }
    }
    return null;
  } catch (err) {
    console.error('[LogoBgRemoval] Failed:', err);
    return null;
  }
};

/**
 * משפר תמונת לקוח דרך Gemini — מוסיף הקשר עסקי (אנשים, תאורה, אווירה)
 * אם נכשל, מחזיר null בשקט (fallback לתמונה המקורית)
 */
const enhanceClientPhoto = async (imagePath, context, sessionId) => {
  try {
    const { buffer: fileBuffer } = await backblazeService.downloadImageByPath(imagePath);
    const ext = path.extname(imagePath).toLowerCase().replace('.', '') || 'jpg';
    const mimeType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
    const base64 = fileBuffer.toString('base64');

    // תרגום תחום לאנגלית לצורך ה-prompt
    const FIELD_EN = {
      'מסעדה': 'restaurant', 'בית קפה': 'cafe', 'קייטרינג': 'catering',
      'טיפוח': 'beauty salon', 'קוסמטיקה': 'cosmetics', 'כושר': 'fitness gym',
      'ספא': 'spa', 'תיירות': 'travel agency', 'נדלן': 'real estate',
      'טכנולוגיה': 'tech company', 'עורך דין': 'law firm',
    };
    const fieldEn = FIELD_EN[context.businessField]
      || Object.entries(FIELD_EN).find(([k]) => context.businessField.includes(k))?.[1]
      || context.businessField;

    const response = await ai.models.generateContent({
      model: process.env.GEMINI_IMAGE_MODEL || 'gemini-3-pro-image-preview',
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType, data: base64 } },
            {
              text: `Transform this photo for the website of "${context.businessName}", a ${fieldEn} business.
Keep the main subject/product from the original image but enhance the scene: add natural human interaction (people enjoying or using the product/service), improve lighting to warm and professional, add relevant atmospheric context that fits a ${fieldEn}.
Services offered: ${context.services?.substring(0, 100) || fieldEn}.
Requirements: photorealistic, commercial photography quality, warm inviting atmosphere, no text or logos.`,
            },
          ],
        },
      ],
      config: { responseModalities: [Modality.IMAGE, Modality.TEXT] },
    });

    const parts = response.candidates?.[0]?.content?.parts;
    if (!parts) return null;

    for (const part of parts) {
      if (part.inlineData) {
        const rawBuffer = Buffer.from(part.inlineData.data, 'base64');
        const hash = crypto.createHash('md5').update(imagePath).digest('hex').substring(0, 8);
        const filename = `enhanced-${hash}-${Date.now()}.webp`;
        const webpBuffer = await sharp(rawBuffer)
          .resize(1200, 900, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 85 })
          .toBuffer();
        const upload = await backblazeService.uploadImage(
          `wow/generated/${sessionId}/${filename}`,
          webpBuffer,
          'image/webp',
        );
        console.log(`✦ [EnhancePhoto] Saved: ${filename}`);
        return upload.publicUrl;
      }
    }
    return null;
  } catch (err) {
    console.error('[EnhancePhoto] Failed:', err);
    return null;
  }
};

/**
 * יוצר תמונה מקצועית עם פנים של בעל העסק דרך Gemini
 */
const generateImageWithFace = async (faceImagePath, context, sessionId) => {
  const { buffer: fileBuffer } = await backblazeService.downloadImageByPath(faceImagePath);
  const ext = path.extname(faceImagePath).toLowerCase().replace('.', '') || 'jpg';
  const mimeType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
  const base64 = fileBuffer.toString('base64');

  const FIELD_EN = {
    'מסעדה': 'restaurant chef', 'בית קפה': 'cafe owner', 'קייטרינג': 'caterer/chef',
    'טיפוח': 'beauty therapist', 'קוסמטיקה': 'cosmetologist', 'כושר': 'personal trainer',
    'ספא': 'spa therapist', 'תיירות': 'travel guide', 'נדלן': 'real estate agent',
    'טכנולוגיה': 'tech professional', 'עורך דין': 'lawyer',
  };
  const roleEn = FIELD_EN[context.businessField]
    || Object.entries(FIELD_EN).find(([k]) => context.businessField.includes(k))?.[1]
    || `${context.businessField} professional`;

  const sceneByRole = {
    'restaurant chef': 'confidently cooking in a professional kitchen, surrounded by fresh ingredients',
    'cafe owner': 'welcoming guests in a beautiful modern cafe, holding a coffee cup',
    'beauty therapist': 'performing a professional skincare treatment in an elegant studio',
    'personal trainer': 'coaching a client in a modern gym with motivating energy',
    'real estate agent': 'standing in front of a beautiful modern home, professional attire',
    'tech professional': 'working on a modern computer setup in a sleek office',
    'lawyer': 'in a professional law office, confident and authoritative pose',
  };
  const scene = sceneByRole[roleEn] || `in a professional setting related to their ${roleEn} role`;

  const response = await ai.models.generateContent({
    model: process.env.GEMINI_IMAGE_MODEL || 'gemini-3-pro-image-preview',
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType, data: base64 } },
          {
            text: `Using the person from this reference photo, create a high-quality professional business photograph.
The person should be shown as a ${roleEn} for "${context.businessName}".
Scene: The person is ${scene}.
Requirements: photorealistic, warm professional lighting, commercial quality headshot/business photo, the person's face must closely match the reference, natural confident expression, no text or logos in image.`,
          },
        ],
      },
    ],
    config: { responseModalities: [Modality.IMAGE, Modality.TEXT] },
  });

  const parts = response.candidates?.[0]?.content?.parts;
  if (!parts) throw new Error('No response parts from Gemini');

  for (const part of parts) {
    if (part.inlineData) {
      const rawBuffer = Buffer.from(part.inlineData.data, 'base64');
      const filename = `face-${context.imageKey}-${Date.now()}.webp`;
      const webpBuffer = await sharp(rawBuffer)
        .resize(1000, 1000, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 88 })
        .toBuffer();
      const upload = await backblazeService.uploadImage(
        `wow/generated/${sessionId}/${filename}`,
        webpBuffer,
        'image/webp',
      );
      console.log(`✦ [FaceGenerate] Saved: ${filename}`);
      return upload.publicUrl;
    }
  }
  throw new Error('No image data in Gemini response for face generation');
};

/**
 * מייצר תמונות לכל ה-data-inject-src שדות בתבנית
 */
const generateAllImages = async (
  imageKeys,
  businessField,
  businessName,
  sessionId,
  briefContext,
) => {
  const results = {};

  // מייצר בקבוצות של 3 כדי לא להעמיס על ה-API
  const batchSize = 3;
  for (let i = 0; i < imageKeys.length; i += batchSize) {
    const batch = imageKeys.slice(i, i + batchSize);
    const promises = batch.map(async (key) => {
      try {
        const url = await generateImage(businessField, businessName, key, sessionId, briefContext);
        results[key] = url;
      } catch {
        // fallback — נשאיר את תמונת ברירת המחדל
        console.log(`Skipping image ${key} — using default`);
      }
    });
    await Promise.all(promises);
  }

  return results;
};

module.exports = {
  generateImage,
  removeLogoBackground,
  enhanceClientPhoto,
  generateImageWithFace,
  generateAllImages,
};
