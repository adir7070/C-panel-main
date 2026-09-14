'use strict';

/**
 * chat.service — the client's SINGLE conversation thread (`agent_chats`). The AI
 * handles it by default; a human manager can TAKE OVER the same thread (Phase-1
 * of the unified-channel architecture) — while a human is handling, the AI loop
 * is paused and the manager's messages are delivered to the client in-thread.
 *
 * Doc: { phone, messages:[...], unread, updatedAt,
 *        handling: "ai" | "human",       // who is answering right now
 *        handledBy: { agentId, name },   // the human who took over
 *        humanTakeoverAt, lastClientMsgAt, managerUnread }
 *   message: { id, role, text, kind, actions, media, suggestions, createdAt,
 *              authorType?: "ai" | "human", authorName? }
 *   role ∈ user | assistant   ·   kind ∈ chat | proactive | system
 *   assistant messages are the AI's UNLESS authorType==="human" (a manager reply)
 */

const { getDB } = require("../../config/db");
const { runAgent } = require("./loop");
const { getClient, MODELS } = require("./anthropic-client");

let notifyUser;
try { ({ notifyUser } = require("../push-notification.service")); } catch (_) { notifyUser = null; }

const col = () => getDB().collection("agent_chats");
const HISTORY_TURNS = 10;

// GHOST-HUMAN clients: the AI must NEVER answer them — a human replies manually
// from the manager console — BUT the client keeps experiencing a normal Kliq AI
// chat (no takeover banner, no "נציג" tag, replies look like the AI). We only
// surface the thread for the manager (needsHuman) and never flip handling→"human".
// Match by digits-only suffix so formatting (0.../972.../+972) can't slip past.
const GHOST_HUMAN_PHONES = ["0535291889"];
const phoneKey = (p) => String(p || "").replace(/\D/g, "").replace(/^972/, "").replace(/^0/, "");
function isGhostHuman(phone) {
  const k = phoneKey(phone);
  return !!k && GHOST_HUMAN_PHONES.some((p) => phoneKey(p) === k);
}

let indexed = false;
async function ensureIndexes() {
  if (indexed) return;
  try {
    // PARTIAL unique index: enforce one thread per phone, but only over docs
    // where phone is a string. A plain { unique:true } build fails with E11000
    // when legacy docs carry phone:null (multiple nulls collide) — and because
    // `indexed` then never flips true, the failed build (and its warning) was
    // re-running on EVERY request. Ignoring null/absent phones lets it build.
    await col().createIndex(
      { phone: 1 },
      { unique: true, partialFilterExpression: { phone: { $type: "string" } }, name: "phone_unique_str" },
    );
    await col().createIndex({ updatedAt: -1 });
    indexed = true;
  } catch (e) {
    console.warn("[agent-chat] index ensure failed:", e.message);
    // Attempt once, then stop — never retry (and re-log) on every request.
    indexed = true;
  }
}

function mkMsg({ role, text, kind = "chat", actions = [], media = [], suggestions = [], authorType, authorName }) {
  const m = {
    id: Math.random().toString(36).slice(2) + Date.now().toString(36),
    role, text: text || "", kind, actions: actions || [], media: media || [], suggestions: suggestions || [], createdAt: new Date(),
  };
  if (authorType) m.authorType = authorType;      // "ai" | "human"
  if (authorName) m.authorName = authorName;      // the manager's display name
  return m;
}

/* ── CONVERSATIONS (sessions within the single per-phone doc) ────────────────
   The doc keeps ONE `messages` array, but each message is stamped with a
   `conversationId`, and the doc carries `conversations:[{id,title,legacy,
   createdAt,lastMessageAt,preview}]` + an `activeConversationId` pointer.
   A "+ new chat" just adds a conversation and moves the pointer — the LLM
   history (`toHistory`) filters to the active conversation, so the context
   window resets (fewer tokens) while the per-phone profile/memory stay intact.
   Legacy messages (pre-feature) carry NO conversationId → they belong to the
   implicit `legacy` conversation. No message is ever rewritten. */
function newConvId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/* A message's conversation = its stamp, or the legacy bucket if untagged. */
function convIdFor(msg, legacyId) {
  return msg.conversationId || legacyId;
}

/* Guarantee the doc has a `conversations` array + a valid `activeConversationId`.
   Idempotent: after a user's first call, the fast path is a single findOne with
   no write. Returns { activeConversationId, legacyId }. */
