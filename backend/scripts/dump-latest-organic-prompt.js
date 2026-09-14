/**
 * One-shot diagnostic: fetch the most recent wow_organic_ads_sessions doc
 * and print, for each post, the post_type + headline/body/cta + the FULL
 * nanoPrompt that was sent to Gemini. Lets us verify whether
 *   - the design-architecture directive made it into the prompt
 *   - the Hebrew pixel-perfect block made it into the prompt
 *   - the exact Hebrew title/body/cta strings made it into the prompt
 *
 * Usage:
 *   node scripts/dump-latest-organic-prompt.js
 *   node scripts/dump-latest-organic-prompt.js --phone=0526706503
 *   node scripts/dump-latest-organic-prompt.js --session=<sessionId>
 *
 * Reads MONGO_URI / AWS_MONGO_URI from .env in repo root (same loader
 * scripts/set-all-prices-1.js uses, copy-pasted here so this script
 * has zero extra deps).
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

function arg(name) {
  const m = process.argv.find(a => a.startsWith(`--${name}=`));
  return m ? m.slice(name.length + 3) : null;
}

async function dump(uri, label) {
  if (!uri) { console.log(`[${label}] no URI — skipping`); return null; }
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  try {
    await client.connect();
  } catch (err) {
    console.warn(`[${label}] connect failed: ${err.message}`);
    return null;
  }
  const col = client.db().collection("wow_organic_ads_sessions");

  const filter = {};
  const session = arg("session");
  const phone   = arg("phone");
  if (session) filter.sessionId = session;
  if (phone)   filter.phone     = phone;

  const doc = await col.findOne(filter, { sort: { createdAt: -1 } });
  await client.close();
  return doc;
}

(async () => {
  /* Try AWS first (primary in prod), fall back to Atlas. */
  let doc = await dump(process.env.AWS_MONGO_URI, "AWS");
  if (!doc) doc = await dump(process.env.MONGO_URI, "Atlas");
  if (!doc) {
    console.log("No session matched. Try --phone=<phone> or --session=<sessionId>.");
    process.exit(0);
  }

  console.log("\n══════════════════════════════════════════════════════════════════");
  console.log("session:       ", doc.sessionId);
  console.log("phone:         ", doc.phone);
  console.log("createdAt:     ", doc.createdAt);
  console.log("status:        ", doc.status);
  console.log("posts found:   ", (doc.generatedPosts || []).length);
  console.log("══════════════════════════════════════════════════════════════════\n");

  for (const post of (doc.generatedPosts || [])) {
    console.log("───────────────────────────────────────────────────────────────");
    console.log(`POST ${post.id}  ·  type=${post.type || "(none)"}`);
    console.log("  headline:    ", JSON.stringify(post.headline || ""));
    console.log("  description: ", JSON.stringify(post.description || ""));
    console.log("  cta:         ", JSON.stringify(post.cta || ""));
    console.log("  imageUrl:    ", post.imageUrl || "(no image yet)");
    console.log("");
    console.log("─── nanoPrompt sent to Gemini ───");
    console.log(post.nanoPrompt || "(none)");
    console.log("");

    /* Quick sanity checklist on the prompt. */
    const p = String(post.nanoPrompt || "");
    const checks = {
      "design architecture (LAYOUT …)":      /\bLAYOUT\b/.test(p),
      "Hebrew pixel-perfect block":          p.includes("PIXEL-PERFECT") || p.includes("IMAGE MUST DISPLAY THIS HEBREW"),
      "exact headline quoted":               post.headline ? p.includes(post.headline) : null,
      "exact body quoted":                   post.description ? p.includes(post.description) : null,
      "exact cta quoted":                    post.cta ? p.includes(post.cta) : null,
      'no "NO TEXT in the image" rule':      !/NO TEXT in the image/i.test(p),
    };
    console.log("─── checks ───");
    for (const [k, v] of Object.entries(checks)) {
      const flag = v === null ? "—" : v ? "✓" : "✗";
      console.log(`  ${flag}  ${k}`);
    }
    console.log("");
  }
})().catch(err => { console.error(err); process.exit(1); });
