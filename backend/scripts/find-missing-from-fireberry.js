/**
 * find-missing-from-fireberry.js
 *
 * Finds all MongoDB users (collection: users) who ever logged into the app
 * but do NOT have a matching record in Fireberry (objecttype=1, field: telephone1).
 *
 * Matching logic: normalise both sides to 9-digit core (5XXXXXXXX).
 * Also checks telephone2 / telephone3 as fallback.
 *
 * Output: missing-from-fireberry.csv on the Desktop
 *
 * Run:  node scripts/find-missing-from-fireberry.js
 *       node scripts/find-missing-from-fireberry.js --out=/path/to/file.csv
 *       node scripts/find-missing-from-fireberry.js --collection=cpanel_clients
 */

const fs   = require("fs");
const path = require("path");

// ─── load .env ───────────────────────────────────────────────────────────────
(function loadEnv() {
  const p = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(p)) return;
  for (const raw of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    )
      v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
})();

const { MongoClient } = require("mongodb");
const axios = require("axios");

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Normalise to 9-digit core (5XXXXXXXX). Returns null for unrecognised formats. */
function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (digits.startsWith("972") && digits.length === 12) return digits.slice(3); // 972501234567
  if (digits.startsWith("0")   && digits.length === 10) return digits.slice(1); // 0501234567
  if (digits.length === 9 && digits.startsWith("5"))    return digits;           // 501234567
  // non-standard but not empty – keep raw digits for comparison
  return digits.length >= 7 ? digits : null;
}

function arg(name, def) {
  const m = process.argv.find((a) => a.startsWith(`--${name}=`));
  return m ? m.slice(name.length + 3) : def;
}

function escapeCsv(val) {
  if (val == null) return "";
  return `"${String(val).replace(/"/g, '""')}"`;
}

// ─── Fireberry: check only the given phones (batch OR queries) ───────────────

/**
 * Given a list of raw phones, returns a Set of normalised phones that EXIST in Fireberry.
 * Batches ~25 phones per request → only N/25 API calls instead of all pages.
 */
