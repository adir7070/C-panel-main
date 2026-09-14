const { MongoClient } = require("mongodb");
const DB = require("../utils/DB");

let mongoClient = null;
let awsMongoClient = null;
let db = null;

const connectDB = async () => {
  let primaryDb = null;
  let fallbackDb = null;

  // Primary: AWS EC2 MongoDB (local, fast)
  if (process.env.AWS_MONGO_URI) {
    try {
      awsMongoClient = new MongoClient(process.env.AWS_MONGO_URI, {
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 5000,
      });
      await awsMongoClient.connect();
      // Verify auth works (connect() succeeds even without credentials in MongoDB v6)
      await awsMongoClient.db().command({ ping: 1 });
      primaryDb = awsMongoClient.db();
      console.log("✅ AWS MongoDB connected (primary)");
    } catch (err) {
      console.error("⚠️ AWS MongoDB connection failed, will use Atlas as primary:", err.message);
    }
  }

  // Atlas: always connect (fallback or primary if AWS failed)
  try {
    mongoClient = new MongoClient(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
    });
    await mongoClient.connect();
    const atlasDb = mongoClient.db();
    console.log("✅ MongoDB Atlas connected");

    if (primaryDb) {
      // AWS is up — Atlas is fallback
      fallbackDb = atlasDb;
      db = primaryDb;
    } else {
      // AWS failed — Atlas becomes primary (no fallback)
      db = atlasDb;
      console.warn("⚠️ Running on Atlas only (AWS unavailable)");
    }
  } catch (err) {
    console.error("❌ MongoDB Atlas connection error:", err.message);
    if (primaryDb) {
      // Atlas failed but AWS is up — run on AWS only
      db = primaryDb;
      console.warn("⚠️ Running on AWS only (Atlas unavailable)");
    } else {
      throw new Error("Both databases unavailable: " + err.message);
    }
  }

  // Initialize the DB wrapper class with primary + fallback
  DB.init(db, fallbackDb);

  // Keep global.db for backward compatibility
  global.db = db;

  console.log(
    `✅ DB wrapper initialized — primary: ${primaryDb ? "AWS" : "Atlas"}, fallback: ${fallbackDb ? "Atlas" : "none"}`,
  );
  return db;
};

const getDB = () => {
  if (!db) {
    throw new Error("Database not connected. Call connectDB first.");
  }
  return db;
};

const closeDB = async () => {
  if (mongoClient) {
    await mongoClient.close();
    console.log("✅ MongoDB Atlas connection closed");
  }
  if (awsMongoClient) {
    await awsMongoClient.close();
    console.log("✅ AWS MongoDB connection closed");
  }
};

module.exports = { connectDB, getDB, closeDB, DB };
module.exports.db = new Proxy(
  {},
  {
    get: (target, prop) => {
      if (!db) {
        throw new Error("Database not connected. Call connectDB first.");
      }
      return db[prop];
    },
  },
);
