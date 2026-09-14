const { DB } = require("../config/db");
const { v4: uuidv4 } = require("uuid");
const waService = require("../services/wa-session.service");
const { requireAdmin } = require("../utils/requireAdmin");
const { createCustomer } = require("../services/fireberry-customers.service");

// Database helpers
const leads = () => DB.collection("leads");

// ─── WhatsApp auto-reply helper (fire-and-forget) ───────────────────────────
async function tryAutoReply(pageId, leadPhone) {
  if (!leadPhone) return;
  try {
    const session = await waService.dbGetSessionByPageId(pageId);
    if (!session) return;
    await waService.sendMessage(session.session_id, leadPhone, session.auto_reply_message);
    console.log(`[AutoReply] Sent to ${leadPhone} via session ${session.session_id}`);
  } catch (err) {
    console.error("[AutoReply] Failed:", err.message);
  }
}

const upsertLead = async (leadData) => {
  await leads().updateOne(
    { phone: leadData.phone },
    {
      $set: { ...leadData, updated_at: new Date() },
      $setOnInsert: { created_at: new Date() },
    },
    { upsert: true },
  );
};

const getLeadsData = async (query, limit, skip) => {
  return await leads()
    .find(query)
    .sort({ created_at: -1 })
    .skip(skip)
    .limit(limit)
    .toArray();
};

const countLeads = async (query) => {
  return await leads().countDocuments(query);
};

const updateLeadData = async (id, updateData, pageId = null) => {
  const query = { _id: id };
  if (pageId) query.page_id = pageId;
  return await leads().updateOne(query, {
    $set: { ...updateData, updated_at: new Date() },
  });
};

const deleteLeadData = async (id, pageId = null) => {
  const query = { _id: id };
  if (pageId) query.page_id = pageId;
  return await leads().updateOne(query, {
    $set: { status: "deleted", updated_at: new Date(), deleted_at: new Date() },
  });
};

const getLeadById = async (id) => {
  return await leads().findOne({ _id: id });
};

