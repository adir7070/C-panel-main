const { getDB } = require("../config/db");

// GET /api/website-chat/search?q=...
exports.searchWebsiteChats = async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  try {
    const orClauses = [
      { name: { $regex: q, $options: 'i' } },
    ];

    const digits = q.replace(/\D/g, '');
    if (digits.length >= 7) {
      const variants = new Set([digits]);
      if (digits.startsWith('0'))   variants.add('972' + digits.slice(1));
      if (digits.startsWith('972')) variants.add('0'   + digits.slice(3));

      orClauses.push({ phone: { $regex: [...variants].join('|') } });
      orClauses.push({ _id: { $in: [...variants] } });
    }

    const results = await getDB()
      .collection("website_support_chats")
      .find({ $or: orClauses }, { projection: { messages: 0 } })
      .sort({ updated_at: -1 })
      .limit(60)
      .toArray();
    return res.json(results);
  } catch (err) {
    console.error("[Website Chat API] searchWebsiteChats error:", err.message);
    return res.status(500).json({ error: err.message });
  }
};
