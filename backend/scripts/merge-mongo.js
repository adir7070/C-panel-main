/**
 * Merge Atlas ↔ AWS MongoDB
 * Source of truth: Atlas
 *   - Docs only in Atlas  → insert into AWS
 *   - Docs only in AWS    → insert into Atlas
 *   - Same _id, different content → Atlas wins (upsert into AWS)
 */

require("dotenv").config();
const { MongoClient } = require("mongodb");

// Large collections processed in batches (not fully loaded into memory)
const LARGE_COLS = new Set(["app_logs", "app_activity", "wa_health_log", "wa_auth_keys"]);
const BATCH_SIZE = 500;

async function mergeLargeCollection(atlasCol, awsCol, colName) {
  console.log(`\n🔄 [LARGE] ${colName} — streaming in batches...`);
  let insertedAws = 0, insertedAtlas = 0;

  // Pass 1: Atlas → AWS (insert missing)
  const atlasCursor = atlasCol.find({}, { projection: { _id: 1 } });
  const awsIds = new Set(
    (await awsCol.find({}, { projection: { _id: 1 } }).toArray()).map((d) => d._id.toString())
  );

  let batch = [];
  for await (const doc of atlasCursor) {
    if (!awsIds.has(doc._id.toString())) {
      const full = await atlasCol.findOne({ _id: doc._id });
      batch.push(full);
      if (batch.length >= BATCH_SIZE) {
        await awsCol.insertMany(batch, { ordered: false }).catch(() => {});
        insertedAws += batch.length;
        batch = [];
        process.stdout.write(`\r  AWS ← Atlas: ${insertedAws} inserted...`);
      }
    }
  }
  if (batch.length > 0) {
    await awsCol.insertMany(batch, { ordered: false }).catch(() => {});
    insertedAws += batch.length;
  }

  // Pass 2: AWS → Atlas (insert missing)
  const atlasIds = new Set(
    (await atlasCol.find({}, { projection: { _id: 1 } }).toArray()).map((d) => d._id.toString())
  );
  const awsCursor = awsCol.find({}, { projection: { _id: 1 } });
  batch = [];
  for await (const doc of awsCursor) {
    if (!atlasIds.has(doc._id.toString())) {
      const full = await awsCol.findOne({ _id: doc._id });
      batch.push(full);
      if (batch.length >= BATCH_SIZE) {
        await atlasCol.insertMany(batch, { ordered: false }).catch(() => {});
        insertedAtlas += batch.length;
        batch = [];
        process.stdout.write(`\r  Atlas ← AWS: ${insertedAtlas} inserted...`);
      }
    }
  }
  if (batch.length > 0) {
    await atlasCol.insertMany(batch, { ordered: false }).catch(() => {});
    insertedAtlas += batch.length;
  }

  console.log(`\n  ✅ AWS ← Atlas: ${insertedAws} | Atlas ← AWS: ${insertedAtlas}`);
}

async function mergeCollection(atlasCol, awsCol, colName) {
  const atlasDocs = await atlasCol.find({}).toArray();
  const awsDocs = await awsCol.find({}).toArray();

  const atlasMap = new Map(atlasDocs.map((d) => [d._id.toString(), d]));
  const awsMap = new Map(awsDocs.map((d) => [d._id.toString(), d]));

  const toInsertAws = [];    // in Atlas, missing from AWS
  const toInsertAtlas = [];  // in AWS, missing from Atlas
  const toUpdateAws = [];    // conflict → Atlas wins
  let alreadySynced = 0;

  for (const [id, doc] of atlasMap) {
    if (!awsMap.has(id)) {
      toInsertAws.push(doc);
    } else {
      const awsDoc = awsMap.get(id);
      const same = JSON.stringify(doc) === JSON.stringify(awsDoc);
      if (!same) toUpdateAws.push(doc);
      else alreadySynced++;
    }
  }

  for (const [id, doc] of awsMap) {
    if (!atlasMap.has(id)) toInsertAtlas.push(doc);
  }

  // Execute
  if (toInsertAws.length > 0) {
    for (let i = 0; i < toInsertAws.length; i += BATCH_SIZE) {
      await awsCol.insertMany(toInsertAws.slice(i, i + BATCH_SIZE), { ordered: false }).catch(() => {});
    }
  }

  if (toInsertAtlas.length > 0) {
    for (let i = 0; i < toInsertAtlas.length; i += BATCH_SIZE) {
      await atlasCol.insertMany(toInsertAtlas.slice(i, i + BATCH_SIZE), { ordered: false }).catch(() => {});
    }
  }

  if (toUpdateAws.length > 0) {
    const bulkOps = toUpdateAws.map((doc) => ({
      replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true },
    }));
    for (let i = 0; i < bulkOps.length; i += BATCH_SIZE) {
      await awsCol.bulkWrite(bulkOps.slice(i, i + BATCH_SIZE), { ordered: false }).catch(() => {});
    }
  }

  const parts = [];
  if (toInsertAws.length) parts.push(`AWS ← Atlas: +${toInsertAws.length}`);
  if (toInsertAtlas.length) parts.push(`Atlas ← AWS: +${toInsertAtlas.length}`);
  if (toUpdateAws.length) parts.push(`conflicts (Atlas won): ${toUpdateAws.length}`);
  if (alreadySynced === atlasMap.size + awsMap.size - atlasMap.size) parts.push("already in sync");

  console.log(`  ${colName.padEnd(30)} ${parts.length ? parts.join(" | ") : "✓ in sync"}`);
}

async function main() {
  console.log("🚀 Starting MongoDB merge (Atlas = source of truth)...\n");

  const atlas = new MongoClient(process.env.MONGO_URI);
  const aws = new MongoClient(process.env.AWS_MONGO_URI);

  await atlas.connect();
  await aws.connect();
  console.log("✅ Both connections established\n");

  const atlasDb = atlas.db();
  const awsDb = aws.db();

  const atlasCols = (await atlasDb.listCollections().toArray()).map((c) => c.name).sort();
  const awsCols = (await awsDb.listCollections().toArray()).map((c) => c.name).sort();
  const allCols = [...new Set([...atlasCols, ...awsCols])].sort();

  console.log(`📦 Total collections to process: ${allCols.length}\n`);
  console.log("--- Small/Medium collections ---");

  for (const col of allCols) {
    if (LARGE_COLS.has(col)) continue;
    await mergeCollection(atlasDb.collection(col), awsDb.collection(col), col);
  }

  console.log("\n--- Large collections (streaming) ---");
  for (const col of LARGE_COLS) {
    await mergeLargeCollection(atlasDb.collection(col), awsDb.collection(col), col);
  }

  await atlas.close();
  await aws.close();

  console.log("\n✅ Merge complete!");
}

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});
