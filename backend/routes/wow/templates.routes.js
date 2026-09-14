const express = require("express");
const router = express.Router();
const { getBrief } = require("../../services/wow/brief.service");
const { createSession, getSession, updateSession } = require("../../services/wow/session.service");
const pipelineRunner = require("../../services/wow/pipeline-runner.service");

// POST /api/templates/generate-gemini — Gemini HTML pipeline
router.post('/generate-gemini', async (req, res, next) => {
  try {
    const { briefId } = req.body;
    if (!briefId) {
      res.status(400).json({ error: true, message: 'חסר briefId' });
      return;
    }

    const brief = await getBrief(briefId);

    const session = await createSession(briefId, ['gemini']);
    await updateSession(session.id, {
      generationMode: 'gemini',
      selectedTemplateId: 'gemini',
      status: 'generating',
    });

    // Record to history immediately so it appears in the user's list
    try {
      const historyService = require("../../services/wow/history.service");
      await historyService.recordPublish({
        phone: brief.phone || "",
        sessionId: session.id,
        briefId,
        url: "",
        businessName: brief.businessName || null,
      });
    } catch (e) { console.warn("[wow] history record on create:", e.message); }

    // Enqueue through the job queue — survives server restarts
    pipelineRunner.enqueueGemini(session.id, briefId);
    pipelineRunner.enqueueAds(session.id, briefId);

    const templates = [{
      id: 'gemini',
      name: 'Gemini AI Studio',
      category: 'gemini',
      previewUrl: `/api/wow/editor/preview/${session.id}`,
    }];

    res.json({ sessionId: session.id, templates });
  } catch (err) {
    next(err);
  }
});

// POST /api/templates/select-gemini — confirm selection (pipeline already running)
router.post('/select-gemini', async (req, res, next) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) {
      res.status(400).json({ error: true, message: 'חסר sessionId' });
      return;
    }

    // Verify session exists
    await getSession(sessionId);

    res.json({
      status: 'selected',
      templateId: 'gemini',
      templateName: 'Gemini AI Studio',
      fields: { texts: [], images: [], links: [], colorVars: [] },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
