const { v4: uuidv4 } = require("uuid");
const { DB } = require("../../config/db");

const COL = "wow_sessions";

const emptyEdits = () => ({
  texts: {},
  images: {},
  colors: {},
  links: {},
  hiddenSections: [],
});

const createSession = async (briefId, templateOptions = []) => {
  const session = {
    id: uuidv4(),
    briefId,
    templateOptions,
    selectedTemplateId: null,
    edits: emptyEdits(),
    status: "templates-generated",
    createdAt: new Date().toISOString(),
  };
  await DB.collection(COL).insertOne(session);
  return session;
};

const getSession = async (id) => {
  const doc = await DB.collection(COL).findOne({ id });
  if (!doc) throw new Error(`Session not found: ${id}`);
  return doc;
};

const updateSession = async (id, updates) => {
  const current = await getSession(id);
  const merged = { ...current, ...updates };
  if (updates.edits) merged.edits = { ...current.edits, ...updates.edits };
  await DB.collection(COL).updateOne({ id }, { $set: merged });
  return merged;
};

const deleteSession = async (id) => {
  await DB.collection(COL).deleteOne({ id });
};

module.exports = {
  createSession,
  getSession,
  updateSession,
  deleteSession,
};
