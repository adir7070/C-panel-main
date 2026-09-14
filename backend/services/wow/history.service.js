const { DB } = require("../../config/db");

const COL = "wow_history";

const recordPublish = async ({ phone, sessionId, briefId, url, s3Url, businessName }) => {
  const set = {
    phone,
    briefId,
    businessName: businessName || null,
    publishedAt: new Date().toISOString(),
  };
  if (url) set.url = url;
  if (s3Url) set.s3Url = s3Url;
  await DB.collection(COL).updateOne(
    { sessionId },
    { $set: set, $setOnInsert: { sessionId } },
    { upsert: true },
  );
  return { sessionId, ...set };
};

const listByPhone = async (phone, limit = 50) => {
  const cursor = DB.collection(COL)
    .find({ phone })
    .sort({ publishedAt: -1 })
    .limit(limit);
  return cursor.toArray();
};

module.exports = {
  recordPublish,
  listByPhone,
};
