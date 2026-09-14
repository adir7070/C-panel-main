/**
 * Sanity-check the whoApp 5 AI agents from the DB side.
 *
 * Connects to the same Mongo iconiq-server uses, then reports on the
 * `aiinvocations` collection (Mongoose default pluralization for the
 * 'AiInvocation' model in
 *   public/whoAppAi/apps/server/src/models/ai-invocation.model.ts).
 *
 * Tells you:
 *   - total invocations (lifetime)
 *   - last 24h count
 *   - breakdown per agent (concierge / summarizer / router / status / guardian / scanner)
 *   - count of error rows in last 24h + top error messages
 *   - the most recent 5 rows (timestamp · agent · tokens · error?)
 *
 * Run:
 *   node scripts/check-whoapp-ai.js
 */
const fs   = require("fs");
const path = require("path");

(function loadEnv() {
  const envPath = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val   = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
})();

const { MongoClient } = require("mongodb");

async function check(uri, label) {
  if (!uri) { console.log(`[${label}] no URI — skipping`); return; }
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  try {
    await client.connect();
  } catch (err) {
    console.warn(`[${label}] connect failed: ${err.message}`);
    return;
  }
  const col = client.db().collection("aiinvocations");

  /* If the collection doesn't exist, listCollections() returns empty. */
  const hasCol = await client.db()
    .listCollections({ name: "aiinvocations" }).toArray();
  if (hasCol.length === 0) {
    console.log(`\n[${label}] ❌ collection "aiinvocations" does NOT exist.`);
    console.log(`         → the 5 AI agents have never been invoked successfully on this DB.`);
    console.log(`         → either /whoapp-api isn't mounted, or every Claude call throws BEFORE the audit write.`);
    await client.close();
    return;
  }

  const since24h = new Date(Date.now() - 24 * 3600 * 1000);
  const [
    total,
    last24h,
    byAgent,
    errorsRecent,
    topErrors,
    recent,
  ] = await Promise.all([
    col.countDocuments({}),
    col.countDocuments({ createdAt: { $gte: since24h } }),
    col.aggregate([
      { $group: { _id: "$agent", count: { $sum: 1 } } },
      { $sort:  { count: -1 } },
    ]).toArray(),
    col.countDocuments({ createdAt: { $gte: since24h }, error: { $exists: true, $ne: null, $ne: "" } }),
    col.aggregate([
      { $match: { error: { $exists: true, $ne: null, $ne: "" } } },
      { $group: { _id: "$error", count: { $sum: 1 }, lastAt: { $max: "$createdAt" } } },
      { $sort:  { count: -1 } },
      { $limit: 5 },
    ]).toArray(),
    col.find({}).sort({ createdAt: -1 }).limit(5).toArray(),
  ]);

  console.log(`\n══════════════════════ [${label}] ai_invocations ══════════════════════`);
  console.log(`total lifetime:         ${total}`);
  console.log(`last 24h:               ${last24h}`);
  console.log(`errors (last 24h):      ${errorsRecent}`);
  console.log("");
  console.log("by agent (lifetime):");
  if (byAgent.length === 0) {
    console.log("  (none)");
  } else {
    for (const a of byAgent) console.log(`  ${(a._id || "(null)").padEnd(12)} ${a.count}`);
  }

  if (topErrors.length > 0) {
    console.log("");
    console.log("top error messages (lifetime):");
    for (const e of topErrors) {
      const msg = String(e._id || "").slice(0, 120);
      console.log(`  [${e.count}× · last ${e.lastAt?.toISOString?.() || "?"}] ${msg}`);
    }
  } else {
    console.log("");
    console.log("top error messages (lifetime):  (none)");
  }

  console.log("");
  console.log("last 5 invocations:");
  for (const r of recent) {
    const ts    = r.createdAt?.toISOString?.() || "?";
    const tok   = `p=${r.promptTokens || 0} c=${r.completionTokens || 0}`;
    const err   = r.error ? `  ERROR: ${String(r.error).slice(0, 80)}` : "";
    console.log(`  ${ts}  ${(r.agent || "?").padEnd(11)}  ${tok}${err}`);
  }
  console.log("══════════════════════════════════════════════════════════════════════\n");

  await client.close();
}

(async () => {
  await check(process.env.AWS_MONGO_URI || process.env.MONGO_URI, "primary");
  /* Don't double-print if both env vars point at the same cluster. */
  if (process.env.AWS_MONGO_URI && process.env.MONGO_URI && process.env.AWS_MONGO_URI !== process.env.MONGO_URI) {
    await check(process.env.MONGO_URI, "atlas-fallback");
  }
})().catch(err => { console.error(err); process.exit(1); });
