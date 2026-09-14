const axios = require("axios");
const { DB } = require("../../config/db");
const col = (name) => DB.collection(name);

const FB_API = "https://api.powerlink.co.il/api";

function fbHeaders() {
  return { tokenid: process.env.FIREBERRY_TOKEN, "Content-Type": "application/json" };
}

function normalizePhone(phone) {
  if (!phone) return null;
  const d = String(phone).replace(/\D/g, "");
  if (d.startsWith("972") && d.length === 12) return "0" + d.slice(3);
  if (d.startsWith("0") && d.length === 10) return d;
  if (d.length === 9 && d.startsWith("5")) return "0" + d;
  return d;
}

async function fetchFireberryByPhone(phone) {
  const digits = phone.replace(/\D/g, "");
  let core = null;
  if (digits.startsWith("0") && digits.length === 10) core = digits.slice(1);
  else if (digits.length === 9 && digits.startsWith("5")) core = digits;
  if (!core) return null;

  const variants = [digits, "972" + core, "0" + core, core, "+972" + core];
  const fields = ["telephone1", "telephone2", "telephone3", "pcfsystemfield104", "pcfsystemfield1478"];
  const clauses = [
    ...variants.flatMap(v => fields.map(f => `(${f} = ${v})`)),
    ...fields.map(f => `(${f} contains "${core}")`),
  ];

  try {
    const resp = await axios.post(`${FB_API}/query`, {
      objecttype: 1, page_size: 1, page_number: 1, query: clauses.join(" OR "),
    }, { headers: fbHeaders(), timeout: 15000 });

    let rec = resp.data?.data?.Data?.[0];
    if (!rec) {
      const r2 = await axios.post(`${FB_API}/query`, {
        objecttype: 1013, page_size: 1, page_number: 1,
        query: variants.map(v => `(pcfsystemfield110 = ${v})`).join(" OR "),
      }, { headers: fbHeaders(), timeout: 10000 });
      const linked = r2.data?.data?.Data?.[0]?.pcfsystemfield106;
      if (!linked) return null;
      const r3 = await axios.post(`${FB_API}/query`, {
        objecttype: 1, page_size: 1, page_number: 1, query: `(accountid = ${linked})`,
      }, { headers: fbHeaders(), timeout: 10000 });
      rec = r3.data?.data?.Data?.[0];
      if (!rec) return null;
    }

    return {
      phone: normalizePhone(rec.telephone1) || phone,
      accountid: rec.accountid,
      accountname: rec.accountname || null,
      firstname: rec.firstname || null,
      bizname: rec.pcfsystemfield1475 || null,
      telephone1: rec.telephone1 || null,
      driveUrl: rec.pcfsystemfield114 || null,
      logoUrl: rec.pcfsystemfield1445 || null,
      websiteUrl: rec.websiteurl || null,
      saleStatusCode: rec.statuscode || null,
      fetchedAt: new Date(),
    };
  } catch (err) {
    console.error("[FB Sync] Error for", phone, ":", err.message);
    return null;
  }
}

let syncRunning = false;
let syncDone = false;

async function syncUncachedUsers() {
  if (syncRunning || syncDone) return;
  syncRunning = true;
  try {
    const allUserPhones = await col("users").find({}).project({ phone: 1 }).toArray().then(r => r.map(u => u.phone));
    const cachedPhones = new Set(await col("fireberry_customers").find({}).project({ phone: 1 }).toArray().then(r => r.map(c => c.phone)));
    const uncached = allUserPhones.filter(p => p && !cachedPhones.has(p));

    if (uncached.length === 0) { syncDone = true; syncRunning = false; return; }
    console.log(`[FB Sync] Fetching ${uncached.length} uncached users from Fireberry...`);

    let fetched = 0;
    for (let i = 0; i < uncached.length; i += 5) {
      const batch = uncached.slice(i, i + 5);
      const results = await Promise.all(batch.map(p => fetchFireberryByPhone(p)));
      for (let j = 0; j < batch.length; j++) {
        const data = results[j];
        const phone = batch[j];
        try {
          if (data) {
            data.phone = phone;
            await col("fireberry_customers").updateOne({ phone }, { $set: data }, { upsert: true });
            fetched++;
          } else {
            await col("fireberry_customers").updateOne(
              { phone },
              { $set: { phone, fetchedAt: new Date() } },
              { upsert: true }
            );
          }
        } catch (e) {
          // skip duplicates
        }
      }
      if (i % 50 === 0 && i > 0) console.log(`[FB Sync] Progress: ${i}/${uncached.length} (${fetched} found)`);
    }
    console.log(`[FB Sync] Done. Fetched ${fetched}/${uncached.length} from Fireberry.`);
    syncDone = true;
  } catch (err) {
    console.error("[FB Sync] Error:", err.message);
  } finally {
    syncRunning = false;
  }
}

