'use strict';

/**
 * agent.controller — HTTP surface for the AI account-manager agent.
 *   app-facing  (/api/agent-chat): the client's dedicated AI thread + approvals
 *   admin-facing (/api/agent):     manual run, audit, approvals queue, kill switch
 *
 * Thin wrappers over services/agent/*. Phone is taken from the request and
 * passed explicitly — it is never a model argument (cross-client safety).
 */

const chat = require("../services/agent/chat.service");
const approvals = require("../services/agent/approvals.service");
const agentLog = require("../services/agent/agent-log.service");
const policy = require("../services/agent/policy.engine");
const { runAgent } = require("../services/agent/loop");
const { getDB } = require("../config/db");

const normPhone = (p) => String(p || "").trim();

/* ── APP: AI chat thread ─────────────────────────────────────────────────── */
async function getChat(req, res) {
  try {
    const phone = normPhone(req.params.phone || req.query.phone);
    if (!phone) return res.status(400).json({ error: "phone required" });
    // includeHistory=1 → merge the client's legacy support_chats history into the
    // thread (the agent chat is becoming the app's single channel; it must carry
    // the full past — text + images the client sent). Display only; append-only.
    const withHistory = req.query.includeHistory === "1" || req.query.includeHistory === "true";
    // conversationId (optional): which conversation to load. Omitted → the active
    // (most-recent) one, so a cold app-entry "auto-opens the last conversation".
    const conversationId = String(req.query.conversationId || "").trim() || null;
    // includeHistory=1 (CPANEL merged view) keeps the legacy whole-thread behavior.
    const thread = withHistory
      ? await chat.getThreadMerged(phone)
      : await chat.getConversationView(phone, conversationId);
    // Sanitize on read: some broken upload paths stored raw file bytes as a
    // message `text` (renders as garbage + bloats the payload). Swap in a short
    // placeholder for display — the stored history is never modified.
    const messages = (thread.messages || []).map(m => (
      m && typeof m.text === "string" ? { ...m, text: chat.visibleText(m.text) } : m
    ));
    res.json({
      phone, messages, unread: thread.unread || 0, thinking: !!thread.thinking,
      handling: thread.handling || "ai",
      handledByName: thread.handledBy?.name || null,
      conversations: thread.conversations || [],
      activeConversationId: thread.activeConversationId || null,
    });
  } catch (e) {
    console.error("[agent] getChat:", e.message);
    res.status(500).json({ error: e.message });
  }
}

async function postMessage(req, res) {
  try {
    const phone = normPhone(req.body.phone);
    const text = String(req.body.text || req.body.message || "").trim();
    if (!phone || !text) return res.status(400).json({ error: "phone and text required" });
    const conversationId = String(req.body.conversationId || "").trim() || null;
    await chat.sendClientMessage(phone, text, conversationId);
    // Async by design: the agent runs in the background; the reply lands in the
    // thread and the app surfaces it via its poll (avoids Heroku's 30s limit).
    res.json({ ok: true, queued: true });
  } catch (e) {
    console.error("[agent] postMessage:", e.message);
    res.status(500).json({ error: e.message });
  }
}

/* Detect the real image type from the bytes (magic numbers) — the declared
   upload mimetype can be wrong, and Anthropic's vision API rejects a media_type
   that doesn't match the actual image. Returns a type Anthropic accepts. */
function sniffImageMime(buf, fallback = "image/jpeg") {
  if (!buf || buf.length < 12) return fallback;
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image/gif";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return fallback;
}

/* Detect media type (image OR video) from bytes/declared mime — clients now send
   both in the AI chat. Returns { mime, isVideo, ext }. */
function sniffChatMedia(buf, declaredMime = "") {
  if (buf && buf.length >= 12) {
    // video magics: MP4/MOV/M4V (ftyp box at bytes 4-8), WebM (EBML 1A45DFA3)
    if (buf.toString("ascii", 4, 8) === "ftyp") {
      const brand = buf.toString("ascii", 8, 12);
      const mime = /qt/i.test(brand) ? "video/quicktime" : "video/mp4";
      return { mime, isVideo: true, ext: mime === "video/quicktime" ? "mov" : "mp4" };
    }
    if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
      return { mime: "video/webm", isVideo: true, ext: "webm" };
    }
  }
  // fall back to the declared mime for videos the magic check missed
  if (/^video\//i.test(declaredMime)) {
    const ext = (declaredMime.split("/")[1] || "mp4").split(";")[0];
    return { mime: declaredMime.split(";")[0], isVideo: true, ext };
  }
  const mime = sniffImageMime(buf, declaredMime || "image/jpeg");
  return { mime, isVideo: false, ext: (mime.split("/")[1] || "jpg").replace("jpeg", "jpg") };
}

