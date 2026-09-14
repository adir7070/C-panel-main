const { initAuthCreds, proto } = require("@whiskeysockets/baileys");
const DB = require("../utils/DB");

const COLLECTION = "wa_auth_keys";

// Replacer/reviver for Buffer serialization — same approach as Baileys internals
const replacer = (_, value) => {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { type: "Buffer", data: Buffer.from(value).toString("base64") };
  }
  if (value?.type === "Buffer" && Array.isArray(value.data)) {
    return { type: "Buffer", data: Buffer.from(value.data).toString("base64") };
  }
  return value;
};

const reviver = (_, value) => {
  if (
    typeof value === "object" &&
    value !== null &&
    value.type === "Buffer" &&
    typeof value.data === "string"
  ) {
    return Buffer.from(value.data, "base64");
  }
  return value;
};

function serialize(obj) {
  return JSON.stringify(obj, replacer);
}

function deserialize(str) {
  return JSON.parse(str, reviver);
}

// MongoDB-based auth state helpers
async function authGet(sessionId, keyType, keyId) {
  const row = await DB.collection(COLLECTION).findOne({
    session_id: sessionId,
    key_type: keyType,
    key_id: keyId,
  });
  return row ? row.data : null;
}

async function authSet(sessionId, keyType, keyId, data) {
  await DB.collection(COLLECTION).updateOne(
    { session_id: sessionId, key_type: keyType, key_id: keyId },
    {
      $set: {
        session_id: sessionId,
        key_type: keyType,
        key_id: keyId,
        data,
      },
    },
    { upsert: true },
  );
}

async function authDelete(sessionId, keyType, keyId) {
  await DB.collection(COLLECTION).deleteOne({
    session_id: sessionId,
    key_type: keyType,
    key_id: keyId,
  });
}

async function authDeleteAll(sessionId) {
  await DB.collection(COLLECTION).deleteMany({ session_id: sessionId });
}

/**
 * MongoDB-based auth state for Baileys.
 * Loads existing credentials or initializes new ones.
 */
async function useMongoAuthState(sessionId) {
  // Load or init credentials
  const credsRaw = await authGet(sessionId, "creds", "creds");
  const creds = credsRaw ? deserialize(credsRaw) : initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        async get(type, ids) {
          const result = {};
          for (const id of ids) {
            const raw = await authGet(sessionId, type, id);
            if (!raw) continue;
            let value = deserialize(raw);
            if (type === "app-state-sync-key" && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            result[id] = value;
          }
          return result;
        },
        async set(data) {
          const ops = [];
          for (const [type, typeData] of Object.entries(data)) {
            for (const [id, value] of Object.entries(typeData)) {
              if (value != null) {
                ops.push(authSet(sessionId, type, id, serialize(value)));
              } else {
                ops.push(authDelete(sessionId, type, id));
              }
            }
          }
          await Promise.all(ops);
        },
      },
    },
    async saveCreds() {
      await authSet(sessionId, "creds", "creds", serialize(creds));
    },
  };
}

module.exports = { useMongoAuthState, authDeleteAll };
