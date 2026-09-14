const { getLatestSessionForPhone: getLpSession, setSectionImageFromUrl } =
  require("../services/wow-lp.service");
const { setAdImageFromUrl } =
  require("../services/wow-ads.service");
const { setOrganicPostImageFromUrl } =
  require("../services/wow-organic-ads.service");

exports.setImage = async (req, res) => {
  const { phone, imageType, itemId, imageUrl } = req.body ?? {};
  if (!phone || !imageType || !itemId || !imageUrl)
    return res.status(400).json({ error: "phone, imageType, itemId, imageUrl required" });

  try {
    if (imageType === "ads") {
      const result = await setAdImageFromUrl(phone, itemId, imageUrl);
      return res.json({ ok: true, ad: result });
    }
    if (imageType === "organic") {
      const result = await setOrganicPostImageFromUrl(phone, itemId, imageUrl);
      return res.json({ ok: true, post: result });
    }
    if (imageType === "lp") {
      const sess = await getLpSession(phone);
      if (!sess) return res.status(404).json({ error: "no active lp session" });
      const result = await setSectionImageFromUrl(sess.sessionId, itemId, imageUrl);
      return res.json({ ok: true, image: result });
    }
    return res.status(400).json({ error: 'imageType must be "ads" | "organic" | "lp"' });
  } catch (err) {
    console.error("[make/set-image]", err.message);
    res.status(500).json({ error: err.message });
  }
};