/* APP: the client uploads an image in the AI chat. Store it on Backblaze and drop
   it into the thread as a client media message, then run the agent (vision) to
   file it into the gallery + the relevant service. */
async function uploadChatImage(req, res) {
  try {
    const phone = normPhone(req.body.phone || req.query.phone);
    if (!phone) return res.status(400).json({ error: "phone required" });
    if (!req.file?.buffer) return res.status(400).json({ error: "image required" });
    const backblaze = require("../services/backblaze.service");
    const { mime, isVideo, ext } = sniffChatMedia(req.file.buffer, req.file.mimetype || "");
    const path = `agent-chat/${phone}/${Date.now()}.${ext}`;
    await backblaze.uploadImage(path, req.file.buffer, mime);   // stores any file type
    const url = `/api/img?url=${encodeURIComponent(path)}`;
    const caption = String(req.body.caption || "").trim();
    const conversationId = String(req.body.conversationId || "").trim() || null;

    const thread = await chat.getThread(phone);
    // media message carries a type so the app/console render an image vs a video player
    await chat.appendMessage(phone, { role: "user", kind: "chat", text: caption, media: [{ url, caption, type: isVideo ? "video" : "image" }] }, conversationId);
    // Human handling → leave it for them. Ghost → surface for the manager. Otherwise
    // run the agent in the background: images via VISION (sees + files them), videos
    // acknowledged text-only (no video vision). Fire-and-forget (response < 30s).
    if (chat.isGhostHuman(phone)) {
      await chat.flagGhostThread(phone);
    } else if (thread.handling === "human") {
      // client sent media while a human is handling → flip the thread back to
      // "waiting" (awaitingReply) until the manager replies.
      await chat.markClientAwaiting(phone);
    } else {
      chat.processClientMedia(phone, {
        url, isVideo, mediaType: mime, caption, conversationId,
        base64: isVideo ? null : req.file.buffer.toString("base64"),
      }).catch((e) => console.error("[agent] processClientMedia bg:", e.message));
    }
    res.json({ ok: true, url, type: isVideo ? "video" : "image" });
  } catch (e) {
    console.error("[agent] uploadChatImage:", e.message);
    res.status(500).json({ error: e.message });
  }
}

