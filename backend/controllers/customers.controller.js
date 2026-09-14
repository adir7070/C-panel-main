const { getCustomer, refreshCustomer } = require("../services/customer-cache.service");
const { searchCustomers, getCharacterizationByPhone } = require("../services/fireberry-customers.service");
const { getDB } = require("../config/db");
const { normalizePhone } = require("../utils/phone");

/**
 * GET /api/customers/by-phone?phone=...&refresh=true
 * Universal customer lookup — DB first, Fireberry fallback.
 */
exports.getByPhone = async (req, res) => {
  const { phone, refresh } = req.query;
  if (!phone) return res.status(400).json({ success: false, message: "phone is required" });

  try {
    const forceRefresh = refresh === "true";

    // Check if cached before fetching (to set fromCache flag)
    let fromCache = false;
    if (!forceRefresh) {
      const cached = await getDB().collection("fireberry_customers").findOne(
        { phone: phone.replace(/\D/g, "").replace(/^972/, "0") },
        { projection: { fetchedAt: 1 } }
      );
      fromCache = !!(cached?.fetchedAt);
    }

    const customer = forceRefresh
      ? await refreshCustomer(phone)
      : await getCustomer(phone);

    if (!customer || !customer.accountid) {
      return res.status(404).json({ success: false, message: "לקוח לא נמצא" });
    }

    res.json({ success: true, data: { customer, fromCache } });
  } catch (err) {
    console.error("[Customers] getByPhone error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

/**
 * GET /api/customers/is-new?phone=...
 * Returns isNew=true if the customer has never purchased coins/tokens.
 */
exports.isNew = async (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ success: false, message: "phone is required" });

  const normalized = normalizePhone(phone);
  if (!normalized) {
    return res.status(400).json({ success: false, message: "invalid Israeli phone number" });
  }

  try {
    const existing = await getDB().collection("coin_transactions").findOne(
      { phone: normalized, type: "add" },
      { projection: { _id: 1 } }
    );

    res.json({ success: true, isNew: !existing });
  } catch (err) {
    console.error("[Customers] isNew error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

/**
 * GET /api/customers/search?q=...
 * Search customers by name or phone — always hits Fireberry (no local search index).
 * Also merges results from local support_chats.
 */
exports.search = async (req, res) => {
  const { q } = req.query;
  if (!q || !q.trim()) return res.json({ success: true, data: [] });

  try {
    const [fbResults, chatDocs] = await Promise.all([
      searchCustomers(q).catch(() => []),
      getDB().collection("support_chats").find({
        $or: [
          { name: { $regex: q.trim(), $options: "i" } },
          { phone: { $regex: q.trim() } },
        ],
      }).limit(8).toArray().catch(() => []),
    ]);

    const merged = [...fbResults];
    for (const chat of chatDocs) {
      if (chat.phone && !merged.find(r => r.telephone1 === chat.phone)) {
        merged.push({
          accountid: null,
          accountname: chat.name || chat._id,
          telephone1: chat.phone,
          source: "chat",
        });
      }
    }

    res.json({ success: true, data: merged });
  } catch (err) {
    console.error("[Customers] search error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

/**
 * GET /api/customers/characterization/:phone
 * Fetch all characterization fields from Fireberry for pre-filling the snake flow.
 */
exports.getCharacterization = async (req, res) => {
  const { phone } = req.params;
  if (!phone) return res.status(400).json({ success: false, message: "phone is required" });

  try {
    const data = await getCharacterizationByPhone(phone);
    if (!data) {
      return res.status(404).json({ success: false, message: "לקוח לא נמצא" });
    }
    res.json({ success: true, data });
  } catch (err) {
    console.error("[Customers] getCharacterization error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
};
