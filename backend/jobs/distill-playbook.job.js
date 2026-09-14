'use strict';

/**
 * distill-playbook.job — SHADOW LEARNING. Reads the best real human-manager
 * conversations from `support_chats`, distills the managers' voice + playbook
 * with Claude (map-reduce), and saves the result as a versioned `agent_brain`
 * doc. The agent's system prompt then adopts that learned voice
 * (system-prompt.js + brain.service.js).
 *
 * Offline batch — safe to run anytime; touches no live ad accounts. Trigger via
 * POST /api/agent/distill or call distillPlaybook() directly.
 */

const { getDB } = require("../config/db");
const { getClient, MODELS } = require("../services/agent/anthropic-client");
const brainSvc = require("../services/agent/brain.service");

const MAX_CHATS = parseInt(process.env.DISTILL_MAX_CHATS, 10) || 40;
const MAX_TAKEOVERS = parseInt(process.env.DISTILL_MAX_TAKEOVERS, 10) || 30;
const BATCH = parseInt(process.env.DISTILL_BATCH, 10) || 8;
const MAX_MSGS_PER_CHAT = 40;
const MAX_CHARS_PER_CHAT = 3000;

const role = (m) => (m.fromRole === "agent" ? "מנהל" : m.fromRole === "user" ? "לקוח" : null);

/* Turn a support_chats doc into a compact, bounded transcript string. */
function transcript(doc) {
  const msgs = (doc.messages || [])
    .filter(m => m && m.text && typeof m.text === "string" && role(m))
    .slice(-MAX_MSGS_PER_CHAT)
    .map(m => `${role(m)}: ${m.text.replace(/\s+/g, " ").trim()}`);
  let out = msgs.join("\n");
  if (out.length > MAX_CHARS_PER_CHAT) out = out.slice(0, MAX_CHARS_PER_CHAT) + " …";
  return out;
}

async function sampleChats() {
  // chats with real back-and-forth: >=6 messages, recent first.
  const rows = await getDB().collection("support_chats")
    .find({ "messages.5": { $exists: true } }, { projection: { messages: 1, name: 1, updated_at: 1 } })
    .sort({ updated_at: -1 })
    .limit(MAX_CHATS * 2)
    .toArray();
  // keep those with at least 2 manager turns
  const good = [];
  for (const r of rows) {
    const mgr = (r.messages || []).filter(m => m.fromRole === "agent" && m.text).length;
    const cli = (r.messages || []).filter(m => m.fromRole === "user" && m.text).length;
    if (mgr >= 2 && cli >= 1) good.push(r);
    if (good.length >= MAX_CHATS) break;
  }
  return good;
}

/* ── HUMAN-TAKEOVER LEARNING (agent_chats) ──────────────────────────────────
   The highest-signal data: threads where the AI was handling a client and a
   human manager had to STEP IN. These are exactly the situations the AI
   couldn't close — learning from how the human handled them lets the AI cover
   more next time (within its marketing scope) and escalate the rest better. */

const takeoverRole = (m) => {
  if (!m || m.kind === "system") return null;             // skip join/leave notices
  if (m.role === "user") return "לקוח";
  if (m.role === "assistant" && m.authorType === "human") return "מנהל אנושי";
  if (m.role === "assistant") return "AI";
  return null;
};

/* agent_chats doc → labeled transcript (לקוח / AI / מנהל אנושי). */
function takeoverTranscript(doc) {
  const msgs = (doc.messages || [])
    .filter(m => m && m.text && typeof m.text === "string" && takeoverRole(m))
    .slice(-MAX_MSGS_PER_CHAT)
    .map(m => `${takeoverRole(m)}: ${m.text.replace(/\s+/g, " ").trim()}`);
  let out = msgs.join("\n");
  if (out.length > MAX_CHARS_PER_CHAT) out = out.slice(0, MAX_CHARS_PER_CHAT) + " …";
  return out;
}

/* Threads with a REAL human reply (a manager chat message, not just the join
   system-notice) + at least one client message. */
async function sampleTakeovers() {
  const rows = await getDB().collection("agent_chats")
    .find(
      { $or: [{ humanTakeoverAt: { $exists: true } }, { "messages.authorType": "human" }] },
      { projection: { messages: 1, phone: 1, humanTakeoverAt: 1, updatedAt: 1 } },
    )
    .sort({ humanTakeoverAt: -1, updatedAt: -1 })
    .limit(MAX_TAKEOVERS * 2)
    .toArray();
  const good = [];
  for (const r of rows) {
    const human = (r.messages || []).filter(m => m.role === "assistant" && m.authorType === "human" && m.kind !== "system" && m.text).length;
    const cli = (r.messages || []).filter(m => m.role === "user" && m.text).length;
    if (human >= 1 && cli >= 1) good.push(r);
    if (good.length >= MAX_TAKEOVERS) break;
  }
  return good;
}

