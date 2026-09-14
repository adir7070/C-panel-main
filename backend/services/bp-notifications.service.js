'use strict';

const { col, oid, BpError } = require('./bp-db');

// ─── Create Notification ──────────────────────────────────────────────────────

/**
 * Inserts a notification record into bp_notifications.
 * Push delivery is stubbed (TODO: FCM/APNs integration).
 * @param {{
 *   tenantId: string,
 *   recipientId: string,
 *   type: string,
 *   title: string,
 *   body: string,
 *   data?: object,
 *   sendPush?: boolean,
 *   sendEmail?: boolean
 * }} input
 * @returns {Promise<void>}
 */
async function createNotification(input) {
  try {
    const now = new Date();
    const doc = {
      tenantId: oid(input.tenantId),
      recipientId: oid(input.recipientId),
      type: input.type,
      title: input.title,
      body: input.body,
      data: input.data || {},
      channels: {
        push: input.sendPush ?? false,
        email: input.sendEmail ?? false,
        inApp: true,
      },
      read: false,
      readAt: null,
      createdAt: now,
    };

    await col('notifications').insertOne(doc);

    // TODO: Integrate FCM/APNs for push delivery
    if (input.sendPush) {
      await _sendPushNotification(input.recipientId, input.title, input.body, input.data).catch((err) => {
        console.error('[Notifications] Push failed (non-fatal)', err);
      });
    }
  } catch (err) {
    // Notification failures must not crash the calling flow
    console.error('[Notifications] Failed to create notification', { err, input });
  }
}

// ─── Notify About Document ────────────────────────────────────────────────────

/**
 * Convenience helper to create a document-related notification.
 * @param {string} tenantId
 * @param {string} recipientId
 * @param {string} type - Notification type key
 * @param {string} docId
 * @param {string} title
 * @param {string} body
 * @returns {Promise<void>}
 */
async function notifyDocument(tenantId, recipientId, type, docId, title, body) {
  return createNotification({
    tenantId,
    recipientId,
    type,
    title,
    body,
    data: { documentId: docId },
    sendPush: true,
  });
}

// ─── Get Notifications ────────────────────────────────────────────────────────

/**
 * Returns paginated notifications for a recipient.
 * @param {string} recipientId
 * @param {{ page?: number, limit?: number, unreadOnly?: boolean }} [options={}]
 * @returns {Promise<{ notifications: object[], total: number, page: number, limit: number, unreadCount: number }>}
 */
async function getNotifications(recipientId, options = {}) {
  const page = Math.max(1, parseInt(options.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(options.limit, 10) || 20));
  const skip = (page - 1) * limit;

  const filter = { recipientId: oid(recipientId) };
  if (options.unreadOnly) {
    filter.read = false;
  }

  const [notifications, total, unreadCount] = await Promise.all([
    col('notifications')
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .toArray(),
    col('notifications').countDocuments(filter),
    col('notifications').countDocuments({ recipientId: oid(recipientId), read: false }),
  ]);

  return { notifications, total, page, limit, unreadCount };
}

// ─── Mark Read ────────────────────────────────────────────────────────────────

/**
 * Marks a single notification as read.
 * @param {string} notificationId
 * @param {string} recipientId
 * @returns {Promise<boolean>} true if a document was modified
 */
async function markRead(notificationId, recipientId) {
  const result = await col('notifications').updateOne(
    {
      _id: oid(notificationId),
      recipientId: oid(recipientId),
    },
    { $set: { read: true, readAt: new Date() } }
  );

  return result.modifiedCount > 0;
}

// ─── Mark All Read ────────────────────────────────────────────────────────────

/**
 * Marks all unread notifications for a recipient as read.
 * @param {string} recipientId
 * @returns {Promise<number>} Count of notifications updated
 */
async function markAllRead(recipientId) {
  const result = await col('notifications').updateMany(
    { recipientId: oid(recipientId), read: false },
    { $set: { read: true, readAt: new Date() } }
  );

  return result.modifiedCount;
}

// ─── Internal: Push Stub ──────────────────────────────────────────────────────

/**
 * Stub for FCM/APNs push delivery.
 * Looks up the user's push tokens and logs the intent.
 * @param {string} recipientId
 * @param {string} title
 * @param {string} body
 * @param {object} [data]
 * @returns {Promise<void>}
 */
async function _sendPushNotification(recipientId, title, body, data) {
  try {
    const user = await col('users').findOne(
      { _id: oid(recipientId) },
      { projection: { pushTokens: 1 } }
    );
    if (!user || !user.pushTokens || user.pushTokens.length === 0) return;

    // TODO: Integrate with FCM (Android) / APNs (iOS)
    console.info('[Notifications] Would send push notification', {
      recipientId,
      title,
      tokenCount: user.pushTokens.length,
      data,
    });
  } catch (err) {
    console.error('[Notifications] Failed to send push notification', { err, recipientId });
  }
}

module.exports = {
  createNotification,
  notifyDocument,
  getNotifications,
  markRead,
  markAllRead,
};
