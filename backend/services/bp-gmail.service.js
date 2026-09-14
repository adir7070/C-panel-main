'use strict';

/**
 * bp-gmail.service.js
 * Gmail OAuth + incremental sync for BillPilot.
 * Ported from email-sync.service.ts — no Mongoose, raw MongoDB driver.
 */

const { google } = require('googleapis');
const { getDB } = require('../config/db');
const { col, oid, BpError } = require('./bp-db');
const { uploadImage } = require('./backblaze.service');

// ─── Constants ────────────────────────────────────────────────────────────────

const GMAIL_ATTACHMENT_QUERY =
  'has:attachment (pdf OR invoice OR receipt OR חשבונית OR קבלה)';

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/octet-stream',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/tiff',
  'image/webp',
]);

const ALLOWED_EXTENSIONS = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.tiff', '.tif', '.webp']);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isAllowedAttachment(mimeType, filename) {
  if (mimeType === 'application/octet-stream') {
    const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'));
    return ALLOWED_EXTENSIONS.has(ext);
  }
  return ALLOWED_MIME_TYPES.has(mimeType);
}

function resolvedMimeType(mimeType, filename) {
  if (mimeType === 'application/octet-stream') {
    const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'));
    const map = {
      '.pdf':  'application/pdf',
      '.jpg':  'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png':  'image/png',
      '.tiff': 'image/tiff',
      '.tif':  'image/tiff',
      '.webp': 'image/webp',
    };
    return map[ext] || mimeType;
  }
  return mimeType;
}

function mimeToExt(mime) {
  const map = {
    'application/pdf': 'pdf',
    'image/jpeg':  'jpg',
    'image/jpg':   'jpg',
    'image/png':   'png',
    'image/tiff':  'tiff',
    'image/webp':  'webp',
  };
  return map[mime] || 'bin';
}

function collectAttachments(part, results = []) {
  if (!part) return results;
  if (part.body && part.body.attachmentId && part.mimeType && part.filename) {
    results.push({
      attachmentId: part.body.attachmentId,
      mimeType:     part.mimeType,
      filename:     part.filename,
      size:         part.body.size || 0,
    });
  }
  if (Array.isArray(part.parts)) {
    for (const child of part.parts) {
      collectAttachments(child, results);
    }
  }
  return results;
}

function buildB2Key(userId, fileName) {
  return `billpilot/${userId}/${Date.now()}_${fileName}`;
}

// ─── OAuth client ─────────────────────────────────────────────────────────────

function getOAuthClient(accessToken, refreshToken) {
  const oauth2 = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    process.env.GMAIL_REDIRECT_URI,
  );
  if (accessToken || refreshToken) {
    oauth2.setCredentials({ access_token: accessToken, refresh_token: refreshToken });
  }
  return oauth2;
}

/**
 * Generate the Gmail OAuth2 authorization URL.
 * Stores a pending state doc in bp_email_connections.
 * @param {string} userId
 * @param {string} tenantId
 * @returns {Promise<string>} authUrl
 */
async function getAuthUrl(userId, tenantId) {
  const oauth2 = getOAuthClient();
  const state = Buffer.from(JSON.stringify({ userId, tenantId, ts: Date.now() })).toString('base64');

  const url = oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
    ],
    state,
  });

  return url;
}

/**
 * Handle Gmail OAuth callback: exchange code → tokens, store connection.
 * @param {string} code
 * @param {string} state  base64-encoded JSON with { userId, tenantId }
 * @returns {Promise<object>} connection document
 */
async function handleCallback(code, state) {
  let stateData;
  try {
    stateData = JSON.parse(Buffer.from(state, 'base64').toString('utf8'));
  } catch {
    throw new BpError('Invalid OAuth state', 400, 'INVALID_STATE');
  }

  const { userId, tenantId } = stateData;
  if (!userId || !tenantId) throw new BpError('Invalid OAuth state payload', 400, 'INVALID_STATE');

  const oauth2 = getOAuthClient();
  const { tokens } = await oauth2.getToken(code);

  if (!tokens.refresh_token) {
    throw new BpError('No refresh token returned — prompt=consent required', 400, 'NO_REFRESH_TOKEN');
  }

  // Get Gmail email address
  oauth2.setCredentials(tokens);
  const gmail = google.gmail({ version: 'v1', auth: oauth2 });
  const profile = await gmail.users.getProfile({ userId: 'me' });
  const emailAddress = profile.data.emailAddress;

  const now = new Date();
  const connection = {
    tenantId:    oid(tenantId),
    userId:      oid(userId),
    provider:    'gmail',
    email:       emailAddress,
    accessToken:  tokens.access_token,
    refreshToken: tokens.refresh_token,
    tokenExpiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : new Date(Date.now() + 3600_000),
    syncSettings: {
      isSyncing: false,
      cancelRequested: false,
      lastSyncAt: null,
      lastSyncError: null,
      importFilters: { senders: [], subjectKeywords: [] },
    },
    stats: { totalEmailsProcessed: 0, totalDocumentsImported: 0 },
    createdAt: now,
    updatedAt: now,
  };

  const result = await col('email_connections').insertOne(connection);
  return { ...connection, _id: result.insertedId };
}