async function checkPhonesInFireberry(rawPhones) {
  const token = process.env.FIREBERRY_TOKEN;
  if (!token) throw new Error("FIREBERRY_TOKEN not set in .env");

  const found = new Set();
  const BATCH = 25;

  for (let i = 0; i < rawPhones.length; i += BATCH) {
    const batch = rawPhones.slice(i, i + BATCH);
    const batchNum = Math.floor(i / BATCH) + 1;
    const totalBatches = Math.ceil(rawPhones.length / BATCH);
    process.stdout.write(`[Fireberry] batch ${batchNum}/${totalBatches}...`);

    // Build OR query: for each phone × 3 variants × telephone1/telephone2/telephone3
    const clauses = [];
    for (const raw of batch) {
      const digits = String(raw).replace(/\D/g, "");
      let core = null;
      if (digits.startsWith("972") && digits.length === 12) core = digits.slice(3);
      else if (digits.startsWith("0") && digits.length === 10) core = digits.slice(1);
      else if (digits.length === 9 && digits.startsWith("5")) core = digits;

      const variants = new Set([digits]);
      if (core) {
        variants.add("972" + core);
        variants.add("0" + core);
        variants.add(core);
        variants.add("+972" + core);
      }

      for (const v of variants) {
        for (const field of ["telephone1", "telephone2", "telephone3"]) {
          clauses.push(`(${field} = ${v})`);
        }
      }
    }

    const res = await axios.post(
      "https://api.powerlink.co.il/api/query",
      {
        objecttype: 1,
        page_size: BATCH * 10,
        page_number: 1,
        fields: "telephone1,telephone2,telephone3",
        query: clauses.join(" OR "),
      },
      {
        headers: { tokenid: token, "Content-Type": "application/json" },
        timeout: 20000,
      },
    );

    const records = res.data?.data?.Data || [];
    for (const r of records) {
      for (const field of ["telephone1", "telephone2", "telephone3"]) {
        const n = normalizePhone(r[field]);
        if (n) found.add(n);
      }
    }

    process.stdout.write(` ${records.length} matched\n`);
    if (i + BATCH < rawPhones.length) {
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  return found;
}

// ─── main ────────────────────────────────────────────────────────────────────

(async () => {
  const collection = arg("collection", "users");
  const daysBack   = parseInt(arg("days", "7"), 10);
  const outPath    = arg(
    "out",
    path.join(
      process.env.HOME || process.env.USERPROFILE || ".",
      "Desktop",
      "missing-from-fireberry.csv",
    ),
  );

  const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
  console.log(`[Filter] users registered OR active since ${since.toISOString()} (last ${daysBack} days)`);

  // 1. MongoDB
  const uri = process.env.AWS_MONGO_URI || process.env.MONGO_URI;
  if (!uri) { console.error("[ERROR] No MONGO_URI in .env"); process.exit(1); }

  const mongo = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
  await mongo.connect();
  const db = mongo.db();
  console.log(`[Mongo] Connected · db=${db.databaseName}`);

  // _id embeds the creation timestamp — use it as "registeredAt"
  // Also include users active (lastSeenAt) in the period
  const { ObjectId } = require("mongodb");
  const sinceObjectId = ObjectId.createFromTime(Math.floor(since.getTime() / 1000));

  const mongoUsers = await db
    .collection(collection)
    .find(
      {
        phone: { $exists: true, $ne: null, $ne: "" },
        $or: [
          { _id: { $gte: sinceObjectId } },          // registered in period
          { lastSeenAt: { $gte: since } },            // OR active in period
        ],
      },
      { projection: { phone: 1, name: 1, customerName: 1, lastSeenAt: 1 } },
    )
    .toArray();
  console.log(`[Mongo] ${mongoUsers.length} documents in '${collection}' matching the date filter`);
  await mongo.close();

  // 2. Fireberry — check only the phones we found in Mongo
  const rawPhones = mongoUsers.map((u) => u.phone).filter(Boolean);
  console.log(`[Fireberry] Checking ${rawPhones.length} phones against Fireberry (objecttype=1)…`);
  const foundInFireberry = await checkPhonesInFireberry(rawPhones);
  console.log(`[Fireberry] Done — ${foundInFireberry.size} of ${rawPhones.length} phones found`);

  // 3. Compare
  const missing = [];
  const noPhone = [];

  for (const u of mongoUsers) {
    const norm = normalizePhone(u.phone);
    if (!norm) { noPhone.push(u); continue; }
    if (!foundInFireberry.has(norm)) {
      missing.push(u);
    }
  }

  console.log(`\n[Result]`);
  console.log(`  MongoDB users in period        : ${mongoUsers.length}`);
  console.log(`  Skipped (unparseable phone)    : ${noPhone.length}`);
  console.log(`  NOT found in Fireberry         : ${missing.length}`);

  // 4. CSV
  const header = ["phone", "name", "registeredAt", "lastSeenAt"].join(",");
  const rows = missing.map((u) => {
    const name        = u.name || u.customerName || "";
    const registeredAt = u._id.getTimestamp().toISOString();
    const lastSeenAt   = u.lastSeenAt ? new Date(u.lastSeenAt).toISOString() : "";
    return [
      escapeCsv(u.phone),
      escapeCsv(name),
      escapeCsv(registeredAt),
      escapeCsv(lastSeenAt),
    ].join(",");
  });

  const csvContent = [header, ...rows].join("\n");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, csvContent, "utf8");

  const kb = Math.round(fs.statSync(outPath).size / 1024);
  console.log(`\n[Export] ✅  ${missing.length} rows → ${outPath} (${kb} KB)`);
})().catch((err) => {
  console.error("[FATAL]", err.message || err);
  process.exit(1);
});
