const express = require("express");
const router = express.Router();
const { getSession, updateSession } = require("../../services/wow/session.service");
const { getBrief } = require("../../services/wow/brief.service");
const { generateImage, generateImageWithFace } = require("../../services/wow/gemini-image.service");
const { generateHeroVideo } = require("../../services/wow/gemini-video.service");
const { startChat, chatWithBrief } = require("../../services/wow/chat-brief.service");
const { processEditorChat } = require("../../services/wow/editor-chat.service");
const wowUpload = require("../../middlewares/wow-upload.middleware");
const backblazeService = require("../../services/backblaze.service");

// צ'אט sessions — in-memory
const chatSessions = new Map();

// POST /api/ai/generate-image — יצירת תמונה חדשה עם Gemini
router.post('/generate-image', async (req, res, next) => {
  try {
    const { sessionId, imageKey } = req.body;
    if (!sessionId || !imageKey) {
      res.status(400).json({ error: true, message: 'חסר sessionId או imageKey' });
      return;
    }

    const session = await getSession(sessionId);
    const brief = await getBrief(session.briefId);

    const imageUrl = await generateImage(
      brief.businessField,
      brief.businessName,
      imageKey,
      sessionId,
    );

    session.edits.images[imageKey] = imageUrl;
    await updateSession(sessionId, { edits: session.edits, status: 'editing' });

    res.json({ status: 'generated', imageUrl });
  } catch (err) {
    next(err);
  }
});

// POST /api/ai/chat/start — התחלת שיחה חדשה
router.post('/chat/start', async (_req, res, next) => {
  try {
    const { reply, history } = await startChat();
    const chatId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    chatSessions.set(chatId, history);
    res.json({ chatId, reply });
  } catch (err) {
    next(err);
  }
});

// POST /api/ai/chat/message — שליחת הודעה בצ'אט
router.post('/chat/message', async (req, res, next) => {
  try {
    const { chatId, message } = req.body;
    if (!chatId || !message) {
      res.status(400).json({ error: true, message: 'חסר chatId או message' });
      return;
    }

    const history = chatSessions.get(chatId) || [];
    const { reply, briefData, history: newHistory } = await chatWithBrief(history, message);
    chatSessions.set(chatId, newHistory);

    res.json({ reply, briefData });
  } catch (err) {
    next(err);
  }
});

