const express = require("express");
const router = express.Router();
const archiver = require("archiver");
const { getSession } = require("../../services/wow/session.service");
const { loadAdsJson, regenerateAd, regenerateAllAds, editAdWithPrompt } = require("../../services/wow/ads.service");
const backblazeService = require("../../services/backblaze.service");

// GET /api/ads/status/:sessionId — poll ads pipeline status
router.get('/status/:sessionId', async (req, res, next) => {
  try {
    const session = await getSession(req.params.sessionId);
    const adsStatus = session.edits?.adsStatus || 'idle';
    const adsData = await loadAdsJson(req.params.sessionId);
    const allAds = adsData?.generatedAds || adsData?.ads || [];
    const adsCount = allAds.filter((a) => a.imageUrl)?.length || 0;

    res.json({
      ready: adsStatus === 'ready',
      status: adsStatus,
      adsCount,
      totalAds: allAds.length,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/ads/:sessionId — get all ads
router.get('/:sessionId', async (req, res, next) => {
  try {
    const data = await loadAdsJson(req.params.sessionId);
    if (!data) {
      res.status(404).json({ error: true, message: 'No ads found' });
      return;
    }
    res.json({ ok: true, ads: data.generatedAds || data.ads || [] });
  } catch (err) {
    next(err);
  }
});

// POST /api/ads/:sessionId/regenerate/:adId — regenerate single ad
router.post('/:sessionId/regenerate/:adId', async (req, res, next) => {
  try {
    const adId = parseInt(req.params.adId);
    const ad = await regenerateAd(req.params.sessionId, adId);
    if (!ad) {
      res.status(404).json({ error: true, message: 'Ad not found' });
      return;
    }
    res.json({ ok: true, ad });
  } catch (err) {
    next(err);
  }
});

// POST /api/ads/:sessionId/edit/:adId — edit ad with user text prompt
router.post('/:sessionId/edit/:adId', async (req, res, next) => {
  try {
    const adId = parseInt(req.params.adId);
    const { prompt } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: true, message: 'prompt required' });
    }
    const ad = await editAdWithPrompt(req.params.sessionId, adId, prompt);
    if (!ad) return res.status(404).json({ error: true, message: 'Ad not found' });
    res.json({ ok: true, ad });
  } catch (err) {
    next(err);
  }
});

// POST /api/ads/:sessionId/regenerate-all — regenerate all ads
router.post('/:sessionId/regenerate-all', async (req, res, next) => {
  try {
    const ads = await regenerateAllAds(req.params.sessionId);
    res.json({ ok: true, ads });
  } catch (err) {
    next(err);
  }
});

// GET /api/ads/:sessionId/download/:adId — download single ad PNG
router.get('/:sessionId/download/:adId', async (req, res, next) => {
  try {
    const sessionId = req.params.sessionId;
    const adId = req.params.adId;
    const filePath = `wow/ads/${sessionId}/ad_${adId}.png`;
    try {
      const { buffer } = await backblazeService.downloadImageByPath(filePath);
      res.setHeader('Content-Disposition', `attachment; filename="ad_${adId}.png"`);
      res.setHeader('Content-Type', 'image/png');
      res.send(buffer);
    } catch {
      res.status(404).json({ error: true, message: 'Image not found' });
    }
  } catch (err) {
    next(err);
  }
});

// GET /api/ads/:sessionId/download-zip — download all ads as ZIP
router.get('/:sessionId/download-zip', async (req, res, next) => {
  try {
    const sessionId = req.params.sessionId;
    const data = await loadAdsJson(sessionId);
    const ads = (data?.generatedAds || data?.ads || []).filter((a) => a.imageUrl);

    if (ads.length === 0) {
      res.status(404).json({ error: true, message: 'No ads to download' });
      return;
    }

    // Get business name for filename
    const name = data?.brief?.businessName?.replace(/[^a-zA-Zא-ת0-9]/g, '_') || 'ads';

    res.setHeader('Content-Disposition', `attachment; filename="wow-ads-${name}.zip"`);
    res.setHeader('Content-Type', 'application/zip');

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(res);

    // Download each ad from Backblaze and add to archive
    for (const ad of ads) {
      try {
        const filePath = `wow/ads/${sessionId}/ad_${ad.id}.png`;
        const { buffer } = await backblazeService.downloadImageByPath(filePath);
        archive.append(buffer, { name: `ad_${ad.id}.png` });
      } catch (e) {
        console.warn(`[AdsZip] Failed to fetch ad_${ad.id}.png:`, e.message);
      }
    }

    // Add ads.json for reference
    try {
      archive.append(Buffer.from(JSON.stringify(data, null, 2), 'utf-8'), { name: 'ads-data.json' });
    } catch { /* */ }

    await archive.finalize();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
