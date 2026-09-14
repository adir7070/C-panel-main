/**
 * One-time migration: copy all support_chats from AWS local MongoDB to Atlas.
 * Run once from AWS EC2 with full .env (AWS_MONGO_URI + MONGO_URI set).
 *
 * Usage: node scripts/migrate-aws-to-atlas.js
 */
require('dotenv').config();
const { MongoClient } = require('mongodb');

const BATCH_SIZE = 50;

async function migrate() {
  const awsUri = process.env.AWS_MONGO_URI;
  const atlasUri = process.env.MONGO_URI;

  if (!awsUri || !atlasUri) {
    console.error('ERROR: AWS_MONGO_URI and MONGO_URI must both be set in .env');
    process.exit(1);
  }

  const aws = new MongoClient(awsUri, { serverSelectionTimeoutMS: 8000 });
  const atlas = new MongoClient(atlasUri, { serverSelectionTimeoutMS: 10000 });

  await aws.connect();
  await atlas.connect();
  console.log('Connected to both databases');

  const awsChats = aws.db().collection('support_chats');
  const atlasChats = atlas.db().collection('support_chats');

  const total = await awsChats.countDocuments();
  console.log(`Total chats in AWS: ${total}`);

  let processed = 0;
  let inserted = 0;
  let merged = 0;
  let skipped = 0;

  const cursor = awsChats.find({});

  while (await cursor.hasNext()) {
    const batch = [];
    for (let i = 0; i < BATCH_SIZE && await cursor.hasNext(); i++) {
      batch.push(await cursor.next());
    }

    for (const chat of batch) {
      try {
        const existing = await atlasChats.findOne({ _id: chat._id }, { projection: { 'messages._id': 1 } });

        if (!existing) {
          await atlasChats.insertOne(chat);
          inserted++;
        } else {
          const existingIds = new Set((existing.messages || []).map(m => String(m._id)));
          const newMessages = (chat.messages || []).filter(m => !existingIds.has(String(m._id)));

          if (newMessages.length > 0) {
            await atlasChats.updateOne(
              { _id: chat._id },
              {
                $push: { messages: { $each: newMessages } },
                $set: { updated_at: chat.updated_at || new Date() },
              }
            );
            merged++;
          } else {
            skipped++;
          }
        }
      } catch (err) {
        console.error(`Error processing chat ${chat._id}:`, err.message);
      }

      processed++;
    }

    console.log(`Progress: ${processed}/${total} (inserted: ${inserted}, merged: ${merged}, skipped: ${skipped})`);
  }

  await cursor.close();
  await aws.close();
  await atlas.close();

  console.log(`\nMigration complete:`);
  console.log(`  Total processed: ${processed}`);
  console.log(`  Inserted (new):  ${inserted}`);
  console.log(`  Merged (gaps):   ${merged}`);
  console.log(`  Skipped (sync):  ${skipped}`);
}

migrate().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
