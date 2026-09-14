/**
 * One-shot migration: canonicalize business_profiles image storage so the app
 * and the cpanel read/write the SAME photos end-to-end.
 *
 *   • client photos  → images[]  (legacy generalImages[] folded in, deduped, ≤20)
 *   • service photos → services[].images[]  (deduped, ≤3; seeded from imageUrl)
 *   • services[].imageUrl = images[0]  (denormalized primary for the pipeline)
 *   • drops data: base64 blobs (they bloat docs to ~600KB and render broken)
 *   • $unset generalImages   (retired — fully folded into images[])
 *
 * Runs through the app's own DB layer (config/db) so it hits the exact same
 * primary the live API uses.
 *
 *   DRY:   node scripts/canonicalize-profile-images.js        (prints, no write)
 *   APPLY: WRITE=1 node scripts/canonicalize-profile-images.js
 */
const { connectDB, getDB, closeDB } = require("../config/db");

const APPLY = !!process.env.WRITE;

function normalizeImageUrl(u) {
  const v = String(typeof u === "string" ? u : (u && u.url) || "").trim();
  if (!v || v.startsWith("data:")) return "";
  if (/^https?:\/\//i.test(v) || v.startsWith("/api/")) return v;
  return `/api/img?url=${encodeURIComponent(v.replace(/^\/+/, ""))}`;
}

function dedupeNormalized(list, cap) {
  const seen = new Set();
  const out = [];
  for (const u of Array.isArray(list) ? list : []) {
    const n = normalizeImageUrl(u);
    if (n && !seen.has(n)) { seen.add(n); out.push(n); }
  }
  return typeof cap === "number" ? out.slice(-cap) : out;
}

(async () => {
  await connectDB();
  const col = getDB().collection("business_profiles");
  const docs = await col.find({}).toArray();

  let scanned = 0, changed = 0, dataDropped = 0, generalFolded = 0, svcSeeded = 0;

  for (const bp of docs) {
    scanned++;
    const beforeImages = Array.isArray(bp.images) ? bp.images : [];
    const beforeGeneral = Array.isArray(bp.generalImages) ? bp.generalImages : [];

    dataDropped += [...beforeImages, ...beforeGeneral].filter(
      (u) => typeof u === "string" && u.startsWith("data:")
    ).length;
    generalFolded += beforeGeneral.length;

    const images = dedupeNormalized([...beforeImages, ...beforeGeneral], 20);

    const services = (Array.isArray(bp.services) ? bp.services : []).map((s) => {
      if (!s || typeof s !== "object") return s;
      let imgs = dedupeNormalized(s.images, 3);
      if (imgs.length === 0) {
        const seed = normalizeImageUrl(s.imageUrl);
        if (seed) { imgs = [seed]; svcSeeded++; }
      }
      return { ...s, images: imgs, imageUrl: imgs[0] || "" };
    });

    const set = { images, services };
    const update = { $set: set };
    if ("generalImages" in bp) update.$unset = { generalImages: "" };

    const sizeBefore = JSON.stringify({ images: beforeImages, generalImages: beforeGeneral, services: bp.services }).length;
    const sizeAfter = JSON.stringify({ images, services }).length;

    // Only count/write docs that actually change.
    const willChange =
      JSON.stringify(beforeImages) !== JSON.stringify(images) ||
      beforeGeneral.length > 0 ||
      JSON.stringify(bp.services || []) !== JSON.stringify(services);

    if (!willChange) continue;
    changed++;

    if (scanned <= 10 || changed <= 30) {
      console.log(
        `~ ${bp.phone}  images ${beforeImages.length}→${images.length}  ` +
        `general ${beforeGeneral.length}→0  svc ${(bp.services || []).length}  ` +
        `bytes ${sizeBefore}→${sizeAfter}`
      );
    }

    if (APPLY) {
      await col.updateOne({ _id: bp._id }, update);
    }
  }

  console.log("\n=== canonicalize-profile-images summary ===");
  console.log("mode:           ", APPLY ? "WRITE" : "DRY (no changes written)");
  console.log("profiles scanned:", scanned);
  console.log("profiles changed:", changed);
  console.log("data: blobs removed:", dataDropped);
  console.log("generalImages folded:", generalFolded);
  console.log("service imageUrls seeded into images[]:", svcSeeded);
  if (!APPLY) console.log("\nRe-run with  WRITE=1  to apply.");

  await closeDB();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
