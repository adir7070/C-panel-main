/**
 * Quick collection census for the whoApp embedded sub-app. Tells us
 * whether the API is being exercised at all (conversations / messages
 * / tasks growing) vs the dashboard rendering static UI on top of an
 * idle backend.
 */
const fs = require("fs"), path = require("path");
(function loadEnv() {
  const p = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(p)) return;
  for (const raw of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("="); if (eq < 0) continue;
    const k = line.slice(0, eq).trim(); let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
})();
const { MongoClient } = require("mongodb");
(async () => {
  const uri = process.env.AWS_MONGO_URI || process.env.MONGO_URI;
  const c = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  await c.connect();
  /* WhoApp pins itself to db "whoapp_ai" on the same cluster — see
     public/whoAppAi/apps/server/src/config/db.ts. iconiq-server uses
     the default DB from the URI. So we MUST query whoapp_ai here. */
  const db = c.db("whoapp_ai");
  const want = [
    "aiinvocations",
    "conversations", "messages", "tasks", "customers", "customerprofiles",
    "departments", "agentreflections", "agentlessons", "scans",
    "admintickets",
  ];
  for (const name of want) {
    const exists = (await db.listCollections({ name }).toArray()).length > 0;
    if (!exists) { console.log(`  ${name.padEnd(20)}  (no collection)`); continue; }
    const total  = await db.collection(name).countDocuments({});
    const since  = new Date(Date.now() - 24 * 3600 * 1000);
    const last24 = await db.collection(name).countDocuments({ createdAt: { $gte: since } });
    const recent = await db.collection(name).find({}).sort({ _id: -1 }).limit(1).toArray();
    const lastAt = recent[0]?.createdAt?.toISOString?.() || recent[0]?._id?.getTimestamp?.()?.toISOString?.() || "?";
    console.log(`  ${name.padEnd(20)}  total=${String(total).padStart(6)}  last24h=${String(last24).padStart(4)}  newest=${lastAt}`);
  }
  await c.close();
})().catch(e => { console.error(e.message); process.exit(1); });
