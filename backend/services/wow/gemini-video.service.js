/**
 * Gemini Video Service — יצירת סרטון Hero עם Veo3/Veo2
 * משתמש ב-@google/genai generateVideos API
 */
const { GoogleGenAI } = require("@google/genai");
const OpenAI = require("openai");
const backblazeService = require("../backblaze.service");

const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_AI_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OpenAI_API_KEY });

// תרגום תחום עסק לאנגלית
const FIELD_EN = {
  'מסעדה': 'upscale restaurant', 'בית קפה': 'cozy modern cafe',
  'קייטרינג': 'professional catering service', 'טיפוח': 'luxury beauty salon',
  'קוסמטיקה': 'premium cosmetics studio', 'כושר': 'high-energy fitness gym',
  'ספא': 'serene luxury spa', 'תיירות': 'exciting travel destination',
  'נדלן': 'premium real estate', 'טכנולוגיה': 'innovative tech company',
  'עורך דין': 'prestigious law firm', 'רופא שיניים': 'modern dental clinic',
  'חינוך': 'inspiring education center', 'אופנה': 'high fashion brand',
  'תכשיטים': 'fine jewelry store', 'עוגות': 'artisan pastry studio',
  'פרחים': 'elegant flower shop', 'צילום': 'professional photography studio',
  'עיצוב פנים': 'sophisticated interior design studio',
};

/**
 * Uses GPT to generate a structured 7-section Veo3 prompt based on full brief context
 */
const generateVideoPrompt = async (businessName, businessField, ctx) => {
  const fieldEn = FIELD_EN[businessField]
    || Object.entries(FIELD_EN).find(([k]) => businessField.includes(k))?.[1]
    || `${businessField} business`;

  const colors = ctx.preferredColors?.primary
    ? `Primary: ${ctx.preferredColors.primary}, Secondary: ${ctx.preferredColors.secondary || 'N/A'}, Accent: ${ctx.preferredColors.accent || 'N/A'}`
    : 'Use colors that complement the business aesthetic';

  const systemMsg = `You are an expert at creating advanced video prompts for AI video generation with Veo3 by Gemini.

CLIENT Q&A:
- Business Name: "${businessName}"
- Business Field: ${businessField} (${fieldEn})
${ctx.businessNiche ? `- Niche/Specialty: ${ctx.businessNiche}` : ''}
- About the business: ${(ctx.about || '').substring(0, 250)}
- Services/Products: ${(ctx.services || '').substring(0, 250)}
- Target Audience: ${(ctx.targetAudience || []).join(', ') || 'general audience'}
- Page Goal: ${ctx.pageGoal || 'showcase the business and attract clients'}
- Design Style: ${ctx.designStyle || 'modern'}

BRAND COLORS:
${colors}

WEBSITE CONTEXT:
This video will be used as a full-viewport hero BACKGROUND video (plays silently in a loop behind the text content on the homepage).
Design aesthetic: ${ctx.designStyle || 'modern'}

YOUR TASK:
Create a precise Veo3 prompt for a seamlessly looping Hero Section background video.

Requirements:
- Must directly reflect the Q&A data (industry, unique value, target audience, atmosphere)
- Must incorporate the brand colors dominantly but aesthetically — through lighting, reflections, gradients, background tones
- Must feel modern, premium, clean and appropriate for a professional website
- Must be a PERFECT SEAMLESS LOOP: last frame connects smoothly to first frame — no jump, no lighting shift, no visible cut
- Zero long text in the video (minimal floating elements only if relevant)
- Background-appropriate: smooth, not too fast, not cluttered, grabs attention but doesn't steal focus from the text overlay

Write ONE English-only Veo3 prompt structured with these 7 sections:

1. Scene Description: Detailed scene — what we see, atmosphere, visual story, specific to THIS business
2. Visual Style: Design aesthetic (modern/minimalist/organic/tech etc.) matching the business and design style
3. Color Direction: How to integrate brand colors through lighting, backgrounds, elements, gradients
4. Motion & Camera: Gentle camera movements (slow pan, floating drift, soft zoom, parallax)
5. Loop Instruction (CRITICAL): Exact instruction for seamless loop — identical start/end framing, or natural cyclic motion (circular drift, breathing depth, gentle wave, continuous flow)
6. Mood & Emotion: The feeling the video must convey (trust, luxury, calm, energy, warmth, innovation, etc.)
7. Technical Specs: 6-10 second duration, seamless loop, 4K cinematic quality, no flicker, shallow depth of field, no text overlays

IMPORTANT:
- Return ONLY the final Veo3 prompt, no explanations, no meta-commentary
- English only — every word
- Ground every section in the specific business data above`;

  const fallbackPrompt = `1. Scene Description: Elegant close-up cinematic shots of a ${fieldEn} environment — beautifully styled surfaces, premium textures, carefully arranged details that tell the story of "${businessName}".
2. Visual Style: ${ctx.designStyle || 'Modern'} premium aesthetic — clean lines, rich materials, editorial photography feel.
3. Color Direction: Warm cinematic lighting with ${ctx.preferredColors?.primary ? `subtle ${ctx.preferredColors.primary} color cast` : 'natural warm tones'} in ambient reflections and background gradients.
4. Motion & Camera: Ultra-slow floating camera drift — barely perceptible forward push combined with a gentle lateral drift, occasional soft focus breathing.
5. Loop Instruction: Camera completes a smooth circular arc returning to the exact starting position and depth — imperceptible loop point, no lighting change between last and first frame.
6. Mood & Emotion: Luxurious, trustworthy, professional, inviting — the viewer feels they are about to experience something exceptional.
7. Technical Specs: 8 seconds, perfect seamless loop, 4K cinematic, no flicker, warm depth of field, zero text, continuous ambient motion.`;

  try {
    const r = await openai.responses.create({ model: 'gpt-5', input: systemMsg });
    const text = (r.output_text || '').trim();
    if (text.length > 100) {
      console.log(`✦ [Video] GPT-5 prompt generated (${text.length} chars)`);
      return text;
    }
    throw new Error('GPT-5 returned empty response');
  } catch {
    try {
      const r = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: systemMsg }],
        max_tokens: 700,
      });
      const text = (r.choices[0]?.message?.content || '').trim();
      if (text.length > 100) {
        console.log(`✦ [Video] GPT-4o prompt generated (${text.length} chars)`);
        return text;
      }
      throw new Error('GPT-4o returned empty response');
    } catch {
      console.warn('✦ [Video] GPT prompt generation failed — using structured fallback');
      return fallbackPrompt;
    }
  }
};

