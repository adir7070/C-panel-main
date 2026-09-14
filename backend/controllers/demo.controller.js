const DB = require('../utils/DB');

const COLLECTION = 'demo_settings';
const DOC_ID = 'demo_ads';

const getDemoAds = async (req, res) => {
  try {
    const doc = await DB.collection(COLLECTION).findOne({ _id: DOC_ID });
    return res.json({ ads: doc?.ads ?? [] });
  } catch (e) {
    console.error('[Demo] getDemoAds error:', e);
    return res.status(500).json({ error: 'שגיאת שרת' });
  }
};

const saveDemoAds = async (req, res) => {
  try {
    const { ads } = req.body;
    if (!Array.isArray(ads)) return res.status(400).json({ error: 'ads חייב להיות מערך' });

    await DB.collection(COLLECTION).updateOne(
      { _id: DOC_ID },
      { $set: { ads } },
      { upsert: true }
    );
    return res.json({ success: true, count: ads.length });
  } catch (e) {
    console.error('[Demo] saveDemoAds error:', e);
    return res.status(500).json({ error: 'שגיאת שרת' });
  }
};

module.exports = { getDemoAds, saveDemoAds };