async function ensureActiveConversation(phone) {
  const d = await col().findOne(
    { phone: String(phone) },
    { projection: { conversations: 1, activeConversationId: 1, createdAt: 1, updatedAt: 1, messages: { $slice: -1 } } },
  );
  if (d && Array.isArray(d.conversations) && d.conversations.length) {
    let active = d.activeConversationId;
    if (!active || !d.conversations.some((c) => c.id === active)) {
      active = [...d.conversations].sort((a, b) => new Date(b.lastMessageAt || 0) - new Date(a.lastMessageAt || 0))[0].id;
      await col().updateOne({ phone: String(phone) }, { $set: { activeConversationId: active } });
    }
    const legacyId = (d.conversations.find((c) => c.legacy) || {}).id || active;
    return { activeConversationId: active, legacyId };
  }
  // No conversations yet → synthesize the legacy conversation (holds all old, untagged messages).
  const legacyId = newConvId();
  const now = new Date();
  const legacy = {
    id: legacyId, legacy: true, title: null,
    createdAt: (d && d.createdAt) || now,
    lastMessageAt: (d && d.updatedAt) || now,
    preview: ((d && d.messages && d.messages[0] && d.messages[0].text) || "").slice(0, 80),
  };
  if (d) {
    // doc exists but lacks conversations → guarded set, NO upsert (avoids a
    // phone-unique-index dup if this races another writer).
    await col().updateOne(
      { phone: String(phone), conversations: { $exists: false } },
      { $set: { conversations: [legacy], activeConversationId: legacyId } },
    );
  } else {
    // brand-new phone → create the doc with the legacy conversation (safe upsert on phone).
    await col().updateOne(
      { phone: String(phone) },
      { $setOnInsert: { conversations: [legacy], activeConversationId: legacyId, createdAt: now } },
      { upsert: true },
    );
  }
  // re-read to resolve whichever concurrent writer won
  const fresh = await col().findOne({ phone: String(phone) }, { projection: { conversations: 1, activeConversationId: 1 } });
  if (fresh && Array.isArray(fresh.conversations) && fresh.conversations.length) {
    const active = fresh.activeConversationId || legacyId;
    const lId = (fresh.conversations.find((c) => c.legacy) || {}).id || active;
    return { activeConversationId: active, legacyId: lId };
  }
  return { activeConversationId: legacyId, legacyId };
}

/** Start a NEW conversation (the "+" button) → becomes active, empty thread. */
async function startConversation(phone, { title = null } = {}) {
  await ensureIndexes();
  await ensureActiveConversation(phone); // guarantee legacy + doc exist first
  const id = newConvId();
  const now = new Date();
  const conv = { id, legacy: false, title: title || null, createdAt: now, lastMessageAt: now, preview: "" };
  await col().updateOne(
    { phone: String(phone) },
    { $push: { conversations: conv }, $set: { activeConversationId: id, updatedAt: now } },
  );
  return conv;
}

/** Switch the active conversation (validated). */
async function setActiveConversation(phone, convId) {
  await ensureIndexes();
  const doc = await col().findOne({ phone: String(phone) }, { projection: { conversations: 1 } });
  const exists = (doc?.conversations || []).some((c) => c.id === convId);
  if (!exists) return { ok: false, error: "conversation not found" };
  await col().updateOne({ phone: String(phone) }, { $set: { activeConversationId: convId } });
  return { ok: true, activeConversationId: convId };
}

/** List a phone's conversations (most-recent first) + the active pointer. */
async function listConversations(phone) {
  await ensureIndexes();
  const { activeConversationId } = await ensureActiveConversation(phone);
  const doc = await col().findOne({ phone: String(phone) }, { projection: { conversations: 1, activeConversationId: 1 } });
  const conversations = [...(doc?.conversations || [])]
    .sort((a, b) => new Date(b.lastMessageAt || 0) - new Date(a.lastMessageAt || 0));
  return { conversations, activeConversationId: doc?.activeConversationId || activeConversationId };
}

/* Cheap AI title (triage model) for a fresh conversation, from its first
   exchange. Best-effort — never throws; leaves title null on failure so the app
   falls back to its default label. */
