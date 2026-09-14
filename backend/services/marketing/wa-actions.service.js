"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// WaActionsService — WhatsApp Native Actions
//
// Features:
//   Feature 6  — WhatsApp Status Campaigns (postStatus)
//   Feature 11 — Native VCard Sending      (sendVCard)
//   Feature 12 — Location Sharing         (sendLocation)
//   Feature 17 — Dynamic Group Creation   (createGroup)
//   Feature 25 — Community Broadcast      (broadcastToCommunity)
//
// All methods:
//   - Accept a sessionId and resolve the Baileys socket internally
//   - Throw typed WaActionError / WaSessionError on failure
//   - Are stateless — can be called from the HTTP controller or the queue worker
//
// Usage:
//   const actions = require('./wa-actions.service');
//   await actions.sendVCard('sess_abc', '972501234567', { name: 'Moshe', phone: '972501234567' });
// ─────────────────────────────────────────────────────────────────────────────

const fs = require("fs");
const path = require("path");
const mktSession = require("./wa-marketing-session.service");
const { WaActionError, WaSessionError } = require("../../errors/wa-errors");

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normalize a phone number to Baileys JID format.
 * Accepts: "0501234567", "972501234567", "+972-50-123-4567"
 * Returns: "972501234567@s.whatsapp.net"
 */
function toJid(phone) {
  let digits = String(phone).replace(/\D/g, "");
  if (!digits) throw new WaActionError("Phone number has no digits", "format_phone");
  if (digits.startsWith("0")) digits = "972" + digits.slice(1);
  if (digits.length < 10 || digits.length > 15)
    throw new WaActionError(`Invalid phone length: ${digits.length}`, "format_phone");
  return `${digits}@s.whatsapp.net`;
}

