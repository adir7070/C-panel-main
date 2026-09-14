const { getDB } = require("../config/db");
const { generateBriefImages } = require("../services/campaign-brief.service");
const { billingEnabled } = require("../utils/billing");

const USERS_COL  = "users";
const TRANS_COL  = "package_transactions";

/* ── GET /api/campaign-brief/status/:phone ────────────────────────────────── */
exports.getStatus = async (req, res) => {
  try {
    const { phone } = req.params;
    if (!phone) return res.status(400).json({ error: "phone required" });

    const user = await getDB()
      .collection(USERS_COL)
      .findOne({ phone }, { projection: { purchasedPackages: 1 } });

    if (!user) return res.status(404).json({ error: "user not found" });

    const packages = user.purchasedPackages || [];
    const latest   = packages
      .filter(p => p.type === "campaign_brief")
      .sort((a, b) => new Date(b.purchasedAt) - new Date(a.purchasedAt))[0];

    if (!latest) return res.status(404).json({ error: "no campaign brief found" });

    const totalAds = (latest.package?.postCount ?? 0) + (latest.package?.carouselCount ?? 0);

    const images = (latest.images || []).map(img => ({
      adIndex:  img.index,
      type:     img.type,
      label:    img.label,
      imageUrl: img.imageUrl || (img.slides?.[0]?.imageUrl ?? null),
      title:    img.adContent?.headline      ?? null,
      body:     img.adContent?.subheadline   ?? null,
      slides:   img.slides   ?? null,
      status:   img.error    ? "failed" : "done",
      error:    img.error    ?? null,
    }));

    return res.json({
      status:     latest.status,
      totalAds,
      images,
      adErrors:   latest.facebookAdErrors ?? [],
      campaignId: latest.facebookCampaignId ?? null,
      adsetId:    latest.facebookAdsetId    ?? null,
      adCount:    (latest.facebookAdIds ?? []).length,
    });
  } catch (err) {
    console.error("[CampaignBrief] getStatus error:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── POST /api/campaign-brief/submit ──────────────────────────────────────── */
exports.submit = async (req, res) => {
  try {
    const { phone, campaignType, pkgData, servicesData, postDescriptions, review } = req.body;

    if (!phone) {
      return res.status(400).json({ error: "phone is required" });
    }

    const selectedPkg = pkgData?.selectedPkgData ?? null;
    // Free unless billing is switched back on — a zero cost skips the debit below.
    const cost        = billingEnabled() ? (Number(selectedPkg?.price) || 0) : 0;

    // CPANEL-style override: generate exactly N HQ ads (default 10) regardless
    // of the package's post count. Additive — when adCount is absent, the
    // original package-driven behavior is unchanged. Clamped 1..30.
    const adCount = Number(req.body.adCount) > 0
      ? Math.min(Math.floor(Number(req.body.adCount)), 30)
      : null;
    const db          = getDB();
    const now         = new Date();

    /* ── Atomic coin deduction ─────────────────────────────────────────────── */
    if (cost > 0) {
      const deducted = await db.collection(USERS_COL).findOneAndUpdate(
        { phone, coins: { $gte: cost } },
        {
          $inc: { coins: -cost, coinsUsed: cost },
          $set: { updatedAt: now },
        },
        { returnDocument: "after", projection: { coins: 1 } },
      );

      if (!deducted) {
        const user = await db.collection(USERS_COL).findOne(
          { phone },
          { projection: { coins: 1 } },
        );
        if (!user) return res.status(404).json({ error: "user not found" });
        return res.status(402).json({
          error:          "insufficient_coins",
          coinsRequired:  cost,
          coinsAvailable: user.coins || 0,
        });
      }

      /* Audit record */
      db.collection(TRANS_COL).insertOne({
        phone,
        packageKey:   `campaign_brief_${campaignType ?? "unknown"}`,
        packageName:  selectedPkg?.name ?? "קמפיין",
        amount:       0,
        coinsCharged: cost,
        coinsGranted: 0,
        source:       "mobile-campaign-brief",
        createdAt:    now,
      }).catch(err => console.warn("[CampaignBrief] transaction insert failed:", err.message));
    }

    const purchasedAt = now.toISOString();

    const briefEntry = {
      key:          "campaign_brief",
      type:         "campaign_brief",
      name:         selectedPkg?.name
        ? `קמפיין ${campaignType ?? ""} — ${selectedPkg.name}`.trim()
        : "קמפיין חדש",
      campaignType: campaignType ?? null,
      purchasedAt,
      status:       "generating",          // יתעדכן ל-images_ready אחרי הגנרציה
      package: (selectedPkg || adCount)
        ? {
            id:           pkgData?.selectedPkgId ?? null,
            name:         selectedPkg?.name ?? "קמפיין",
            // adCount (when sent) forces N single-image ad posts, no carousels —
            // matching the CPANEL "10 marketing ads" flow.
            postCount:    adCount ?? (selectedPkg?.postCount ?? 0),
            carouselCount: adCount ? 0 : (selectedPkg?.carouselCount ?? 0),
            price:        selectedPkg?.price        ?? 0,
            billingCycle: pkgData?.billingCycle    ?? "monthly",
          }
        : null,
      services: (servicesData?.selectedData ?? []).map(s => ({ id: s.id, title: s.title })),
      postDescriptions: postDescriptions ?? {},
      review: {
        contactInfo: review?.contactInfo ?? [],
        ctaText:
          review?.selectedCTA === "אחר - מותאם אישית"
            ? review?.customCTAText ?? ""
            : review?.selectedCTA ?? "",
      },
      images: [],
    };

    const result = await getDB()
      .collection(USERS_COL)
      .updateOne(
        { phone },
        { $push: { purchasedPackages: briefEntry } },
        { upsert: false }
      );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: "user not found" });
    }

    console.log(`[CampaignBrief] ✅ brief saved for ${phone} — ${briefEntry.name}`);

    // תשובה מיידית — הגנרציה ממשיכה ב-background
    res.json({ success: true, purchasedAt });

    // ── Background image generation ──────────────────────────────────────────
    const briefData = {
      campaignType,
      package:          briefEntry.package,
      services:         briefEntry.services,
      postDescriptions: briefEntry.postDescriptions,
      review:           briefEntry.review,
      // FB creds the app carries (userToken/pageToken/pageId/adAccountId). When
      // present, injectCampaignToFacebook uses them; else it falls back to the
      // Fireberry/users lookup. Lets non-Fireberry mobile clients create campaigns.
      fbCreds:          req.body.facebook || null,
    };

    generateBriefImages(phone, purchasedAt, briefData).catch(err => {
      console.error(`[CampaignBrief] ❌ image generation failed for ${phone}:`, err.message);
    });

  } catch (err) {
    console.error("[CampaignBrief] submit error:", err.message);
    res.status(500).json({ error: err.message });
  }
};