const getLeadsStats = async (pageId) => {
  return await leads()
    .aggregate([
      { $match: { page_id: pageId } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ])
    .toArray();
};

exports.getLeads = async (req, res) => {
  console.log("🔍 [Leads] Get Leads requested");
  try {
    const { page_id, status, since, limit = 50, skip = 0 } = req.query;

    if (!page_id) {
      return res.status(400).json({ error: "page_id is required" });
    }

    const query = { page_id };
    if (status) query.status = status;
    if (since) query.updated_at = { $gt: new Date(since) };

    const leadsData = await getLeadsData(
      query,
      parseInt(limit),
      parseInt(skip),
    );
    const total = await countLeads(query);

    console.log(
      `✅ [Leads] Found ${leadsData.length} leads for page ${page_id}`,
    );

    res.json({
      success: true,
      data: leadsData,
      pagination: { total, limit: parseInt(limit), skip: parseInt(skip) },
    });
  } catch (error) {
    console.error("❌ [Leads] Error fetching leads:", error.message);
    res
      .status(500)
      .json({ error: "Failed to fetch leads", details: error.message });
  }
};

exports.createLead = async (req, res) => {
  console.log(" [Leads] Create Lead requested");
  try {
    const {
      page_id,
      account_id,
      name,
      email,
      phone,
      custom_fields,
      status,
      token,
    } = req.body;

    if (!page_id) {
      return res.status(400).json({ error: "page_id is required" });
    }

    const newLead = await upsertLead({
      page_id,
      name,
      email,
      phone,
      custom_fields,
      status,
      lead_id: uuidv4(),
    });

    console.log(`✅ [Leads] Lead created with ID: ${newLead._id}`);

    // Fire-and-forget auto-reply
    tryAutoReply(page_id, phone);

    res.status(201).json({
      success: true,
      data: newLead,
    });
  } catch (error) {
    console.error("❌ [Leads] Error creating lead:", error.message);
    res
      .status(500)
      .json({ error: "Failed to create lead", details: error.message });
  }
};

exports.updateLead = async (req, res) => {
  console.log("✏️ [Leads] Update Lead requested");
  try {
    const { id } = req.params;
    const { page_id, status, name, email, phone, custom_fields } = req.body;

    if (!id) {
      return res.status(400).json({ error: "Lead ID is required" });
    }

    const updateData = {};
    if (status !== undefined) updateData.status = status;
    if (name !== undefined) updateData.name = name;
    if (email !== undefined) updateData.email = email;
    if (phone !== undefined) updateData.phone = phone;
    if (custom_fields !== undefined) updateData.custom_fields = custom_fields;

    const result = await updateLeadData(id, updateData, page_id);

    if (result.matchedCount === 0) {
      return res
        .status(404)
        .json({ error: "Lead not found or page_id mismatch" });
    }

    const updatedLead = await getLeadById(id);

    console.log(`✅ [Leads] Lead updated: ${id}`);
    res.json({ success: true, data: updatedLead });
  } catch (error) {
    console.error("❌ [Leads] Error updating lead:", error.message);
    res
      .status(500)
      .json({ error: "Failed to update lead", details: error.message });
  }
};

exports.deleteLead = async (req, res) => {
  console.log("🗑️ [Leads] Delete Lead requested");
  try {
    const { id } = req.params;
    const { page_id } = req.query;

    if (!id) {
      return res.status(400).json({ error: "Lead ID is required" });
    }

    const result = await deleteLeadData(id, page_id);

    if (result.matchedCount === 0) {
      return res
        .status(404)
        .json({ error: "Lead not found or page_id mismatch" });
    }

    console.log(`✅ [Leads] Lead soft-deleted: ${id}`);
    res.json({ success: true, message: "Lead deleted successfully" });
  } catch (error) {
    console.error("❌ [Leads] Error deleting lead:", error.message);
    res
      .status(500)
      .json({ error: "Failed to delete lead", details: error.message });
  }
};

exports.getStats = async (req, res) => {
  console.log("📊 [Leads] Get Stats requested");
  try {
    const { page_id } = req.query;

    if (!page_id) {
      return res.status(400).json({ error: "page_id is required" });
    }

    const stats = await getLeadsStats(page_id);
    const statsObject = {};
    stats.forEach((stat) => {
      statsObject[stat._id] = stat.count;
    });
    const total = stats.reduce((sum, stat) => sum + stat.count, 0);

    console.log(`✅ [Leads] Stats retrieved for page ${page_id}`);
    res.json({ success: true, data: { stats: statsObject, total } });
  } catch (error) {
    console.error("❌ [Leads] Error fetching stats:", error.message);
    res
      .status(500)
      .json({ error: "Failed to fetch stats", details: error.message });
  }
};

exports.updateLeadStatus = async (req, res) => {
  console.log("🔄 [Leads] Update Lead Status requested");
  try {
    const { id } = req.params;
    const { status, page_id, revenue, notes, name, phone } = req.body;

    if (!id) {
      return res.status(400).json({ error: "Lead ID is required" });
    }

    const validStatuses = ["new", "in_progress", "closed", "rejected", "not_closed"];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({
        error: `status is required and must be one of: ${validStatuses.join(", ")}`,
      });
    }

    const $set = { status, updated_at: new Date() };
    if (page_id) $set.page_id = page_id;
    if (revenue !== undefined) $set.revenue = Number(revenue) || 0;
    if (notes !== undefined) $set.notes = notes;
    if (name !== undefined) $set.name = name;
    if (phone !== undefined) $set.phone = phone;

    // Upsert: creates lead doc if it doesn't exist yet (leads stored locally and synced on-demand)
    await leads().updateOne(
      { _id: id },
      {
        $set,
        $setOnInsert: { created_at: new Date() },
      },
      { upsert: true }
    );

    const updatedLead = await getLeadById(id);
    console.log(`✅ [Leads] Lead status upserted: ${id} → ${status}`);
    res.json({ success: true, data: updatedLead });
  } catch (error) {
    console.error("❌ [Leads] Error updating lead status:", error.message);
    res
      .status(500)
      .json({ error: "Failed to update lead status", details: error.message });
  }
};