// GET /api/ai/pipeline-status/:sessionId — מצב ה-pipeline
router.get('/pipeline-status/:sessionId', async (req, res, next) => {
  try {
    const session = await getSession(req.params.sessionId);

    const hasContent = !!session.edits.aiContent;
    const hasHtml = !!session.edits.geminiHtml;
    const ready = hasHtml && session.status === 'ready';
    const generatingImages = session.status === 'generating-images';

    const adsStatus = session.edits?.adsStatus || 'idle';
    const adsReady = adsStatus === 'ready';

    return res.json({
      ready: ready && adsReady,
      mode: 'gemini',
      hasContent,
      hasHtml,
      generatingImages,
      imageCount: Object.keys(session.edits.images || {}).length,
      adsStatus,
      adsReady,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/ai/editor-chat — צ'אט AI בעורך
const editorChatHistories = new Map();

router.post('/editor-chat', async (req, res, next) => {
  try {
    const { sessionId, message } = req.body;
    if (!sessionId || !message) {
      res.status(400).json({ error: true, message: 'חסר sessionId או message' });
      return;
    }

    const history = editorChatHistories.get(sessionId) || [];
    const { actions, reply } = await processEditorChat(history, message);

    history.push({ role: 'user', content: message });
    history.push({ role: 'assistant', content: JSON.stringify({ actions, message: reply }) });
    editorChatHistories.set(sessionId, history);

    const session = await getSession(sessionId);
    for (const action of actions) {
      if (action.type === 'text' && action.field && action.value) {
        session.edits.texts[action.field] = action.value.replace(/\n/g, '<br>');
      }
      if (action.type === 'color' && action.field && action.value) {
        session.edits.colors[action.field] = action.value;
      }
      if (action.type === 'icon' && action.field && action.value) {
        session.edits.texts[action.field] = action.value;
      }
      if (action.type === 'section-toggle' && action.field) {
        const hidden = session.edits.hiddenSections || [];
        if (action.value === 'hide' && !hidden.includes(action.field)) {
          hidden.push(action.field);
        } else if (action.value === 'show') {
          const idx = hidden.indexOf(action.field);
          if (idx > -1) hidden.splice(idx, 1);
        }
        session.edits.hiddenSections = hidden;
      }
    }
    await updateSession(sessionId, { edits: session.edits });

    res.json({ reply, actions });
  } catch (err) {
    next(err);
  }
});

// POST /api/ai/generate-with-face — יצירת תמונה עם פנים של בעל עסק
router.post(
  '/generate-with-face',
  wowUpload.single('facePhoto'),
  async (req, res, next) => {
    try {
      const { sessionId, imageKey } = req.body;
      if (!sessionId || !imageKey || !req.file) {
        res.status(400).json({ error: true, message: 'חסר sessionId, imageKey או תמונת פנים' });
        return;
      }

      const session = await getSession(sessionId);
      const brief = await getBrief(session.briefId);

      // Upload face photo to Backblaze so the service can fetch it by path
      const faceFilename = `face-${Date.now()}-${req.file.originalname || 'face.jpg'}`;
      const facePath = `wow/briefs/${session.briefId}/${faceFilename}`;
      await backblazeService.uploadImage(facePath, req.file.buffer, req.file.mimetype);

      const imageUrl = await generateImageWithFace(
        facePath,
        {
          businessName: brief.businessName,
          businessField: brief.businessField,
          imageKey,
        },
        sessionId,
      );

      session.edits.images[imageKey] = imageUrl;
      await updateSession(sessionId, { edits: session.edits });

      res.json({ status: 'generated', imageUrl });
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/ai/generate-video — מתחיל יצירת סרטון Hero (async, ברקע)
router.post('/generate-video', async (req, res, next) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) {
      res.status(400).json({ error: true, message: 'חסר sessionId' });
      return;
    }

    const session = await getSession(sessionId);
    const brief = await getBrief(session.briefId);

    // סמן בסשן שהסרטון בתהליך
    const edits = session.edits;
    edits.videoStatus = 'generating';
    await updateSession(sessionId, { edits: session.edits });

    // הפעל יצירת הסרטון ברקע (no await)
    generateHeroVideo(brief.businessField, brief.businessName, sessionId, {
      services: brief.services,
      about: brief.about,
      preferredColors: brief.preferredColors,
      designStyle: brief.designStyle,
      targetAudience: brief.targetAudience,
      pageGoal: brief.pageGoal,
      businessNiche: brief.businessNiche,
    })
      .then(async (videoUrl) => {
        const s = await getSession(sessionId);
        const e = s.edits;
        e.videoStatus = 'ready';
        e.videoUrl = videoUrl;
        await updateSession(sessionId, { edits: s.edits });
        console.log(`✦ [Video] Ready: ${videoUrl}`);
      })
      .catch(async (err) => {
        console.error('[Video] Failed:', err);
        const s = await getSession(sessionId);
        const e = s.edits;
        e.videoStatus = 'error';
        await updateSession(sessionId, { edits: s.edits });
      });

    res.json({ status: 'generating' });
  } catch (err) {
    next(err);
  }
});

// GET /api/ai/video-status/:sessionId — בדיקת מצב הסרטון
router.get('/video-status/:sessionId', async (req, res, next) => {
  try {
    const session = await getSession(req.params.sessionId);
    const edits = session.edits;
    res.json({
      status: edits.videoStatus || 'idle',
      url: edits.videoUrl || null,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
