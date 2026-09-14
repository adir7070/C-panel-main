const { getSalesByPhone, getSalesByAccountId } = require("../services/fireberry-sales.service");

// GET /api/sales?phone=0542587070
exports.getSalesByPhone = async (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ success: false, error: "phone query param is required" });
  try {
    const sales = await getSalesByPhone(phone);
    return res.json({ success: true, data: sales });
  } catch (err) {
    console.error("❌ [Sales] getSalesByPhone error:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// GET /api/sales/account/:accountid
exports.getSalesByAccountId = async (req, res) => {
  const { accountid } = req.params;
  try {
    const sales = await getSalesByAccountId(accountid);
    return res.json({ success: true, data: sales });
  } catch (err) {
    console.error("❌ [Sales] getSalesByAccountId error:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
};