exports.updateLeadNotes = async (req, res) => {
  try {
    const { id } = req.params;
    const { notes, page_id, name, phone } = req.body;
    if (!id) return res.status(400).json({ error: "Lead ID is required" });

    const $set = { notes: notes || "", updated_at: new Date() };
    if (page_id) $set.page_id = page_id;
    if (name !== undefined) $set.name = name;
    if (phone !== undefined) $set.phone = phone;

    await leads().updateOne(
      { _id: id },
      {
        $set,
        $setOnInsert: { created_at: new Date() },
      },
      { upsert: true }
    );

    console.log(`✅ [Leads] Lead notes updated: ${id}`);
    res.json({ success: true });
  } catch (error) {
    console.error("❌ [Leads] Error updating lead notes:", error.message);
    res.status(500).json({ error: "Failed to update lead notes", details: error.message });
  }
};

exports.getLeadStatuses = async (req, res) => {
  try {
    const { page_id } = req.query;
    if (!page_id) return res.status(400).json({ success: false, error: "page_id required" });
    // _id IS the FB lead ID (stored as string), status and notes are also fetched
    const docs = await leads().find(
      { page_id },
      { projection: { status: 1, notes: 1, revenue: 1 } }
    ).toArray();
    const map = {};
    for (const d of docs) {
      if (d._id) map[String(d._id)] = { status: d.status, notes: d.notes, revenue: d.revenue };
    }
    res.json({ success: true, data: map });
  } catch (err) {
    console.error("❌ [Leads] Error fetching statuses:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.batchUpsert = async (req, res) => {
  console.log("📦 [Leads] Batch Upsert requested");
  try {
    const { page_id, leads: leadsData } = req.body;

    if (!page_id) {
      return res.status(400).json({ error: "page_id is required" });
    }

    if (!Array.isArray(leadsData) || leadsData.length === 0) {
      return res
        .status(400)
        .json({ error: "leads array is required and must not be empty" });
    }

    const invalidLeads = leadsData.filter(
      (lead) => lead.page_id && lead.page_id !== page_id,
    );
    if (invalidLeads.length > 0) {
      return res.status(400).json({
        error: "All leads must belong to the specified page_id",
        invalid_count: invalidLeads.length,
      });
    }

    const bulkOps = leadsData.map((lead) => ({
      updateOne: {
        filter: { _id: lead._id || lead.id || uuidv4() },
        update: {
          $set: {
            _id: lead._id || lead.id || uuidv4(),
            page_id,
            account_id: lead.account_id,
            status: lead.status || "new",
            name: lead.name || null,
            email: lead.email || null,
            phone: lead.phone || null,
            custom_fields: lead.custom_fields || {},
            updated_at: new Date(),
          },
          $setOnInsert: { created_at: new Date(), synced_at: null },
        },
        upsert: true,
      },
    }));

    const result = await leads().bulkWrite(bulkOps);

    console.log(
      `✅ [Leads] Batch upsert completed: ${result.upsertedCount} inserted, ${result.modifiedCount} updated`,
    );

    // Fire-and-forget auto-reply for new leads with phone numbers
    for (const lead of leadsData) {
      if (lead.phone) tryAutoReply(page_id, lead.phone);
    }

    res.json({
      success: true,
      data: {
        inserted: result.upsertedCount,
        updated: result.modifiedCount,
        total: leadsData.length,
      },
    });
  } catch (error) {
    console.error("❌ [Leads] Error in batch upsert:", error.message);
    res
      .status(500)
      .json({ error: "Failed to batch upsert leads", details: error.message });
  }
};

exports.syncLeads = async (req, res) => {
  console.log("📥 [Leads] Sync requested");
  try {
    const { userId, phone, pageId, syncedAt, forms } = req.body;
    if (!phone || !pageId) {
      return res.status(400).json({ success: false, error: "phone and pageId are required" });
    }

    const totalLeads = (forms ?? []).reduce((sum, f) => sum + (f.leads?.length ?? 0), 0);

    await DB.collection("user_leads").updateOne(
      { phone },
      {
        $set: {
          phone,
          userId,
          pageId,
          totalLeads,
          formsCount: (forms ?? []).length,
          lastSyncAt: syncedAt ?? Math.floor(Date.now() / 1000),
          updatedAt: new Date(),
          forms: (forms ?? []).map((form) => ({
            formId: form.formId,
            formName: form.formName,
            formStatus: form.formStatus,
            leadsCount: form.leads?.length ?? 0,
            leads: (form.leads ?? []).map((lead) => ({
              fb_lead_id: lead.fb_lead_id,
              created_time: lead.created_time,
              name: lead.name || null,
              email: lead.email || null,
              lead_phone: lead.phone || null,
              campaign_id: lead.campaign_id || null,
              campaign_name: lead.campaign_name || null,
              adset_id: lead.adset_id || null,
              adset_name: lead.adset_name || null,
              ad_id: lead.ad_id || null,
              ad_name: lead.ad_name || null,
              field_data: lead.field_data ?? [],
            })),
          })),
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true }
    );

    console.log(`✅ [LeadsSync] ${phone}: ${totalLeads} leads across ${(forms ?? []).length} forms`);
    res.json({ success: true, data: { totalLeads, formsCount: (forms ?? []).length } });
  } catch (err) {
    console.error("❌ [LeadsSync] Error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.getLeadsByPhone = async (req, res) => {
  try {
    const { phone } = req.params;
    if (!phone) {
      return res.status(400).json({ success: false, error: "phone is required" });
    }

    const col = DB.collection("user_leads");

    // חיפוש ראשון: לפי טלפון המפרסם (המזהה הראשי)
    let doc = await col.findOne({ phone });

    // חיפוש שני: אם לא נמצא — חפש לפי טלפון של ליד בתוך המסמכים
    if (!doc) {
      doc = await col.findOne({ "forms.leads.lead_phone": phone });
    }

    if (!doc) {
      return res.status(404).json({ success: false, error: "No data found for this phone" });
    }

    // Flatten all leads from all forms into a single array
    const leads = (doc.forms || []).flatMap(form =>
      (form.leads || []).map(lead => ({
        ...lead,
        fb_created_time: lead.created_time,
        form_name: form.formName,
        form_id: form.formId,
      }))
    );

    const profile = {
      phone: doc.phone,
      totalLeads: doc.totalLeads,
      formsCount: doc.formsCount,
      updatedAt: doc.updatedAt,
      pageId: doc.pageId,
      userId: doc.userId,
      lastSyncAt: doc.lastSyncAt,
    };

    res.json({ success: true, data: { profile, leads } });
  } catch (err) {
    console.error("❌ [GetLeadsByPhone] Error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

// ─── Referral (חבר מביא חבר) endpoints ───────────────────────────────────────

exports.createReferralLead = async (req, res) => {
  try {
    const { referred_by, page_id, name, business_name, phone } = req.body;
    if (!referred_by || !page_id || !phone) {
      return res.status(400).json({ success: false, error: "referred_by, page_id and phone are required" });
    }
    const doc = {
      type: "friend_referral",
      referred_by,
      page_id,
      name: name || "",
      business_name: business_name || "",
      phone,
      referral_status: 0,
      status: "new",
      created_at: new Date(),
      updated_at: new Date(),
    };
    const result = await DB.collection("leads").insertOne(doc);
    tryAutoReply(page_id, phone);

    // Add referral to the referrer's portfolio manager's client list
    try {
      const referrerRow = await DB.collection("cpanel_clients").findOne(
        { phone: referred_by },
        { projection: { agentId: 1, agentName: 1 } }
      );
      if (referrerRow?.agentId) {
        await DB.collection("cpanel_clients").insertOne({
          phone,
          agentId:      referrerRow.agentId,
          agentName:    referrerRow.agentName || null,
          customerName: name || phone,
          status:       "friend_referral",
          referralLeadId: result.insertedId.toString(),
          referredBy:   referred_by,
          createdAt:    new Date(),
          tier:         "REGULAR",
        });
      }
    } catch (cpanelErr) {
      console.warn("[CreateReferralLead] cpanel_clients insert failed:", cpanelErr.message);
    }

    // Create a matching customer record (objecttype 1) in Fireberry CRM
    try {
      const accountid = await createCustomer({
        accountname: name || "",
        idnumber:    business_name || "",
        telephone1:  phone,
        statuscode:  6,
      });
      if (accountid) {
        await DB.collection("leads").updateOne(
          { _id: result.insertedId },
          { $set: { fireberry_account_id: accountid } },
        );
      }
    } catch (fbErr) {
      console.warn("[CreateReferralLead] Fireberry customer create failed:", fbErr.message);
    }

    res.status(201).json({ success: true, data: { ...doc, _id: result.insertedId } });
  } catch (err) {
    console.error("❌ [CreateReferralLead] Error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.getReferralsByUser = async (req, res) => {
  try {
    const { phone } = req.params;
    if (!phone) return res.status(400).json({ success: false, error: "phone is required" });
    const data = await DB.collection("leads")
      .find({ type: "friend_referral", referred_by: phone })
      .sort({ created_at: -1 })
      .toArray();
    res.json({ success: true, data });
  } catch (err) {
    console.error("❌ [GetReferralsByUser] Error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.getAllReferralLeads = async (req, res) => {
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    const data = await DB.collection("leads")
      .find({ type: "friend_referral" })
      .sort({ created_at: -1 })
      .toArray();
    res.json({ success: true, data });
  } catch (err) {
    console.error("❌ [GetAllReferralLeads] Error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.approveReferralLead = async (req, res) => {
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    const { id } = req.params;
    const { ObjectId } = require("mongodb");
    const lead = await DB.collection("leads").findOne({ _id: new ObjectId(id) });
    if (!lead) return res.status(404).json({ success: false, error: "Lead not found" });
    if (lead.type !== "friend_referral") return res.status(400).json({ success: false, error: "Not a referral lead" });
    if (lead.referral_status !== 0) return res.status(400).json({ success: false, error: "Lead already processed" });

    await DB.collection("leads").updateOne(
      { _id: new ObjectId(id) },
      { $set: { referral_status: 1, updated_at: new Date() } }
    );
    await DB.collection("cpanel_clients").updateOne(
      { referralLeadId: id },
      { $set: { status: "friend_referral_approved" } }
    );

    const updated = await DB.collection("users").findOneAndUpdate(
      { phone: lead.referred_by },
      {
        $inc: { coins: 100 },
        $set: { updatedAt: new Date() },
        $setOnInsert: { phone: lead.referred_by, createdAt: new Date() },
      },
      { returnDocument: "after", upsert: true }
    );
    const newBalance = updated?.coins ?? 100;
    await DB.collection("coin_transactions").insertOne({
      phone: lead.referred_by,
      type: "add",
      amount: 100,
      reason: "referral_approved",
      balance_after: newBalance,
      created_at: new Date(),
    });
    res.json({ success: true, new_balance: newBalance });
  } catch (err) {
    console.error("❌ [ApproveReferralLead] Error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.closeReferralLead = async (req, res) => {
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    const { id } = req.params;
    const { ObjectId } = require("mongodb");
    const lead = await DB.collection("leads").findOne({ _id: new ObjectId(id) });
    if (!lead) return res.status(404).json({ success: false, error: "Lead not found" });
    if (lead.type !== "friend_referral") return res.status(400).json({ success: false, error: "Not a referral lead" });
    if (lead.referral_status !== 1) return res.status(400).json({ success: false, error: "Lead must be approved before closing" });

    await DB.collection("leads").updateOne(
      { _id: new ObjectId(id) },
      { $set: { referral_status: 2, updated_at: new Date() } }
    );
    await DB.collection("cpanel_clients").updateOne(
      { referralLeadId: id },
      { $set: { status: "done" } }
    );

    const updated = await DB.collection("users").findOneAndUpdate(
      { phone: lead.referred_by },
      {
        $inc: { coins: 1000 },
        $set: { updatedAt: new Date() },
        $setOnInsert: { phone: lead.referred_by, createdAt: new Date() },
      },
      { returnDocument: "after", upsert: true }
    );
    const newBalance = updated?.coins ?? 1000;
    await DB.collection("coin_transactions").insertOne({
      phone: lead.referred_by,
      type: "add",
      amount: 1000,
      reason: "referral_closed",
      balance_after: newBalance,
      created_at: new Date(),
    });
    res.json({ success: true, new_balance: newBalance });
  } catch (err) {
    console.error("❌ [CloseReferralLead] Error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};
