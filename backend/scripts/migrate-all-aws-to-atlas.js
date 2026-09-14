/**
 * Full migration: copy all collections from AWS MongoDB → Atlas.
 * Strategy: insert docs missing from Atlas, skip docs that already exist.
 * Support_chats: merge messages arrays (no duplicates).
 *
 * Usage: node scripts/migrate-all-aws-to-atlas.js
 */
require('dotenv').config();
const { MongoClient } = require('mongodb');

const BATCH_SIZE = 100;

// Collections to skip (large read-only logs that don't matter)
const SKIP_COLLECTIONS = ['logs', 'app_logs', 'audit_log', 'wa_health_log', 'db_fallback_logs', 'aiinvocations', 'bp_jobs', 'wa_auth_keys', 'app_activity', 'wa_clicks', 'scans'];

async function migrateCollection(awsDb, atlasDb, colName) {
  const awsCol   = awsDb.collection(colName);
  const atlasCol = atlasDb.collection(colName);

  const total = await awsCol.countDocuments();
  if (total === 0) { console.log(`  [${colName}] empty — skip`); return { inserted: 0, merged: 0, skipped: 0 }; }

  console.log(`\n  [${colName}] ${total} docs...`);

  let inserted = 0, merged = 0, skipped = 0, processed = 0;
  let lastId = null;

  while (true) {
    const query = lastId ? { _id: { $gt: lastId } } : {};
    const batch = await awsCol.find(query).sort({ _id: 1 }).limit(BATCH_SIZE).toArray();
    if (batch.length === 0) break;
    lastId = batch[batch.length - 1]._id;

    for (const doc of batch) {
      try {
        if (colName === 'support_chats') {
          // Merge messages array — don't overwrite Atlas version
          const existing = await atlasCol.findOne({ _id: doc._id }, { projection: { 'messages._id': 1 } });
          if (!existing) {
            await atlasCol.insertOne(doc);
            inserted++;
          } else {
            const existingIds = new Set((existing.messages || []).map(m => String(m._id)));
            const newMsgs = (doc.messages || []).filter(m => !existingIds.has(String(m._id)));
            if (newMsgs.length > 0) {
              await atlasCol.updateOne({ _id: doc._id }, { $push: { messages: { $each: newMsgs } } });
              merged++;
            } else {
              skipped++;
            }
          }
        } else {
          // For all other collections: insert only if missing in Atlas
          const exists = await atlasCol.findOne({ _id: doc._id }, { projection: { _id: 1 } });
          if (!exists) {
            await atlasCol.insertOne(doc);
            inserted++;
          } else {
            skipped++;
          }
        }
      } catch (err) {
        if (err.code === 11000) { skipped++; } // duplicate key
        else console.error(`    Error on ${doc._id}:`, err.message);
      }
      processed++;
    }

    if (total > 200) process.stdout.write(`\r    ${processed}/${total}`);
  }

  if (total > 200) process.stdout.write('\n');
  console.log(`    ✅ inserted: ${inserted}, merged: ${merged}, skipped (already in Atlas): ${skipped}`);
  return { inserted, merged, skipped };
}

async function main() {
  const awsUri   = process.env.AWS_MONGO_URI;
  const atlasUri = process.env.MONGO_URI;

  if (!awsUri || !atlasUri) {
    console.error('ERROR: AWS_MONGO_URI and MONGO_URI must both be set in .env');
    process.exit(1);
  }

  console.log('Connecting to AWS MongoDB...');
  const awsClient   = new MongoClient(awsUri,   { serverSelectionTimeoutMS: 8000 });
  const atlasClient = new MongoClient(atlasUri, { serverSelectionTimeoutMS: 10000 });

  await awsClient.connect();
  console.log('✅ AWS connected');
  await atlasClient.connect();
  console.log('✅ Atlas connected');

  const awsDb   = awsClient.db();
  const atlasDb = atlasClient.db();

  const collections = (await awsDb.listCollections().toArray()).map(c => c.name);
  const toMigrate   = collections.filter(c => !SKIP_COLLECTIONS.includes(c));

  console.log(`\nFound ${collections.length} collections. Migrating ${toMigrate.length} (skipping ${SKIP_COLLECTIONS.length} log collections).\n`);

  let totalInserted = 0, totalMerged = 0, totalSkipped = 0;

  for (const colName of toMigrate) {
    const result = await migrateCollection(awsDb, atlasDb, colName);
    totalInserted += result.inserted;
    totalMerged   += result.merged;
    totalSkipped  += result.skipped;
  }

  await awsClient.close();
  await atlasClient.close();

  console.log('\n════════════════════════════════════');
  console.log('Migration complete!');
  console.log(`  Inserted (new to Atlas): ${totalInserted}`);
  console.log(`  Merged (support_chats):  ${totalMerged}`);
  console.log(`  Skipped (already there): ${totalSkipped}`);
  console.log('════════════════════════════════════');
  console.log('\nNext step: remove AWS_MONGO_URI from Heroku Config Vars.');
}

main().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
