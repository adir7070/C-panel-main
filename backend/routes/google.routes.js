const express = require('express');
const router = express.Router();
const c = require('../controllers/google.controller');

// Redirect admin to Google consent screen
router.get('/connect', c.getConnectUrl);

// Google redirects here after approval — no auth middleware (public callback)
router.get('/callback', c.handleCallback);

// Check connection status
router.get('/status', c.getStatus);

// Disconnect (revoke + delete from DB)
router.delete('/disconnect', c.disconnect);

// Upload brief image to client's Drive folder (replaces Make scenario "העלה לדרייב")
router.post(
  '/upload-brief-image',
  (req, res, next) => {
    c.briefImageUpload.single('image')(req, res, (err) => {
      if (err) return res.status(400).json({ success: false, error: err.message });
      next();
    });
  },
  c.uploadBriefImage,
);

module.exports = router;
