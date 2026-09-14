const cardcomService = require("../services/cardcom.service");
const { getDB } = require("../config/db");
const { ObjectId } = require("mongodb");
const { sendPurchaseWebhook } = require("../utils/purchase-webhook");
const { createReceipt } = require("../utils/create-receipt");

// ─── Package lookup — checks new cpanel_products then falls back to coin_packages ─
async function getCoinsPackage(packageId) {
    const db = getDB();
    const newPkg = await db.collection("cpanel_products").findOne({ key: packageId, kind: "coins" });
    if (newPkg) return { ...newPkg, packageId: newPkg.key, label: newPkg.label || newPkg.name };
    return db.collection("coin_packages").findOne({ packageId });
}

// ─── Promotion helpers ────────────────────────────────────────────────────────

async function loadValidPromotion(promotionId) {
    if (!promotionId) return null;
    try {
        const promo = await getDB().collection("promotions").findOne({ _id: new ObjectId(promotionId) });
        if (!promo || !promo.isActive) return null;
        if (promo.expiresAt && new Date(promo.expiresAt) < new Date()) return null;
        if (promo.maxRedemptions && (promo.redemptionCount || 0) >= promo.maxRedemptions) return null;
        return promo;
    } catch { return null; }
}

async function hasAlreadyRedeemed(phone, promotionId) {
    const existing = await getDB().collection("promotion_redemptions").findOne({ phone, promotionId });
    return !!existing;
}

async function recordRedemption(phone, promo, promotionId, extra = {}) {
    await getDB().collection("promotions").updateOne(
        { _id: new ObjectId(promotionId) },
        { $inc: { redemptionCount: 1 } }
    );
    await getDB().collection("promotion_redemptions").insertOne({
        promotionId,
        promotionTitle: promo.title,
        actionType: promo.actionType,
        actionData: promo.actionData,
        phone,
        redeemedAt: new Date(),
        ...extra,
    });
}

function calcEffectivePrice(pkg, promo) {
    if (!promo || promo.actionType !== "coins_discount") return pkg.price;
    const ad = promo.actionData || {};
    if (ad.fixedPrice) return Number(ad.fixedPrice);
    if (ad.discountPct) return Math.round(pkg.price * (1 - Number(ad.discountPct) / 100) * 100) / 100;
    return pkg.price;
}

// יצירת מנוי חודשי (נקראת מהאפליקציה)
exports.createMonthlySubscription = async (req, res) => {
    console.log("1️⃣ Controller: Creating Subscription Request");

    try {
        // האפליקציה שולחת: planType, phone, userName
        // אנחנו נמיר את זה למה שהשירות צריך
        const { phone, userName, planType } = req.body;

        // שימוש בטלפון כמזהה ליד אם אין מזהה אחר
        const leadId = req.body.leadId || phone;

        if (!phone) {
            return res.status(400).json({ error: "חסר מספר טלפון" });
        }

        const result = await cardcomService.createMonthlySubscription({
            phone,
            leadId,
            clientName: userName,
        });

        if (result.success) {
            res.json({ url: result.url });
        } else {
            res.status(400).json({ error: "שגיאה ביצירת דף תשלום" });
        }

    } catch (error) {
        console.error("❌ Controller Error:", error.message);
        res.status(500).json({ error: error.message });
    }
};

