const { getDB } = require("./config/db");
const DB = require("./utils/DB");
const pushNotification = require("./services/push-notification.service");
const fireberry = require("./services/fireberry.service");
const { getCustomer } = require("./services/customer-cache.service");
const { relaySocketEvent } = require("./services/socket-relay.service");
const { broadcast } = require("./utils/broadcast");
const { syncToPeer } = require("./services/db-sync.service");

function stripPhoneFromName(str) {
  if (!str) return str;
  return str.replace(/(\+972|972|05)\d[\d\s\-]{6,}/g, '').replace(/\n+/g, ' ').trim();
}

const INQUIRY_AUTO_RESPONSES = {
  customer_service: 'תודה שפנית! 😊 נא לפרט את הבקשה או השאלה ונחזור אלייך בהקדם.',
  website_build:    'תודה שפנית! 🌐 נא לפרט את הבקשה או השאלה ונחזור אלייך בהקדם.',
  ad_design:        'תודה שפנית! 🎨 נא לפרט את הבקשה או השאלה ונחזור אלייך בהקדם.',
  app_problem:      'תודה שפנית! 📱 נא לשלוח צילום מסך של הבעיה ולאחר מכן לפרט את הבעיה.',
};

// Collection helpers - use DB wrapper for dual-write + fallback
const chats        = () => DB.collection("support_chats");
const stations     = () => DB.collection("stations");
const agentChats   = () => DB.collection("agent_chats");
const websiteChats = () => DB.collection("website_support_chats");

// ── Website Support — in-memory state ──────────────────────────────────────
const websiteChatHistory  = {}; // userId → messages[]
const websiteTicketStatus = {}; // userId → "open"|"closed"

// שמירת טלפונים שנמצאים כרגע ב-enrichment — מונע כפילויות כשמתחברים מספר נציגים בו-זמנית
const _enriching = new Set();

/**
 * enrichSessionNames — מריץ ברקע אחרי all_sessions.
 * לכל session שחסר לו fireberyName: שולף מ-customer-cache (MongoDB-first, לא API),
 * שומר ל-support_chats, ומשדר user_info_updated לכל הנציגים.
 * כך בטעינה הבאה השם כבר מגיע ישירות מ-all_sessions.
 */
async function enrichSessionNames(sessions, io) {
  for (const session of sessions) {
    const phone = session.phone;
    // _enriching מונע כפילויות בתוך אותו process (נציגים שמתחברים בו-זמנית)
    if (!phone || _enriching.has(phone)) continue;
    _enriching.add(phone);
    try {
      const customer = await getCustomer(phone);
      if (!customer?.accountid) continue; // לא קיים בפיירברי — לא שומרים כלום
      const freshName = stripPhoneFromName(customer.accountname) || customer.firstname || null;
      const update = {};
      if (freshName)          update.fireberyName      = freshName;
      if (customer.firstname) update.fireberyFirstName = customer.firstname;
      if (!session.fireberyAccountId && customer.accountid) update.fireberyAccountId = customer.accountid;
      if (!Object.keys(update).length) continue;

      // כתיבה אטומית: MongoDB מעדכן רק אם fireberyName עדיין חסר.
      // אם process אחר (PM2 cluster) כבר כתב — modifiedCount=0 ולא שולחים socket כפול.
      const result = await chats().updateOne(
        { _id: session._id, $or: [{ fireberyName: { $exists: false } }, { fireberyName: null }, { fireberyName: '' }] },
        { $set: update }
      );
      if (result.modifiedCount === 0) continue; // כבר עודכן
      broadcast(io, "user_info_updated", "support_team", { userId: session._id, ...update });
    } catch (err) {
      console.error(`[Enrich] ${phone}:`, err.message);
    } finally {
      _enriching.delete(phone);
    }
  }
}

const phoneToSocketId = {}; // phone → socketId (module-scope for isPhoneOnline)

function isPhoneOnline(phone) {
  return !!phoneToSocketId[phone];
}

