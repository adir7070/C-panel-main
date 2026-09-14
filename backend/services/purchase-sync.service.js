/* Shared bookkeeping for a verified Cardcom payment, so every charge path the
   C-panel offers — the catalog "חייב" button, the contract SMS link and its
   coin add-on — lands on the same screens: users (Products tab, package
   columns), the panel revenue ledger cpanel_pending_purchases (dashboard,
   "הוצאה"/"עסקאות", טופ מנהלים) and the lead board.

   Crash-safe order for callers:
     1. lockPayment()      — lock row BEFORE any credit
     2. creditUserOnce()   — conditional on the payment id, safe to repeat
     3. other idempotent writes, recordRevenue(), markLeadsActive()
     4. markPaymentDone()  — true for exactly one caller: send receipts and
                             notifications only then
   An attempt that dies anywhere in 2–3 leaves a "crediting" row that the
   next webhook retry / panel check resumes without crediting twice. */

const TRANS_COL    = "package_transactions";
const PANEL_LEDGER = "cpanel_pending_purchases";
/* C-panel lead statuses (C-panel server/leads.js) that a payment promotes. */
const LEAD_STATUSES_BEFORE_PAID = ["new", "call_again", "not_relevant", "in_process", "to_charge"];

/* "none" | "crediting" | "done". Rows written before the lock existed have no
   status and were fully applied, so they count as done. */
async function paymentState(db, lowProfileId) {
  const row = await db.collection(TRANS_COL).findOne({ lowProfileId }, { projection: { status: 1 } });
  if (!row) return "none";
  return row.status === "crediting" ? "crediting" : "done";
}

/* "new" (first attempt) | "resume" (an earlier attempt died mid-way) | "done". */
async function lockPayment(db, lowProfileId, row) {
  try {
    await db.collection(TRANS_COL).insertOne({ ...row, lowProfileId, status: "crediting", createdAt: new Date() });
    // without the unique index (e.g. it failed to build) a concurrent attempt
    // may have inserted too — both then proceed as resumes, which is safe
    const rows = await db.collection(TRANS_COL).countDocuments({ lowProfileId }, { limit: 2 });
    return rows > 1 ? "resume" : "new";
  } catch (err) {
    if (err?.code !== 11000) throw err;
    return (await paymentState(db, lowProfileId)) === "crediting" ? "resume" : "done";
  }
}

async function markPaymentDone(db, lowProfileId) {
  // updateMany: with duplicate lock rows only the first caller flips any
  const r = await db.collection(TRANS_COL).updateMany(
    { lowProfileId, status: "crediting" },
    { $set: { status: "done", doneAt: new Date() } },
  );
  return r.modifiedCount > 0;
}

/* Clients created from a lead have no users doc — create a minimal one so
   the credit has somewhere to land. */
async function ensureUserDoc(db, phone) {
  const client = await db.collection("cpanel_clients").findOne({ phone }, { projection: { customerName: 1 } });
  try {
    await db.collection("users").updateOne(
      { phone },
      { $setOnInsert: { name: client?.customerName || phone, createdAt: new Date() } },
      { upsert: true },
    );
  } catch (err) {
    if (err?.code !== 11000) throw err; // a concurrent upsert created it
  }
}

/* Applies `update` to the client's users doc once per payment id. */
async function creditUserOnce(db, phone, lowProfileId, update) {
  await ensureUserDoc(db, phone);
  const r = await db.collection("users").updateOne(
    { phone, creditedPayments: { $ne: lowProfileId } },
    { ...update, $push: { ...(update.$push || {}), creditedPayments: lowProfileId } },
  );
  return r.modifiedCount === 1;
}

/* Marks the payment as revenue in the panel ledger and stamps the owning
   manager. Catalog charges already have a ledger row (written when the
   Cardcom page was created) — pass no `fields`. Contract payments don't —
   pass `fields` to create it. */
async function recordRevenue(db, { lowProfileId, phone, fields = null }) {
  const now = new Date();
  const client = await db.collection("cpanel_clients").findOne({ phone }, { projection: { agentId: 1 } });
  const owner = client?.agentId ? { agentId: String(client.agentId) } : null;
  if (fields) {
    try {
      await db.collection(PANEL_LEDGER).updateOne(
        { lowProfileId },
        { $setOnInsert: { phone, createdAt: now, ...fields }, ...(owner ? { $set: owner } : {}) },
        { upsert: true },
      );
    } catch (err) {
      if (err?.code !== 11000) throw err; // a concurrent upsert created the row
      if (owner) await db.collection(PANEL_LEDGER).updateOne({ lowProfileId }, { $set: owner });
    }
  } else if (owner) {
    await db.collection(PANEL_LEDGER).updateOne({ lowProfileId }, { $set: owner });
  }
  await db.collection(PANEL_LEDGER).updateOne(
    { lowProfileId, completedAt: { $exists: false } },
    { $set: { completedAt: now }, $unset: { finalizingAt: "" } },
  );
}

/* A paying client is an active client — move the lead they came from to
   "לקוח פעיל". Only C-panel leads carry statusHistory, which keeps the old
   Facebook lead docs (same collection name) out of this. */
async function markLeadsActive(db, phone) {
  const now = new Date();
  const leads = await db.collection("leads").find(
    { $or: [{ phone }, { clientPhone: phone }], status: { $in: LEAD_STATUSES_BEFORE_PAID }, statusHistory: { $exists: true } },
    { projection: { status: 1, name: 1, phone: 1 } },
  ).toArray();
  for (const lead of leads) {
    const r = await db.collection("leads").updateOne(
      { _id: lead._id, status: lead.status },
      {
        $set:  { status: "active_client", activatedAt: now, updatedAt: now },
        $push: { statusHistory: { from: lead.status, to: "active_client", by: null, byName: "סליקה", at: now } },
      },
    );
    if (r.modifiedCount === 1) {
      await require("./client-notify.service").notify.welcome(lead.phone || phone, { name: lead.name });
    }
  }
}

async function ensurePaymentIndexes(db) {
  await db.collection(TRANS_COL).createIndex(
    { lowProfileId: 1 },
    { unique: true, partialFilterExpression: { lowProfileId: { $type: "string" } }, name: "lowProfileId_unique_str" },
  );
  const ledger = db.collection(PANEL_LEDGER);
  await ledger.createIndex({ phone: 1, personalPackageId: 1, createdAt: -1 });
  /* One ledger row per payment so concurrent recordRevenue upserts can't
     double the revenue. Replaces the plain index an earlier build created. */
  const existing = await ledger.indexes().catch(() => []);
  if (existing.some(i => i.name === "lowProfileId_1" && !i.unique)) await ledger.dropIndex("lowProfileId_1");
  await ledger.createIndex(
    { lowProfileId: 1 },
    { unique: true, partialFilterExpression: { lowProfileId: { $type: "string" } }, name: "lowProfileId_unique_str" },
  );
}

module.exports = {
  paymentState, lockPayment, markPaymentDone,
  ensureUserDoc, creditUserOnce, recordRevenue, markLeadsActive,
  ensurePaymentIndexes,
};
