/**
 * Export every client with full details to a JSON file.
 *
 * Pulls from the AWS Mongo cluster (the primary one iconiq-server uses)
 * and joins three collections by phone:
 *
 *   cpanel_clients      — the roster row (agent, name, status)
 *   business_profiles   — the full profile (colors, logo, services, etc.)
 *   users               — coins balance, activePackage, payment token info
 *
 * Output: { exportedAt, totalClients, clients: [...] }
 * Default destination: C:\Users\Goals\Desktop\clients-export.json
 *
 * Run:  node scripts/export-clients-json.js
 *       node scripts/export-clients-json.js --out=path/to/file.json
 */
const fs   = require("fs");
const path = require("path");

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

function arg(name, def) {
  const m = process.argv.find(a => a.startsWith(`--${name}=`));
  return m ? m.slice(name.length + 3) : def;
}

(async () => {
  const uri = process.env.AWS_MONGO_URI || process.env.MONGO_URI;
  if (!uri) { console.error("No MONGO_URI"); process.exit(1); }

  const out = arg("out", path.join("C:", "Users", "Goals", "Desktop", "clients-export.json"));

  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000 });
  await client.connect();
  const db = client.db();
  console.log(`[export] connected · db=${db.databaseName}`);

  /* Pull every cpanel_clients row first — that's the canonical roster. */
  const cpanelClients = await db.collection("cpanel_clients").find({}).toArray();
  console.log(`[export] cpanel_clients: ${cpanelClients.length}`);

  const phones = cpanelClients.map(c => c.phone).filter(Boolean);

  /* Enrichment lookups, batched. */
  const [profiles, users, chats] = await Promise.all([
    db.collection("business_profiles").find({ phone: { $in: phones } }).toArray(),
    db.collection("users").find(
      { phone: { $in: phones } },
      { projection: {
        paymentToken: 0,           // never export the saved-card token
        paymentExpiry: 0,
      } }
    ).toArray(),
    db.collection("support_chats").find(
      { phone: { $in: phones } },
      { projection: { messages: 0 } }   // chat history is huge; drop
    ).toArray(),
  ]);
  console.log(`[export] enriched · profiles=${profiles.length} users=${users.length} chats=${chats.length}`);

  const profileByPhone = new Map(profiles.map(p => [p.phone, p]));
  const userByPhone    = new Map(users.map(u => [u.phone, u]));
  const chatByPhone    = new Map(chats.map(c => [c.phone, c]));

  /* Hydrate agent name from cpanel_clients itself if present, else look up. */
  const agentIds = [...new Set(cpanelClients.map(c => c.agentId).filter(Boolean).map(String))];
  const { ObjectId } = require("mongodb");
  const agentOids = agentIds.map(id => { try { return new ObjectId(id); } catch { return null; } }).filter(Boolean);
  const agents = agentOids.length
    ? await db.collection("agents").find(
        { $or: [{ _id: { $in: agentOids } }, { _id: { $in: agentIds } }] },
        { projection: { name: 1, nickname: 1, email: 1, phone: 1, role: 1 } },
      ).toArray()
    : [];
  const agentById = new Map(agents.map(a => [String(a._id), a]));

  const exportRows = cpanelClients.map(c => {
    const p = profileByPhone.get(c.phone) || null;
    const u = userByPhone.get(c.phone)    || null;
    const s = chatByPhone.get(c.phone)    || null;
    const a = c.agentId ? agentById.get(String(c.agentId)) : null;

    return {
      phone:        c.phone,
      customerName: c.customerName || p?.businessName || s?.name || null,
      assignedAgent: a ? {
        id:       String(a._id),
        name:     a.nickname || a.name || null,
        email:    a.email    || null,
        phone:    a.phone    || null,
        role:     a.role     || null,
      } : null,

      status:       c.status || s?.status || null,
      createdAt:    c.createdAt || null,
      updatedAt:    c.updatedAt || null,
      tier:         c.tier      || null,
      firebery1013Id: c.firebery1013Id || null,
      leadSource:   c.leadSource || null,

      businessProfile: p ? {
        businessName:   p.businessName,
        businessField:  p.businessField,
        businessNiche:  p.businessNiche,
        about:          p.about,
        targetAudience: p.targetAudience,
        services:       p.services,
        promotion:      p.promotion,
        designStyle:    p.designStyle,
        pageGoal:       p.pageGoal,
        preferredColors: p.preferredColors,    // all 6 keys if set
        logoUrl:        p.logoUrl || null,
        socialLinks:    p.socialLinks || null,
        address:        p.address || null,
        email:          p.email || null,
        images:         Array.isArray(p.images) ? p.images.length : 0,    // count, not URLs
      } : null,

      wallet: u ? {
        coins:               u.coins      || 0,
        coinsUsed:           u.coinsUsed  || 0,
        hasSavedCard:        !!u.paymentLast4,
        paymentLast4:        u.paymentLast4 || null,
        activePackage:       u.activePackage ? {
          key:    u.activePackage.key,
          name:   u.activePackage.name,
          status: u.activePackage.status,
          coins:  u.activePackage.coins,
          items:  u.activePackage.items,
          purchasedAt: u.activePackage.purchasedAt,
        } : null,
        purchasedPackagesCount: Array.isArray(u.purchasedPackages) ? u.purchasedPackages.length : 0,
      } : null,

      chat: s ? {
        chatId:              s._id || null,
        status:              s.status || null,
        accountManagerId:    s.accountManagerId || null,
        accountManagerName:  s.accountManagerName || null,
        notes:               s.notes || null,
        lastMessageAt:       s.lastMessageAt || s.updated_at || null,
      } : null,
    };
  });

  const payload = {
    exportedAt:   new Date().toISOString(),
    totalClients: exportRows.length,
    source:       { mongoHost: client.options.hosts?.[0]?.host || "?", db: db.databaseName },
    clients:      exportRows,
  };

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(payload, null, 2), "utf8");
  const sizeKb = Math.round(fs.statSync(out).size / 1024);
  console.log(`[export] ✅ wrote ${exportRows.length} clients to ${out} (${sizeKb} KB)`);

  await client.close();
})().catch(err => { console.error(err); process.exit(1); });