// רכישת מטבעות
exports.createCoinPurchase = async (req, res) => {
    console.log("🪙 Controller: Creating Coin Purchase Request");

    try {
        const { phone, userName, package: packageId, saveCard, promotionId } = req.body;

        if (!phone) return res.status(400).json({ error: "חסר מספר טלפון" });
        if (!packageId) return res.status(400).json({ error: "חסרה חבילת מטבעות" });

        // Load promotion and check double-redemption
        const promo = await loadValidPromotion(promotionId);
        let overridePrice = null;
        let promotionLabel = null;

        if (promotionId && promo) {
            if (await hasAlreadyRedeemed(phone, promotionId)) {
                return res.status(409).json({ error: "המבצע כבר מומש בחשבון זה" });
            }
            const pkg = await getCoinsPackage(packageId);
            if (pkg) {
                overridePrice = calcEffectivePrice(pkg, promo);
                if (promo.actionType === "coins_discount") {
                    promotionLabel = promo.title;
                }
            }
        } else if (promotionId && !promo) {
            return res.status(410).json({ error: "המבצע אינו פעיל או פג תוקף" });
        }

        const result = await cardcomService.createCoinPurchase({
            phone,
            clientName: userName,
            packageId,
            saveCard: !!saveCard,
            overridePrice,
            promotionLabel,
        });

        if (result.success) {
            res.json({ url: result.url, lowProfileId: result.lowProfileId });
        } else {
            res.status(400).json({ error: "שגיאה ביצירת דף תשלום" });
        }
    } catch (error) {
        console.error("❌ Coin Purchase Controller Error:", error.message);
        res.status(500).json({ error: error.message });
    }
};

// חיוב ישיר עם פרטי כרטיס
exports.chargeDirect = async (req, res) => {
    console.log("💳 Controller: Direct Payment Request");

    try {
        const { phone, packageId, cardNumber, expiry, cvv, cardholderName, saveCard } = req.body;

        if (!phone) return res.status(400).json({ error: "חסר מספר טלפון" });
        if (!packageId) return res.status(400).json({ error: "חסרה חבילת מטבעות" });
        if (!cardNumber || !expiry || !cvv) return res.status(400).json({ error: "חסרים פרטי כרטיס" });

        const result = await cardcomService.chargeDirectPayment({
            phone, packageId, cardNumber, expiry, cvv, cardholderName, saveCard,
        });

        if (result.success) {
            // הוספת מטבעות
            await getDB().collection("users").updateOne(
                { phone },
                { $inc: { coins: result.coins }, $set: { updatedAt: new Date() } },
                { upsert: true }
            );

            // שמירת עסקה
            await getDB().collection("coin_transactions").insertOne({
                phone,
                type: "add",
                amount: result.coins,
                reason: "purchase",
                balance_after: null,
                created_at: new Date(),
            });

            // שמירת טוקן אם נוצר
            if (result.tokenInfo) {
                await getDB().collection("users").updateOne(
                    { phone },
                    { $set: {
                        paymentToken: result.tokenInfo.token,
                        paymentLast4: result.tokenInfo.last4,
                        paymentExpiry: result.tokenInfo.expiry,
                    } }
                );
            }

            res.json({ success: true, message: `${result.coins} מטבעות נוספו בהצלחה` });
        } else {
            res.status(400).json({ error: "התשלום נכשל" });
        }
    } catch (error) {
        console.error("❌ Direct Payment Controller Error:", error.message);
        res.status(500).json({ error: error.message });
    }
};

