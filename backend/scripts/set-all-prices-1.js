/**
 * One-shot: set every product price to 1 ILS in cpanel_products.
 * Updates BOTH AWS (primary) and Atlas (fallback) to keep them in sync.
 *
 * Run:  DRY=1 node scripts/set-all-prices-1.js   (prints, no write)
 * Run:  node scripts/set-all-prices-1.js          (writes)
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

const DRY = !!process.env.DRY;

const ITEM_KEYS    = ["ad", "lp", "video", "logo", "social_ad"];
const PACKAGE_KEYS = ["platinum", "premium", "basic", "platinum_coins", "premium_coins", "basic_coins"];

async function updatePrices(uri, label) {
  if (!uri) { console.log(`[${label}] no URI — skipping`); return; }
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000, connectTimeoutMS: 8000 });
  try {
    await client.connect();
  } catch (err) {
    console.warn(`[${label}] connection failed: ${err.message} — skipping`);
    return;
  }
  const col = client.db().collection("cpanel_products");
  const now = new Date();

  if (DRY) {
    const docs = await col.find({ key: { $in: [...ITEM_KEYS, ...PACKAGE_KEYS] } }).toArray();
    for (const doc of docs) {
      const field = doc.kind === "item" ? "unitPrice" : "price";
      console.log(`[DRY][${label}] ${doc.key} (${doc.kind}): ${field} ${doc[field]} → 1`);
    }
    await client.close();
    return;
  }

  const itemRes = await col.updateMany(
    { key: { $in: ITEM_KEYS } },
    { $set: { unitPrice: 1, updatedAt: now } }
  );
  const pkgRes = await col.updateMany(
    { key: { $in: PACKAGE_KEYS } },
    { $set: { price: 1, updatedAt: now } }
  );
  console.log(`[${label}] Items: ${itemRes.modifiedCount}/5 | Packages: ${pkgRes.modifiedCount}/6`);
  await client.close();
}

(async () => {
  await updatePrices(process.env.AWS_MONGO_URI, "AWS");
  await updatePrices(process.env.MONGO_URI,     "Atlas");
  if (!DRY) console.log("Done — both databases updated.");
})().catch(err => {
  console.error(err);
  process.exit(1);
});