function setupSocketManager(io) {
  // In-memory cache for quick access during a session
  let activeUsers = {};
  let chatHistory = {};
  let ticketStatus = {};
  let userNames = {}; // userId -> { name, phone }
  let userStation = {}; // userId -> stationId
  let chatPhones = {}; // userId -> phone (persists across chatHistory cache hits)

  // Internal agent-to-agent chat tracking
  let activeAgentsInternal = {}; // agentId -> { socketId, name }
  let internalSocketToAgent = {}; // socket.id -> agentId

  // Version update flag — persists in memory until server restarts (cleared on deploy)
  let pendingVersionUpdate = false;

  // Collision detection — tracks which agents are viewing each conversation
  let conversationViewers = {}; // userId → { agentId → { agentName, socketId } }

  // Pinned messages & favorites — global per chat
  let pinnedMessages = {}; // userId → { messageId, text, type, senderName, createdAt, mediaUrl } | null
  let favoriteMessages = {}; // userId → [{ messageId, text, type, senderName, createdAt, mediaUrl }]

  function buildMessageSnapshot(msg) {
    return {
      messageId: msg._id,
      text: msg.text,
      type: msg.type,
      senderName: msg.user?.name || (msg.fromRole === 'user' ? 'לקוח' : 'נציג'),
      createdAt: msg.createdAt,
      mediaUrl: (msg.type === 'image' ? msg.text : null) || msg.videoUrl || null,
    };
  }

  // ─── Load or create a session doc in MongoDB ───
  async function loadSession(userId) {
    let doc = await chats().findOne({ _id: userId });
    if (!doc) {
      // Don't create the doc yet — wait for user_info (which may need to merge a proactive chat first).
      // pushMessage() uses upsert:true so the doc will be created on first real message if needed.
      doc = { _id: userId, status: "open", messages: [], created_at: new Date(), updated_at: new Date() };
    }
    if (!doc.messages) doc.messages = [];
    chatHistory[userId] = doc.messages;
    ticketStatus[userId] = doc.status;
    return doc;
  }

  // ─── Persist a new message ───
  async function pushMessage(userId, messageObj) {
    // Only update in-memory cache if it was already fully loaded from DB.
    // If chatHistory[userId] is not set yet, don't initialise it with a single message —
    // agent_request_history will load the full history from DB on first request.
    if (chatHistory[userId]) {
      chatHistory[userId].push(messageObj);
    }
    await chats().updateOne(
      { _id: userId },
      { $push: { messages: messageObj }, $set: { updated_at: new Date() } },
      { upsert: true }
    );
    syncToPeer('push_message', userId, { message: messageObj });
  }

  // ─── Update ticket status ───
  async function setStatus(userId, status) {
    ticketStatus[userId] = status;
    await chats().updateOne(
      { _id: userId },
      { $set: { status, updated_at: new Date() } },
      { upsert: true }
    );
    syncToPeer('set_status', userId, { status });
  }

  io.on("connection", (socket) => {
    console.log(`[Socket] New Connection: ${socket.id}`);

    // --- WhatsApp session rooms ---
    socket.on("join", (room) => {
      if (typeof room === "string" && room.startsWith("session:")) {
        socket.join(room);
        console.log(`[Socket] ${socket.id} joined room ${room}`);

        // Send cached QR if available (handles race condition)
        const waService = require("./services/wa-session.service");
        const sessionId = room.replace("session:", "");
        const cachedQr = waService.lastQrCache.get(sessionId);
        if (cachedQr) {
          socket.emit("qr", { qr: cachedQr });
          socket.emit("status", { status: "qr_ready" });
        }
      }
    });

    // --- 1. לקוח מתחבר ---
    socket.on("join_user", async (userId) => {
      socket.join(userId);
      activeUsers[socket.id] = { userId, role: "user" };
      console.log(`[User Joined] ID: ${userId}`);

      try {
        const doc = await loadSession(userId);

        socket.emit("history_loaded", {
          messages: doc.messages.filter(m => !m.agentOnly),
          status: doc.status,
          inquiryType: doc.inquiryType ?? null,
        });

        broadcast(io, "system_notification", "support_team", {
          type: "USER_CONNECTED",
          userId,
          status: doc.status,
        });
      } catch (err) {
        console.error(`[Socket] DB error on join_user:`, err.message);
      }
    });

    // --- 1b. לקוח שולח פרטי זיהוי ---
    socket.on("user_info", async ({ userId, phone, name }) => {
      if (!userId) return;
      userNames[userId] = { name, phone };
      if (phone) chatPhones[userId] = phone;
      if (phone) {
        phoneToSocketId[phone] = socket.id;
        // getDB() throws synchronously if Mongo hasn't connected yet (race during boot).
        // Wrap so the throw doesn't kill the dyno — the lastSeenAt update is best-effort.
        try {
          getDB().collection("users").updateOne({ phone }, { $set: { lastSeenAt: new Date() } }, { upsert: true }).catch(() => {});
        } catch (e) {
          console.warn(`[Socket] user_info: DB not ready, skipping lastSeenAt for phone=${phone}`);
        }
      }

      // Join phone-based room so appointment socket events reach the customer
      if (phone) socket.join(phone);

      // מיזוג צ'אט proactive: אם נציג פתח צ'אט לפני שהלקוח התחבר
      const normalizedIncomingPhone = phone ? phone.replace(/\D/g, "") : null;
      if (normalizedIncomingPhone && normalizedIncomingPhone !== String(userId)) {
        try {
          // מחפש proactive chat שה-_id שלו הוא הטלפון, ושעוד לא מוזג
          const proactiveChat = await chats().findOne({ _id: normalizedIncomingPhone, status: { $ne: "merged" } });
          if (proactiveChat) {
            const proactiveMsgs = proactiveChat.messages || [];

            // העבר הודעות לתוך ה-userId doc (בתחילת המערך)
            if (proactiveMsgs.length > 0) {
              await chats().updateOne(
                { _id: userId },
                { $push: { messages: { $each: proactiveMsgs, $position: 0 } }, $set: { updated_at: new Date() } },
                { upsert: true }
              );
              chatHistory[userId] = [...proactiveMsgs, ...(chatHistory[userId] || [])];
            }

            // העבר מטאדאטה (fireberyName, station וכו') אם לא קיים ב-userId doc
            const userDoc = await chats().findOne({ _id: userId });
            const metaUpdate = {};
            if (!userDoc?.fireberyName    && proactiveChat.fireberyName)    metaUpdate.fireberyName    = proactiveChat.fireberyName;
            if (!userDoc?.fireberyAccountId && proactiveChat.fireberyAccountId) metaUpdate.fireberyAccountId = proactiveChat.fireberyAccountId;
            if (!userDoc?.station          && proactiveChat.station)          metaUpdate.station         = proactiveChat.station;
            if (!userDoc?.stations?.length && proactiveChat.stations?.length) metaUpdate.stations        = proactiveChat.stations;
            if (Object.keys(metaUpdate).length > 0) {
              await chats().updateOne({ _id: userId }, { $set: metaUpdate });
            }

            // סמן כ-merged במקום למחוק — שומר היסטוריה
            await chats().updateOne(
              { _id: normalizedIncomingPhone },
              { $set: { status: "merged", mergedInto: userId, mergedAt: new Date() } }
            );
            delete chatHistory[normalizedIncomingPhone];
            delete ticketStatus[normalizedIncomingPhone];
            delete chatPhones[normalizedIncomingPhone];

            broadcast(io, "proactive_chat_merged", "support_team", {
              oldId: normalizedIncomingPhone,
              newId: userId,
              name,
              phone: normalizedIncomingPhone,
            });
            console.log(`[Socket] Merged proactive chat ${normalizedIncomingPhone} → ${userId}`);

            // שלח ללקוח היסטוריה מעודכנת
            if (proactiveMsgs.length > 0) {
              const updatedDoc = await chats().findOne({ _id: userId });
              socket.emit("history_loaded", {
                messages: (updatedDoc?.messages || []).filter(m => !m.agentOnly),
                status: updatedDoc?.status || "open",
              });
            }
          }
        } catch (mergeErr) {
          console.error(`[Socket] Error merging proactive chat:`, mergeErr.message);
        }
      }

      try {
        await chats().updateOne(
          { _id: userId },
          { $set: { name, phone, updated_at: new Date() } },
          { upsert: true }
        );
        broadcast(io, "user_info_updated", "support_team", { userId, name, phone });

        // עדכון Fireberry שהלקוח השתמש בצ'אט
        if (phone) {
          fireberry.markChatActive(phone).catch(e =>
            console.error(`[Fireberry] markChatActive error for ${phone}:`, e.message)
          );
        }
      } catch (err) {
        console.error(`[Socket] DB error on user_info:`, err.message);
      }
    });

    // --- 1c. מנהל תיק מתחבר לחדר פרטי ---
    socket.on("join_account_manager", (agentId) => {
      if (!agentId) return;
      socket.join(`am_${agentId}`);
      console.log(`[Account Manager Joined] am_${agentId}`);
    });

    socket.on("join_client_chat", (chatId) => {
      if (chatId) socket.join(chatId);
    });
    socket.on("leave_client_chat", (chatId) => {
      if (chatId) socket.leave(chatId);
    });

    // --- 2. נציג מתחבר ---
    socket.on("agent_ping", (t) => socket.emit("agent_pong", t));

    socket.on("join_agent", async (data) => {
      socket.join("support_team");
      // תמיכה בפורמט ישן (string) וחדש (object)
      const agentId = typeof data === "object" ? data.agentId : data;
      const agentName = typeof data === "object" ? data.agentName : data;
      activeUsers[socket.id] = { userId: agentId, name: agentName, role: "agent" };
      console.log(`[Agent Joined] ID: ${agentId}, Name: ${agentName}`);

      // אם יש עדכון גרסה ממתין — שלח לנציג החדש שהתחבר
      if (pendingVersionUpdate) {
        socket.emit("app_version_update");
      }

      // שליחת שיחות 3 ימים אחרונים — ממוזגות משני ה-DBים
      try {
        const merged = await DB.findMergedRecentChats(3);
        const sessions = merged.map(chat => ({
          ...chat,
          messages: (chat.messages || []).slice(-3),
        }));
        socket.emit("all_sessions", sessions);

        // ברקע: עשיר שמות חסרים מ-customer-cache ושמור ל-DB
        const missing = sessions.filter(s => s.phone && (!s.fireberyName || s.fireberyName.length <= 2));
        if (missing.length) enrichSessionNames(missing, io).catch(() => {});
      } catch (err) {
        console.error(`[Socket] DB error loading sessions for agent:`, err.message);
      }
    });

    // --- 2a. נציג מתחיל לצפות בשיחה (Collision Detection) ---
    socket.on("view_conversation", ({ userId }) => {
      if (!userId) return;
      const agentInfo = activeUsers[socket.id];
      if (!agentInfo) return;
      const agentId = agentInfo.userId;
      const agentName = agentInfo.name;
      if (!conversationViewers[userId]) conversationViewers[userId] = {};
      conversationViewers[userId][agentId] = { agentName, socketId: socket.id };
      broadcast(io, "conversation_viewers_update", "support_team", {
        userId,
        viewers: Object.entries(conversationViewers[userId]).map(([aid, v]) => ({ agentId: aid, ...v })),
      });
    });

    socket.on("leave_conversation", ({ userId }) => {
      if (!userId) return;
      const agentInfo = activeUsers[socket.id];
      if (!agentInfo) return;
      const agentId = agentInfo.userId;
      if (conversationViewers[userId]) {
        delete conversationViewers[userId][agentId];
        if (Object.keys(conversationViewers[userId]).length === 0) {
          delete conversationViewers[userId];
        }
      }
      broadcast(io, "conversation_viewers_update", "support_team", {
        userId,
        viewers: conversationViewers[userId]
          ? Object.entries(conversationViewers[userId]).map(([aid, v]) => ({ agentId: aid, ...v }))
          : [],
      });
    });

    // --- 2b. נציג פותח צ'אט חדש ביוזמתו לפי מספר טלפון ---
    socket.on("agent_open_new_chat", async ({ phone }) => {
      if (!phone) return;
      const normalizedPhone = phone.replace(/\D/g, "");
      if (!/^05\d{8}$/.test(normalizedPhone)) {
        socket.emit("new_chat_error", { message: "מספר טלפון לא תקין. יש להזין מספר ישראלי בפורמט 05XXXXXXXX" });
        return;
      }
      try {
        // ── שלב 1: בדיקת פיירברי ──────────────────────────────────────────
        const customer = await getCustomer(normalizedPhone);
        if (!customer || !customer.accountid) {
          socket.emit("new_chat_error", { message: "הלקוח לא קיים בפיירברי, אנא בדוק את המספר" });
          return;
        }

        // ── שלב 2: בדיקת MongoDB — מחפש לפי phone או _id, לא merged ──────
        const existingChat = await chats().findOne({
          $or: [{ phone: normalizedPhone }, { _id: normalizedPhone }],
          status: { $ne: "merged" },
        });
        if (existingChat) {
          if (existingChat.status === "closed") {
            await setStatus(existingChat._id, "open");
            const reopenMsg = {
              _id: Date.now(), type: "system", event: "ticket_reopened",
              text: "הפנייה נפתחה מחדש על ידי הנציג", createdAt: new Date(),
            };
            await pushMessage(existingChat._id, reopenMsg);
            broadcast(io, "ticket_reopened_confirmed", "support_team", { userId: existingChat._id });
          }
          const freshName = stripPhoneFromName(customer.accountname) || customer.firstname || null;
          socket.emit("open_existing_chat", {
            userId: existingChat._id,
            name: existingChat.name || null,
            phone: normalizedPhone,
            fireberyName: existingChat.fireberyName || freshName || null,
            fireberyAccountId: existingChat.fireberyAccountId || customer.accountid || null,
            status: existingChat.status || "open",
          });
          console.log(`[NewChat] Opened existing chat for ${normalizedPhone} → ${existingChat._id}`);
          const notifSent = await pushNotification.notifyUser(
            normalizedPhone, "נציג תמיכה", "נציג תמיכה יצר איתך קשר 👋",
            { screen: "ChatScreenAi" }
          );
          if (!notifSent) {
            socket.emit("new_chat_warning", { message: "הלקוח לא מחובר לאפליקציה — ייתכן שלא יקבל את ההתראה" });
          }
        } else {
          // ── שלב 3: יצירת צ'אט חדש עם נתוני פיירברי ──────────────────
          const freshName = stripPhoneFromName(customer.accountname) || customer.firstname || null;
          const now = new Date();
          const newDoc = {
            _id: normalizedPhone,
            phone: normalizedPhone,
            status: "open",
            agentInitiated: true,
            messages: [],
            created_at: now,
            updated_at: now,
            ...(freshName && { fireberyName: freshName }),
            ...(customer.accountid && { fireberyAccountId: customer.accountid }),
          };
          await chats().insertOne(newDoc);
          chatHistory[normalizedPhone] = [];
          ticketStatus[normalizedPhone] = "open";
          chatPhones[normalizedPhone] = normalizedPhone;
          broadcast(io, "proactive_chat_created", "support_team", newDoc);
          console.log(`[NewChat] Created proactive chat for ${normalizedPhone}`);

          const notifSent = await pushNotification.notifyUser(
            normalizedPhone, "נציג תמיכה", "נציג תמיכה יצר איתך קשר 👋",
            { screen: "ChatScreenAi" }
          );
          if (!notifSent) {
            socket.emit("new_chat_warning", { message: "הלקוח לא מחובר לאפליקציה — ייתכן שלא יקבל את ההתראה" });
          }
        }
      } catch (err) {
        console.error(`[Socket] Error in agent_open_new_chat:`, err.message);
        socket.emit("new_chat_error", { message: "שגיאה בפתיחת הצ'אט, נסה שוב" });
      }
    });

  function normalizeStationIds(input) {
    if (Array.isArray(input)) return [...new Set(input.filter(Boolean))];
    if (input) return [input];
    return [];
  }

    // --- 2b. שיוך שיחה לעמדה ---
    socket.on("assign_station", async ({ userId, stationId, stationIds }) => {
      try {
        const nextStationIds = normalizeStationIds(stationIds ?? stationId);
        const currentChat = await chats().findOne({ _id: userId }, { projection: { station: 1, stations: 1 } });
        const previousStationIds = normalizeStationIds(currentChat?.stations?.length ? currentChat.stations : currentChat?.station);
        const uniqueIds = [...new Set([...previousStationIds, ...nextStationIds])];
        const stationDocs = uniqueIds.length
          ? await stations().find({ _id: { $in: uniqueIds } }).toArray()
          : [];
        const byId = {};
        stationDocs.forEach(s => { byId[s._id] = s; });

        const newStationNames = nextStationIds.map(id => byId[id]?.name || 'עמדה לא ידועה');
        const oldStationNames = previousStationIds.map(id => byId[id]?.name || 'עמדה לא ידועה');
        const primaryStationId = nextStationIds[0] || null;
        const primaryStationName = primaryStationId ? (byId[primaryStationId]?.name || 'עמדה לא ידועה') : null;

        const systemMsg = {
          _id: Date.now(),
          type: "system",
          event: "station_transferred",
          agentOnly: true,
          text: nextStationIds.length === 0
            ? 'השיוך לעמדות הוסר'
            : oldStationNames.length > 0
              ? `הצ'אט הועבר מ-${oldStationNames.join(', ')} לעמדות ${newStationNames.join(', ')}`
              : `הצ'אט הועבר לעמדות ${newStationNames.join(', ')}`,
          createdAt: new Date(),
        };
        await pushMessage(userId, systemMsg);

        await chats().updateOne(
          { _id: userId },
          {
            $set:   { station: primaryStationId, stations: nextStationIds, updated_at: new Date() },
            $unset: { reminderSentAt: '' },
            $push:  { stationHistory: {
              stationId: primaryStationId,
              stationName: primaryStationName || null,
              stationIds: nextStationIds,
              stationNames: newStationNames,
              assignedAt: new Date(),
            } },
          }
        );
        userStation[userId] = primaryStationId;
        syncToPeer('update_fields', userId, { fields: { station: primaryStationId, stations: nextStationIds, updated_at: new Date() } });

        broadcast(io, "station_assigned", "support_team", {
          userId,
          stationId: primaryStationId,
          stationIds: nextStationIds,
          stationName: primaryStationName,
          stationNames: newStationNames,
          previousStationId: previousStationIds[0] || null,
          systemMessage: systemMsg,
        });
        console.log(`[Station Assigned] Chat ${userId} → Stations ${newStationNames.join(', ') || 'none'}`);
      } catch (err) {
        console.error(`[Socket] Error assigning station:`, err.message);
      }
    });

    // --- 3. נציג מבקש היסטוריה ---
    socket.on("agent_request_history", async (data) => {
      const targetUserId = typeof data === "string" ? data : data?.userId;
      const offset = typeof data === "object" && data?.offset ? parseInt(data.offset) : 0;
      const LIMIT = 25;
      try {
        // offset=0 → always read fresh from DB (avoids race where a new message arrived
        // while the previous findOne was in flight and wasn't pushed to the cache).
        // offset>0 → use in-memory cache for pagination (messages are stable at that point).
        let chatDoc = null;
        if (offset === 0 || !chatHistory[targetUserId]) {
          chatDoc = await DB.findMergedChat(targetUserId);
          if (!chatDoc) chatDoc = { messages: [], status: "open" };
          chatHistory[targetUserId] = chatDoc.messages;
          ticketStatus[targetUserId] = chatDoc.status;
          chatHistory[`${targetUserId}_notes`] = chatDoc.notes || '';
          if (chatDoc.phone) chatPhones[targetUserId] = chatDoc.phone;
          pinnedMessages[targetUserId] = chatDoc.pinnedMessage || null;
          favoriteMessages[targetUserId] = chatDoc.favoriteMessages || [];
          // ברקע: השלם הודעות חסרות לשרת השני
          if (chatDoc.messages?.length) {
            syncToPeer('push_merged_messages', targetUserId, { messages: chatDoc.messages });
          }
        }

        const all = chatHistory[targetUserId] || [];
        const total = all.length;
        const end = Math.max(0, total - offset);
        const start = Math.max(0, end - LIMIT);
        const messages = all.slice(start, end);
        const hasMore = start > 0;

        socket.emit("agent_history_response", {
          userId: targetUserId,
          messages,
          status: ticketStatus[targetUserId] || "open",
          notes: offset === 0 ? (chatHistory[`${targetUserId}_notes`] || '') : undefined,
          hasMore,
          offset,
          pinnedMessage: offset === 0 ? (pinnedMessages[targetUserId] ?? null) : undefined,
          favoriteMessages: offset === 0 ? (favoriteMessages[targetUserId] ?? []) : undefined,
        });

        // Background enrichment — populate fireberyAccountId/fireberyName if missing.
        // Only runs when chatDoc was freshly loaded from DB (cache miss), so we have accurate field state.
        if (offset === 0 && chatDoc) {
          const phone = chatDoc.phone || chatPhones[targetUserId];
          const staleOrMissingName = !chatDoc.fireberyName || chatDoc.fireberyName.length <= 2;
          const needsEnrichment = phone && (!chatDoc.fireberyAccountId || staleOrMissingName);
          if (needsEnrichment) {
            getCustomer(phone).then(customer => {
              if (!customer) return;
              const update = {};
              if (staleOrMissingName) {
                const freshName = stripPhoneFromName(customer.accountname) || customer.firstname || null;
                if (freshName) update.fireberyName = freshName;
                if (customer.firstname) update.fireberyFirstName = customer.firstname;
              }
              if (!chatDoc?.fireberyAccountId && customer.accountid) {
                update.fireberyAccountId = customer.accountid;
              }
              if (!Object.keys(update).length) return;
              chats().updateOne({ _id: targetUserId }, { $set: update }).catch(() => {});
              broadcast(io, "user_info_updated", "support_team", { userId: targetUserId, ...update });
            }).catch(() => {});
          }
        }
      } catch (err) {
        console.error(`[Socket] DB error on agent_request_history:`, err.message);
        socket.emit("agent_history_response", {
          userId: targetUserId,
          messages: chatHistory[targetUserId] || [],
          status: ticketStatus[targetUserId] || "open",
          hasMore: false,
          offset: 0,
        });
      }
    });

    // --- 4. הודעה מלקוח ---
    socket.on("send_message_from_user", async (data) => {
      const userId = data.userId;

      try {
        // אם הפנייה הייתה סגורה - פותחים מחדש
        if (ticketStatus[userId] === "closed") {
          await setStatus(userId, "open");
          await chats().updateOne({ _id: userId }, { $unset: { inquiryType: '' } });
          await pushMessage(userId, {
            _id: Date.now(),
            type: "system",
            event: "ticket_reopened",
            text: "פנייה חדשה נפתחה",
            createdAt: new Date(),
          });
          broadcast(io, "ticket_status_changed", userId, "open");
        }

        const userName = userNames[userId]?.name || "לקוח";
        const messageObj = {
          _id: data.clientMessageId || Date.now(),
          text: data.text,
          ...(data.type && { type: data.type }),
          ...(data.videoUrl && { videoUrl: data.videoUrl }),
          ...(data.fileUrl && { fileUrl: data.fileUrl }),
          ...(data.fileName && { fileName: data.fileName }),
          ...(data.appointmentIso && { appointmentIso: data.appointmentIso }),
          ...(data.callPurpose && { callPurpose: data.callPurpose }),
          createdAt: new Date(),
          user: { _id: userId, name: userName },
          fromRole: "user",
          ...(data.replyTo && { replyTo: data.replyTo }),
        };

        await pushMessage(userId, messageObj);

        // לקוח ענה — נקה reminderSentAt כדי שלא יעלה בחיפוש הבא
        await chats().updateOne({ _id: userId }, { $unset: { reminderSentAt: '' } });

        if (data.type === 'appointment' && data.appointmentIso) {
          await chats().updateOne(
            { _id: userId },
            { $set: { appointmentAt: data.appointmentIso } }
          );
          // שמור callPurpose בפגישה אם קיים
          if (data.callPurpose) {
            try {
              const { upsertAppointmentPurpose } = require('./services/mongo-appointments.service');
              await upsertAppointmentPurpose({
                customerPhone: data.phone,
                appointmentIso: data.appointmentIso,
                callPurpose: data.callPurpose,
              });
            } catch (e) {
              console.error('[Socket] upsertAppointmentPurpose error:', e.message);
            }
          }
        }

        const emittedMsg = {
          ...messageObj,
          userId,
          name: userName,
          station: userStation[userId] || null,
          phone: userNames[userId]?.phone || null,
          ticketStatus: ticketStatus[userId],
        };
        broadcast(io, "receive_message", "support_team", emittedMsg);
        broadcast(io, "receive_message", userId, emittedMsg);

        // Notify the assigned account manager
        chats().findOne({ _id: userId }, { projection: { accountManagerId: 1 } }).then(doc => {
          if (doc?.accountManagerId) {
            broadcast(io, "new_client_message", `am_${doc.accountManagerId}`, {
              userId,
              phone: userNames[userId]?.phone || null,
              name: userName,
              preview: (messageObj.text || "").slice(0, 80),
              at: messageObj.createdAt,
            });
          }
        }).catch(() => {});

        // Background: populate fireberyName if not yet set for this chat (DB-first via cache service)
        const phone = userNames[userId]?.phone || userId;
        if (phone) {
          chats().findOne({ _id: userId }, { projection: { fireberyName: 1, fireberyAccountId: 1 } }).then(doc => {
            const staleOrMissingName = !doc?.fireberyName || doc.fireberyName.length <= 2;
            if (!staleOrMissingName && doc?.fireberyAccountId) return;
            getCustomer(phone).then(customer => {
              if (!customer) return;
              const freshName = stripPhoneFromName(customer.accountname) || customer.firstname || null;
              const update = {};
              if (staleOrMissingName && freshName) update.fireberyName = freshName;
              if (staleOrMissingName && customer.firstname) update.fireberyFirstName = customer.firstname;
              if (!doc?.fireberyAccountId && customer.accountid) update.fireberyAccountId = customer.accountid;
              if (!Object.keys(update).length) return;
              chats().updateOne({ _id: userId }, { $set: update }).catch(() => {});
              broadcast(io, "user_info_updated", "support_team", { userId, ...update });
            }).catch(() => {});
          }).catch(() => {});
        }
      } catch (err) {
        console.error(`[Socket] DB error on send_message_from_user:`, err.message);
      }
    });

    // --- 5. סוג פנייה ---
    socket.on("set_inquiry_type", async ({ userId, inquiryType }) => {
      if (!userId || !inquiryType) return;
      try {
        await chats().updateOne(
          { _id: userId },
          { $set: { inquiryType } },
          { upsert: false }
        );
      } catch (err) {
        console.error("[Socket] set_inquiry_type error:", err.message);
      }
    });

    // --- 5b. בחירת נושא פנייה — שולח הודעת לקוח + תגובה אוטומטית ---
    socket.on("select_inquiry_topic", async ({ userId, phone, topicKey, topicLabel, clientMessageId }) => {
      if (!userId || !topicKey || !topicLabel) return;
      try {
        if (ticketStatus[userId] === "closed") {
          await setStatus(userId, "open");
          await chats().updateOne({ _id: userId }, { $unset: { inquiryType: '' } });
          broadcast(io, "ticket_reopened_confirmed", "support_team", { userId });
        }

        const userName = userNames[userId]?.name || "לקוח";

        const userMsg = {
          _id: clientMessageId || Date.now(),
          text: topicLabel,
          type: "text",
          createdAt: new Date(),
          user: { _id: userId, name: userName },
          fromRole: "user",
        };
        await pushMessage(userId, userMsg);
        broadcast(io, "receive_message", "support_team", { ...userMsg, userId });
        broadcast(io, "receive_message", userId, { ...userMsg, userId });

        const responseText = INQUIRY_AUTO_RESPONSES[topicKey];
        if (responseText) {
          const autoMsgId = Date.now() + 1;
          const autoMsg = {
            _id: autoMsgId,
            text: responseText,
            type: "text",
            createdAt: new Date(),
            user: { _id: "agent", name: "נציג תמיכה" },
            fromRole: "agent",
          };
          await pushMessage(userId, autoMsg);
          broadcast(io, "receive_message", userId, autoMsg);
          broadcast(io, "receive_message", "support_team", { ...autoMsg, userId });
        }

        await chats().updateOne({ _id: userId }, { $set: { inquiryType: topicKey } }, { upsert: true });

        chats().findOne({ _id: userId }, { projection: { accountManagerId: 1 } }).then(doc => {
          if (doc?.accountManagerId) {
            broadcast(io, "new_client_message", `am_${doc.accountManagerId}`, {
              userId,
              phone: phone || userNames[userId]?.phone || null,
              name: userName,
              preview: topicLabel,
              at: new Date(),
            });
          }
        }).catch(() => {});
      } catch (err) {
        console.error("[Socket] select_inquiry_topic error:", err.message);
      }
    });

    // --- 6. הודעה מנציג ---
    socket.on("send_message_from_agent", async (data) => {
      const targetUserId = data.targetUserId;
      const agentInfo = activeUsers[socket.id] || {};
      const agentName = data.senderLabel || agentInfo.name || "נציג תמיכה";
      const agentId = agentInfo.userId || "agent";

      try {
        const messageObj = {
          _id: data.clientMessageId || Date.now(),
          text: data.text,
          type: data.type || "text",
          ...(data.videoUrl && { videoUrl: data.videoUrl }),
          ...(data.fileUrl && { fileUrl: data.fileUrl }),
          ...(data.fileName && { fileName: data.fileName }),
          createdAt: new Date(),
          user: { _id: agentId, name: agentName },
          fromRole: "agent",
          ...(data.replyTo && { replyTo: data.replyTo }),
        };

        await pushMessage(targetUserId, messageObj);

        broadcast(io, "receive_message", targetUserId, messageObj);
        socket.broadcast.to("support_team").emit("receive_message", { ...messageObj, userId: targetUserId });
        relaySocketEvent("receive_message", "support_team", { ...messageObj, userId: targetUserId });

        // Push notification
        const notifBody = data.type === "video"
          ? "🎥 סרטון חדש"
          : data.type === "image"
          ? "📷 תמונה חדשה"
          : data.type === "file"
          ? `📄 ${data.fileName || "קובץ חדש"}`
          : data.text || "הודעה חדשה";

        // Push notification — try customerPhone first if the client provided
        // one (C-panel passes it from the URL). If that doesn't find a token,
        // fall back to the chat _id (the path the legacy webapp always used).
        // notifyUser already tries multiple phone format variants internally,
        // so this two-step covers all the cases we've observed.
        (async () => {
          const targets = [];
          if (data.customerPhone) targets.push(data.customerPhone);
          if (targetUserId && targetUserId !== data.customerPhone) targets.push(targetUserId);
          console.log(`[Push] send_message_from_agent → trying targets in order: ${targets.join(" → ")}`);
          for (const t of targets) {
            const ok = await pushNotification.notifyUser(t, "נציג תמיכה", notifBody, {
              screen: "ChatScreenAi",
            });
            if (ok) {
              console.log(`[Push] succeeded with target=${t}`);
              return;
            }
          }
          console.warn(`[Push] all targets failed for send_message_from_agent — no notification delivered`);
        })().catch(err => console.error(`[Push] dispatch error:`, err.message));
      } catch (err) {
        console.error(`[Socket] DB error on send_message_from_agent:`, err.message);
      }
    });

    // --- 5b. תמונה מנציג ---
    socket.on("send_image_from_agent", async (data) => {
      const targetUserId = data.targetUserId;
      const agentInfo = activeUsers[socket.id] || {};
      const agentName = data.senderLabel || agentInfo.name || "נציג תמיכה";
      const agentId = agentInfo.userId || "agent";

      try {
        const messageObj = {
          _id: Date.now(),
          text: data.imageUrl,
          type: "image",
          createdAt: new Date(),
          user: { _id: agentId, name: agentName },
          fromRole: "agent",
        };

        await pushMessage(targetUserId, messageObj);
        broadcast(io, "receive_message", targetUserId, messageObj);
        socket.broadcast.to("support_team").emit("receive_message", { ...messageObj, userId: targetUserId });
        relaySocketEvent("receive_message", "support_team", { ...messageObj, userId: targetUserId });

        pushNotification.notifyUser(targetUserId, "נציג תמיכה", "📷 תמונה חדשה", {
          screen: "ChatScreenAi",
        });
      } catch (err) {
        console.error(`[Socket] DB error on send_image_from_agent:`, err.message);
      }
    });

    // --- 6. מחיקת הודעה (עד שעה וחצי) ---
    socket.on("delete_message", async ({ userId, messageId }) => {
      if (!userId || !messageId) return;
      const cutoff = Date.now() - 90 * 60 * 1000;
      if (messageId < cutoff) return; // הודעה ישנה מדי

      const senderRole = activeUsers[socket.id]?.role || "user";

      try {
        const result = await chats().updateOne(
          { _id: userId, "messages._id": messageId, "messages.fromRole": senderRole },
          { $pull: { messages: { _id: messageId } } }
        );

        if (result.modifiedCount > 0) {
          // עדכן גם את ה-cache בזיכרון
          if (chatHistory[userId]) {
            chatHistory[userId] = chatHistory[userId].filter(m => m._id !== messageId);
          }
          broadcast(io, "message_deleted", userId, { messageId });
          broadcast(io, "message_deleted", "support_team", { userId, messageId });
          console.log(`[delete_message] messageId=${messageId} deleted for userId=${userId}`);
        }
      } catch (err) {
        console.error(`[Socket] DB error on delete_message:`, err.message);
      }
    });

    // --- 7א. הצמדת הודעה ---
    socket.on("pin_message", async ({ userId, messageId }) => {
      if (!userId) return;
      try {
        let pinned = null;
        if (messageId) {
          const msg = (chatHistory[userId] || []).find(m => String(m._id) === String(messageId));
          if (msg) pinned = buildMessageSnapshot(msg);
        }
        pinnedMessages[userId] = pinned;
        if (pinned) {
          await chats().updateOne({ _id: userId }, { $set: { pinnedMessage: pinned } });
        } else {
          await chats().updateOne({ _id: userId }, { $unset: { pinnedMessage: '' } });
        }
        broadcast(io, "message_pinned", "support_team", { userId, pinnedMessage: pinned });
        console.log(`[pin_message] userId=${userId} messageId=${messageId}`);
      } catch (err) {
        console.error('[Socket] pin_message error:', err.message);
      }
    });

    // --- 7ב. מועדפים ---
    socket.on("toggle_favorite", async ({ userId, messageId }) => {
      if (!userId || !messageId) return;
      try {
        const current = favoriteMessages[userId] || [];
        const existingIdx = current.findIndex(f => String(f.messageId) === String(messageId));
        let updated;
        if (existingIdx >= 0) {
          updated = current.filter((_, i) => i !== existingIdx);
        } else {
          const msg = (chatHistory[userId] || []).find(m => String(m._id) === String(messageId));
          if (!msg) return;
          updated = [...current, buildMessageSnapshot(msg)];
        }
        favoriteMessages[userId] = updated;
        await chats().updateOne({ _id: userId }, { $set: { favoriteMessages: updated } });
        broadcast(io, "favorites_updated", "support_team", { userId, favoriteMessages: updated });
        console.log(`[toggle_favorite] userId=${userId} messageId=${messageId} count=${updated.length}`);
      } catch (err) {
        console.error('[Socket] toggle_favorite error:', err.message);
      }
    });

    // --- 7. סגירת פנייה ---
    socket.on("close_ticket", async (targetUserId) => {
      console.log(`[Ticket Closed] for ${targetUserId}`);
      try {
        // שלוף מסמך צ'אט לפני סגירה כדי להפיק נציגים ועמדות לדירוג
        const chatDoc = await chats().findOne(
          { _id: targetUserId },
          { projection: { status: 1, messages: 1, stationHistory: 1 } }
        );

        // guard: ignore if already closed (prevents double-processing from duplicate emits)
        if (chatDoc?.status === 'closed') return;

        // הפק נציגים שהגיבו בפועל מתוך הודעות נציג
        const agentMessages = (chatDoc?.messages || []).filter(
          m => m.fromRole === 'agent' && m.user?._id && m.user._id !== 'system'
        );
        const agentMap = {};
        agentMessages.forEach(m => { agentMap[m.user._id] = m.user.name || m.user._id; });
        const handledAgents = Object.entries(agentMap).map(([aId, aName]) => ({ agentId: aId, agentName: aName }));
        const lastAgent = handledAgents[handledAgents.length - 1] || null;
        const stationHistory = chatDoc?.stationHistory || [];

        // שמור pendingAgentRating כדי שהדירוג יכיל נציגים ועמדות
        await chats().updateOne(
          { _id: targetUserId },
          { $set: { pendingAgentRating: {
            agentId:       lastAgent?.agentId   || null,
            agentName:     lastAgent?.agentName || null,
            callType:      'chat',
            handledAgents,
            stations:      stationHistory.map(s => s.stationName),
            stationHistory,
          }}}
        );

        await setStatus(targetUserId, "closed");
        await pushMessage(targetUserId, {
          _id: Date.now(),
          type: "system",
          event: "ticket_closed",
          text: "הפנייה נסגרה",
          createdAt: new Date(),
        });

        // הסר שיוך עמדה בעת סגירה
        await chats().updateOne(
          { _id: targetUserId },
          { $unset: { station: "", stations: "" }, $set: { updated_at: new Date() } }
        );

        broadcast(io, "ticket_status_changed", targetUserId, "closed");
        broadcast(io, "ticket_closed_confirmed", "support_team", { userId: targetUserId, stationCleared: true });
      } catch (err) {
        console.error(`[Socket] DB error on close_ticket:`, err.message);
      }
    });

    // --- 6b. פתיחה מחדש של פנייה על ידי נציג ---
    socket.on("reopen_ticket", async (targetUserId) => {
      console.log(`[Ticket Reopened] for ${targetUserId}`);
      try {
        await setStatus(targetUserId, "open");
        await pushMessage(targetUserId, {
          _id: Date.now(),
          type: "system",
          event: "ticket_reopened",
          text: "הפנייה נפתחה מחדש על ידי הנציג",
          createdAt: new Date(),
        });
        broadcast(io, "ticket_status_changed", targetUserId, "open");
        broadcast(io, "ticket_reopened_confirmed", "support_team", { userId: targetUserId });
      } catch (err) {
        console.error(`[Socket] DB error on reopen_ticket:`, err.message);
      }
    });

    // --- 8. נציג מצטרף לצ'אט פנימי ---
    socket.on("join_agent_internal", async ({ agentId, agentName }) => {
      if (!agentId) return;
      activeAgentsInternal[agentId] = { socketId: socket.id, name: agentName };
      internalSocketToAgent[socket.id] = agentId;
      console.log(`[Internal Chat] Agent joined: ${agentName} (${agentId})`);

      try {
        const conversations = await agentChats()
          .find({ participants: agentId })
          .sort({ updated_at: -1 })
          .project({ messages: { $slice: -3 } })
          .toArray();
        socket.emit("agent_chat_list", conversations);
      } catch (err) {
        console.error(`[Internal Chat] DB error on join_agent_internal:`, err.message);
        socket.emit("agent_chat_list", []);
      }
    });

    // --- 9. בקשת היסטוריה עם נציג ספציפי ---
    socket.on("agent_chat_request_history", async ({ myAgentId, targetAgentId }) => {
      const convId = [myAgentId, targetAgentId].sort().join("_");
      try {
        const conv = await agentChats().findOne({ _id: convId });
        socket.emit("agent_chat_history_response", {
          conversationId: convId,
          otherAgentId: targetAgentId,
          messages: conv?.messages || [],
        });
      } catch (err) {
        console.error(`[Internal Chat] DB error on agent_chat_request_history:`, err.message);
        socket.emit("agent_chat_history_response", { conversationId: convId, otherAgentId: targetAgentId, messages: [] });
      }
    });

    // --- 10. שליחת הודעה פנימית בין נציגים ---
    socket.on("send_internal_message", async ({ toAgentId, text, type, imageUrl, forwarded, forwardedFrom, replyTo }) => {
      const fromAgentId = internalSocketToAgent[socket.id];
      if (!fromAgentId) return;
      const fromAgentName = activeAgentsInternal[fromAgentId]?.name || "נציג";
      const convId = [fromAgentId, toAgentId].sort().join("_");

      const msg = {
        _id: Date.now(),
        text: text || "",
        ...(type && { type }),
        ...(imageUrl && { imageUrl }),
        ...(forwarded && { forwarded: true }),
        ...(forwardedFrom && { forwardedFrom }),
        ...(replyTo && { replyTo }),
        senderId: fromAgentId,
        senderName: fromAgentName,
        createdAt: new Date(),
      };

      try {
        await agentChats().updateOne(
          { _id: convId },
          {
            $push: { messages: msg },
            $set: { participants: [fromAgentId, toAgentId], updated_at: new Date() },
          },
          { upsert: true }
        );

        // שלח לשולח
        socket.emit("receive_internal_message", { conversationId: convId, ...msg });

        // שלח לנמען אם מחובר
        const recipientInfo = activeAgentsInternal[toAgentId];
        if (recipientInfo) {
          io.to(recipientInfo.socketId).emit("receive_internal_message", { conversationId: convId, ...msg });
        }
      } catch (err) {
        console.error(`[Internal Chat] DB error on send_internal_message:`, err.message);
      }
    });

    // --- 7. שידור עדכון גרסה לכל הנציגים (רק נציגים מחוברים יכולים לשגר) ---
    socket.on("trigger_version_update", () => {
      const agent = activeUsers[socket.id];
      if (agent?.role !== "agent") return;
      console.log(`[Socket] app_version_update broadcast by agent ${agent.userId}`);
      pendingVersionUpdate = true;
      broadcast(io, "app_version_update", "support_team", undefined);
    });

    // --- 8. ניתוק ---
    socket.on("disconnect", () => {
      // נקה מיפויים של צ'אט פנימי
      const internalAgentId = internalSocketToAgent[socket.id];
      if (internalAgentId) {
        delete activeAgentsInternal[internalAgentId];
        delete internalSocketToAgent[socket.id];
      }

      // נקה Collision Detection — הסר נציג מכל השיחות שצפה בהן
      const agentInfo = activeUsers[socket.id];
      if (agentInfo) {
        const agentId = agentInfo.userId;
        for (const userId of Object.keys(conversationViewers)) {
          if (conversationViewers[userId]?.[agentId]) {
            delete conversationViewers[userId][agentId];
            if (Object.keys(conversationViewers[userId]).length === 0) {
              delete conversationViewers[userId];
            }
            broadcast(io, "conversation_viewers_update", "support_team", {
              userId,
              viewers: conversationViewers[userId]
                ? Object.entries(conversationViewers[userId]).map(([aid, v]) => ({ agentId: aid, ...v }))
                : [],
            });
          }
        }
      }

      // נקה reverse map phone→socket
      for (const [ph, sid] of Object.entries(phoneToSocketId)) {
        if (sid === socket.id) { delete phoneToSocketId[ph]; break; }
      }

      delete activeUsers[socket.id];
    });

    // ── WEBSITE SUPPORT ────────────────────────────────────────────────────

    function getWebsiteChats() {
      try { return websiteChats(); } catch (e) {
        if (e.code === 'DB_NOT_INITIALIZED') return null;
        throw e;
      }
    }

    async function pushWebsiteMessage(userId, msg) {
      if (websiteChatHistory[userId]) websiteChatHistory[userId].push(msg);
      const col = getWebsiteChats();
      if (!col) return;
      await col.updateOne(
        { _id: userId },
        { $push: { messages: msg }, $set: { updated_at: new Date() } },
        { upsert: true },
      );
    }

    async function setWebsiteStatus(userId, status) {
      websiteTicketStatus[userId] = status;
      const col = getWebsiteChats();
      if (!col) return;
      await col.updateOne(
        { _id: userId },
        { $set: { status, updated_at: new Date() } },
        { upsert: true },
      );
    }

    // לקוח מצטרף + טעינת היסטוריה
    socket.on("website_join_user", async (userId) => {
      socket.join(`ws_${userId}`);
      let col;
      try { col = websiteChats(); } catch (e) {
        if (e.code === 'DB_NOT_INITIALIZED') return;
        throw e;
      }
      let doc = await col.findOne({ _id: userId });
      if (!doc) {
        doc = { _id: userId, status: "open", messages: [], created_at: new Date(), updated_at: new Date() };
      }
      websiteChatHistory[userId]  = doc.messages || [];
      websiteTicketStatus[userId] = doc.status || "open";
      socket.emit("website_history_loaded", {
        messages: doc.messages || [],
        status:   doc.status   || "open",
      });
      broadcast(io, "system_notification", "website_team", {
        type: "USER_CONNECTED",
        userId,
        status: doc.status || "open",
      });
    });

    // לקוח שולח פרטיו
    socket.on("website_user_info", async ({ userId, phone, name }) => {
      const col = getWebsiteChats();
      if (!col) return;
      await col.updateOne(
        { _id: userId },
        { $set: { name, phone, updated_at: new Date() } },
        { upsert: true },
      );
    });

    // לקוח שולח הודעה
    socket.on("website_send_message", async (data) => {
      const userId = data.userId;
      if (!userId) return;

      if (websiteTicketStatus[userId] === "closed") {
        await setWebsiteStatus(userId, "open");
        io.to(`ws_${userId}`).emit("website_ticket_status_changed", "open");
        io.to("website_team").emit("website_ticket_status_changed", { userId, status: "open" });
      }

      const msg = {
        _id:       data.clientMessageId || Date.now(),
        text:      data.text,
        type:      data.type || "text",
        videoUrl:  data.videoUrl  || undefined,
        fileUrl:   data.fileUrl   || undefined,
        fileName:  data.fileName  || undefined,
        createdAt: new Date(),
        user:      { _id: userId, name: data.name || "" },
        fromRole:  "user",
        replyTo:   data.replyTo || null,
      };

      await pushWebsiteMessage(userId, msg);

      io.to(`ws_${userId}`).emit("website_receive_message", msg);
      io.to("website_team").emit("website_receive_message", { ...msg, userId });

      // Push notification → מסך WebsiteChat
      const notifBody = msg.type === "video" ? "🎥 סרטון חדש"
        : msg.type === "image"  ? "📷 תמונה חדשה"
        : msg.type === "file"   ? `📎 ${msg.fileName || "קובץ חדש"}`
        : (msg.text || "הודעה חדשה");
      pushNotification.notifyUser(userId, "תמיכת אתרים", notifBody, { screen: "WebsiteChat" });
    });

    // נציג מצטרף + קבלת כל השיחות
    socket.on("website_join_agent", async ({ agentId, agentName } = {}) => {
      socket.join("website_team");
      const agInfo = agentId ? { userId: agentId, name: agentName, role: "agent" } : null;
      if (agInfo) activeUsers[socket.id] = agInfo;

      let col;
      try { col = websiteChats(); } catch (e) {
        if (e.code === 'DB_NOT_INITIALIZED') return;
        throw e;
      }
      const sessions = await col
        .find({ status: { $ne: "merged" } })
        .sort({ updated_at: -1 })
        .project({ messages: { $slice: -3 } })
        .toArray();
      socket.emit("website_all_sessions", sessions);
    });

    // נציג מבקש היסטוריה
    socket.on("website_agent_request_history", async (data) => {
      const targetUserId = typeof data === "string" ? data : data?.userId;
      const offset = data?.offset ? parseInt(data.offset) : 0;
      const LIMIT = 25;

      if (offset === 0 || !websiteChatHistory[targetUserId]) {
        const col = getWebsiteChats();
        if (!col) return;
        const doc = await col.findOne({ _id: targetUserId });
        websiteChatHistory[targetUserId]  = doc?.messages || [];
        websiteTicketStatus[targetUserId] = doc?.status   || "open";
      }

      const all   = websiteChatHistory[targetUserId] || [];
      const total = all.length;
      const start = Math.max(0, total - offset - LIMIT);

      socket.emit("website_agent_history_response", {
        userId:   targetUserId,
        messages: all.slice(start, start + LIMIT),
        status:   websiteTicketStatus[targetUserId],
        hasMore:  start > 0,
        offset,
      });
    });

    // נציג שולח הודעה ללקוח
    socket.on("website_send_message_from_agent", async (data) => {
      const { targetUserId, text, type, videoUrl, fileUrl, fileName, replyTo, senderLabel, clientMessageId } = data;
      if (!targetUserId) return;

      const agentId   = activeUsers[socket.id]?.userId || "agent";
      const agentName = senderLabel || activeUsers[socket.id]?.name || "נציג אתרים";

      const msg = {
        _id:       clientMessageId || Date.now(),
        text,
        type:      type || "text",
        videoUrl:  videoUrl  || undefined,
        fileUrl:   fileUrl   || undefined,
        fileName:  fileName  || undefined,
        createdAt: new Date(),
        user:      { _id: agentId, name: agentName },
        fromRole:  "agent",
        replyTo:   replyTo || null,
      };

      await pushWebsiteMessage(targetUserId, msg);

      io.to(`ws_${targetUserId}`).emit("website_receive_message", msg);
      socket.broadcast.to("website_team").emit("website_receive_message", { ...msg, userId: targetUserId });

      // Push notification ללקוח → מסך WebsiteChat
      const notifBody = msg.type === "video" ? "🎥 סרטון חדש"
        : msg.type === "image"  ? "📷 תמונה חדשה"
        : msg.type === "file"   ? `📎 ${msg.fileName || "קובץ חדש"}`
        : (msg.text || "הודעה חדשה");
      pushNotification.notifyUser(targetUserId, "תמיכת אתרים", notifBody, { screen: "WebsiteChat" });
    });

    // סגירה ידנית
    socket.on("website_close_ticket", async (targetUserId) => {
      if (!targetUserId) return;
      if (websiteTicketStatus[targetUserId] === "closed") return;

      await setWebsiteStatus(targetUserId, "closed");
      const systemMsg = {
        _id: Date.now(), type: "system", event: "ticket_closed",
        text: "הפנייה נסגרה", createdAt: new Date(), fromRole: "system",
      };
      await pushWebsiteMessage(targetUserId, systemMsg);

      io.to(`ws_${targetUserId}`).emit("website_ticket_status_changed", "closed");
      io.to("website_team").emit("website_ticket_status_changed", { userId: targetUserId, status: "closed" });
    });

    // פתיחה מחדש ידנית
    socket.on("website_reopen_ticket", async (targetUserId) => {
      if (!targetUserId) return;

      await setWebsiteStatus(targetUserId, "open");
      const systemMsg = {
        _id: Date.now(), type: "system", event: "ticket_reopened",
        text: "הפנייה נפתחה מחדש", createdAt: new Date(), fromRole: "system",
      };
      await pushWebsiteMessage(targetUserId, systemMsg);

      io.to(`ws_${targetUserId}`).emit("website_ticket_status_changed", "open");
      io.to("website_team").emit("website_ticket_status_changed", { userId: targetUserId, status: "open" });
    });

    // מחיקת הודעה (עד 90 דקות)
    socket.on("website_delete_message", async ({ userId, messageId }) => {
      if (!userId || !messageId) return;
      const cutoff = Date.now() - 90 * 60 * 1000;
      if (messageId < cutoff) return;

      const senderRole = activeUsers[socket.id]?.role || "user";
      const col = getWebsiteChats();
      if (!col) return;
      const result = await col.updateOne(
        { _id: userId, "messages._id": messageId, "messages.fromRole": senderRole },
        { $pull: { messages: { _id: messageId } } },
      );

      if (result.modifiedCount > 0) {
        if (websiteChatHistory[userId]) {
          websiteChatHistory[userId] = websiteChatHistory[userId].filter(m => m._id !== messageId);
        }
        io.to(`ws_${userId}`).emit("website_message_deleted", { messageId });
        io.to("website_team").emit("website_message_deleted", { userId, messageId });
      }
    });

    // ── END WEBSITE SUPPORT ────────────────────────────────────────────────
  });
}

module.exports = setupSocketManager;
module.exports.isPhoneOnline = isPhoneOnline;