// חיוב אסימון שמור
exports.chargeToken = async (req, res) => {
    console.log("🔑 Controller: Token Payment Request");

    try {
        const { phone, packageId, promotionId } = req.body;

        if (!phone) return res.status(400).json({ error: "חסר מספר טלפון" });
        if (!packageId) return res.status(400).json({ error: "חסרה חבילת מטבעות" });

        const user = await getDB().collection("users").findOne({ phone });
        if (!user?.paymentToken) return res.status(400).json({ error: "לא נמצא כרטיס שמור" });

        // Promotion validation
        const promo = await loadValidPromotion(promotionId);
        let overridePrice = null;
        let bonusCoins = 0;

        if (promotionId && promo) {
            if (await hasAlreadyRedeemed(phone, promotionId)) {
                return res.status(409).json({ error: "המבצע כבר מומש בחשבון זה" });
            }
            const pkg = await getCoinsPackage(packageId);
            if (pkg) {
                overridePrice = calcEffectivePrice(pkg, promo);
                if (promo.actionType === "coins_bonus") {
                    bonusCoins = Number(promo.actionData?.bonusCoins || 0);
                }
            }
        } else if (promotionId && !promo) {
            return res.status(410).json({ error: "המבצע אינו פעיל או פג תוקף" });
        }

        const result = await cardcomService.chargeToken({
            phone,
            packageId,
            token: user.paymentToken,
            cardExpiry: user.paymentExpiry,
            overridePrice,
        });

        if (result.success) {
            const totalCoins = result.coins + bonusCoins;

            await getDB().collection("users").updateOne(
                { phone },
                { $inc: { coins: totalCoins }, $set: { updatedAt: new Date() } }
            );

            await getDB().collection("coin_transactions").insertOne({
                phone,
                type: "add",
                amount: totalCoins,
                baseCoins: result.coins,
                bonusCoins: bonusCoins || null,
                promotionId: promotionId || null,
                promotionTitle: promo?.title || null,
                reason: promotionId ? `רכישה במבצע: ${promo?.title || promotionId}` : "רכישה מהאפליקציה - כרטיס שמור",
                balance_after: null,
                created_at: new Date(),
            });

            if (promo) {
                await recordRedemption(phone, promo, promotionId, {
                    packageId,
                    baseCoins: result.coins,
                    bonusCoins: bonusCoins || null,
                });
            }

            const msg = bonusCoins > 0
                ? `${result.coins} מטבעות + ${bonusCoins} בונוס נוספו בהצלחה`
                : `${result.coins} מטבעות נוספו בהצלחה`;

            // Fire purchase webhook — fire-and-forget
            Promise.resolve().then(async () => {
                const clientMapping = await getDB().collection("cpanel_clients").findOne({ phone }, { projection: { agentId: 1 } });
                const agentDoc = clientMapping?.agentId
                    ? await getDB().collection("agents").findOne({ _id: clientMapping.agentId }, { projection: { name: 1, nickname: 1, email: 1, phone: 1 } })
                    : null;
                return sendPurchaseWebhook({
                    event:     "purchase_success",
                    source:    "mobile_app",
                    timestamp: new Date().toISOString(),
                    client:    { phone },
                    manager: {
                        id:    clientMapping?.agentId || null,
                        name:  agentDoc?.nickname || agentDoc?.name || null,
                        email: agentDoc?.email || null,
                        phone: agentDoc?.phone || null,
                    },
                    package: {
                        name:         packageId,
                        kind:         "coins",
                        amount:       overridePrice ?? result.amount ?? 0,
                        coinsGranted: totalCoins,
                        bonusCoins:   bonusCoins || 0,
                    },
                    payment: {
                        last4:   user.paymentLast4 || null,
                        expDate: user.paymentExpiry || null,
                    },
                });
            }).catch(err => console.warn("[Payment] token charge webhook failed:", err.message));

            createReceipt({ phone, type: "coins", description: packageId, amount: overridePrice ?? 0, coinsGranted: totalCoins, source: "mobile_app", lowProfileId: null }).catch(() => {});

            res.json({ success: true, coins: totalCoins, bonusCoins: bonusCoins || null, message: msg });
        } else {
            sendPurchaseWebhook({
                event:     "purchase_rejected",
                source:    "mobile_app",
                timestamp: new Date().toISOString(),
                client:    { phone },
                package:   { name: packageId, kind: "coins" },
                error:     "התשלום נכשל",
                payment:   { last4: user.paymentLast4 || null },
            }).catch(() => {});
            res.status(400).json({ error: "התשלום נכשל" });
        }
    } catch (error) {
        console.error("❌ Token Payment Controller Error:", error.message);
        res.status(500).json({ error: error.message });
    }
};

