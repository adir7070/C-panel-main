/**
 * One-shot (2026-11-24): the sales team.
 *
 *   • gali    — role "sales" (מכירות), nickname גלי
 *   • netanel — role "admin", nickname נתנאל, maxDiscountPct 100 (no cap)
 *   • every incoming lead is auto-assigned to gali
 *     (admin_settings.leadsAutoAssignTo), and every lead that is unassigned
 *     right now is handed to her
 *
 * Idempotent: an existing user keeps its password unless one is passed, and
 * gets its role / nickname / cap set again. The existing "admin" user is
 * not touched.
 *
 * Passwords come from the environment so they never land in git:
 *   MONGO_URI=… GALI_PASSWORD=… NETANEL_PASSWORD=… node backend/scripts/setup-sales-team.js            (dry run)
 *   MONGO_URI=… GALI_PASSWORD=… NETANEL_PASSWORD=… node backend/scripts/setup-sales-team.js --apply    (writes)
 */
const crypto = require("crypto");
const { MongoClient } = require("mongodb");
const { v4: uuidv4 } = require("uuid");

const APPLY = process.argv.includes("--apply");

/* Same hash as the panel login (controllers/agents.controller.js). */
const hashPass = pw => crypto.createHash("sha256").update(pw + "iconiq2024").digest("hex");

const USERS = [
  { name: "gali", nickname: "גלי", role: "sales", maxDiscountPct: null, passwordEnv: "GALI_PASSWORD" },
  { name: "netanel", nickname: "נתנאל", role: "admin", maxDiscountPct: 100, passwordEnv: "NETANEL_PASSWORD" },
];
const AUTO_ASSIGN_TO = "gali";

async function upsertUser(col, u) {
  const password = process.env[u.passwordEnv] || "";
  if (password && password.length < 6) throw new Error(`${u.passwordEnv} must be at least 6 characters`);
  const existing = await col.findOne({ name: u.name });
  if (!existing && !password) throw new Error(`${u.name} does not exist yet — set ${u.passwordEnv}`);

  const $set = { nickname: u.nickname, role: u.role, active: true, updatedAt: new Date() };
  if (password) $set.password = hashPass(password);
  const update = { $set };
  if (typeof u.maxDiscountPct === "number") $set.maxDiscountPct = u.maxDiscountPct;
  else update.$unset = { maxDiscountPct: "" };

  console.log(`${existing ? "update" : "create"} ${u.name} → role ${u.role}, nickname ${u.nickname}, `
    + `discount cap ${u.maxDiscountPct ?? "default (10%)"}${password ? ", password set" : ", password unchanged"}`);
  if (!APPLY) return existing?._id ?? "(new id)";

  if (existing) {
    await col.updateOne({ _id: existing._id }, update);
    return existing._id;
  }
  const _id = uuidv4();
  await col.insertOne({ _id, name: u.name, station: null, phone: null, email: null, createdAt: new Date(), createdBy: "setup-sales-team", ...$set });
  return _id;
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set");
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  try {
    const db = client.db(); // database name comes from the URI path
    console.log(`database: ${db.databaseName}${APPLY ? "" : "  (dry run — pass --apply to write)"}`);
    const agents = db.collection("agents");

    const ids = {};
    for (const u of USERS) ids[u.name] = await upsertUser(agents, u);

    const galiId = String(ids[AUTO_ASSIGN_TO]);
    const unassigned = await db.collection("leads").countDocuments({ assignedTo: null });
    console.log(`auto-assign new leads → ${AUTO_ASSIGN_TO} (${galiId})`);
    console.log(`unassigned leads to hand to ${AUTO_ASSIGN_TO}: ${unassigned}`);
    if (!APPLY) return;

    await db.collection("admin_settings").updateOne(
      {},
      { $set: { leadsAutoAssignTo: galiId, leadsAutoAssignUpdatedAt: new Date(), leadsAutoAssignUpdatedBy: "setup-sales-team" } },
      { upsert: true },
    );
    const nickname = USERS.find(u => u.name === AUTO_ASSIGN_TO).nickname;
    const r = await db.collection("leads").updateMany(
      { assignedTo: null },
      { $set: { assignedTo: galiId, assignedToName: nickname, updatedAt: new Date() } },
    );
    console.log(`assigned ${r.modifiedCount} leads`);
  } finally {
    await client.close();
  }
}

main().then(() => console.log("done")).catch(err => { console.error(err.message); process.exit(1); });
