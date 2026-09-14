/* ── Canonical business-profile image normalization ──────────────────────────
   SINGLE source of truth shared by the app API (business-profile.controller)
   and the cpanel API (cpanel.controller). Both read paths run every profile
   through canonicalizeProfileImages() so the app and the cpanel show the EXACT
   same photos — no drift, full end-to-end sync.

   Canonical storage:
     • client/general photos → images[]            (cap 20; legacy generalImages[] folded in)
     • per-service photos    → services[].images[] (cap 3; seeded from legacy imageUrl)
     • services[].imageUrl   = images[0]           (denormalized primary for the pipeline)

   Rules applied on every read:
     • drop data: base64 blobs (bloat the doc + render broken)
     • bare B2 path → /api/img proxy URL; http(s) and /api/ pass through
     • dedupe, preserving order. */

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

function canonicalizeProfileImages(bp) {
  if (!bp || typeof bp !== "object") return bp;
  const next = { ...bp };
  // Client/general photos — single canonical field, legacy generalImages folded in.
  next.images = dedupeNormalized([
    ...(Array.isArray(bp.images) ? bp.images : []),
    ...(Array.isArray(bp.generalImages) ? bp.generalImages : []),
  ], 20);
  // Retired: drop the legacy field from the response entirely. Do NOT emit it
  // as [] — that value flows back into the cpanel save payload and collides
  // with the $unset of generalImages there (Mongo "conflict at generalImages").
  delete next.generalImages;
  if (Array.isArray(bp.services)) {
    next.services = bp.services.map((s) => {
      if (!s || typeof s !== "object") return s;
      let imgs = dedupeNormalized(s.images, 3);
      // Legacy services stored only a single imageUrl — seed images[] from it.
      if (imgs.length === 0) {
        const seed = normalizeImageUrl(s.imageUrl);
        if (seed) imgs = [seed];
      }
      return { ...s, images: imgs, imageUrl: imgs[0] || "" };
    });
  }
  return next;
}

/* Generation pipelines (ads / social): the merged set of CLIENT gallery refs —
   images[] + the legacy generalImages[] where the iOS app stored uploads —
   deduped, in their ORIGINAL form. Intentionally does NOT drop data: refs or
   rewrite bare paths: the pipelines hand each ref straight to fetchAssetBuffer,
   which already decodes data:, downloads /api/img proxy + bare B2 paths, and
   fetches absolute URLs. A photo reaches generation no matter which field
   holds it. */
function clientGalleryRefs(bp) {
  const seen = new Set();
  const out = [];
  for (const u of [
    ...(Array.isArray(bp && bp.images) ? bp.images : []),
    ...(Array.isArray(bp && bp.generalImages) ? bp.generalImages : []),
  ]) {
    if (typeof u === "string" && u.length > 0 && !seen.has(u)) { seen.add(u); out.push(u); }
  }
  return out;
}

module.exports = { normalizeImageUrl, dedupeNormalized, canonicalizeProfileImages, clientGalleryRefs };
