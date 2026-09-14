const { getDB } = require("../config/db");
/* Canonical image normalizer shared with the cpanel read path so the app and
   the cpanel show the EXACT same photos (no drift). See utils/profileImages. */
const { normalizeImageUrl, canonicalizeProfileImages } = require("../utils/profileImages");

const getBusinessProfile = async (req, res) => {
  try {
    const { phone } = req.query;
    if (!phone) {
      return res.status(400).json({ success: false, message: "phone is required" });
    }

    const profile = await getDB()
      .collection("business_profiles")
      .findOne({ phone });

    if (!profile) {
      return res.status(404).json({ success: false, message: "Not found", data: null });
    }

    res.json({ success: true, data: canonicalizeProfileImages(profile) });
  } catch (err) {
    console.error("business-profile/get error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

const saveBusinessProfile = async (req, res) => {
  try {
    const {
      phone, businessName, businessPhone, address, email,
      categoryKey, subCategoryKeys, subCategoryCustom, services, logoUrl,
      about, targetAudience, preferredColors, socialLinks, promotion, designStyle, pageGoal,
      /* Manager toggles — control whether the wow-ads/lp/organic pipelines
         surface phone/address on generated creatives. Default off. */
      includePhoneInAds, includeAddressInAds,
    } = req.body;

    if (!phone) {
      return res.status(400).json({ success: false, message: "phone is required" });
    }

    // Check existing doc BEFORE update to know if reward was already given
    const existing = await getDB()
      .collection("business_profiles")
      .findOne({ phone }, { projection: { rewardGiven: 1 } });

    const alreadyRewarded = existing?.rewardGiven === true;

    // A profile counts as "complete" when at least businessName is filled in
    const isComplete = typeof businessName === "string" && businessName.trim().length > 0;
    const giveReward = !alreadyRewarded && isComplete;

    /* Sanitize logoUrl — the iOS app occasionally posts a local picker
       path (file:///var/mobile/Containers/.../ImagePicker/X.png) when
       the upload step silently fails. Persisting that path makes the
       cpanel show a broken image (browsers block file:// from remote
       origins). Accept only fully-qualified web URLs, app-proxy paths,
       and data: URIs; treat anything else as "no logo" so the manager
       can re-upload. Empty string is allowed (explicit clear). */
    const safeLogoUrl =
      logoUrl === undefined ? undefined
      : (typeof logoUrl === "string" && (
          logoUrl === "" ||
          /^https?:\/\//i.test(logoUrl) ||
          logoUrl.startsWith("/api") ||
          logoUrl.startsWith("data:image/")
        )) ? logoUrl
      : null;
    if (logoUrl !== undefined && safeLogoUrl !== logoUrl) {
      console.warn(`[business-profile] dropped non-web logoUrl for phone=${phone}: ${String(logoUrl).slice(0, 80)}`);
    }

    const updateData = {
      businessName: businessName || "",
      businessPhone: businessPhone || "",
      address: address || "",
      email: email || "",
      categoryKey: categoryKey || "",
      subCategoryKeys: Array.isArray(subCategoryKeys) ? subCategoryKeys : [],
      subCategoryCustom: subCategoryCustom || "",
      services: Array.isArray(services) ? services : [],
      ...(safeLogoUrl !== undefined ? { logoUrl: safeLogoUrl } : {}),
      /* Toggle persistence — only $set when explicitly provided as a
         boolean so we don't accidentally clear a previous value when
         the iOS app omits the field. */
      ...(typeof includePhoneInAds   === "boolean" ? { includePhoneInAds }   : {}),
      ...(typeof includeAddressInAds === "boolean" ? { includeAddressInAds } : {}),
      // WOW fields — only save if non-empty (never overwrite with empty strings/arrays/objects)
      ...(about ? { about } : {}),
      ...(Array.isArray(targetAudience) && targetAudience.length > 0 ? { targetAudience } : {}),
      ...(preferredColors && typeof preferredColors === "object" && Object.values(preferredColors).some(Boolean) ? { preferredColors } : {}),
      ...(socialLinks && typeof socialLinks === "object" && Object.values(socialLinks).some(Boolean) ? { socialLinks } : {}),
      ...(promotion ? { promotion } : {}),
      ...(designStyle ? { designStyle } : {}),
      ...(pageGoal ? { pageGoal } : {}),
      updatedAt: new Date(),
    };

    if (giveReward) {
      updateData.rewardGiven = true;
    }

    await getDB()
      .collection("business_profiles")
      .updateOne(
        { phone },
        { $set: updateData },
        { upsert: true },
      );

    res.json({ success: true, coinReward: giveReward });
  } catch (err) {
    console.error("business-profile/save error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

const addService = async (req, res) => {
  try {
    const { phone, service } = req.body;
    if (!phone) return res.status(400).json({ success: false, message: "phone is required" });
    if (!service?.title) return res.status(400).json({ success: false, message: "service.title is required" });

    await getDB()
      .collection("business_profiles")
      .updateOne(
        { phone },
        { $push: { services: service } },
      );

    res.json({ success: true });
  } catch (err) {
    console.error("business-profile/add-service error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

/* CANONICAL image fields, shared by the app AND the cpanel so the two stay
   in sync end-to-end:
     - client/general photos → business_profiles.images[]   (cap 20)
     - per-service photos    → services[].images[]          (cap 3)
   services[].imageUrl is kept = images[0] as a denormalized "primary" the
   ad/LP pipeline reads. (Legacy app data lived in generalImages[]; a
   one-time migration + the cpanel read-reconcile bridge the old field.) */
const MAX_GENERAL_IMAGES = 20;
const MAX_SERVICE_IMAGES = 3;

/* After mutating a service's images[], refresh imageUrl = images[0] so the
   pipeline's "primary image" stays correct without a cpanel save. */
async function resyncServiceImageUrl(col, phone, serviceId) {
  const doc = await col.findOne(
    { phone, "services.id": serviceId },
    { projection: { "services.$": 1 } },
  );
  const imgs = Array.isArray(doc?.services?.[0]?.images) ? doc.services[0].images : [];
  await col.updateOne(
    { phone, "services.id": serviceId },
    { $set: { "services.$.imageUrl": (typeof imgs[0] === "string" ? imgs[0] : "") } },
  );
}

const addImages = async (req, res) => {
  try {
    const { phone, urls, categoryType, serviceId } = req.body;
    if (!phone) return res.status(400).json({ success: false, message: "phone is required" });
    if (!Array.isArray(urls) || urls.length === 0) return res.status(400).json({ success: false, message: "urls array is required" });
    if (!["general", "service"].includes(categoryType)) return res.status(400).json({ success: false, message: "invalid categoryType" });

    // Normalize incoming URLs (drop data:/empties, bare path → proxy url) so we
    // never persist junk that one side renders and the other hides.
    const clean = urls.map(normalizeImageUrl).filter(Boolean);
    if (clean.length === 0) return res.status(400).json({ success: false, message: "no valid image urls" });
    const col = getDB().collection("business_profiles");

    if (categoryType === "general") {
      await col.updateOne(
        { phone },
        { $push: { images: { $each: clean, $slice: -MAX_GENERAL_IMAGES } } },
        { upsert: true },
      );
    } else {
      if (!serviceId) return res.status(400).json({ success: false, message: "serviceId is required for service category" });
      const r = await col.updateOne(
        { phone, "services.id": serviceId },
        { $push: { "services.$.images": { $each: clean, $slice: -MAX_SERVICE_IMAGES } } },
      );
      // No matching service → updateOne silently no-ops. Surface it so the app
      // doesn't show a phantom "saved" image that never persisted.
      if (r.matchedCount === 0) {
        return res.status(404).json({ success: false, message: "service not found for this phone+serviceId" });
      }
      await resyncServiceImageUrl(col, phone, serviceId);
    }

    res.json({ success: true });
  } catch (err) {
    console.error("business-profile/add-images error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

const removeImage = async (req, res) => {
  try {
    const { phone, url, categoryType, serviceId } = req.body;
    if (!phone || !url) return res.status(400).json({ success: false, message: "phone and url required" });
    const col = getDB().collection("business_profiles");
    if (categoryType === "general") {
      // $pull from the canonical field AND legacy generalImages so removing a
      // pre-migration photo still sticks.
      await col.updateOne({ phone }, { $pull: { images: url, generalImages: url } });
    } else {
      if (!serviceId) return res.status(400).json({ success: false, message: "serviceId required" });
      await col.updateOne({ phone, "services.id": serviceId }, { $pull: { "services.$.images": url } });
      await resyncServiceImageUrl(col, phone, serviceId);
    }
    res.json({ success: true });
  } catch (err) {
    console.error("business-profile/remove-image error:", err);
    res.status(500).json({ success: false });
  }
};

module.exports = { getBusinessProfile, saveBusinessProfile, addService, addImages, removeImage };
