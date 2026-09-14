#!/usr/bin/env node
require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const { MongoClient } = require("mongodb");
const { v4: uuidv4 } = require("uuid");

const DEFAULTS = [
  { mimeType: "application/pdf", ext: "pdf", label: "PDF", maxSizeMb: 25 },
  { mimeType: "application/msword", ext: "doc", label: "Word", maxSizeMb: 25 },
  { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: "docx", label: "Word", maxSizeMb: 25 },
  { mimeType: "application/vnd.ms-excel", ext: "xls", label: "Excel", maxSizeMb: 25 },
  { mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: "xlsx", label: "Excel", maxSizeMb: 25 },
  { mimeType: "application/vnd.ms-powerpoint", ext: "ppt", label: "PowerPoint", maxSizeMb: 25 },
  { mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", ext: "pptx", label: "PowerPoint", maxSizeMb: 25 },
  { mimeType: "text/plain", ext: "txt", label: "Text", maxSizeMb: 5 },
];

async function run() {
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  const db = client.db();
  const col = db.collection("allowed_file_types");

  let inserted = 0, skipped = 0;
  for (const d of DEFAULTS) {
    const exists = await col.findOne({ ext: d.ext });
    if (exists) {
      console.log(`  skip — .${d.ext} already exists`);
      skipped++;
    } else {
      await col.insertOne({ _id: uuidv4(), ...d, createdAt: new Date() });
      console.log(`  added — .${d.ext} (${d.label})`);
      inserted++;
    }
  }

  console.log(`\nDone: ${inserted} inserted, ${skipped} skipped`);
  await client.close();
}

run().catch(e => { console.error(e.message); process.exit(1); });