/** Resolve to a socket, throwing WaSessionError if not active */
function sock(sessionId) {
  return mktSession.getSocket(sessionId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Feature 6 — WhatsApp Status Campaign
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Post an image or video to the WhatsApp Status (Stories).
 * Visible to all contacts for 24 hours.
 *
 * @param {string} sessionId
 * @param {object} params
 * @param {Buffer|string} params.media     - File Buffer OR absolute file path
 * @param {"image"|"video"} params.type    - Media type
 * @param {string}  [params.caption]       - Text caption (optional)
 * @param {number}  [params.videoDuration] - Video duration in seconds (required for video)
 * @returns {Promise<object>}  Baileys send result
 */
async function postStatus(sessionId, { media, type = "image", caption = "", videoDuration }) {
  const socket = sock(sessionId);

  let mediaBuffer;
  if (Buffer.isBuffer(media)) {
    mediaBuffer = media;
  } else if (typeof media === "string") {
    // Treat as file path
    if (!fs.existsSync(media)) {
      throw new WaActionError(`Media file not found: ${media}`, "post_status", sessionId);
    }
    mediaBuffer = fs.readFileSync(media);
  } else {
    throw new WaActionError("media must be a Buffer or file path", "post_status", sessionId);
  }

  try {
    const messageContent =
      type === "video"
        ? {
            video: mediaBuffer,
            caption,
            seconds: videoDuration || 30,
            ptv: false, // false = story; true = view-once video note
          }
        : {
            image: mediaBuffer,
            caption,
          };

    const result = await socket.sendMessage(
      "status@broadcast",
      messageContent,
      { backgroundColor: "#000000" },
    );

    console.log(`[WaActions:${sessionId}] Status posted (type: ${type})`);
    return result;
  } catch (err) {
    throw new WaActionError(`Failed to post status: ${err.message}`, "post_status", sessionId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Feature 11 — Native VCard Sending
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a standard VCF 3.0 string from contact data.
 *
 * @param {object} contact
 * @param {string}  contact.name          - Display name
 * @param {string}  contact.phone         - Phone number (any format)
 * @param {string}  [contact.org]         - Organization / company
 * @param {string}  [contact.email]       - Email address
 * @param {string}  [contact.title]       - Job title
 * @param {string}  [contact.website]     - Website URL
 * @returns {string}  VCF string
 */
function buildVCard({ name, phone, org, email, title, website }) {
  if (!name || !phone) throw new WaActionError("name and phone are required for VCard", "build_vcard");

  const digits = String(phone).replace(/\D/g, "");
  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `FN:${name}`,
    `N:${name};;;`,
    `TEL;type=CELL;type=VOICE;waid=${digits}:+${digits}`,
  ];
  if (org) lines.push(`ORG:${org}`);
  if (title) lines.push(`TITLE:${title}`);
  if (email) lines.push(`EMAIL:${email}`);
  if (website) lines.push(`URL:${website}`);
  lines.push("END:VCARD");

  return lines.join("\n");
}

/**
 * Send a native WhatsApp Contact Card (VCard) to a recipient.
 *
 * @param {string} sessionId
 * @param {string} toPhone   - Recipient phone number
 * @param {object} contact   - Contact data (see buildVCard)
 * @returns {Promise<object>}
 */
async function sendVCard(sessionId, toPhone, contact) {
  const socket = sock(sessionId);
  const jid = toJid(toPhone);
  const vcard = buildVCard(contact);

  try {
    const result = await socket.sendMessage(jid, {
      contacts: {
        displayName: contact.name,
        contacts: [{ vcard }],
      },
    });

    console.log(`[WaActions:${sessionId}] VCard sent to ${toPhone}`);
    return result;
  } catch (err) {
    throw new WaActionError(`Failed to send VCard: ${err.message}`, "send_vcard", sessionId, { toPhone });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Feature 12 — Location Sharing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send a native WhatsApp Location Message.
 *
 * @param {string} sessionId
 * @param {string} toPhone
 * @param {object} params
 * @param {number}  params.latitude
 * @param {number}  params.longitude
 * @param {string}  [params.name]     - Location name (shown as title in chat)
 * @param {string}  [params.address]  - Street address (shown as subtitle)
 * @returns {Promise<object>}
 */
async function sendLocation(sessionId, toPhone, { latitude, longitude, name, address }) {
  const socket = sock(sessionId);
  const jid = toJid(toPhone);

  if (typeof latitude !== "number" || typeof longitude !== "number") {
    throw new WaActionError("latitude and longitude must be numbers", "send_location", sessionId);
  }
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    throw new WaActionError("Invalid coordinates", "send_location", sessionId, { latitude, longitude });
  }

  try {
    const result = await socket.sendMessage(jid, {
      location: {
        degreesLatitude: latitude,
        degreesLongitude: longitude,
        name: name || "",
        address: address || "",
      },
    });

    console.log(`[WaActions:${sessionId}] Location sent to ${toPhone} (${latitude},${longitude})`);
    return result;
  } catch (err) {
    throw new WaActionError(`Failed to send location: ${err.message}`, "send_location", sessionId, { toPhone });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Feature 17 — Dynamic Group Creation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a new WhatsApp group, add participants, optionally promote admins,
 * and return the group JID + invite link.
 *
 * @param {string}   sessionId
 * @param {object}   params
 * @param {string}    params.name         - Group name
 * @param {string[]}  params.phones       - Participant phone numbers to add
 * @param {string[]}  [params.adminPhones]- Subset of phones to promote as admins
 * @param {string}    [params.description]- Group description (set after creation)
 * @returns {Promise<{ groupJid: string, inviteLink: string, participants: string[] }>}
 */
async function createGroup(sessionId, { name, phones, adminPhones = [], description }) {
  const socket = sock(sessionId);

  if (!name || !name.trim()) {
    throw new WaActionError("Group name is required", "create_group", sessionId);
  }
  if (!Array.isArray(phones) || phones.length === 0) {
    throw new WaActionError("At least one participant phone is required", "create_group", sessionId);
  }

  // Convert phones to JIDs
  const participantJids = phones.map((p) => toJid(p));

  let groupResult;
  try {
    groupResult = await socket.groupCreate(name.trim(), participantJids);
  } catch (err) {
    throw new WaActionError(`Group creation failed: ${err.message}`, "create_group", sessionId, { name });
  }

  const groupJid = groupResult.id;
  console.log(`[WaActions:${sessionId}] Group created: ${groupJid} ("${name}")`);

  // Set description if provided
  if (description) {
    try {
      await socket.groupUpdateDescription(groupJid, description);
    } catch (err) {
      console.warn(`[WaActions:${sessionId}] Failed to set group description:`, err.message);
    }
  }

  // Promote admins if specified
  if (adminPhones.length > 0) {
    try {
      const adminJids = adminPhones.map((p) => toJid(p));
      await socket.groupParticipantsUpdate(groupJid, adminJids, "promote");
      console.log(`[WaActions:${sessionId}] Promoted ${adminJids.length} admin(s) in ${groupJid}`);
    } catch (err) {
      console.warn(`[WaActions:${sessionId}] Failed to promote admins:`, err.message);
    }
  }

  // Fetch invite link
  let inviteLink = null;
  try {
    const inviteCode = await socket.groupInviteCode(groupJid);
    inviteLink = `https://chat.whatsapp.com/${inviteCode}`;
  } catch (err) {
    console.warn(`[WaActions:${sessionId}] Failed to fetch invite link:`, err.message);
  }

  return {
    groupJid,
    inviteLink,
    participants: participantJids,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Feature 25 — Community Announcement Push
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send a broadcast message to a WhatsApp Community announcement group.
 *
 * How Communities work in Baileys:
 *   - A Community has a "linked announcement group" (the main broadcast channel)
 *   - Only admins can send to the announcement group
 *   - The announcement group JID ends in @g.us
 *
 * @param {string} sessionId
 * @param {object} params
 * @param {string}  params.announcementJid  - JID of the announcement group
 *                                            (e.g. "120363XXXXX@g.us")
 * @param {string}  [params.text]           - Text message
 * @param {object}  [params.media]          - { buffer, type: 'image'|'video', caption }
 * @returns {Promise<object>}
 */
async function broadcastToCommunity(sessionId, { announcementJid, text, media }) {
  const socket = sock(sessionId);

  if (!announcementJid || !announcementJid.endsWith("@g.us")) {
    throw new WaActionError(
      "announcementJid must be a valid group JID ending in @g.us",
      "community_broadcast",
      sessionId,
    );
  }
  if (!text && !media) {
    throw new WaActionError("text or media is required", "community_broadcast", sessionId);
  }

  try {
    let messageContent;

    if (media) {
      // Media broadcast (image or video)
      const { buffer, type = "image", caption = "" } = media;
      if (!Buffer.isBuffer(buffer)) {
        throw new WaActionError("media.buffer must be a Buffer", "community_broadcast", sessionId);
      }
      messageContent = type === "video"
        ? { video: buffer, caption }
        : { image: buffer, caption };
    } else {
      messageContent = { text };
    }

    const result = await socket.sendMessage(announcementJid, messageContent);
    console.log(`[WaActions:${sessionId}] Community broadcast sent to ${announcementJid}`);
    return result;
  } catch (err) {
    throw new WaActionError(
      `Community broadcast failed: ${err.message}`,
      "community_broadcast",
      sessionId,
      { announcementJid },
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  postStatus,
  sendVCard,
  buildVCard,  // exported for testing / preview
  sendLocation,
  createGroup,
  broadcastToCommunity,
};
