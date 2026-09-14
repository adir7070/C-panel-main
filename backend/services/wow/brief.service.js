const { v4: uuidv4 } = require("uuid");
const { DB } = require("../../config/db");

const COL = "wow_briefs";

const saveBrief = async (data) => {
  const brief = {
    id: uuidv4(),
    createdAt: new Date().toISOString(),
    ...data,
    logo: null,
    photos: [],
    facePhoto: null,
  };
  await DB.collection(COL).insertOne(brief);
  return { briefId: brief.id };
};

const getBrief = async (id) => {
  const doc = await DB.collection(COL).findOne({ id });
  if (!doc) throw new Error(`Brief not found: ${id}`);
  return doc;
};

const updateBriefFiles = async (briefId, logo, photos, facePhoto) => {
  const set = { logo, photos };
  if (facePhoto !== undefined) set.facePhoto = facePhoto;
  await DB.collection(COL).updateOne({ id: briefId }, { $set: set });
};

module.exports = {
  saveBrief,
  getBrief,
  updateBriefFiles,
};
