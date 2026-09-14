'use strict';

/**
 * style-rag.service — per-message VOICE matching. The distilled brain gives the
 * agent a static "manager voice"; this goes further: it embeds real (client
 * question → human manager answer) pairs from the actual history, and for every
 * inbound client message retrieves the top-K most similar real exchanges to
 * inject as live style exemplars — so the agent answers the way OUR managers
 * actually answered in that exact situation.
 *
 * Embeddings: OpenAI text-embedding-3-small (same env key the image stack uses).
 * Vectors live in `agent_style_vectors`; the whole (bounded) set is cached
 * in-process and matched with plain cosine — no vector DB needed at this scale.
 *
 * Everything is best-effort: any failure returns null and the agent runs
 * exactly as before. Read-only over chat history.
 */

const { getDB } = require("../../config/db");

const col = () => getDB().collection("agent_style_vectors");
const EMBED_MODEL = "text-embedding-3-small";
const MAX_VECTORS = parseInt(process.env.AGENT_STYLE_MAX_VECTORS, 10) || 2000;
const MIN_SCORE = 0.35;

let _openai = null;
function getOpenAI() {
  if (_openai) return _openai;
  const key = process.env.OpenAI_API_KEY || process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OpenAI API key not configured");
  const { OpenAI } = require("openai");
  _openai = new OpenAI({ apiKey: key });
  return _openai;
}

