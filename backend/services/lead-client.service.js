/* Lead → client: the one place that turns a C-panel lead (the `leads`
   collection, managed by ../../server/leads.js) into a client. It does the
   same writes the backend's own Fireberry-free client creation does
   (cpanel_clients mapping + support_chats owner), plus a business_profiles
   seed so the איפיון tab opens pre-filled. After that the lead shows up in
   "כל הלקוחות" and opens as a client.

   Two callers:
     • server/leads.js — the lead moves to בתהליך / לסלוק / לקוח פעיל.
     • purchase-sync.ensureUserDoc — a lead is charged straight from the
       personal catalog on its lead screen before anyone moved it. This runs
       before the credit and the revenue row, so both find their owner.

   Idempotent: running it again only refreshes the owner. */

const { ObjectId } = require("mongodb");

/* Only the panel's leads carry statusHistory. The old Facebook lead docs
   live in the same collection name and must never become clients here. */
const PANEL_LEAD = { statusHistory: { $exists: true } };

function agentIdQuery(id) {
  const s = String(id ?? "");
  const or = [{ _id: s }];
  if (ObjectId.isValid(s)) or.push({ _id: new ObjectId(s) });
  return { $or: or };
}

/* owner: { id, name } — the manager the client belongs to (null = no owner). */
async function syncLeadToClient(db, lead, owner) {
  if (!lead?.phone) return { skipped: "no_phone" };
  const now = new Date();
  const ownerId = owner?.id ? String(owner.id) : null;
  const ownerName = owner?.name || "";
  const name = lead.name || lead.business || lead.phone;

  await db.collection("cpanel_clients").updateOne(
    { phone: lead.phone },
    {
      $set: { agentId: ownerId, agentName: ownerName, phone: lead.phone, customerName: name, leadId: String(lead._id) },
      $setOnInsert: { firebery1013Id: null, customerId: null, createdAt: now, source: "lead" },
    },
    { upsert: true },
  );
  await db.collection("support_chats").updateOne(
    { phone: lead.phone },
    {
      $set: { accountManagerId: ownerId, accountManagerName: ownerName || null, updated_at: now },
      $setOnInsert: { _id: lead.phone, phone: lead.phone, name, status: "open", created_at: now },
    },
    { upsert: true },
  );
  const profileSeed = { phone: lead.phone, updatedAt: now };
  if (lead.business) profileSeed.businessName = lead.business;
  if (lead.email) profileSeed.email = lead.email;
  if (lead.field) profileSeed.businessField = lead.field;
  await db.collection("business_profiles").updateOne(
    { phone: lead.phone },
    { $setOnInsert: { ...profileSeed, createdAt: now, businessPhone: lead.phone } },
    { upsert: true },
  );
  await db.collection("leads").updateOne(
    { _id: lead._id },
    { $set: { clientPhone: lead.phone, convertedAt: lead.convertedAt || now, updatedAt: now } },
  );
  return { clientPhone: lead.phone };
}

/* A phone that has no client yet but came in as a panel lead: create the
   client now. The owner is the manager the lead is assigned to; for an
   unassigned lead it is whoever built the personal-catalog quote. A phone
   that is already a client is left untouched, so a client a manager claimed
   is never handed back to the lead's assignee. */
async function ensureClientFromLead(db, phone) {
  if (!phone) return null;
  if (await db.collection("cpanel_clients").findOne({ phone }, { projection: { _id: 1 } })) return null;
  const lead = await db.collection("leads")
    .find({ phone, ...PANEL_LEAD })
    .sort({ createdAt: 1 })
    .limit(1)
    .next();
  if (!lead) return null;

  let owner = lead.assignedTo ? { id: lead.assignedTo, name: lead.assignedToName || "" } : null;
  if (!owner) {
    const pkg = await db.collection("personal_packages")
      .find({ phone, agentId: { $nin: [null, ""] } }, { projection: { agentId: 1 } })
      .sort({ createdAt: -1 })
      .limit(1)
      .next();
    if (pkg?.agentId) {
      const agent = await db.collection("agents").findOne(agentIdQuery(pkg.agentId), { projection: { name: 1, nickname: 1 } });
      owner = { id: String(pkg.agentId), name: agent?.nickname || agent?.name || "" };
    }
  }
  return syncLeadToClient(db, lead, owner);
}

/* True when this manager may open the phone as a client because a panel
   lead with that phone is assigned to them and nobody owns it as a client
   yet (requireClientAccess in controllers/cpanel.controller.js). */
async function isAssignedLead(db, phone, agentId) {
  if (!phone || !agentId) return false;
  const lead = await db.collection("leads").findOne(
    { phone, assignedTo: String(agentId), ...PANEL_LEAD },
    { projection: { _id: 1 } },
  );
  return !!lead;
}

module.exports = { syncLeadToClient, ensureClientFromLead, isAssignedLead };
