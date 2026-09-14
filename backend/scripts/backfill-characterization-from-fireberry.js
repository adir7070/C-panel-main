/**
 * backfill-characterization-from-fireberry.js
 *
 * Old clients filled their "אפיון" (characterization) in Fireberry, before the
 * app's own characterization screen existed. This backfills business_profiles
 * for every app user whose characterization is incomplete, pulling the
 * missing pieces from Fireberry (customer object, objecttype=1) by phone.
 *
 * The 5 fields checked (per business_profiles doc):
 *   businessName        ← Fireberry pcfsystemfield1475  (שם העסק)
 *   address              ← Fireberry pcfsystemfield1448  (כתובת)
 *   email                ← Fireberry emailaddress1        (כתובת מייל)
 *   about                ← Fireberry pcfsystemfield1491  (אודות)
 *   services[0].description ← Fireberry pcfsystemfield1495 (תיאור שירות)
 *
 * Rule: if all 5 are already filled → skip entirely (no Fireberry call).
 * Otherwise, fetch from Fireberry and fill ONLY the missing fields —
 * existing values are never overwritten.
 *
 * Matching: users.phone → Fireberry telephone1 (via getCharacterizationByPhone,
 * which also handles phone-format variants and the objecttype 1013 fallback).
 *
 * Run:
 *   node scripts/backfill-characterization-from-fireberry.js              (dry-run, writes a CSV report)
 *   node scripts/backfill-characterization-from-fireberry.js --apply      (writes to Mongo)
 *   node scripts/backfill-characterization-from-fireberry.js --apply --out=/path/report.csv
 *   node scripts/backfill-characterization-from-fireberry.js --limit=50   (test on first 50 users)
 */

const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

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
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
})();

const { MongoClient } = require("mongodb");
const { getCharacterizationByPhone } = require("../services/fireberry-customers.service");

function arg(name, def) {
  const m = process.argv.find((a) => a.startsWith(`--${name}=`));
  return m ? m.slice(name.length + 3) : def;
}
const APPLY = process.argv.includes("--apply");
const LIMIT = parseInt(arg("limit", "0"), 10) || 0;
const OUT_PATH = arg(
  "out",
  path.join(process.env.HOME || process.env.USERPROFILE || ".", "Desktop", "characterization-backfill.csv"),
);

function escapeCsv(val) {
  if (val == null) return "";
  return `"${String(val).replace(/"/g, '""')}"`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Fireberry throttles aggressively — retry 429s with exponential backoff
// instead of burning the whole run on "Too Many Requests."
async function getCharacterizationWithRetry(phone, maxRetries = 5) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await getCharacterizationByPhone(phone);
    } catch (err) {
      const isRateLimit = err.response?.status === 429 || /Too Many Requests/i.test(err.message || "");
      if (!isRateLimit || attempt === maxRetries) throw err;
      const backoff = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s, 8s, 16s
      console.warn(`[RateLimit] phone=${phone} attempt=${attempt + 1}/${maxRetries} — backing off ${backoff}ms`);
      await sleep(backoff);
    }
  }
}

function hasServiceDescription(profile) {
  return Array.isArray(profile?.services) && profile.services.some((s) => s?.description && String(s.description).trim());
}

function missingFields(profile) {
  const missing = [];
  if (!profile?.businessName || !String(profile.businessName).trim()) missing.push("businessName");
  if (!profile?.address || !String(profile.address).trim()) missing.push("address");
  if (!profile?.email || !String(profile.email).trim()) missing.push("email");
  if (!profile?.about || !String(profile.about).trim()) missing.push("about");
  if (!hasServiceDescription(profile)) missing.push("serviceDescription");
  return missing;
}

// Build a Mongo update ($set/$push) that fills only the given missing fields
// from a Fireberry characterization record. Returns null if there's nothing
// Fireberry can actually supply for the gaps.
function buildPatch(missing, record, existingProfile) {
  const set = {};
  let push = null;

  if (missing.includes("businessName") && record.pcfsystemfield1475) {
    set.businessName = record.pcfsystemfield1475;
  }
  if (missing.includes("address") && record.pcfsystemfield1448) {
    set.address = record.pcfsystemfield1448;
  }
  if (missing.includes("email") && record.emailaddress1) {
    set.email = record.emailaddress1;
  }
  if (missing.includes("about") && record.pcfsystemfield1491) {
    set.about = record.pcfsystemfield1491;
  }
  if (missing.includes("serviceDescription") && record.pcfsystemfield1495) {
    const services = Array.isArray(existingProfile?.services) ? existingProfile.services : [];
    if (services.length > 0) {
      // First service exists but has no description (that's why it's "missing") — fill it in place.
      set["services.0.description"] = record.pcfsystemfield1495;
    } else {
      push = { services: { id: randomUUID(), title: "", description: record.pcfsystemfield1495, images: [], imageUrl: "" } };
    }
  }

  if (Object.keys(set).length === 0 && !push) return null;
  const update = {};
  if (Object.keys(set).length > 0) update.$set = { ...set, updatedAt: new Date() };
  if (push) update.$push = push;
  if (!update.$set) update.$set = { updatedAt: new Date() };
  return update;
}