// קבלת פרטי כרטיס שמור
exports.getSavedCard = async (req, res) => {
    try {
        const { phone } = req.query;
        if (!phone) return res.status(400).json({ error: "חסר מספר טלפון" });

        const user = await getDB().collection("users").findOne({ phone });

        if (user?.paymentToken) {
            res.json({
                data: {
                    hasCard: true,
                    last4: user.paymentLast4 || "",
                    expiry: user.paymentExpiry || "",
                },
            });
        } else {
            res.json({ data: { hasCard: false } });
        }
    } catch (error) {
        console.error("❌ getSavedCard Error:", error.message);
        res.status(500).json({ error: error.message });
    }
};

// מחיקת כרטיס שמור
exports.deleteSavedCard = async (req, res) => {
    try {
        const { phone } = req.body;
        if (!phone) return res.status(400).json({ error: "חסר מספר טלפון" });

        await getDB().collection("users").updateOne(
            { phone },
            { $unset: { paymentToken: "", paymentLast4: "", paymentExpiry: "" } }
        );

        console.log("🗑️ Saved card deleted for:", phone);
        res.json({ success: true, message: "הכרטיס השמור נמחק בהצלחה" });
    } catch (error) {
        console.error("❌ deleteSavedCard Error:", error.message);
        res.status(500).json({ error: error.message });
    }
};