exports.syncFireberry = async (req, res) => {
  syncDone = false;
  syncUncachedUsers();
  res.json({ message: "Sync started in background" });
};

exports.list = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 25, 100);
    const skip = (page - 1) * limit;
    const search = req.query.search?.trim();

    const filter = {};
    if (search) {
      const [fbMatches, briefMatches] = await Promise.all([
        col("fireberry_customers")
          .find({
            $or: [
              { firstname: { $regex: search, $options: "i" } },
              { bizname: { $regex: search, $options: "i" } },
              { accountname: { $regex: search, $options: "i" } },
            ],
          })
          .project({ phone: 1 })
          .toArray(),
        col("client_briefs")
          .find({
            $or: [
              { clientName: { $regex: search, $options: "i" } },
              { "answers.1.clientData.client_name": { $regex: search, $options: "i" } },
              { "answers.1.clientData.business_name": { $regex: search, $options: "i" } },
            ],
          })
          .project({ phone: 1 })
          .toArray(),
      ]);
      const matchedPhones = [
        ...fbMatches.map((m) => m.phone),
        ...briefMatches.map((m) => m.phone),
      ];

      filter.$or = [
        { phone: { $regex: search, $options: "i" } },
        ...(matchedPhones.length ? [{ phone: { $in: matchedPhones } }] : []),
      ];
    }

    const allFbPhones = await col("fireberry_customers").find({}).project({ phone: 1 }).toArray().then(r => r.map(c => c.phone));
    const allBriefPhones = await col("client_briefs").find({}).project({ phone: 1 }).toArray().then(r => r.map(b => b.phone));
    const phonesWithData = new Set([...allFbPhones, ...allBriefPhones]);

    const [users, total] = await Promise.all([
      col("users").find(filter).toArray(),
      col("users").countDocuments(filter),
    ]);

    const phones = users.map((u) => u.phone).filter(Boolean);
    const [fbCustomers, briefs, profiles, lastTransactions] = await Promise.all([
      col("fireberry_customers").find({ phone: { $in: phones } }).toArray(),
      col("client_briefs").find({ phone: { $in: phones } }).project({ phone: 1, clientName: 1, answers: 1 }).toArray(),
      col("profiles").find({ phone: { $in: phones } }).project({ phone: 1, websiteUrl: 1 }).toArray(),
      col("coin_transactions").aggregate([
        { $match: { phone: { $in: phones } } },
        { $sort: { created_at: -1 } },
        { $group: { _id: "$phone", lastUsed: { $first: "$created_at" }, txCount: { $sum: 1 } } },
      ]).toArray(),
    ]);

    const fbMap = Object.fromEntries(fbCustomers.map((c) => [c.phone, c]));
    const briefMap = {};
    for (const b of briefs) {
      const cd = b.answers?.["1"]?.clientData;
      briefMap[b.phone] = {
        clientName: cd?.client_name || b.clientName || null,
        businessName: cd?.business_name || b.clientName || null,
      };
    }
    const profileMap = {};
    for (const p of profiles) {
      const url = p.websiteUrl;
      if (url && url !== "https://iconiqmedia.co.il" && url.trim()) {
        profileMap[p.phone] = url;
      }
    }
    const activityMap = {};
    for (const t of lastTransactions) {
      activityMap[t._id] = { lastUsed: t.lastUsed, txCount: t.txCount };
    }

    const enriched = users.map((u) => {
      const fb = fbMap[u.phone];
      const br = briefMap[u.phone];
      const activity = activityMap[u.phone];
      return {
        ...u,
        clientName: fb?.firstname || fb?.accountname?.replace(/\s*\d{9,}$/g, "").trim() || br?.clientName || null,
        businessName: fb?.bizname || br?.businessName || null,
        websiteUrl: fb?.websiteUrl || profileMap[u.phone] || null,
        driveUrl: fb?.driveUrl || null,
        logoUrl: fb?.logoUrl || null,
        appActive: !!activity,
        lastActivity: activity?.lastUsed || null,
        _hasData: phonesWithData.has(u.phone) ? 1 : 0,
      };
    });

    const statusFilter = req.query.filter?.trim();
    let filtered = enriched;
    if (statusFilter === "active") filtered = enriched.filter((u) => u.appActive);
    else if (statusFilter === "inactive") filtered = enriched.filter((u) => !u.appActive);
    else if (statusFilter === "has_data") filtered = enriched.filter((u) => u._hasData);
    else if (statusFilter === "has_website") filtered = enriched.filter((u) => u.websiteUrl);
    else if (statusFilter === "has_drive") filtered = enriched.filter((u) => u.driveUrl);

    const sortParam = req.query.sort || "clientName_asc";
    const [sortField, sortDirection] = sortParam.split(/_(?=asc$|desc$)/);
    const dir = sortDirection === "desc" ? -1 : 1;

    const getSortValue = (u, field) => {
      switch (field) {
        case "clientName": return (u.clientName || "").toLowerCase();
        case "businessName": return (u.businessName || "").toLowerCase();
        case "coins": return u.coins || 0;
        case "appActive": return u.appActive ? 1 : 0;
        case "lastActivity": return new Date(u.lastActivity || 0).getTime();
        default: return (u[field] || "").toString().toLowerCase();
      }
    };

    filtered.sort((a, b) => {
      const av = getSortValue(a, sortField);
      const bv = getSortValue(b, sortField);
      if (typeof av === "string") return dir * av.localeCompare(bv);
      return dir * (av - bv);
    });

    const filteredTotal = filtered.length;
    const paginated = filtered.slice(skip, skip + limit);
    paginated.forEach((u) => delete u._hasData);

    res.json({ users: paginated, page, totalPages: Math.ceil(filteredTotal / limit), total: filteredTotal });
  } catch (err) {
    console.error("[Admin/Users] list:", err.message);
    res.status(500).json({ message: "Failed to list users" });
  }
};