(async () => {
  const uri = process.env.AWS_MONGO_URI || process.env.MONGO_URI;
  if (!uri) { console.error("[ERROR] No AWS_MONGO_URI/MONGO_URI in .env"); process.exit(1); }

  console.log(`[Mode] ${APPLY ? "APPLY (writing to Mongo)" : "DRY-RUN (CSV report only, no writes)"}`);

  const mongo = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
  await mongo.connect();
  const db = mongo.db();
  console.log(`[Mongo] Connected · db=${db.databaseName}`);

  let usersQuery = db
    .collection("users")
    .find({ phone: { $exists: true, $ne: null, $ne: "" } }, { projection: { phone: 1, name: 1, customerName: 1 } });
  if (LIMIT) usersQuery = usersQuery.limit(LIMIT);
  const users = await usersQuery.toArray();
  console.log(`[Mongo] ${users.length} users with a phone number`);

  const profilesCol = db.collection("business_profiles");

  const rows = [];
  let complete = 0, updated = 0, wouldUpdate = 0, notFoundInFireberry = 0, noPatchPossible = 0, errors = 0;

  for (let i = 0; i < users.length; i++) {
    const u = users[i];
    const phone = u.phone;

    const profile = await profilesCol.findOne({ phone });
    const missing = missingFields(profile);

    if (missing.length === 0) {
      complete++;
      continue;
    }

    let record;
    try {
      record = await getCharacterizationWithRetry(phone);
    } catch (err) {
      errors++;
      console.error(`[Error] phone=${phone}: ${err.message}`);
      await sleep(300); // fixed pacing between Fireberry calls, even on failure
      continue;
    }
    await sleep(300); // fixed pacing between Fireberry calls

    if (!record) {
      notFoundInFireberry++;
      continue;
    }

    const patch = buildPatch(missing, record, profile);
    if (!patch) {
      noPatchPossible++;
      continue;
    }

    const name = u.name || u.customerName || "";
    rows.push({
      phone,
      name,
      missing: missing.join("|"),
      willSet: JSON.stringify(patch.$set || {}),
      willPush: patch.$push ? JSON.stringify(patch.$push) : "",
    });

    if (APPLY) {
      await profilesCol.updateOne({ phone }, patch, { upsert: true });
      updated++;
    } else {
      wouldUpdate++;
    }

    if ((i + 1) % 50 === 0) {
      console.log(`[Progress] ${i + 1}/${users.length} processed`);
    }
  }

  await mongo.close();

  console.log(`\n[Result]`);
  console.log(`  Users checked                    : ${users.length}`);
  console.log(`  Already complete (skipped)       : ${complete}`);
  console.log(`  Not found in Fireberry           : ${notFoundInFireberry}`);
  console.log(`  Found but no usable data for gaps: ${noPatchPossible}`);
  console.log(`  Errors                           : ${errors}`);
  console.log(`  ${APPLY ? "Updated in Mongo" : "Would be updated (dry-run)"}      : ${APPLY ? updated : wouldUpdate}`);

  const header = ["phone", "name", "missingFields", "willSet", "willPush"].join(",");
  const csvRows = rows.map((r) => [escapeCsv(r.phone), escapeCsv(r.name), escapeCsv(r.missing), escapeCsv(r.willSet), escapeCsv(r.willPush)].join(","));
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, [header, ...csvRows].join("\n"), "utf8");
  console.log(`\n[Export] ✅ ${rows.length} rows → ${OUT_PATH}`);

  if (!APPLY) {
    console.log(`\n[Next step] Review the CSV, then run again with --apply to write these changes to Mongo.`);
  }
})().catch((err) => {
  console.error("[FATAL]", err.message || err);
  process.exit(1);
});
