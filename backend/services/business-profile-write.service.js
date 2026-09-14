'use strict';

/**
 * business-profile-write — small write helpers the AI agent uses to file images
 * the client sends into their business_profiles doc. Mirrors the canonical rules
 * in controllers/business-profile.controller.js (kept in sync intentionally):
 *   - general/gallery photos → business_profiles.images[]   (cap 20)
 *   - per-service photos     → services[].images[]          (cap 3)
 *   - services[].imageUrl = images[0]  (denormalized "primary" the ad/LP pipeline reads)
 */

const { getDB } = require("../config/db");

const MAX_GENERAL_IMAGES = 20;
const MAX_SERVICE_IMAGES = 3;
const col = () => getDB().collection("business_profiles");

/** Add an image to the client's general gallery. */
async function addToGallery(phone, url) {
  if (!url) return { ok: false, error: "no url" };
  await col().updateOne(
    { phone: String(phone) },
    { $push: { images: { $each: [url], $slice: -MAX_GENERAL_IMAGES } } },
    { upsert: true },
  );
  return { ok: true };
}

/** Attach an image to a specific service + resync that service's primary imageUrl. */
async function addToService(phone, serviceId, url) {
  if (!url) return { ok: false, error: "no url" };
  if (!serviceId) return { ok: false, error: "serviceId required" };
  const r = await col().updateOne(
    { phone: String(phone), "services.id": serviceId },
    { $push: { "services.$.images": { $each: [url], $slice: -MAX_SERVICE_IMAGES } } },
  );
  if (r.matchedCount === 0) return { ok: false, error: "service not found for this phone+serviceId" };
  const doc = await col().findOne(
    { phone: String(phone), "services.id": serviceId },
    { projection: { "services.$": 1 } },
  );
  const imgs = Array.isArray(doc?.services?.[0]?.images) ? doc.services[0].images : [];
  await col().updateOne(
    { phone: String(phone), "services.id": serviceId },
    { $set: { "services.$.imageUrl": (typeof imgs[0] === "string" ? imgs[0] : "") } },
  );
  return { ok: true };
}

/** Update the client's characterization fields (only the ones provided). */
async function updateProfile(phone, fields = {}) {
  const $set = {};
  if (typeof fields.businessName === "string" && fields.businessName.trim()) $set.businessName = fields.businessName.trim();
  if (typeof fields.businessField === "string" && fields.businessField.trim()) $set.categoryKey = fields.businessField.trim(); // view maps categoryKey → businessField
  if (typeof fields.about === "string") $set.about = fields.about;
  if (Array.isArray(fields.targetAudience)) $set.targetAudience = fields.targetAudience.filter(x => typeof x === "string" && x.trim());
  if (typeof fields.designStyle === "string" && fields.designStyle.trim()) $set.designStyle = fields.designStyle.trim();
  if (fields.preferredColors && typeof fields.preferredColors === "object") $set.preferredColors = fields.preferredColors;
  if (!Object.keys($set).length) return { ok: false, error: "no valid fields to update" };
  $set.updatedAt = new Date();
  await col().updateOne({ phone: String(phone) }, { $set }, { upsert: true });
  return { ok: true, updated: Object.keys($set).filter(k => k !== "updatedAt") };
}

/** Add a service (matches the app's id shape so attach_image_to_service works). */
async function addService(phone, { title, description } = {}) {
  if (!title || !String(title).trim()) return { ok: false, error: "title required" };
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const service = { id, title: String(title).trim(), description: String(description || "").trim(), images: [], imageUrl: "" };
  await col().updateOne({ phone: String(phone) }, { $push: { services: service } }, { upsert: true });
  return { ok: true, serviceId: id, title: service.title };
}

/** Set the business logo. */
async function setLogo(phone, url) {
  if (!url) return { ok: false, error: "no url" };
  await col().updateOne({ phone: String(phone) }, { $set: { logoUrl: url } }, { upsert: true });
  return { ok: true };
}

module.exports = { addToGallery, addToService, updateProfile, addService, setLogo };