// ─── Sync lock helpers ────────────────────────────────────────────────────────

async function releaseSyncLock(connectionId, error) {
  const update = {
    $set: {
      'syncSettings.isSyncing': false,
      'syncSettings.cancelRequested': false,
      updatedAt: new Date(),
    },
  };
  if (error) update.$set['syncSettings.lastSyncError'] = error;
  await col('email_connections').updateOne({ _id: oid(connectionId) }, update);
}

// ─── Main sync ────────────────────────────────────────────────────────────────

/**
 * Incremental Gmail sync for a connection.
 * @param {string} connectionId
 */
async function syncGmailConnection(connectionId) {
  console.log('[bp-gmail] syncGmailConnection started', { connectionId });

  const connection = await col('email_connections').findOne({ _id: oid(connectionId) });
  if (!connection) {
    console.warn('[bp-gmail] connection not found', { connectionId });
    await releaseSyncLock(connectionId, 'Connection not found');
    return;
  }

  if (!connection.accessToken || !connection.refreshToken) {
    console.warn('[bp-gmail] missing tokens', { connectionId });
    await releaseSyncLock(connectionId, 'Missing OAuth tokens — reconnect required');
    return;
  }

  const auth = getOAuthClient(connection.accessToken, connection.refreshToken);

  // Refresh token if expiring within 5 minutes
  if (
    connection.tokenExpiresAt &&
    new Date(connection.tokenExpiresAt).getTime() < Date.now() + 5 * 60 * 1000
  ) {
    try {
      const { credentials } = await auth.refreshAccessToken();
      await col('email_connections').updateOne(
        { _id: oid(connectionId) },
        {
          $set: {
            accessToken: credentials.access_token,
            tokenExpiresAt: new Date(credentials.expiry_date || Date.now() + 3600_000),
            updatedAt: new Date(),
          },
        },
      );
      if (credentials.access_token) auth.setCredentials(credentials);
    } catch (err) {
      console.error('[bp-gmail] token refresh failed', { connectionId, err: err.message });
      await releaseSyncLock(connectionId, 'Token refresh failed — reconnect required');
      return;
    }
  }

  const gmail = google.gmail({ version: 'v1', auth });

  // Build incremental query
  const lastSyncAt = connection.syncSettings && connection.syncSettings.lastSyncAt;
  let query = GMAIL_ATTACHMENT_QUERY;
  if (lastSyncAt) {
    const afterSec = Math.floor(new Date(lastSyncAt).getTime() / 1000);
    query += ` after:${afterSec}`;
  }

  const senders  = (connection.syncSettings && connection.syncSettings.importFilters && connection.syncSettings.importFilters.senders)  || [];
  const keywords = (connection.syncSettings && connection.syncSettings.importFilters && connection.syncSettings.importFilters.subjectKeywords) || [];
  if (senders.length > 0) query += ` (${senders.map(s => `from:${s}`).join(' OR ')})`;
  if (keywords.length > 0) query += ` (${keywords.map(k => `subject:${k}`).join(' OR ')})`;

  let pageToken;
  let importedCount = 0;
  let processedCount = 0;
  let cancelled = false;

  const isCancelled = async () => {
    const fresh = await col('email_connections').findOne(
      { _id: oid(connectionId) },
      { projection: { 'syncSettings.cancelRequested': 1 } },
    );
    return !!(fresh && fresh.syncSettings && fresh.syncSettings.cancelRequested);
  };

  try {
    do {
      if (await isCancelled()) { cancelled = true; break; }

      const listRes = await gmail.users.messages.list({
        userId: 'me',
        q: query,
        maxResults: 50,
        pageToken,
      });

      const messages = listRes.data.messages || [];
      pageToken = listRes.data.nextPageToken || undefined;

      for (const msg of messages) {
        if (!msg.id) continue;
        if (await isCancelled()) { cancelled = true; break; }

        try {
          const imported = await importGmailMessage(
            gmail,
            msg.id,
            connectionId,
            connection.tenantId.toString(),
            connection.userId.toString(),
          );
          if (imported) importedCount++;
          processedCount++;
        } catch (err) {
          console.error('[bp-gmail] failed to import message', { connectionId, msgId: msg.id, err: err.message });
        }
      }

      if (cancelled) break;
    } while (pageToken);
  } catch (err) {
    console.error('[bp-gmail] fatal sync error', { connectionId, err: err.message });
    await releaseSyncLock(connectionId, err.message || 'Unknown sync error');
    return;
  }

  const syncUpdate = {
    $set: {
      'syncSettings.isSyncing': false,
      'syncSettings.cancelRequested': false,
      updatedAt: new Date(),
    },
    $inc: {
      'stats.totalEmailsProcessed': processedCount,
      'stats.totalDocumentsImported': importedCount,
    },
  };
  if (!cancelled) {
    syncUpdate.$set['syncSettings.lastSyncAt'] = new Date();
    syncUpdate.$set['syncSettings.lastSyncError'] = null;
  }
  await col('email_connections').updateOne({ _id: oid(connectionId) }, syncUpdate);

  console.log('[bp-gmail] sync complete', { connectionId, processedCount, importedCount, cancelled });
}