async function generateConversationTitle(userText, aiText) {
  try {
    const resp = await getClient().messages.create({
      model: MODELS.triage,
      max_tokens: 40,
      system: `נסח כותרת קצרה וברורה בעברית (2-5 מילים) שמתארת את נושא השיחה, לפי ההודעה הראשונה של הלקוח ותשובת המנהל. בלי מרכאות, בלי נקודה בסוף, בלי אימוג'י. החזר JSON בלבד: {"title":"..."}.`,
      messages: [{ role: "user", content: `לקוח: "${(userText || "").slice(0, 300)}"\nמנהל: "${(aiText || "").slice(0, 300)}"` }],
    });
    const txt = resp.content.filter((c) => c.type === "text").map((c) => c.text).join("");
    const m = txt.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(m ? m[0] : txt);
    const title = typeof parsed.title === "string" ? parsed.title.trim().slice(0, 40) : "";
    return title || null;
  } catch (_) { return null; }
}

/* After a fresh (non-legacy) conversation gets its first exchange, name it. */
async function maybeTitleConversation(phone, convId) {
  try {
    if (!convId) return;
    const doc = await col().findOne({ phone: String(phone) }, { projection: { conversations: 1, messages: 1 } });
    const conv = (doc?.conversations || []).find((c) => c.id === convId);
    if (!conv || conv.legacy || conv.title) return;
    const convMsgs = (doc?.messages || []).filter((m) => m.conversationId === convId && (m.role === "user" || m.role === "assistant") && m.text);
    const firstUser = convMsgs.find((m) => m.role === "user");
    const firstAi = convMsgs.find((m) => m.role === "assistant");
    if (!firstUser || !firstAi) return;
    const title = await generateConversationTitle(firstUser.text, firstAi.text);
    if (title) {
      await col().updateOne({ phone: String(phone) }, { $set: { "conversations.$[c].title": title } }, { arrayFilters: [{ "c.id": convId }] });
    }
  } catch (e) { console.warn("[agent-chat] title gen failed:", e.message); }
}

/* getThread, filtered to one conversation (+ the conversations list & active
   pointer). Used by the app's load. requestedConvId defaults to the active one
   (→ "auto-open the last conversation" on entry). */
async function getConversationView(phone, requestedConvId) {
  // ensure FIRST so a legacy user's freshly-synthesized `conversations` array is
  // present in the getThread read below (otherwise the menu shows empty on entry).
  const { activeConversationId, legacyId } = await ensureActiveConversation(phone);
  const thread = await getThread(phone);
  const convId = requestedConvId || activeConversationId;
  const messages = (thread.messages || []).filter((m) => convIdFor(m, legacyId) === convId);
  const conversations = [...(thread.conversations || [])]
    .sort((a, b) => new Date(b.lastMessageAt || 0) - new Date(a.lastMessageAt || 0));
  return { ...thread, messages, conversations, activeConversationId: convId };
}

async function getThread(phone) {
  await ensureIndexes();
  const doc = await col().findOne({ phone: String(phone) });
  return doc || { phone: String(phone), messages: [], unread: 0, thinking: false, handling: "ai" };
}

/* A message's `text` is meant to be human-readable. Some broken upload paths
   dumped raw FILE BYTES into `text` (e.g. a JPEG's binary → 112KB of mojibake),
   which renders as garbage in the console and bloats the LLM context. Detect that
   and swap in a short placeholder ON READ — the stored history is NEVER modified. */
function looksBinaryText(s) {
  if (typeof s !== "string" || s.length < 8) return false;
  if (/JFIF|\bPNG\b|GIF8|%PDF/.test(s.slice(0, 16))) return true;   // file signatures
  const sample = s.slice(0, 500);
  let bad = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    // U+FFFD replacement, NUL, or control chars other than tab/newline/CR
    if (c === 0xFFFD || c === 0 || c < 0x09 || (c > 0x0D && c < 0x20)) bad++;
  }
  return bad / sample.length > 0.15;
}
function visibleText(text) {
  return looksBinaryText(text) ? "📎 קובץ שהתקבל" : text;
}

/* Normalize a legacy support_chats message → the agent_chats message shape, so
   the historical support conversation (text + images/files the client sent) can
   be shown seamlessly in the unified thread. Read-only projection — the source
   support_chats doc is never modified. */