exports.getByPhone = async (req, res) => {
  try {
    const { phone } = req.params;
    const user = await col("users").findOne({ phone });
    if (!user) return res.status(404).json({ message: "User not found" });

    const [transactions, briefs, chats, leads] = await Promise.all([
      col("coin_transactions").find({ phone }).sort({ created_at: -1 }).limit(50).toArray(),
      col("client_briefs").find({ phone }).toArray(),
      col("support_chats").find({ participants: phone }).sort({ updated_at: -1 }).limit(10)
        .project({ _id: 1, status: 1, station: 1, updated_at: 1 }).toArray(),
      col("leads").find({ phone }).sort({ created_at: -1 }).limit(20).toArray(),
    ]);

    const balance = transactions.reduce((s, t) => s + (t.type === "add" ? t.amount : -t.amount), 0);

    res.json({ user, coinBalance: balance, recentTransactions: transactions.slice(0, 20), briefs, recentChats: chats, recentLeads: leads });
  } catch (err) {
    console.error("[Admin/Users] getByPhone:", err.message);
    res.status(500).json({ message: "Failed to get user" });
  }
};

exports.update = async (req, res) => {
  try {
    const { phone } = req.params;
    const updates = { ...req.body };
    delete updates._id;
    delete updates.phone;

    const result = await col("users").updateOne({ phone }, { $set: { ...updates, updatedAt: new Date() } });
    if (result.matchedCount === 0) return res.status(404).json({ message: "User not found" });

    res.json({ message: "User updated", modifiedCount: result.modifiedCount });
  } catch (err) {
    console.error("[Admin/Users] update:", err.message);
    res.status(500).json({ message: "Failed to update user" });
  }
};

exports.getTransactions = async (req, res) => {
  try {
    const { phone } = req.params;
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 25, 100);
    const skip = (page - 1) * limit;

    const [transactions, total] = await Promise.all([
      col("coin_transactions").find({ phone }).sort({ created_at: -1 }).skip(skip).limit(limit).toArray(),
      col("coin_transactions").countDocuments({ phone }),
    ]);

    res.json({ transactions, page, totalPages: Math.ceil(total / limit), total });
  } catch (err) {
    console.error("[Admin/Users] transactions:", err.message);
    res.status(500).json({ message: "Failed to get transactions" });
  }
};
