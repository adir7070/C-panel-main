#!/usr/bin/env node
/**
 * clear-agent-thread.js — wipe a client's AI-manager chat thread (agent_chats).
 *
 * Deletes the thread doc(s) for a phone on BOTH databases (AWS primary + Atlas
 * fallback) — the app mirrors writes to both, so a clean slate must clear both.
 * Matches tolerant phone formats (0.../972.../+972...) so nothing is missed.
 *
 * Usage:
 *   node scripts/clear-agent-thread.js 0535291889 --dry-run   (report only)
 *   node scripts/clear-agent-thread.js 0535291889             (delete)
 *   node scripts/clear-agent-thread.js                        (defaults to 0535291889)
 */
require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const { MongoClient } = require("mongodb");

const PHONE = String(process.argv.find((a) => /^\+?\d/.test(a)) || "0535291889").trim();
const DRY_RUN = process.argv.includes("--dry-run");

// tolerant match: every common way this number could be stored
const digits = PHONE.replace(/\D/g, "");
const key = digits.replace(/^972/, "").replace(/^0/, ""); // e.g. "535291889"
const candidates = [...new Set([PHONE, digits, key, "0" + key, "972" + key, "+972" + key])];
const query = { phone: { $in: candidates } };

const TARGETS = [
  { name: "AWS primary", uri: process.env.AWS_MONGO_URI },
  { name: "Atlas fallback", uri: process.env.MONGO_URI },
].filter((t) => t.uri);

async function clearOn({ name, uri }) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 6000, connectTimeoutMS: 6000 });
  try {
    await client.connect();
    const col = client.db().collection("agent_chats");
    const docs = await col.find(query, { projection: { phone: 1, messages: 1, handling: 1, needsHuman: 1 } }).toArray();
    if (!docs.length) { console.log(`[${name}] no thread matches ${candidates.join("/")} — nothing to do.`); return; }
    for (const d of docs) {
      console.log(`[${name}] match phone="${d.phone}": ${(d.messages || []).length} messages, handling=${d.handling || "ai"}, needsHuman=${!!d.needsHuman}`);
    }
    if (DRY_RUN) { console.log(`[${name}] DRY-RUN — would delete ${docs.length} thread doc(s).`); return; }
    const res = await col.deleteMany(query);
    console.log(`[${name}] ✅ deleted ${res.deletedCount} thread doc(s).`);
  } catch (e) {
    console.error(`[${name}] ⚠️  FAILED: ${e.message}`);
  } finally {
    await client.close().catch(() => {});
  }
}

(async () => {
  console.log(`Target: ${PHONE} | candidates: ${candidates.join(", ")} | mode: ${DRY_RUN ? "DRY-RUN" : "DELETE"} | DBs: ${TARGETS.map((t) => t.name).join(", ") || "none"}`);
  if (!TARGETS.length) { console.error("No MONGO URIs in .env — aborting."); process.exit(1); }
  for (const t of TARGETS) await clearOn(t);
  console.log("Done.");
  process.exit(0);
})();