// ביטול מנוי
exports.cancelSubscription = async (req, res) => {
    try {
        const { subscriptionToken } = req.body;
        if (!subscriptionToken) return res.status(400).json({ error: "חסר טוקן" });

        const result = await cardcomService.cancelSubscription(subscriptionToken);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

// אימות תשלום LowProfile (אחרי שהמשתמש שילם ב-iframe)
exports.verifyPayment = async (req, res) => {
    console.log("🔍 Controller: Verify LowProfile Payment");

    try {
        const { lowProfileId, phone, packageId, saveCard, promotionId } = req.body;

        if (!lowProfileId) return res.status(400).json({ error: "חסר מזהה תשלום" });
        if (!phone) return res.status(400).json({ error: "חסר מספר טלפון" });
        if (!packageId) return res.status(400).json({ error: "חסרה חבילת מטבעות" });

        // 1. אימות מול קארדקום
        const result = await cardcomService.verifyLowProfilePayment(lowProfileId);
        if (result.ResponseCode !== 0) {
            sendPurchaseWebhook({
                event:     "purchase_rejected",
                source:    "mobile_app",
                timestamp: new Date().toISOString(),
                client:    { phone },
                package:   { name: packageId, kind: "coins" },
                error:     result.Description || "התשלום לא אושר",
                payment:   { lowProfileId },
            }).catch(() => {});
            return res.status(400).json({ success: false, message: result.Description || "התשלום לא אושר" });
        }

        // 2. בדיקת כפילות עסקה (lowProfileId)
        const existing = await getDB().collection("coin_transactions").findOne({ lowProfileId });
        if (existing) {
            return res.json({ success: true, coins: existing.amount, message: "העסקה כבר טופלה" });
        }

        // 3. שליפת חבילה
        const pkg = await getCoinsPackage(packageId);
        if (!pkg) return res.status(400).json({ success: false, message: "חבילה לא נמצאה" });

        // 4. מבצע — בדיקת כפילות per-user + חישוב בונוס
        const promo = await loadValidPromotion(promotionId);
        let bonusCoins = 0;

        if (promotionId && promo) {
            if (await hasAlreadyRedeemed(phone, promotionId)) {
                // התשלום כבר עבר — מוסיפים רק את המטבעות הבסיסיים ללא בונוס
                console.warn("[Promotions] already redeemed by", phone, "— skipping bonus");
            } else if (promo.actionType === "coins_bonus") {
                bonusCoins = Number(promo.actionData?.bonusCoins || 0);
            }
        }

        const effectiveCoins = pkg.coins + bonusCoins;

        // 5. הוספת מטבעות
        await getDB().collection("users").updateOne(
            { phone },
            { $inc: { coins: effectiveCoins }, $set: { updatedAt: new Date() } },
            { upsert: true }
        );

        // 6. תיעוד עסקה
        await getDB().collection("coin_transactions").insertOne({
            phone,
            type: "add",
            amount: effectiveCoins,
            baseCoins: pkg.coins,
            bonusCoins: bonusCoins || null,
            promotionId: promotionId || null,
            promotionTitle: promo?.title || null,
            reason: promotionId ? `רכישה במבצע: ${promo?.title || promotionId}` : "רכישה מהאפליקציה",
            lowProfileId,
            transactionId: result.TransactionId || null,
            balance_after: null,
            created_at: new Date(),
        });

        // 7. מימוש מבצע
        if (promo && bonusCoins >= 0) {
            await recordRedemption(phone, promo, promotionId, {
                packageId,
                baseCoins: pkg.coins,
                bonusCoins: bonusCoins || null,
            });
        }

        // 8. שמירת טוקן אם נוצר
        const tokenInfo = result.TokenInfo;
        const txnInfo = result.TranzactionInfo;
        if (saveCard && tokenInfo?.Token) {
            const month = String(tokenInfo.CardMonth).padStart(2, "0");
            const year = String(tokenInfo.CardYear).slice(-2);
            await getDB().collection("users").updateOne(
                { phone },
                { $set: {
                    paymentToken: tokenInfo.Token,
                    paymentLast4: txnInfo?.Last4CardDigitsString || String(txnInfo?.Last4CardDigits || ""),
                    paymentExpiry: month + year,
                } }
            );
            console.log("✅ Token saved for:", phone);
        }

        console.log("✅ LowProfile Payment Verified:", { phone, packageId, coins: effectiveCoins, bonusCoins, promotionId });
        createReceipt({ phone, type: "coins", description: pkg.label || pkg.name || packageId, amount: pkg.price || 0, coinsGranted: effectiveCoins, source: "mobile_app", lowProfileId }).catch(() => {});

        // Fire purchase webhook — fire-and-forget
        Promise.resolve().then(async () => {
            const clientMapping = await getDB().collection("cpanel_clients").findOne({ phone }, { projection: { agentId: 1 } });
            const agentDoc = clientMapping?.agentId
                ? await getDB().collection("agents").findOne({ _id: clientMapping.agentId }, { projection: { name: 1, nickname: 1, email: 1, phone: 1 } })
                : null;
            return sendPurchaseWebhook({
                event:     "purchase_success",
                source:    "mobile_app",
                timestamp: new Date().toISOString(),
                client:    { phone },
                manager: {
                    id:    clientMapping?.agentId || null,
                    name:  agentDoc?.nickname || agentDoc?.name || null,
                    email: agentDoc?.email || null,
                    phone: agentDoc?.phone || null,
                },
                package: {
                    name:         pkg.label || pkg.name || packageId,
                    kind:         "coins",
                    amount:       pkg.price || 0,
                    coinsGranted: effectiveCoins,
                    bonusCoins:   bonusCoins || 0,
                },
                payment: {
                    lowProfileId,
                    transactionId: result.TransactionId || null,
                    last4: txnInfo?.Last4CardDigitsString || String(txnInfo?.Last4CardDigits || "") || null,
                },
            });
        }).catch(err => console.warn("[Payment] verify webhook failed:", err.message));

        res.json({
            success: true,
            coins: effectiveCoins,
            bonusCoins: bonusCoins || null,
            message: bonusCoins > 0
                ? `${pkg.coins} מטבעות + ${bonusCoins} בונוס נוספו בהצלחה`
                : `${pkg.coins} מטבעות נוספו בהצלחה`,
        });
    } catch (error) {
        console.error("❌ Verify Payment Controller Error:", error.message);
        res.status(500).json({ error: error.message });
    }
};

exports.healthCheck = async (req, res) => {
    res.status(200).send("OK");
};