async function importGmailMessage(gmail, messageId, connectionId, tenantId, userId) {
  // Dedup check
  const existing = await col('documents').findOne({
    tenantId: oid(tenantId),
    'source.emailId': messageId,
  });
  if (existing) return false;

  const msgRes = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
  const msg     = msgRes.data;
  const headers = (msg.payload && msg.payload.headers) || [];

  const subject = (headers.find(h => h.name && h.name.toLowerCase() === 'subject') || {}).value || '';
  const from    = (headers.find(h => h.name && h.name.toLowerCase() === 'from') || {}).value || '';
  const dateHeader = (headers.find(h => h.name && h.name.toLowerCase() === 'date') || {}).value;
  const receivedAt = dateHeader ? new Date(dateHeader) : new Date();

  const attachments = collectAttachments(msg.payload);
  if (attachments.length === 0) return false;

  let anyImported = false;

  for (const att of attachments) {
    if (!isAllowedAttachment(att.mimeType, att.filename)) continue;
    if (!att.attachmentId) continue;

    const effectiveMimeType = resolvedMimeType(att.mimeType, att.filename);

    try {
      const attRes = await gmail.users.messages.attachments.get({
        userId: 'me',
        messageId,
        id: att.attachmentId,
      });

      const data = attRes.data.data;
      if (!data) continue;

      const buffer = Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

      const now = new Date();
      const docRecord = {
        tenantId:   oid(tenantId),
        clientId:   oid(userId),
        uploadedBy: oid(userId),
        source: {
          type: 'email',
          emailId: messageId,
          emailSubject: subject,
          emailFrom: from,
          emailConnectionId: oid(connectionId),
          receivedAt,
        },
        files: [],
        extraction: { status: 'pending' },
        status: 'pending_processing',
        flags: { needsReview: false, isDuplicate: false, isRecurring: false },
        year:  now.getFullYear(),
        month: now.getMonth() + 1,
        createdAt: now,
        updatedAt: now,
      };

      const docResult = await col('documents').insertOne(docRecord);
      const docId = docResult.insertedId;

      const fileName = att.filename || `attachment-${att.attachmentId}.${mimeToExt(effectiveMimeType)}`;
      const b2Key    = buildB2Key(userId, fileName);

      const uploaded = await uploadImage(b2Key, buffer, effectiveMimeType);

      await col('documents').updateOne(
        { _id: docId },
        {
          $push: {
            files: {
              b2Key,
              b2FileId:  uploaded.fileId,
              b2Bucket:  process.env.BACKBLAZE_BUCKET_NAME || 'iconicMedia',
              fileName,
              mimeType:  effectiveMimeType,
              sizeBytes: buffer.length,
              uploadedAt: new Date(),
            },
          },
          $set: { updatedAt: new Date() },
        },
      );

      anyImported = true;
      console.log('[bp-gmail] attachment imported', { messageId, docId: docId.toString(), fileName });
    } catch (err) {
      console.error('[bp-gmail] failed to import attachment', { messageId, filename: att.filename, err: err.message });
    }
  }

  return anyImported;
}

// ─── Connection management ────────────────────────────────────────────────────

/**
 * List email connections for a user.
 * @param {string} userId
 * @param {string} tenantId
 * @returns {Promise<object[]>}
 */
async function listEmailConnections(userId, tenantId) {
  return col('email_connections')
    .find({ userId: oid(userId), tenantId: oid(tenantId) })
    .project({ accessToken: 0, refreshToken: 0 })
    .sort({ createdAt: -1 })
    .toArray();
}

/**
 * Soft-delete an email connection.
 * @param {string} connectionId
 * @param {string} userId
 */
async function deleteEmailConnection(connectionId, userId) {
  const result = await col('email_connections').deleteOne({
    _id: oid(connectionId),
    userId: oid(userId),
  });
  if (result.deletedCount === 0) throw new BpError('Connection not found', 404, 'NOT_FOUND');
}

/**
 * Trigger a manual sync for a connection.
 * @param {string} connectionId
 * @param {string} userId
 */
async function triggerSync(connectionId, userId) {
  const conn = await col('email_connections').findOne({
    _id: oid(connectionId),
    userId: oid(userId),
  });
  if (!conn) throw new BpError('Connection not found', 404, 'NOT_FOUND');

  if (conn.syncSettings && conn.syncSettings.isSyncing) {
    throw new BpError('Sync already in progress', 409, 'SYNC_IN_PROGRESS');
  }

  await col('email_connections').updateOne(
    { _id: oid(connectionId) },
    { $set: { 'syncSettings.isSyncing': true, updatedAt: new Date() } },
  );

  // Run sync in background — do not await
  syncGmailConnection(connectionId).catch(err => {
    console.error('[bp-gmail] background sync failed', { connectionId, err: err.message });
  });
}

module.exports = {
  getOAuthClient,
  getAuthUrl,
  handleCallback,
  syncGmailConnection,
  listEmailConnections,
  deleteEmailConnection,
  triggerSync,
};