const TAKEOVER_MAP_SYSTEM = `אתה אנליסט שמנתח שיחות שבהן סוכן AI של Kliq טיפל בלקוח ואז מנהל אנושי נאלץ להשתלט ולהמשיך. מטרתך: ללמד את ה-AI לטפל טוב יותר בפעם הבאה. אל תצטט פרטים מזהים (שמות/טלפונים) — רק דפוסים.`;

function takeoverMapPrompt(transcripts) {
  return `להלן ${transcripts.length} שיחות שבהן AI טיפל ואז מנהל אנושי השתלט. כל הודעה מתויגת: "לקוח" / "AI" / "מנהל אנושי". חלץ בעברית, בנקודות תמציתיות:
1. באילו מצבים ה-AI לא הסתדר לבד והמנהל נאלץ להשתלט (סוג הפנייה).
2. איך המנהל האנושי טיפל — הטון, הניסוח, והמהות.
3. מה ה-AI יכול ללמוד לעשות טוב יותר **בתחום השיווק שלו** (קמפיינים/מודעות/לידים/תקציב/תוכן/תמונות/טוקנים) כדי לא להזדקק להשתלטות.
4. במקרים **מחוץ לתחום ה-AI** (כספים/חוזים/תקלה טכנית) — איך המנהל *ניסח והכיל* את הפנייה. חשוב: ה-AI עדיין חייב להסלים נושאים אלה ולעולם לא להבטיח החזרים/ביטולים — כאן לומדים רק ניסוח והכלה, לא לפתור לבד.
אל תמציא — רק מה שמופיע בשיחות.

${transcripts.map((t, i) => `=== שיחה ${i + 1} ===\n${t}`).join("\n\n")}`;
}

const TAKEOVER_REDUCE_SYSTEM = `אתה כותב סעיף ל"ספר משחק" של מנהל תיקים AI של Kliq, המבוסס על מקרים אמיתיים שבהם ה-AI נזקק להשתלטות אנושית. הפלט ייכנס ישירות ל-system prompt של הסוכן — הנחיות ישירות, תמציתיות ומעשיות בעברית.`;

function takeoverReducePrompt(insights) {
  return `אחד את התובנות הבאות לסעיף אחד מגובש שכותרתו בדיוק "## למידה מהשתלטויות אנושיות". כלול:
- דפוסי מצבים שגרמו להשתלטות, ולכל אחד מה ה-AI יעשה אחרת בפעם הבאה (בתחום השיווק).
- ניסוחים וגישה של המנהל האנושי ששווה לאמץ.
- תזכורת קצרה: נושאים מחוץ לתחום (כספים/חוזים/טכני) ממשיכים להסלמה עם ניסוח מכיל — בלי להבטיח פתרון.
תמציתי, בלי הקדמות, בלי טבלאות markdown.

תובנות:
${insights.map((b, i) => `--- מקבץ ${i + 1} ---\n${b}`).join("\n\n")}`;
}

const MAP_SYSTEM = `אתה אנליסט שיווק שמנתח שיחות אמיתיות בין מנהלי תיקים של חברת Kliq (שיווק דיגיטלי ופרסום בפייסבוק/אינסטגרם) לבין לקוחות. מטרתך: לחלץ את ה-DNA של מנהלי התיק כדי לאמן סוכן AI שיחליף אותם. אל תצטט פרטים אישיים מזהים של לקוחות (שמות/טלפונים) — רק דפוסים.`;

function mapPrompt(transcripts) {
  return `להלן ${transcripts.length} שיחות (מנהל/לקוח). חלץ בעברית, בנקודות תמציתיות:
1. טון וסגנון דיבור של המנהל (איך הוא פותח, מרגיע, סוגר).
2. עצות/אסטרטגיות שיווק חוזרות שהמנהלים נותנים.
3. טיפול במצבים נפוצים: תלונות, ירידה בלידים, שאלות תקציב, בעיות טכניות, לקוח מתלבט.
4. ניסוחים/ביטויים אופייניים שחוזרים (פתיחים, מעברים, סגירות).
אל תמציא — רק מה שמופיע בשיחות.

${transcripts.map((t, i) => `=== שיחה ${i + 1} ===\n${t}`).join("\n\n")}`;
}

const REDUCE_SYSTEM = `אתה כותב "ספר משחק" (playbook) למנהל תיקים AI של Kliq, על בסיס תובנות שזוקקו משיחות אמיתיות של מנהלי תיק אנושיים. הפלט ייכנס ישירות ל-system prompt של הסוכן, אז כתוב אותו כהנחיות ישירות, תמציתיות ומעשיות בעברית.`;