function normalizeSupportMsg(m) {
  if (!m) return null;
  const isSystem = m.fromRole === "system";
  const isHuman = m.fromRole === "agent";
  const role = m.fromRole === "user" ? "user" : "assistant";
  const isMedia = m.type === "image" || m.type === "video" || m.type === "file" || !!m.videoUrl || !!m.fileUrl;
  const url = m.videoUrl || m.fileUrl || (isMedia ? m.text : null);
  const msg = {
    id: "sup_" + String(m._id || m.createdAt || Math.random().toString(36).slice(2)),
    role,
    kind: isSystem ? "system" : "chat",
    text: isMedia ? "" : (m.text || ""),
    media: isMedia && url ? [{ url, caption: m.fileName || "" }] : [],
    createdAt: m.createdAt || new Date(),
    source: "support",   // historical (from the old support chat)
  };
  if (isHuman) { msg.authorType = "human"; msg.authorName = m.user?.name || "נציג"; }
  return msg;
}

/* getThread + the client's legacy support_chats history, merged chronologically.
   The agent chat is becoming the app's single/general channel, so it must carry
   the full past. Display only — never used as the LLM's context (that stays on
   agent_chats via toHistory). */
async function getThreadMerged(phone) {
  const thread = await getThread(phone);
  let support = [];
  try {
    const sc = await getDB().collection("support_chats").findOne({ phone: String(phone) }, { projection: { messages: 1 } });
    support = (sc?.messages || []).map(normalizeSupportMsg).filter(Boolean);
  } catch (e) { console.warn("[agent-chat] support history merge failed:", e.message); }
  const merged = [...support, ...(thread.messages || [])]
    .sort((a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime());
  return { ...thread, messages: merged, supportCount: support.length };
}

/** Append one message; bumps unread when it's an assistant/proactive message.
    The optional 3rd arg pins the message to a conversation; when omitted it lands
    in the active conversation (keeps every existing 2-arg caller working). */
async function appendMessage(phone, msg, conversationId) {
  await ensureIndexes();
  const { activeConversationId, legacyId } = await ensureActiveConversation(phone);
  const convId = conversationId || activeConversationId || legacyId;
  const m = mkMsg(msg);
  m.conversationId = convId;
  const incUnread = m.role === "assistant" ? 1 : 0;
  const now = new Date();
  const preview = (m.text || (m.media && m.media.length ? "📎 קובץ" : "")).slice(0, 80);
  await col().updateOne(
    { phone: String(phone) },
    {
      $push: { messages: m },
      $set: { updatedAt: now, "conversations.$[c].lastMessageAt": now, "conversations.$[c].preview": preview },
      $inc: { unread: incUnread },
    },
    { upsert: true, arrayFilters: [{ "c.id": convId }] },
  );
  return m;
}

async function markRead(phone) {
  await col().updateOne({ phone: String(phone) }, { $set: { unread: 0 } });
}

/* "typing" flag so the app can show an indicator while a background run is in
   flight — agent runs can exceed Heroku's 30s request limit, so we never block
   the HTTP response on the loop (see sendClientMessage). */
async function setThinking(phone, thinking) {
  try {
    await col().updateOne({ phone: String(phone) }, { $set: { thinking: !!thinking } }, { upsert: true });
  } catch (e) { console.warn("[agent-chat] setThinking failed:", e.message); }
}

/* Convert stored thread → bounded Claude history (visible text only). When a
   conversation is given, only that conversation's turns are fed to the model —
   THIS is the memory-reset mechanism: a fresh conversation → empty/short window. */
function toHistory(thread, convId, legacyId) {
  let msgs = thread.messages || [];
  if (convId) msgs = msgs.filter((m) => convIdFor(m, legacyId) === convId);
  return msgs
    .filter(m => (m.role === "user" || m.role === "assistant") && m.text)
    .slice(-HISTORY_TURNS)
    .map(m => ({ role: m.role, content: visibleText(m.text) }));
}

/**
 * Client sends a message → persist it → kick off the agent loop in the
 * BACKGROUND and return immediately (the loop can exceed Heroku's 30s request
 * limit). The reply lands in the thread; the app surfaces it via its poll.
 */
async function sendClientMessage(phone, text, conversationId) {
  const thread = await getThread(phone);
  const { activeConversationId } = await ensureActiveConversation(phone);
  // If the client is continuing/reopening a specific (older) conversation, make
  // it active first so the reply + history target it. Falls back to active on a
  // stale/unknown id.
  let targetConv = activeConversationId;
  if (conversationId && conversationId !== activeConversationId) {
    const sw = await setActiveConversation(phone, conversationId);
    if (sw.ok) targetConv = conversationId;
  }
  await appendMessage(phone, { role: "user", text, kind: "chat" }, targetConv);

  // ── GHOST-HUMAN client → the AI must never answer; a human replies manually
  // while the client keeps seeing a normal AI chat. Surface it for the manager
  // (needsHuman) WITHOUT flipping handling→"human" (that would show the client a
  // takeover banner). No AI run.
  if (isGhostHuman(phone)) {
    await flagGhostThread(phone);
    return { queued: true, handling: "ghost" };
  }

  // ── HUMAN TAKEOVER: a manager is handling this thread → the AI stays silent.
  // Persist the client message, flag it for the manager (managerUnread), and do
  // NOT run the loop. The manager sees it in the takeover console and replies.
  if (thread.handling === "human") {
    await markClientAwaiting(phone); // → back to "waiting" until the manager replies
    return { queued: true, handling: "human" };
  }

  // ── AI is handling (default) → run the loop in the background (fire-and-forget,
  // so the HTTP response stays < Heroku's 30s limit). Reply lands via the poll.
  // Runs are SERIALIZED per phone: two quick messages no longer spawn two
  // concurrent loops (duplicate/conflicting replies) — the second chains after
  // the first and re-reads the thread, so it sees the full context.
  await setThinking(phone, true);
  // capture the conversation at enqueue time so a later switch can't misroute the reply
  queuePendingAnswer(phone, targetConv).catch((e) => console.error("[agent-chat] background run failed:", e.message));

  return { queued: true, handling: "ai" };
}

/** A client message/media arrived while a human is handling → flip the thread
    back to "waiting" (awaitingReply) and bump the manager's unread count. The
    flag is cleared only when the manager actually replies (sendHumanMessage/
    sendHumanMedia), NOT merely when they open the thread. */
async function markClientAwaiting(phone) {
  await col().updateOne(
    { phone: String(phone) },
    { $set: { lastClientMsgAt: new Date(), awaitingReply: true }, $inc: { managerUnread: 1 } },
  );
}

/* Chained background run that answers the thread's trailing unanswered client
   message (if any). Shared by sendClientMessage and ops.answerPendingIfAny. */
function queuePendingAnswer(phone, convId) {
  return chainRun(phone, async () => {
    const fresh = await getThread(phone);
    if (fresh.handling === "human" || isGhostHuman(phone)) { await setThinking(phone, false); return; } // taken over meanwhile
    const { activeConversationId, legacyId } = await ensureActiveConversation(phone);
    const targetConv = convId || activeConversationId;
    const hist = toHistory(fresh, targetConv, legacyId);
    // the trailing user turn is what awaits an answer; if the thread already ends
    // with an assistant reply, a previous chained run covered it — don't double-answer
    if (!hist.length || hist[hist.length - 1].role !== "user") { await setThinking(phone, false); return; }
    await runAndPersist(phone, hist[hist.length - 1].content, hist.slice(0, -1), targetConv);
  });
}

/** Answer the thread's pending client message if one awaits (ops: after a stale
    human takeover is auto-released, the client must not stay unanswered). */
async function answerPendingIfAny(phone) {
  await setThinking(phone, true);
  return queuePendingAnswer(phone);
}

/* Per-phone promise chain — serializes background agent runs for one client. */
const _runChains = new Map();
function chainRun(phone, fn) {
  const key = String(phone);
  const prev = _runChains.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  _runChains.set(key, next);
  next.finally(() => { if (_runChains.get(key) === next) _runChains.delete(key); }).catch(() => {});
  return next;
}

/* Run the agent loop and persist its reply to the thread. Always clears the
   thinking flag, and on hard failure drops a friendly message so the user is
   never left hanging. */
async function runAndPersist(phone, text, history, convId) {
  try {
    // NB: runAgent returns { text }, not { reply } — alias it.
    const { text: reply, actions, media, suggestions } = await runAgent({
      phone, userMessage: text, history, mode: "chat", trigger: "client_message",
    });
    await appendMessage(phone, {
      role: "assistant",
      text: reply || "קיבלתי, אבדוק ואחזור אליך.",
      kind: "chat",
      actions: (actions || []).filter(a => a.status === "awaiting_approval"),
      media: media || [],
      suggestions: suggestions || [],
    }, convId);
    // fresh conversation → give it an AI-generated title once (best-effort, bg)
    maybeTitleConversation(phone, convId).catch(() => {});
  } catch (e) {
    console.error("[agent-chat] run error:", e.message);
    await appendMessage(phone, {
      role: "assistant",
      text: "מצטער, נתקלתי בתקלה רגעית. נסה שוב בעוד רגע.",
      kind: "system",
    }, convId);
  } finally {
    await setThinking(phone, false);
  }
}

/** A client uploaded MEDIA (image or video) → run the agent to acknowledge/file
    it and reply. Images go through VISION (the agent sees + files them); videos
    are acknowledged text-only (no video vision) with a purpose question, since
    the model can't watch them. Serialized per-phone; fire-and-forget. */
function processClientMedia(phone, { url, base64, mediaType, isVideo = false, caption = "", conversationId = null } = {}) {
  return chainRun(phone, async () => {
    try {
      const fresh = await getThread(phone);
      if (fresh.handling === "human" || isGhostHuman(phone)) { await setThinking(phone, false); return; }
      const { activeConversationId, legacyId } = await ensureActiveConversation(phone);
      const convId = conversationId || activeConversationId;
      const history = toHistory(fresh, convId, legacyId).slice(0, -1); // trailing user turn = the media msg itself
      let userMessage, image = null, imageUrl = null;
      if (isVideo) {
        userMessage = `הלקוח שלח סרטון בצ'אט${caption ? ` (כיתוב: "${caption}")` : ""}. אינך יכול לצפות בסרטון, אבל אשר בחום שקיבלת אותו, שאל בקצרה למה הוא מיועד (מודעה? תוכן לרשתות? עדות לקוח?), וציין שנשמור אותו לשימוש. אל תמציא מה מופיע בסרטון.`;
      } else {
        userMessage = caption ? `הלקוח שלח תמונה עם ההודעה: "${caption}"` : `הלקוח שלח תמונה — נתח אותה ותייק אותה לפרופיל לפי ההנחיות.`;
        image = base64 ? { base64, mediaType } : null;
        imageUrl = url || null;
      }
      const { text: reply, actions, media, suggestions } = await runAgent({
        phone, userMessage, history, mode: "chat", trigger: "client_media", image, imageUrl,
      });
      await appendMessage(phone, {
        role: "assistant",
        text: reply || (isVideo ? "קיבלתי את הסרטון, תודה! 🎬 למה הוא מיועד?" : "קיבלתי את התמונה 👍"),
        kind: "chat",
        actions: (actions || []).filter(a => a.status === "awaiting_approval"),
        media: media || [], suggestions: suggestions || [],
      }, convId);
      maybeTitleConversation(phone, convId).catch(() => {});
    } catch (e) {
      console.error("[agent-chat] processClientMedia:", e.message);
    } finally {
      await setThinking(phone, false);
    }
  });
}

/** Drop a proactive (agent-initiated) message into the thread. */
async function postProactive(phone, text, actions = [], suggestions = []) {
  return appendMessage(phone, { role: "assistant", text, kind: "proactive", actions, suggestions });
}

/* ── HUMAN TAKEOVER (Phase-1 of the single-channel architecture) ─────────────
   All of these ONLY append system/human messages + flip flags — the full
   message history is never mutated or deleted. */

/** Flag a thread as awaiting a human (called on escalation) so it surfaces in
    the manager takeover console. Best-effort; no upsert (only real threads). */
async function flagNeedsHuman(phone) {
  // reopen a previously-closed thread — a fresh escalation needs attention again
  try { await col().updateOne({ phone: String(phone) }, { $set: { needsHuman: true, needsHumanAt: new Date(), closed: false } }); }
  catch (e) { console.warn("[agent-chat] flagNeedsHuman failed:", e.message); }
}

/** GHOST-HUMAN thread: the AI is silenced (no run) and the thread is surfaced in
    the manager console via needsHuman + managerUnread — but handling STAYS "ai"
    so the client never sees a takeover banner. The manager answers manually and
    those replies go out looking like the AI (see sendHumanMessage/sendHumanMedia). */
async function flagGhostThread(phone) {
  await ensureIndexes();
  await setThinking(phone, false);
  await col().updateOne(
    { phone: String(phone) },
    { $set: { ghost: true, lastClientMsgAt: new Date(), needsHuman: true, needsHumanAt: new Date() }, $inc: { managerUnread: 1 } },
    { upsert: true },
  );
}

/** A manager takes over the thread → the AI pauses; a system note marks it. */
async function takeOver(phone, { agentId, name } = {}) {
  await ensureIndexes();
  // GHOST-HUMAN: the client must never see a takeover. Keep the thread as a plain
  // "AI" chat from their side — the manager already answers manually. No-op.
  if (isGhostHuman(phone)) { await setThinking(phone, false); return { ok: true, handling: "ghost" }; }
  await setThinking(phone, false); // cancel any AI "typing" indicator
  await col().updateOne(
    { phone: String(phone) },
    { $set: { handling: "human", handledBy: { agentId: agentId || null, name: name || null }, humanTakeoverAt: new Date(), managerUnread: 0, needsHuman: false, closed: false, awaitingReply: false } },
    { upsert: true },
  );
  await appendMessage(phone, { role: "assistant", kind: "system", text: `${name || "נציג"} מ-Kliq הצטרף/ה לשיחה ומטפל/ת בפנייה שלך.`, authorType: "human", authorName: name });
  return { ok: true, handling: "human" };
}

/** Hand the thread back to the AI. */
async function returnToAi(phone, { name } = {}) {
  await ensureIndexes();
  // GHOST-HUMAN: there is no client-visible "human" state to return from — the
  // client already sees the AI. Skip the system note (would break the illusion).
  if (isGhostHuman(phone)) return { ok: true, handling: "ghost" };
  await col().updateOne(
    { phone: String(phone) },
    { $set: { handling: "ai", needsHuman: false, awaitingReply: false }, $unset: { handledBy: "" } },
  );
  await appendMessage(phone, { role: "assistant", kind: "system", text: "מנהל ה-AI חזר לטפל בשיחה. אני כאן לכל דבר 🙂" });
  // LIVE LEARNING: the human just finished handling — distill what the AI should
  // do differently next time into the typed lesson store (best-effort, background),
  // and mine durable client facts from the exchange (human turns are fact-rich).
  try {
    require("./lessons.service").distillLessons({ phone, reason: "takeover_end" })
      .catch((e) => console.warn("[agent-chat] takeover distill failed:", e.message));
    require("./client-memory.service").distillFacts(phone)
      .catch((e) => console.warn("[agent-chat] client-memory distill failed:", e.message));
  } catch (_) { /* learning modules optional */ }
  return { ok: true, handling: "ai" };
}

/** CLOSE a thread from the manager console: mark it resolved (drops out of the
    active queue → "סגור" tab), clear the human/waiting flags, and hand the AI
    back. A later escalation or takeover REOPENS it (flagNeedsHuman/takeOver
    clear `closed`). History is never touched. */
async function closeThread(phone, { agentId, name } = {}) {
  await ensureIndexes();
  await setThinking(phone, false);
  await col().updateOne(
    { phone: String(phone) },
    { $set: { closed: true, closedAt: new Date(), closedBy: name || null, handling: "ai", needsHuman: false, managerUnread: 0, awaitingReply: false }, $unset: { handledBy: "" } },
  );
  // If a manager WAS handling it, distill lessons/facts like a normal hand-back.
  try {
    require("./lessons.service").distillLessons({ phone, reason: "takeover_end" }).catch(() => {});
    require("./client-memory.service").distillFacts(phone).catch(() => {});
  } catch (_) {}
  return { ok: true, closed: true };
}

/** A manager sends a message to the client in-thread (auto-takes-over if needed). */
async function sendHumanMessage(phone, { agentId, name } = {}, text, opts = {}) {
  await ensureIndexes();
  // GHOST-HUMAN: deliver the manager's reply AS THE AI — no "human" author tag, no
  // takeover, no banner. The client just sees a normal Kliq AI message.
  if (isGhostHuman(phone)) {
    const gm = await appendMessage(phone, { role: "assistant", kind: "chat", text });
    await col().updateOne({ phone: String(phone) }, { $set: { managerUnread: 0 } });
    if (notifyUser) {
      try { await notifyUser(phone, "מנהל ה-AI", (text || "").slice(0, 120), { screen: "AIManager" }); }
      catch (e) { console.warn("[agent-chat] ghost-msg push failed:", e.message); }
    }
    return gm;
  }
  const thread = await getThread(phone);
  // announce mode (e.g. from the CPANEL client-profile chat): drop a human
  // message into the thread WITHOUT taking over — the AI stays active for the
  // client's follow-ups (and sees the manager's message in its history).
  if (!opts.announce && thread.handling !== "human") await takeOver(phone, { agentId, name });
  const m = await appendMessage(phone, { role: "assistant", kind: "chat", text, authorType: "human", authorName: name });
  await col().updateOne({ phone: String(phone) }, { $set: { managerUnread: 0, awaitingReply: false } });
  if (notifyUser) {
    try { await notifyUser(phone, name ? `${name} מ-Kliq` : "מנהל Kliq", (text || "").slice(0, 120), { screen: "AIManager" }); }
    catch (e) { console.warn("[agent-chat] human-msg push failed:", e.message); }
  }
  return m;
}

/** A manager sends MEDIA (image or document) to the client in-thread. Mirrors
    sendHumanMessage: ghost-human → delivered as an AI media message; otherwise a
    human media message (auto-takes-over). `media` = { url, caption, type?, fileName? }.
    type defaults to "image"; "document" carries a fileName (e.g. an invoice PDF). */
async function sendHumanMedia(phone, { agentId, name } = {}, { url, caption = "", type = "image", fileName = "", announce = false } = {}) {
  await ensureIndexes();
  const mediaObj = { url, caption, ...(type && type !== "image" ? { type } : {}), ...(fileName ? { fileName } : {}) };
  const pushBody = caption || (type === "document" ? `📄 ${fileName || "מסמך"}` : "📷 תמונה");
  if (isGhostHuman(phone)) {
    const gm = await appendMessage(phone, { role: "assistant", kind: "chat", text: caption, media: [mediaObj] });
    await col().updateOne({ phone: String(phone) }, { $set: { managerUnread: 0 } });
    if (notifyUser) {
      try { await notifyUser(phone, "מנהל ה-AI", pushBody, { screen: "AIManager" }); }
      catch (e) { console.warn("[agent-chat] ghost-media push failed:", e.message); }
    }
    return gm;
  }
  const thread = await getThread(phone);
  // announce mode (CPANEL client-profile chat) → drop the media WITHOUT taking
  // over, so the AI keeps handling the conversation (mirrors sendHumanMessage).
  if (!announce && thread.handling !== "human") await takeOver(phone, { agentId, name });
  const m = await appendMessage(phone, { role: "assistant", kind: "chat", text: caption, media: [mediaObj], authorType: "human", authorName: name });
  await col().updateOne({ phone: String(phone) }, { $set: { managerUnread: 0, awaitingReply: false } });
  if (notifyUser) {
    try { await notifyUser(phone, name ? `${name} מ-Kliq` : "מנהל Kliq", pushBody, { screen: "AIManager" }); }
    catch (e) { console.warn("[agent-chat] human-media push failed:", e.message); }
  }
  return m;
}

/** Threads a manager needs to look at: currently human-handled, or with unseen
    client messages while human-handled. (The escalations queue drives the rest.) */
async function listManagerThreads({ handling } = {}) {
  await ensureIndexes();
  // default queue = threads that need attention (flagged for a human, currently
  // human-handled, or with unseen client messages) PLUS recently-closed threads
  // (last 14d) so the console's "סגור" tab has content. `handling` narrows it.
  const closedCutoff = new Date(Date.now() - 14 * 86400000);
  const q = handling
    ? { handling }
    : { $or: [{ needsHuman: true }, { handling: "human" }, { managerUnread: { $gt: 0 } }, { closed: true, closedAt: { $gte: closedCutoff } }] };
  const rows = await col().find(q, { projection: { messages: { $slice: -1 }, phone: 1, handling: 1, handledBy: 1, managerUnread: 1, awaitingReply: 1, lastClientMsgAt: 1, needsHuman: 1, needsHumanAt: 1, updatedAt: 1, closed: 1, closedAt: 1, closedBy: 1 } })
    .sort({ needsHumanAt: -1, lastClientMsgAt: -1, updatedAt: -1 }).limit(300).toArray();
  // one derived status per row so the console doesn't recompute: closed | handling | waiting.
  // A human-handled thread with a NEW unanswered client message (awaitingReply)
  // reads as "waiting" again, until the manager replies.
  return rows.map(t => ({
    ...t,
    status: t.closed
      ? "closed"
      : (t.handling === "human" && !t.awaitingReply)
        ? "handling"
        : "waiting",
  }));
}

module.exports = {
  getThread, getThreadMerged, appendMessage, markRead, setThinking, sendClientMessage, postProactive, ensureIndexes,
  takeOver, returnToAi, closeThread, sendHumanMessage, sendHumanMedia, listManagerThreads, flagNeedsHuman,
  isGhostHuman, flagGhostThread, visibleText, answerPendingIfAny, processClientMedia, markClientAwaiting,
  // conversations (sessions within the per-phone doc)
  getConversationView, startConversation, setActiveConversation, listConversations,
};
