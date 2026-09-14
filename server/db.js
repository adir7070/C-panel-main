import { MongoClient } from "mongodb";

/* The panel's own MongoDB handle (leads, agent lookups). MONGO_URI is the
   backend's: the same database, which must be named in the URI path. */
const MONGO_URI = process.env.MONGO_URI || "";

let clientPromise = null;

export async function getDb() {
  if (!MONGO_URI) throw new Error("MONGO_URI is not set");
  if (!clientPromise) {
    const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 4000 });
    clientPromise = client.connect().then(async c => {
      const db = c.db(); // db name comes from the URI path
      await Promise.all([
        db.collection("agents").createIndex({ name: 1 }, { unique: true }),
        db.collection("leads").createIndex({ phone: 1 }),
        db.collection("leads").createIndex({ status: 1, assignedTo: 1, createdAt: -1 }),
      ]).catch(err => console.warn("[db] index creation warning:", err.message));
      console.log(`[db] connected → ${MONGO_URI.replace(/\/\/([^@]+)@/, "//***@")}`);
      return c;
    }).catch(err => {
      clientPromise = null;
      throw err;
    });
  }
  const client = await clientPromise;
  return client.db();
}