function reducePrompt(batchInsights) {
  return `להלן תובנות שחולצו מ-${batchInsights.length} מקבצי שיחות. אחד אותן ל-playbook אחד, מגובש ולא חוזר על עצמו, עם הכותרות הבאות:

## הטון והקול
(איך מנהל Kliq מדבר — פתיחים, אמפתיה, ביטחון, סגירות. ביטויים אופייניים אמיתיים.)

## אסטרטגיות שיווק חוזרות
(העצות וההמלצות שחוזרות אצל המנהלים.)

## טיפול במצבים
(מצב → תגובה מומלצת: תלונה, ירידת לידים, שאלת תקציב, בעיה טכנית, התלבטות.)

## עשה / אל תעשה
(דפוסים שעובדים, ודברים שהמנהלים נמנעים מהם.)

שמור על תמציתיות — זה ייכנס ל-prompt. בלי הקדמות, בלי טבלאות markdown.

תובנות:
${batchInsights.map((b, i) => `--- מקבץ ${i + 1} ---\n${b}`).join("\n\n")}`;
}

async function callClaude(model, system, prompt, maxTokens) {
  const client = getClient();
  const resp = await client.messages.create({
    model, max_tokens: maxTokens, system,
    messages: [{ role: "user", content: prompt }],
  });
  return resp.content.filter(c => c.type === "text").map(c => c.text).join("\n").trim();
}

/**
 * distillPlaybook({ dryRun }) → { version?, stats }
 *   dryRun=true returns the distilled text WITHOUT saving an agent_brain doc.
 */
async function distillPlaybook({ dryRun = false } = {}) {
  const chats = await sampleChats();
  if (chats.length < 3) return { error: "not enough manager conversations to distill", chats: chats.length };

  const transcripts = chats.map(transcript).filter(Boolean);
  console.log(`[distill] distilling from ${transcripts.length} conversations`);

  // MAP — summarize each batch of transcripts
  const batchInsights = [];
  for (let i = 0; i < transcripts.length; i += BATCH) {
    const slice = transcripts.slice(i, i + BATCH);
    const insight = await callClaude(MODELS.strategy, MAP_SYSTEM, mapPrompt(slice), 1500);
    if (insight) batchInsights.push(insight);
    console.log(`[distill] batch ${Math.floor(i / BATCH) + 1}: ${insight.length} chars`);
  }
  if (!batchInsights.length) return { error: "distillation produced no insights" };

  // REDUCE — combine into one playbook
  const mainPlaybook = await callClaude(MODELS.strategy, REDUCE_SYSTEM, reducePrompt(batchInsights), 2500);
  if (!mainPlaybook) return { error: "reduce step produced empty playbook" };

  // LEARN FROM HUMAN TAKEOVERS — additive section (skipped gracefully if too few).
  let takeoverSection = "";
  let takeoverCount = 0;
  try {
    const takeovers = await sampleTakeovers();
    takeoverCount = takeovers.length;
    if (takeovers.length >= 2) {
      const tTranscripts = takeovers.map(takeoverTranscript).filter(Boolean);
      console.log(`[distill] learning from ${tTranscripts.length} human-takeover threads`);
      const tInsights = [];
      for (let i = 0; i < tTranscripts.length; i += BATCH) {
        const slice = tTranscripts.slice(i, i + BATCH);
        const insight = await callClaude(MODELS.strategy, TAKEOVER_MAP_SYSTEM, takeoverMapPrompt(slice), 1500);
        if (insight) tInsights.push(insight);
      }
      if (tInsights.length) {
        const section = await callClaude(MODELS.strategy, TAKEOVER_REDUCE_SYSTEM, takeoverReducePrompt(tInsights), 1500);
        if (section) {
          const s = section.trim();
          takeoverSection = s.startsWith("##") ? s : `## למידה מהשתלטויות אנושיות\n${s}`;
        }
      }
    } else {
      console.log(`[distill] only ${takeoverCount} takeover thread(s) — skipping takeover section (need ≥2)`);
    }
  } catch (e) {
    console.warn("[distill] takeover learning failed (skipping section):", e.message);
  }

  const playbookText = takeoverSection ? `${mainPlaybook}\n\n${takeoverSection}` : mainPlaybook;

  const stats = { conversations: transcripts.length, batches: batchInsights.length, takeovers: takeoverCount, chars: playbookText.length };
  if (dryRun) return { dryRun: true, playbookText, stats, hasTakeoverSection: !!takeoverSection };

  const { version } = await brainSvc.saveBrain({ playbookText, stats });
  console.log(`[distill] ✅ saved agent_brain v${version} (${stats.chars} chars from ${stats.conversations} chats + ${takeoverCount} takeovers)`);
  return { version, stats, playbookText };
}

module.exports = { distillPlaybook, sampleTakeovers, takeoverTranscript };
