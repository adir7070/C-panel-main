/**
 * One-shot (2026-11-22): replace the old Iconiq-era product catalog with the
 * 64 Dashen sales-kit services.
 *
 *   • backs up every cpanel_products document of the old kinds
 *     (item / prebuilt / social / coins) to a JSON file
 *   • deletes them
 *   • inserts any missing service (same as the boot seeding)
 *
 * The boot seeding no longer creates the old products, so this only has to
 * run once per database (local, then production).
 *
 * Run:  MONGO_URI=… node backend/scripts/replace-catalog-with-services.js            (dry run)
 * Run:  MONGO_URI=… node backend/scripts/replace-catalog-with-services.js --apply    (writes)
 * Optional: --backup=/path/to/file.json
 */
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");
const { DEFAULT_SERVICES } = require("../services/cpanel-products.service");

const APPLY = process.argv.includes("--apply");
const backupArg = process.argv.find(a => a.startsWith("--backup="));
const LEGACY_KINDS = ["item", "prebuilt", "social", "coins"];

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set");
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  try {
    const db = client.db(); // database name comes from the URI path
    const col = db.collection("cpanel_products");
    console.log(`database: ${db.databaseName}${APPLY ? "" : "  (dry run — pass --apply to write)"}`);

    const legacy = await col.find({ kind: { $in: LEGACY_KINDS } }).toArray();
    const existingKeys = new Set((await col.find({}, { projection: { key: 1 } }).toArray()).map(d => d.key));
    const missing = DEFAULT_SERVICES.filter(s => !existingKeys.has(s.key));
    console.log(`old products to delete: ${legacy.length}`);
    legacy.forEach(d => console.log(`  - [${d.kind}] ${d.key} · ${d.label || d.name || ""}`));
    console.log(`services to insert: ${missing.length} of ${DEFAULT_SERVICES.length}`);
    if (!APPLY) return;

    if (legacy.length) {
      const file = backupArg
        ? backupArg.slice("--backup=".length)
        : path.join(process.cwd(), `cpanel-products-backup-${db.databaseName}-${Date.now()}.json`);
      fs.writeFileSync(file, JSON.stringify(legacy, null, 2));
      console.log(`backup written: ${file}`);
      const r = await col.deleteMany({ _id: { $in: legacy.map(d => d._id) } });
      console.log(`deleted: ${r.deletedCount}`);
    }
    if (missing.length) {
      const now = new Date();
      const r = await col.insertMany(missing.map(s => ({ ...s, active: true, createdAt: now, updatedAt: now })), { ordered: false });
      console.log(`inserted: ${r.insertedCount}`);
    }
  } finally {
    await client.close();
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
