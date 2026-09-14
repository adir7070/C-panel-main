import { MongoClient } from "mongodb";

/* Local persistence for the parts of the backend that now live in this
   repo (agents/auth + leads). Defaults to a local mongod; on Heroku set
   MONGO_URI to your own Atlas cluster (this is a fresh database — no
   old cluster is referenced anywhere). */
const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/dashen-cpanel";

let clientPromise = null;

export async function getDb() {
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
