'use strict';

/**
 * email-connections.routes.js — Gmail OAuth + email connection management
 */

const express = require('express');
const router  = express.Router();
const { bpProtect } = require('../../middlewares/bp.middleware');
const gmailSvc = require('../../services/bp-gmail.service');

function errRes(res, err) {
  return res.status(err.status || 500).json({ success: false, message: err.message });
}

// ─── PUBLIC: OAuth callback (no auth — verified via signed state) ─────────────

// GET /api/bp/email-connections/oauth/gmail/callback
router.get('/oauth/gmail/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query;

    if (error) {
      console.warn('[bp-email-connections] OAuth error from Google:', error);
      return res.redirect(`${process.env.APP_DEEP_LINK || 'billpilot://'}email-connected?error=${encodeURIComponent(error)}`);
    }

    if (!code || !state) {
      return res.status(400).json({ success: false, message: 'code and state required' });
    }

    const connection = await gmailSvc.handleCallback(code, state);
    // Redirect to app / return JSON depending on client type
    const redirectUri = process.env.BP_GMAIL_SUCCESS_REDIRECT;
    if (redirectUri) {
      return res.redirect(`${redirectUri}?connectionId=${connection._id.toString()}`);
    }
    res.json({ success: true, data: { connectionId: connection._id, email: connection.email } });
  } catch (err) {
    errRes(res, err);
  }
});

// ─── PROTECTED ────────────────────────────────────────────────────────────────

// GET /api/bp/email-connections/oauth/gmail/init
router.get('/oauth/gmail/init', bpProtect, async (req, res) => {
  try {
    const { user, tenantId } = req.bp;
    const url = await gmailSvc.getAuthUrl(user._id.toString(), tenantId);
    res.json({ success: true, data: { authUrl: url } });
  } catch (err) {
    errRes(res, err);
  }
});

// GET /api/bp/email-connections
router.get('/', bpProtect, async (req, res) => {
  try {
    const { user, tenantId } = req.bp;
    const connections = await gmailSvc.listEmailConnections(user._id.toString(), tenantId);
    res.json({ success: true, data: connections });
  } catch (err) {
    errRes(res, err);
  }
});

// DELETE /api/bp/email-connections/:id
router.delete('/:id', bpProtect, async (req, res) => {
  try {
    const { user } = req.bp;
    await gmailSvc.deleteEmailConnection(req.params.id, user._id.toString());
    res.json({ success: true });
  } catch (err) {
    errRes(res, err);
  }
});

// POST /api/bp/email-connections/:id/sync-now
router.post('/:id/sync-now', bpProtect, async (req, res) => {
  try {
    const { user } = req.bp;
    await gmailSvc.triggerSync(req.params.id, user._id.toString());
    res.json({ success: true, message: 'Sync triggered' });
  } catch (err) {
    errRes(res, err);
  }
});

module.exports = router;
