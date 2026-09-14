const { google } = require('googleapis');
const path = require('path');
const multer = require('multer');
const { getDB } = require('../config/db');
const driveService = require('../services/google-drive.service');

// Parent folder: "אייקוניק לקוחות דרייב חדש"
const ICONIQ_CUSTOMERS_FOLDER_ID = '1_cH83i2w0pnlVJPjNnu48ji56Jfct9TK';
const WEBSITE_SUBFOLDER_NAME = 'לבונה אתרים';

exports.briefImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

const settingsCol = () => getDB().collection('settings');

// Read OAuth credentials from client_secret_desktop.json (server root)
// These will be replaced by Web Application credentials from Cloud Console
let _creds;
const getCreds = () => {
  if (!_creds) {
    try {
      const f = require(path.join(__dirname, '..', 'client_secret_web.json'));
      _creds = f.web || f.installed;
    } catch {
      // Fallback to env vars (Web Application credentials)
      _creds = {
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
      };
    }
  }
  return _creds;
};

// Derive callback URL from the incoming request (works for both local and production)
// x-forwarded-proto is needed on Heroku where TLS is terminated by the proxy
const getCallbackUrl = (req) => {
  const protocol = (req.headers['x-forwarded-proto'] || req.protocol).split(',')[0].trim();
  return `${protocol}://${req.get('host')}/api/google/callback`;
};

const makeOAuth2Client = (req) => {
  const creds = getCreds();
  return new google.auth.OAuth2(creds.client_id, creds.client_secret, getCallbackUrl(req));
};

// GET /api/google/connect
// Redirects the admin to Google OAuth consent screen
exports.getConnectUrl = (req, res) => {
  const client = makeOAuth2Client(req);
  const url = client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/drive'],
    prompt: 'consent',
  });
  res.redirect(url);
};

// GET /api/google/callback
// Google redirects here after user approves. Saves tokens to DB.
exports.handleCallback = async (req, res) => {
  const { code, error } = req.query;

  if (error || !code) {
    console.error('[Google OAuth] Callback error:', error);
    return res.redirect('/agent/settings?drive=error');
  }

  try {
    const client = makeOAuth2Client(req);
    const { tokens } = await client.getToken(code);

    if (!tokens.refresh_token) {
      console.warn('[Google OAuth] No refresh_token received. Revoke access at https://myaccount.google.com/permissions and try again.');
      return res.redirect('/agent/app?drive=no_refresh_token');
    }

    // Save token to DB FIRST — before any other calls that might fail
    await settingsCol().updateOne(
      { key: 'google_oauth' },
      {
        $set: {
          key: 'google_oauth',
          refresh_token: tokens.refresh_token,
          access_token: tokens.access_token,
          expiry_date: tokens.expiry_date,
          connected_at: new Date(),
        },
      },
      { upsert: true }
    );

    // Reload drive client cache
    const { reloadOAuthClient } = require('../services/google-drive.service');
    await reloadOAuthClient();

    // Fetch email (non-critical — don't fail the whole flow if this errors)
    try {
      client.setCredentials(tokens);
      const oauth2 = google.oauth2({ version: 'v2', auth: client });
      const info = await oauth2.userinfo.get();
      await settingsCol().updateOne({ key: 'google_oauth' }, { $set: { email: info.data.email } });
      console.log(`[Google OAuth] Connected: ${info.data.email}`);
    } catch (emailErr) {
      console.warn('[Google OAuth] Could not fetch email (token saved):', emailErr.message);
    }

    res.redirect('/agent/app?drive=connected');
  } catch (err) {
    console.error('[Google OAuth] handleCallback error:', err.message);
    res.redirect('/agent/app?drive=error');
  }
};

// GET /api/google/status
exports.getStatus = async (req, res) => {
  try {
    const doc = await settingsCol().findOne({ key: 'google_oauth' });
    if (!doc?.refresh_token) {
      return res.json({ connected: false });
    }
    res.json({
      connected: true,
      email: doc.email,
      connected_at: doc.connected_at,
    });
  } catch (err) {
    res.status(500).json({ connected: false, error: err.message });
  }
};

// POST /api/google/upload-brief-image
// Receives: multipart/form-data { phone, image_index?, image (file) }
// Mirrors the Make scenario "העלה לדרייב":
//   1. Find client folder (by phone, within ICONIQ_CUSTOMERS_FOLDER_ID)
//   2. Find/create "לבונה אתרים" subfolder
//   3. Upload image
exports.uploadBriefImage = async (req, res) => {
  try {
    const { phone } = req.body;
    const file = req.file;

    if (!phone) return res.status(400).json({ success: false, error: 'phone is required' });
    if (!file)  return res.status(400).json({ success: false, error: 'image is required' });

    const drive = await driveService.getDriveClient();
    const safePhone = phone.replace(/'/g, "\\'");

    // Step 1: Find client folder inside the customers root folder
    const clientSearch = await drive.files.list({
      q: `'${ICONIQ_CUSTOMERS_FOLDER_ID}' in parents and name contains '${safePhone}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id, name)',
      pageSize: 1,
    });

    let clientFolderId;
    if (clientSearch.data.files.length > 0) {
      clientFolderId = clientSearch.data.files[0].id;
      console.log(`[BriefUpload] Found client folder: "${clientSearch.data.files[0].name}" (${clientFolderId})`);
    } else {
      const newFolder = await driveService.createFolder(phone, ICONIQ_CUSTOMERS_FOLDER_ID);
      clientFolderId = newFolder.id;
      console.log(`[BriefUpload] Created client folder: "${phone}" (${clientFolderId})`);
    }

    // Step 2: Find or create "לבונה אתרים" subfolder inside client folder
    const subSearch = await drive.files.list({
      q: `'${clientFolderId}' in parents and name contains '${WEBSITE_SUBFOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id, name)',
      pageSize: 1,
    });

    let targetFolderId;
    if (subSearch.data.files.length > 0) {
      targetFolderId = subSearch.data.files[0].id;
      console.log(`[BriefUpload] Found subfolder: "${subSearch.data.files[0].name}" (${targetFolderId})`);
    } else {
      const newSub = await driveService.createFolder(WEBSITE_SUBFOLDER_NAME, clientFolderId);
      targetFolderId = newSub.id;
      console.log(`[BriefUpload] Created subfolder: "${WEBSITE_SUBFOLDER_NAME}" (${targetFolderId})`);
    }

    // Step 3: Upload the image
    const uploaded = await driveService.uploadFile(targetFolderId, file.originalname, file.buffer, file.mimetype);
    console.log(`[BriefUpload] ✅ Uploaded: "${uploaded.name}"`);

    res.json({ success: true, file: uploaded });
  } catch (err) {
    console.error('[BriefUpload] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

// DELETE /api/google/disconnect
exports.disconnect = async (req, res) => {
  try {
    // Try to revoke the token at Google
    const doc = await settingsCol().findOne({ key: 'google_oauth' });
    if (doc?.refresh_token) {
      try {
        const client = makeOAuth2Client();
        client.setCredentials({ refresh_token: doc.refresh_token });
        await client.revokeCredentials();
      } catch {
        // Ignore revoke errors — still remove from DB
      }
    }

    await settingsCol().deleteOne({ key: 'google_oauth' });

    const { reloadOAuthClient } = require('../services/google-drive.service');
    await reloadOAuthClient();

    console.log('[Google OAuth] Disconnected');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};