async function embed(texts) {
  const resp = await getOpenAI().embeddings.create({ model: EMBED_MODEL, input: texts });
  return resp.data.map(d => d.embedding);
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

let indexed = false;
async function ensureIndexes() {
  if (indexed) return;
  try {
    await col().createIndex({ key: 1 }, { unique: true });
    await col().createIndex({ createdAt: -1 });
    indexed = true;
  } catch (e) { console.warn("[style-rag] index ensure failed:", e.message); }
}

/* ── index building — mine real (client → human manager) pairs ─────────────── */

const okQ = (t) => typeof t === "string" && t.trim().length >= 8 && t.trim().length <= 400 && !/^https?:/.test(t);
const okA = (t) => typeof t === "string" && t.trim().length >= 15 && t.trim().length <= 600;

/* support_chats: fromRole user → agent (the human manager). */
function minePairsFromSupport(doc) {
  const pairs = [];
  const msgs = (doc.messages || []).filter(m => m && typeof m.text === "string" && m.text);
  for (let i = 1; i < msgs.length; i++) {
    const q = msgs[i - 1], a = msgs[i];
    if (q.fromRole === "user" && a.fromRole === "agent" && okQ(q.text) && okA(a.text) && !a.agentOnly) {
      pairs.push({ key: `sup:${doc._id}:${i}`, q: q.text.trim(), a: a.text.trim(), source: "support" });
    }
  }
  return pairs;
}

/* agent_chats: user → assistant with authorType human (a takeover reply). */
function minePairsFromAgentChats(doc) {
  const pairs = [];
  const msgs = (doc.messages || []).filter(m => m && typeof m.text === "string" && m.text && m.kind !== "system");
  for (let i = 1; i < msgs.length; i++) {
    const q = msgs[i - 1], a = msgs[i];
    if (q.role === "user" && a.role === "assistant" && a.authorType === "human" && okQ(q.text) && okA(a.text)) {
      pairs.push({ key: `tak:${doc._id}:${i}`, q: q.text.trim(), a: a.text.trim(), source: "takeover" });
    }
  }
  return pairs;
}

/**
 * buildIndex({ scanLimit }) — incremental: mines new pairs, embeds only unseen
 * keys (batched), inserts. Safe to run nightly. Returns { mined, embedded }.
 */
async function buildIndex({ scanLimit = 150 } = {}) {
  try {
    await ensureIndexes();
    const db = getDB();
    const [supDocs, agDocs] = await Promise.all([
      db.collection("support_chats").find({ "messages.3": { $exists: true } },
        { projection: { messages: 1 } }).sort({ updated_at: -1 }).limit(scanLimit).toArray(),
      db.collection("agent_chats").find({ "messages.authorType": "human" },
        { projection: { messages: 1 } }).sort({ updatedAt: -1 }).limit(scanLimit).toArray(),
    ]);
    const pairs = [
      ...supDocs.flatMap(minePairsFromSupport),
      ...agDocs.flatMap(minePairsFromAgentChats),
    ];
    if (!pairs.length) return { mined: 0, embedded: 0 };

    const existing = new Set((await col().find({}, { projection: { key: 1 } }).toArray()).map(d => d.key));
    const fresh = pairs.filter(p => !existing.has(p.key)).slice(0, 500);
    let embedded = 0;
    for (let i = 0; i < fresh.length; i += 96) {
      const batch = fresh.slice(i, i + 96);
      const vecs = await embed(batch.map(p => p.q));
      const docs = batch.map((p, j) => ({ ...p, embedding: vecs[j], createdAt: new Date() }));
      try { await col().insertMany(docs, { ordered: false }); embedded += docs.length; }
      catch (e) { embedded += e.result?.insertedCount || 0; }
    }
    // keep the collection bounded — drop the oldest beyond the cap
    const total = await col().countDocuments();
    if (total > MAX_VECTORS) {
      const overflow = await col().find({}, { projection: { _id: 1 } })
        .sort({ createdAt: 1 }).limit(total - MAX_VECTORS).toArray();
      await col().deleteMany({ _id: { $in: overflow.map(d => d._id) } });
    }
    if (embedded) { _vecCache = { rows: null, at: 0 }; console.log(`[style-rag] indexed ${embedded} new pair(s) (mined ${pairs.length})`); }
    return { mined: pairs.length, embedded };
  } catch (e) {
    console.warn("[style-rag] buildIndex failed:", e.message);
    return { mined: 0, embedded: 0, error: e.message };
  }
}

/* ── runtime retrieval ──────────────────────────────────────────────────────── */

const VEC_TTL_MS = 10 * 60 * 1000;
let _vecCache = { rows: null, at: 0 };

async function loadVectors() {
  if (_vecCache.rows && (Date.now() - _vecCache.at) < VEC_TTL_MS) return _vecCache.rows;
  const rows = await col().find({}, { projection: { q: 1, a: 1, embedding: 1 } })
    .sort({ createdAt: -1 }).limit(MAX_VECTORS).toArray();
  _vecCache = { rows, at: Date.now() };
  return rows;
}

/**
 * getStyleBlock(userMessage, k) → a prompt block with the K most similar REAL
 * manager exchanges, or null. Adds ~1 embedding call (~50ms) per message.
 */
async function getStyleBlock(userMessage, k = 3) {
  try {
    const msg = String(userMessage || "").trim();
    if (msg.length < 8) return null;
    const rows = await loadVectors();
    if (!rows.length) return null;
    const [qv] = await embed([msg.slice(0, 400)]);
    const scored = rows
      .map(r => ({ r, s: cosine(qv, r.embedding) }))
      .filter(x => x.s >= MIN_SCORE)
      .sort((a, b) => b.s - a.s)
      .slice(0, k);
    if (!scored.length) return null;
    const lines = scored.map(({ r }, i) =>
      `דוגמה ${i + 1}:\nלקוח: ${r.q.slice(0, 200)}\nמנהל: ${r.a.slice(0, 300)}`);
    return [
      `# דוגמאות סגנון אמיתיות (מנהלים אנושיים של Kliq במצבים דומים)`,
      `אמץ את הטון והגישה — אל תעתיק מילולית, והנתונים בדוגמאות אינם רלוונטיים ללקוח הנוכחי:`,
      ...lines,
    ].join("\n");
  } catch (e) {
    // best-effort: the agent must run fine without style examples
    return null;
  }
}

module.exports = { buildIndex, getStyleBlock };