const generateHeroVideo = async (
  businessField,
  businessName,
  sessionId,
  briefContext,
  imageRef,
) => {
  console.log(`✦ [Video] Generating Veo3 prompt for "${businessName}" (${businessField})...`);
  const prompt = await generateVideoPrompt(businessName, businessField, briefContext || {});
  console.log(`✦ [Video] Prompt preview:\n${prompt.substring(0, 200)}...\n`);

  const models = ['veo-3.0-generate-preview', 'veo-2.0-generate-001'];
  let operation = null;
  let usedModel = '';

  for (const model of models) {
    try {
      console.log(`✦ [Video] Trying model: ${model}`);
      const videoParams = {
        model,
        prompt,
        config: {
          numberOfVideos: 1,
          durationSeconds: 8,
          aspectRatio: '16:9',
        },
      };
      if (imageRef) {
        videoParams.image = {
          imageBytes: imageRef.toString('base64'),
          mimeType: 'image/jpeg',
        };
        console.log(`✦ [Video] Image reference attached (${(imageRef.length / 1024).toFixed(0)}KB)`);
      }
      operation = await ai.models.generateVideos(videoParams);
      usedModel = model;
      console.log(`✦ [Video] Operation started with ${model}`);
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Video] ${model} failed: ${msg}`);
      if (model === models[models.length - 1]) throw err;
    }
  }

  if (!operation) throw new Error('Failed to start video generation');

  // Poll until done (max 8 minutes, every 15 seconds)
  const maxWait = 8 * 60 * 1000;
  const pollInterval = 15000;
  const startTime = Date.now();

  while (!operation.done) {
    if (Date.now() - startTime > maxWait) {
      throw new Error('Video generation timed out after 8 minutes');
    }
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`✦ [Video] Polling ${usedModel}... (${elapsed}s elapsed)`);
    await new Promise((r) => setTimeout(r, pollInterval));

    try {
      operation = await ai.operations.getVideosOperation({ operation });
    } catch (pollErr) {
      console.warn('[Video] Polling error:', pollErr);
      break;
    }
  }

  // Extract video data
  const generatedVideos = operation.response?.generatedVideos;
  if (!generatedVideos || generatedVideos.length === 0) {
    throw new Error('No video generated in response');
  }

  const videoObj = generatedVideos[0]?.video;
  const videoBytes = videoObj?.videoBytes;
  const videoUri = videoObj?.uri;

  const filename = `hero-video-${Date.now()}.mp4`;
  const fullPath = `wow/generated/${sessionId}/${filename}`;

  if (videoBytes) {
    const buf = Buffer.from(videoBytes, 'base64');
    const upload = await backblazeService.uploadImage(fullPath, buf, 'video/mp4');
    console.log(`✦ [Video] Saved (${usedModel}): ${filename} (${(buf.length / 1024 / 1024).toFixed(1)}MB)`);
    return upload.publicUrl;
  } else if (videoUri) {
    // Veo sometimes returns a URI instead of inline bytes — download it
    console.log(`✦ [Video] URI-based video (${usedModel}), downloading: ${videoUri.substring(0, 80)}...`);
    try {
      const downloadUrl = videoUri.includes('?')
        ? `${videoUri}&key=${process.env.GOOGLE_AI_API_KEY}`
        : `${videoUri}?key=${process.env.GOOGLE_AI_API_KEY}`;
      const resp = await fetch(downloadUrl);
      if (resp.ok) {
        const buf = Buffer.from(await resp.arrayBuffer());
        const upload = await backblazeService.uploadImage(fullPath, buf, 'video/mp4');
        console.log(`✦ [Video] Downloaded → ${filename} (${(buf.length / 1024 / 1024).toFixed(1)}MB)`);
        return upload.publicUrl;
      }
      console.warn(`✦ [Video] Download returned ${resp.status} — using URI as fallback`);
    } catch (downloadErr) {
      console.warn(`✦ [Video] Download error:`, downloadErr);
    }
    return videoUri;
  }

  throw new Error('Video data not available in response');
};

module.exports = {
  generateHeroVideo,
};