async function markRead(req, res) {
  try {
    const phone = normPhone(req.body.phone || req.params.phone);
    if (!phone) return res.status(400).json({ error: "phone required" });
    await chat.markRead(phone);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

/* ── Conversations (multi-thread within the per-phone AI chat) ─────────────── */
/* List the client's conversations (most-recent first) + the active pointer. */
async function listConversations(req, res) {
  try {
    const phone = normPhone(req.params.phone || req.query.phone);
    if (!phone) return res.status(400).json({ error: "phone required" });
    const out = await chat.listConversations(phone);
    res.json(out);
  } catch (e) {
    console.error("[agent] listConversations:", e.message);
    res.status(500).json({ error: e.message });
  }
}

/* Start a NEW conversation (the "+" button) → becomes active, empty thread. */
async function newConversation(req, res) {
  try {
    const phone = normPhone(req.body.phone || req.query.phone);
    if (!phone) return res.status(400).json({ error: "phone required" });
    const title = String(req.body.title || "").trim() || null;
    const conversation = await chat.startConversation(phone, { title });
    res.json({ ok: true, conversation, activeConversationId: conversation.id, messages: [] });
  } catch (e) {
    console.error("[agent] newConversation:", e.message);
    res.status(500).json({ error: e.message });
  }
}

/* Switch the active conversation (also happens implicitly on postMessage). */
async function switchConversation(req, res) {
  try {
    const phone = normPhone(req.body.phone || req.query.phone);
    const conversationId = String(req.body.conversationId || "").trim();
    if (!phone || !conversationId) return res.status(400).json({ error: "phone and conversationId required" });
    const out = await chat.setActiveConversation(phone, conversationId);
    res.json(out);
  } catch (e) {
    console.error("[agent] switchConversation:", e.message);
    res.status(500).json({ error: e.message });
  }
}

/* ── Approvals (app: client approves; admin: manager approves) ───────────── */
async function approve(req, res) {
  try {
    const approvalId = req.body.approvalId || req.params.approvalId;
    const who = req.body.approver || "client";
    if (!approvalId) return res.status(400).json({ error: "approvalId required" });
    const appr = await approvals.byId(approvalId);
    if (!appr) return res.status(404).json({ error: "approval not found" });
    if (appr.status !== "pending") return res.json({ ok: false, status: appr.status, note: "כבר טופל" });

    // ASYNC: executing the action can be long (launch = AI image + FB ≈ 60-230s,
    // over Heroku's 30s limit). Respond immediately; run in the background and
    // drop the outcome into the chat (the app surfaces it via its poll).
    res.json({ ok: true, queued: true });
    (async () => {
      const phone = appr.clientPhone;
      let ownsThinking = true; // a race-loser must NOT clear the winner's thinking flag
      try {
        if (phone) await chat.setThinking(phone, true);
        const out = await approvals.approve(approvalId, who);
        // A double-tap / poll retry that lost the atomic claim did nothing —
        // stay silent (no duplicate "בוצע/נכשל") and leave thinking to the winner.
        if (out.alreadyHandled) { ownsThinking = false; return; }
        if (phone) {
          // Everything the agent does is included in the subscription — never
          // surface tokens/coins/cost/balance to the client, under any outcome.
          let txt;
          if (out.ok) txt = `✅ בוצע: ${appr.summary}`;
          else txt = `לא הצלחתי לבצע כרגע: ${appr.summary}${out.error ? ` (${out.error})` : ""}. אפשר לנסות שוב עוד רגע.`;
          await chat.appendMessage(phone, { role: "assistant", text: txt, kind: "system" });
        }
      } catch (e) {
        console.error("[agent] approve background:", e.message);
        if (phone) await chat.appendMessage(phone, { role: "assistant", text: `לא הצלחתי לבצע: ${appr.summary} (${e.message})`, kind: "system" }).catch(() => {});
      } finally {
        if (phone && ownsThinking) await chat.setThinking(phone, false).catch(() => {});
      }
    })();
  } catch (e) {
    console.error("[agent] approve:", e.message);
    res.status(500).json({ error: e.message });
  }
}

async function reject(req, res) {
  try {
    const approvalId = req.body.approvalId || req.params.approvalId;
    const who = req.body.approver || "client";
    if (!approvalId) return res.status(400).json({ error: "approvalId required" });
    const appr = await approvals.byId(approvalId);
    const out = await approvals.reject(approvalId, who);
    if (out.ok && appr?.clientPhone) {
      await chat.appendMessage(appr.clientPhone, { role: "assistant", text: `הבנתי, לא מבצע: ${appr.summary}.`, kind: "system" });
    }
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
}

async function listApprovals(req, res) {
  try {
    const phone = normPhone(req.query.phone || req.params.phone);
    const list = await approvals.listPending(phone || undefined);
    res.json({ approvals: list });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

/* ── ADMIN/MANAGER: manual run, audit, kill switch ───────────────────────── */
async function run(req, res) {
  try {
    const phone = normPhone(req.body.phone);
    const message = String(req.body.message || req.body.text || "מה מצב הקמפיינים שלי?");
    const mode = req.body.mode || "chat";  // "readonly" for a safe dry run
    if (!phone) return res.status(400).json({ error: "phone required" });
    const out = await runAgent({ phone, userMessage: message, mode, trigger: "manager_invoked" });
    res.json(out);
  } catch (e) {
    console.error("[agent] run:", e.message);
    res.status(500).json({ error: e.message });
  }
}

async function getActions(req, res) {
  try {
    const list = await agentLog.list({
      phone: req.query.phone, agentRunId: req.query.runId,
      status: req.query.status, limit: req.query.limit,
    });
    res.json({ actions: list });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

async function killSwitch(req, res) {
  try {
    const enabled = req.body.enabled !== false && req.body.enabled !== "false";
    await getDB().collection("admin_settings").updateOne({}, { $set: { agentEnabled: enabled, agentEnabledAt: new Date() } }, { upsert: true });
    res.json({ ok: true, agentEnabled: enabled });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

async function status(req, res) {
  try {
    const enabled = await policy.isAgentEnabled();
    res.json({ agentEnabled: enabled });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

/* Proactive: sweep all clients, or one client (force skips cooldown for testing). */
async function proactiveSweep(req, res) {
  try {
    const { runProactiveSweep } = require("../cron/account-manager.cron");
    const summary = await runProactiveSweep({ force: req.body.force === true });
    res.json(summary);
  } catch (e) { res.status(500).json({ error: e.message }); }
}

async function proactiveOne(req, res) {
  try {
    const phone = normPhone(req.body.phone);
    if (!phone) return res.status(400).json({ error: "phone required" });
    const proactive = require("../services/agent/proactive.service");
    const out = await proactive.runForClient(phone, { force: req.body.force !== false, nowHour: req.body.nowHour });
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
}

/* Shadow learning: distill the brain from real manager chats; view active brain. */
async function distill(req, res) {
  try {
    const { distillPlaybook } = require("../jobs/distill-playbook.job");
    const out = await distillPlaybook({ dryRun: req.body.dryRun === true });
    res.json(out);
  } catch (e) {
    console.error("[agent] distill:", e.message);
    res.status(500).json({ error: e.message });
  }
}

async function getBrain(req, res) {
  try {
    const brainSvc = require("../services/agent/brain.service");
    const doc = await brainSvc.getActiveBrainDoc();
    res.json(doc ? { version: doc.version, stats: doc.stats, createdAt: doc.createdAt, playbookText: doc.playbookText } : { active: null });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

/* Manager "client 360" for the AI-conversations panel: report (leads/campaigns/
   spend/tokens/status) + creative outputs (gallery) + open escalations (detailed)
   + a technical debug trail (recent tool calls & errors, e.g. a failed
   generate_ad_image) so the team can diagnose + fix. */
async function getClientReport(req, res) {
  try {
    const phone = normPhone(req.params.phone || req.query.phone);
    if (!phone) return res.status(400).json({ error: "phone required" });
    const { assembleContext } = require("../services/agent/context");
    const esc = require("../services/agent/escalation.service");
    const db = getDB();

    const ctx = await assembleContext(phone).catch(() => ({ view: {} }));
    const v = ctx.view || {};
    const perf = v.performance || {};
    const report = {
      clientName: v.clientName || null,
      businessName: v.profile?.businessName || null,
      businessField: v.profile?.businessField || null,
      tier: v.tier || null,
      leads14d: perf.leads14d?.total ?? 0,
      campaignsTotal: perf.totalCampaigns ?? 0,
      campaignsActive: perf.activeCampaigns ?? 0,
      spend14d: perf.spend14d ?? 0,
      tokens: v.account?.coinBalance ?? 0,
      packageName: v.account?.package?.name || null,
      packageStatus: v.account?.package?.status || null,
      campaigns: (perf.campaigns || []).map(c => ({ name: c.name, status: c.status, dailyBudget: c.dailyBudget, leadsToday: c.leadsToday, spendToday: c.spendToday })),
    };

    // creative outputs — the client's gallery (uploaded + generated), fast (no FB calls)
    let creatives = [];
    try {
      const bp = await db.collection("business_profiles").findOne({ phone }, { projection: { images: 1, services: 1 } });
      creatives = [...(bp?.images || [])];
      for (const s of (bp?.services || [])) for (const im of (s.images || [])) if (!creatives.includes(im)) creatives.push(im);
    } catch (_) {}

    const escalations = await esc.listEscalations({ phone, status: "open" }).catch(() => []);

    // technical debug trail — the actual tool calls + errors (real "why it failed")
    let debug = [];
    try {
      debug = await db.collection("agent_actions")
        .find({ clientPhone: String(phone), type: "tool_call" })
        .sort({ at: -1 }).limit(25)
        .project({ tool: 1, status: 1, at: 1, args: 1, "result.error": 1, policyDecision: 1 })
        .toArray();
    } catch (_) {}

    // AI handling suggestions for the human manager (best-effort; based on the
    // escalation + the real failed tool calls → concrete steps, incl. tech fixes)
    let handlingSuggestions = [];
    if (escalations.length) {
      try {
        const { getClient, MODELS } = require("../services/agent/anthropic-client");
        const top = escalations[0];
        const failed = debug.filter(d => d.status === "failed").slice(0, 6)
          .map(d => `${d.tool} → ${d.result?.error || "failed"}`).join("; ");
        const resp = await getClient().messages.create({
          model: MODELS.triage, max_tokens: 400,
          system: "אתה עוזר למנהל אנושי ב-Kliq לטפל בפנייה שהסוכן העביר אליו. הצע 2-4 צעדים קונקרטיים ומעשיים לטיפול/פתרון, בעברית, קצרים וברורים. אם זו תקלה טכנית (כלי שנכשל / שגיאת API) — כלול מה לבדוק או לתקן במערכת (למשל מפתח API, הרשאה, שירות שנפל) וגם מה לומר ללקוח בינתיים. החזר JSON בלבד ותו לא: {\"suggestions\":[\"...\"]}.",
          messages: [{ role: "user", content: `נושא הפנייה: ${top.lastCategory || top.category}\nתקציר: ${top.summary}\nקריאות כלי שנכשלו (דיבוג טכני): ${failed || "אין"}` }],
        });
        const txt = resp.content.filter(c => c.type === "text").map(c => c.text).join("");
        const m = txt.match(/\{[\s\S]*\}/);
        const parsed = JSON.parse(m ? m[0] : txt);
        if (Array.isArray(parsed.suggestions)) handlingSuggestions = parsed.suggestions.filter(s => typeof s === "string" && s.trim()).slice(0, 4);
      } catch (_) { /* best-effort */ }
    }

    res.json({ report, creatives: creatives.slice(0, 24), escalations, debug, handlingSuggestions });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

/* Middleware: only the ADMIN-BOSS (agent.isOwner) may touch the escalations
   queue — resolves the CPANEL Bearer token → agent, checks isOwner. */
async function requireOwner(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: "unauthorized" });
    const agent = await getDB().collection("agents").findOne({ token }, { projection: { isOwner: 1, name: 1, role: 1 } });
    if (!agent) return res.status(401).json({ error: "unauthorized" });
    if (!agent.isOwner) return res.status(403).json({ error: "owner only" });
    req.agent = agent;
    next();
  } catch (e) { res.status(500).json({ error: e.message }); }
}

/* CPANEL: the manager's queue of AI-escalated client issues. */
async function getEscalations(req, res) {
  try {
    const esc = require("../services/agent/escalation.service");
    // enriched with a derived handling status (control view) — additive fields
    const list = await esc.listEscalationsWithStatus({ status: req.query.status, phone: req.query.phone, limit: req.query.limit });
    res.json({ escalations: list });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

async function resolveEscalation(req, res) {
  try {
    const esc = require("../services/agent/escalation.service");
    const id = req.body.id || req.params.id;
    if (!id) return res.status(400).json({ error: "id required" });
    const out = await esc.resolveEscalation(id, req.body.by || "manager");
    // LIVE LEARNING: a resolved escalation is a labeled outcome — distill a lesson
    // (what to recognize/phrase/escalate better) in the background, best-effort.
    try {
      const { ObjectId } = require("mongodb");
      const { getDB } = require("../config/db");
      getDB().collection("agent_escalations").findOne({ _id: new ObjectId(String(id)) })
        .then((doc) => doc && require("../services/agent/lessons.service")
          .distillLessons({ phone: doc.phone, reason: "escalation_resolved", escalation: doc }))
        .catch(() => {});
    } catch (_) {}
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
}

/* ── HUMAN TAKEOVER of the AI thread (manager-authenticated) ───────────────── */

/* Middleware: any active staff agent (by Bearer token) may take over a thread. */
async function requireAgent(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: "unauthorized" });
    const agent = await getDB().collection("agents").findOne({ token }, { projection: { name: 1, nickname: 1, role: 1 } });
    if (!agent) return res.status(401).json({ error: "unauthorized" });
    req.agent = agent;
    next();
  } catch (e) { res.status(500).json({ error: e.message }); }
}

/* List AI threads a manager may want to handle (human-handled / with new client msgs). */
async function getManagerThreads(req, res) {
  try {
    const rows = await chat.listManagerThreads({ handling: req.query.handling });
    res.json({ threads: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

async function takeOverChat(req, res) {
  try {
    const phone = normPhone(req.body.phone);
    if (!phone) return res.status(400).json({ error: "phone required" });
    const name = req.agent?.nickname || req.agent?.name || "נציג";
    const out = await chat.takeOver(phone, { agentId: req.agent?._id, name });
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
}

async function returnChatToAi(req, res) {
  try {
    const phone = normPhone(req.body.phone);
    if (!phone) return res.status(400).json({ error: "phone required" });
    const out = await chat.returnToAi(phone, { name: req.agent?.name });
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
}

/* MANAGER: close/resolve a thread → it moves to the "סגור" tab and leaves the
   active queue; the AI resumes. A later escalation/takeover reopens it. */
async function closeChat(req, res) {
  try {
    const phone = normPhone(req.body.phone);
    if (!phone) return res.status(400).json({ error: "phone required" });
    const name = req.agent?.nickname || req.agent?.name || "נציג";
    const out = await chat.closeThread(phone, { agentId: req.agent?._id, name });
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
}

async function sendHumanChatMessage(req, res) {
  try {
    const phone = normPhone(req.body.phone);
    const text = (req.body.text || "").trim();
    if (!phone || !text) return res.status(400).json({ error: "phone and text required" });
    const name = req.agent?.nickname || req.agent?.name || "נציג";
    // announce=true (CPANEL client-profile chat): human message + push WITHOUT
    // pausing the AI — for one-off important notices, not a takeover.
    const m = await chat.sendHumanMessage(phone, { agentId: req.agent?._id, name }, text, { announce: req.body.announce === true });
    res.json({ ok: true, message: m });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

/* MANAGER: send an IMAGE to the client in-thread (from the AI-conversations panel).
   Stores it on Backblaze and drops it into the thread — as an AI-looking media
   message for ghost clients, otherwise a human media message (auto-takeover). */
async function sendHumanChatImage(req, res) {
  try {
    const phone = normPhone(req.body.phone || req.query.phone);
    if (!phone) return res.status(400).json({ error: "phone required" });
    if (!req.file?.buffer) return res.status(400).json({ error: "image required" });
    const backblaze = require("../services/backblaze.service");
    const mime = sniffImageMime(req.file.buffer, req.file.mimetype || "image/jpeg");
    const ext = (mime.split("/")[1] || "jpg").replace("jpeg", "jpg");
    const path = `agent-chat/${phone}/${Date.now()}.${ext}`;
    await backblaze.uploadImage(path, req.file.buffer, mime);
    const url = `/api/img?url=${encodeURIComponent(path)}`;
    const caption = String(req.body.caption || "").trim();
    const announce = req.body.announce === true || req.body.announce === "true";
    const name = req.agent?.nickname || req.agent?.name || "נציג";
    const m = await chat.sendHumanMedia(phone, { agentId: req.agent?._id, name }, { url, caption, announce });
    res.json({ ok: true, url, message: m });
  } catch (e) {
    console.error("[agent] sendHumanChatImage:", e.message);
    res.status(500).json({ error: e.message });
  }
}

/* Manager (Noy) sends a DOCUMENT (PDF — e.g. an invoice) to the client in-thread.
   Documents are manager-only; the client never uploads and the agent never sends
   invoices itself (money stays with a human). PDF-only, validated by magic bytes. */
async function sendHumanChatDocument(req, res) {
  try {
    const phone = normPhone(req.body.phone || req.query.phone);
    if (!phone) return res.status(400).json({ error: "phone required" });
    const buf = req.file?.buffer;
    if (!buf) return res.status(400).json({ error: "document required" });
    // accept PDF only — sniff the %PDF magic (or a declared application/pdf)
    const isPdf = buf.toString("ascii", 0, 5) === "%PDF-" || /application\/pdf/i.test(req.file.mimetype || "");
    if (!isPdf) return res.status(400).json({ error: "רק קובצי PDF נתמכים" });
    const backblaze = require("../services/backblaze.service");
    // keep a clean, human-readable original filename for the client's file bubble
    const raw = String(req.file.originalname || "document.pdf");
    const safeName = (raw.replace(/[^\w.\-֐-׿ ]+/g, "_").replace(/\s+/g, " ").trim() || "document") .replace(/(\.pdf)?$/i, ".pdf");
    const path = `agent-chat/${phone}/${Date.now()}.pdf`;
    await backblaze.uploadImage(path, buf, "application/pdf");
    const url = `/api/img?url=${encodeURIComponent(path)}`;
    const caption = String(req.body.caption || "").trim();
    const name = req.agent?.nickname || req.agent?.name || "נציג";
    const m = await chat.sendHumanMedia(phone, { agentId: req.agent?._id, name }, { url, caption, type: "document", fileName: safeName });
    res.json({ ok: true, url, fileName: safeName, message: m });
  } catch (e) {
    console.error("[agent] sendHumanChatDocument:", e.message);
    res.status(500).json({ error: e.message });
  }
}

/* CPANEL: the agent's "hi-tech division" report — recurring technical failures
   from the audit trail + AI root-cause & code-optimization suggestions. */
async function getTechReport(req, res) {
  try {
    const tech = require("../services/agent/tech-report.service");
    const windowDays = Math.min(parseInt(req.query.days, 10) || 7, 60);
    const out = await tech.getReport({ windowDays, force: req.query.force === "1" });
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
}

/* CPANEL: auto-resolve a tech-report failure cluster — re-run each affected
   client's failed request through the agent (safety chokepoint intact). Runs in
   the background (each client = a full agent run; far exceeds 30s). */
async function resolveTechIssue(req, res) {
  try {
    const tool = req.body.tool;
    const errorPrefix = req.body.errorPrefix || "";
    if (!tool) return res.status(400).json({ error: "tool required" });
    const ar = require("../services/agent/auto-resolve.service");
    const since = new Date(Date.now() - 7 * 86400000);
    const clients = await getDB().collection("agent_actions")
      .distinct("clientPhone", { type: "tool_call", status: "failed", tool, at: { $gte: since } });
    ar.resolveCluster({ tool, errorPrefix })
      .then(r => console.log("[auto-resolve]", JSON.stringify({ tool, attempted: r.attempted, skipped: r.skipped, failed: r.failed })))
      .catch(e => console.error("[auto-resolve] bg:", e.message));
    res.json({ ok: true, started: true, clientsAffected: clients.filter(Boolean).length });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

/* CPANEL: hand an escalation to the human triage manager (Noy) as a real client
   conversation in the WebApp support inbox. */
async function forwardEscalation(req, res) {
  try {
    const esc = require("../services/agent/escalation.service");
    const id = req.body.id || req.params.id;
    if (!id) return res.status(400).json({ error: "id required" });
    const io = req.app.get("io");
    const out = await esc.forwardToManagerInbox({ escalationId: id, io });
    if (!out.ok) return res.status(400).json(out);
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
}

/* ── LIVE-LEARNING admin surface (lessons / reflection / style index) ───────── */

async function getLessons(req, res) {
  try {
    const lessons = require("../services/agent/lessons.service");
    const list = await lessons.listLessons({ activeOnly: req.query.all !== "1", limit: parseInt(req.query.limit, 10) || 100 });
    res.json({ lessons: list });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

async function deactivateLesson(req, res) {
  try {
    if (!req.body.id) return res.status(400).json({ error: "id required" });
    const lessons = require("../services/agent/lessons.service");
    res.json(await lessons.deactivateLesson(req.body.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
}

/* Run the nightly jobs on demand — in the background (LLM/embeddings > 30s). */
async function reflectNow(req, res) {
  try {
    require("../services/agent/reflection.service").reflect()
      .then((out) => console.log("[agent] manual reflection:", JSON.stringify(out)))
      .catch((e) => console.error("[agent] manual reflection failed:", e.message));
    res.json({ queued: true, note: "הרפלקציה רצה ברקע — לקחים חדשים יופיעו ב-GET /api/agent/lessons" });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

/* Long-term client memory — view (managers) / retire a wrong fact (owner). */
async function getClientMemory(req, res) {
  try {
    const phone = normPhone(req.params.phone);
    if (!phone) return res.status(400).json({ error: "phone required" });
    const mem = require("../services/agent/client-memory.service");
    const doc = await mem.getMemoryDoc(phone);
    res.json({ phone, facts: doc?.facts || [], updatedAt: doc?.updatedAt || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

async function deactivateClientFact(req, res) {
  try {
    const phone = normPhone(req.body.phone);
    if (!phone || !req.body.id) return res.status(400).json({ error: "phone + id required" });
    const mem = require("../services/agent/client-memory.service");
    res.json(await mem.deactivateFact(phone, req.body.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
}

/* Quality trend (nightly Opus judge) + internal benchmarks — owner oversight. */
async function getQualityScores(req, res) {
  try {
    const qj = require("../services/agent/quality-judge.service");
    res.json({ scores: await qj.getScores(parseInt(req.query.limit, 10) || 14) });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

async function judgeNow(req, res) {
  try {
    require("../services/agent/quality-judge.service").judge()
      .then((out) => console.log("[agent] manual quality-judge:", JSON.stringify(out)))
      .catch((e) => console.error("[agent] manual quality-judge failed:", e.message));
    res.json({ queued: true, note: "השופט רץ ברקע — התוצאה תופיע ב-GET /api/agent/quality" });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

async function getBenchmarks(req, res) {
  try {
    const bm = require("../services/agent/benchmarks.service");
    res.json(await bm.getAllBenchmarks());
  } catch (e) { res.status(500).json({ error: e.message }); }
}

/* Autonomy oversight: preview (dryRun) what the ops loops WOULD do, or run now. */
async function opsPreview(req, res) {
  try {
    const ops = require("../services/agent/ops.service");
    const autoResolve = require("../services/agent/auto-resolve.service");
    const [takeovers, escalations, failures] = await Promise.all([
      ops.releaseStaleTakeovers({ dryRun: true }),
      ops.followUpStaleEscalations({ dryRun: true }),
      autoResolve.autoResolveRecent({ dryRun: true }),
    ]);
    res.json({ staleTakeovers: takeovers.candidates, staleEscalations: escalations.candidates, failureClusters: failures.clusters });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

async function opsRunNow(req, res) {
  try {
    const ops = require("../services/agent/ops.service");
    const autoResolve = require("../services/agent/auto-resolve.service");
    Promise.all([
      ops.releaseStaleTakeovers(),
      ops.followUpStaleEscalations(),
      autoResolve.autoResolveRecent(),
    ]).then((out) => console.log("[agent] manual ops run:", JSON.stringify(out.map(o => ({ ...o, candidates: undefined })))))
      .catch((e) => console.error("[agent] manual ops run failed:", e.message));
    res.json({ queued: true, note: "מעגלי האוטונומיה רצים ברקע" });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

async function styleIndexNow(req, res) {
  try {
    require("../services/agent/style-rag.service").buildIndex()
      .then((out) => console.log("[agent] manual style-index:", JSON.stringify(out)))
      .catch((e) => console.error("[agent] manual style-index failed:", e.message));
    res.json({ queued: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

module.exports = {
  getChat, postMessage, markRead, uploadChatImage,
  listConversations, newConversation, switchConversation,
  approve, reject, listApprovals,
  run, getActions, killSwitch, status,
  proactiveSweep, proactiveOne,
  distill, getBrain,
  getLessons, deactivateLesson, reflectNow, styleIndexNow, getClientMemory, deactivateClientFact,
  getQualityScores, judgeNow, getBenchmarks, opsPreview, opsRunNow,
  getEscalations, resolveEscalation, forwardEscalation, getTechReport, resolveTechIssue, requireOwner,
  requireAgent, getManagerThreads, takeOverChat, returnChatToAi, closeChat, sendHumanChatMessage, sendHumanChatImage, sendHumanChatDocument, getClientReport,
};
