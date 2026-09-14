const axios = require("axios");
const cardcomConfig = require("../config/cardcom.config");
const { getDB } = require("../config/db");

const VAT_RATE = 0.18; // 18% מע"מ
const withVAT = (price) => Math.round(price * (1 + VAT_RATE) * 100) / 100;
exports.VAT_RATE = VAT_RATE;
exports.withVAT  = withVAT;

async function getPackageById(packageId) {
  const db = getDB();
  const newPkg = await db.collection("cpanel_products").findOne({ key: packageId, kind: "coins" });
  if (newPkg) return { ...newPkg, packageId: newPkg.key, label: newPkg.label || newPkg.name };
  return db.collection("coin_packages").findOne({ packageId });
}

// --- יצירת דף תשלום למנוי חודשי ---
exports.createMonthlySubscription = async (paymentData) => {
  const { phone, leadId, clientName } = paymentData;

  const amount = 1; // המחיר החודשי
  const description = "מנוי חודשי - אייקוניק (1 ₪)";

  console.log("🚀 Creating Monthly Subscription:", { leadId, phone, amount });

  // ה-Webhook צריך לקבל את הטוקן מקארדקום ולשמור אותו
  if (!cardcomConfig.notifyURL) throw new Error("legacy_cardcom_notify_not_configured");
  const MAKE_WEBHOOK_URL = `${cardcomConfig.notifyURL}?phone=${phone}&leadId=${leadId}&plan=monthly`;

  try {
    //      ISOCoinId: 2 = dollar, 1 = shekel.
    const requestBody = {
      TerminalNumber: cardcomConfig.terminal,
      ApiName: cardcomConfig.apiName,
      ApiPassword: cardcomConfig.apiPassword,

      // פרטי העסקה
      Amount: withVAT(amount),
      ISOCoinId: 2,
      ProductName: description,

      // URLs
      SuccessRedirectUrl: `${cardcomConfig.successURL}?leadId=${leadId}`,
      ErrorRedirectUrl: `${cardcomConfig.errorURL}?leadId=${leadId}`,
      NotifyURL: MAKE_WEBHOOK_URL,

      // מזהה ייחודי
      ReturnValue: leadId,

      // 🔑 החלק החשוב - הוראת קבע חודשית
      CreateInvoice: false, // לא צריך חשבונית אוטומטית
      IsCreateToken: true, // יצירת טוקן לחיובים עתידיים

      // J5 - הגדרת תשלום חוזר
      Operation: 2, // 2 = תשלום רגיל + יצירת טוקן

      // תשלומים נוספים — Bit תומך רק בשקלים, והמנוי הזה בדולר (ISOCoinId 2)
      IsApplePay: true,
      IsBit: false,
      IsGooglePay: true,

      // פרטי לקוח (אופציונלי אבל מומלץ)
      CustomerName: clientName || "",
      PhoneNumber: phone || "",
    };

    const response = await axios.post(cardcomConfig.apiUrl, requestBody);

    if (response.data.ResponseCode === 0) {
      console.log("✅ Payment page created:", response.data.Url);
      return {
        success: true,
        url: response.data.Url,
        lowProfileId: response.data.LowProfileId, // זה מה שצריך לשמור!
      };
    } else {
      throw new Error(response.data.Description || "שגיאה ביצירת דף תשלום");
    }
  } catch (error) {
    console.error("❌ Cardcom Create Error:", error.message);
    throw new Error("Failed to create payment page");
  }
};

// --- רכישת מטבעות (LowProfile iframe) ---
exports.createCoinPurchase = async (paymentData) => {
  const { phone, clientName, packageId, saveCard, overridePrice, promotionLabel } = paymentData;

  const pkg = await getPackageById(packageId);
  if (!pkg) {
    throw new Error("חבילת מטבעות לא תקינה");
  }

  const effectivePrice = overridePrice != null ? overridePrice : pkg.price;

  console.log("🪙 Creating Coin Purchase:", {
    phone,
    packageId,
    amount: effectivePrice,
    originalPrice: pkg.price,
    saveCard,
  });

  if (!cardcomConfig.notifyURL) throw new Error("legacy_cardcom_notify_not_configured");

  const MAKE_WEBHOOK_URL = `${cardcomConfig.notifyURL}?phone=${phone}&type=coins&package=${packageId}`;

  try {
    //      ISOCoinId: 2 = dollar, 1 = shekel.
    const productName = promotionLabel ? `${pkg.label} — ${promotionLabel}` : pkg.label;
    const requestBody = {
      TerminalNumber: cardcomConfig.terminal,
      ApiName: cardcomConfig.apiName,
      ApiPassword: cardcomConfig.apiPassword,

      // פרטי העסקה
      Amount: withVAT(effectivePrice),
      ISOCoinId: pkg.currencyCode ?? 1,
      ProductName: productName,

      // URLs
      SuccessRedirectUrl: `${cardcomConfig.successURL}?type=coins&package=${packageId}`,
      ErrorRedirectUrl: `${cardcomConfig.errorURL}?type=coins`,
      NotifyURL: MAKE_WEBHOOK_URL,

      // מזהה ייחודי — phone|packageId
      ReturnValue: `${phone}|${packageId}`,

      // שמירת כרטיס — אם המשתמש רוצה לשמור, ניצור טוקן
      CreateInvoice: false,
      IsCreateToken: saveCard ? true : false,
      Operation: saveCard ? 2 : 1, // 2 = תשלום + טוקן, 1 = תשלום רגיל

      // אמצעי תשלום
      IsApplePay: true,
      IsBit: true,
      IsGooglePay: true,

      // פרטי לקוח
      CustomerName: clientName || "",
      PhoneNumber: phone || "",
    };

    const response = await axios.post(cardcomConfig.apiUrl, requestBody);

    if (response.data.ResponseCode === 0) {
      console.log("✅ Coin purchase page created:", response.data.Url);
      return {
        success: true,
        url: response.data.Url,
        lowProfileId: response.data.LowProfileId,
      };
    } else {
      throw new Error(response.data.Description || "שגיאה ביצירת דף תשלום");
    }
  } catch (error) {
    console.error("❌ Cardcom Coin Purchase Error:", error.message);
    throw new Error("Failed to create coin purchase page");
  }
};

// --- אימות תשלום LowProfile (אחרי שהמשתמש שילם ב-iframe) ---
exports.verifyLowProfilePayment = async (lowProfileId) => {
  try {
    const response = await axios.post(
      "https://secure.cardcom.solutions/api/v11/LowProfile/GetLpResult",
      {
        TerminalNumber: cardcomConfig.terminal,
        ApiName: cardcomConfig.apiName,
        ApiPassword: cardcomConfig.apiPassword,
        LowProfileId: lowProfileId,
      },
    );

    console.log(
      "🔍 LowProfile Verify:",
      JSON.stringify(response.data, null, 2),
    );

    return response.data;
  } catch (error) {
    console.error(
      "❌ LowProfile Verify Error:",
      error.message,
      error.response?.data,
    );
    throw new Error("Failed to verify payment");
  }
};

// --- חיוב ישיר עם פרטי כרטיס (Do Transaction) ---
exports.chargeDirectPayment = async (paymentData) => {
  const {
    phone,
    packageId,
    cardNumber,
    expiry,
    cvv,
    cardholderName,
    saveCard,
  } = paymentData;

  const pkg = await getPackageById(packageId);
  if (!pkg) {
    throw new Error("חבילת מטבעות לא תקינה");
  }

  console.log("💳 Direct Payment:", {
    phone,
    packageId,
    amount: pkg.price,
    saveCard,
  });

  try {
    //      ISOCoinId: 2 = dollar, 1 = shekel.
    const requestBody = {
      TerminalNumber: Number(cardcomConfig.terminal),
      ApiName: cardcomConfig.apiName,
      Amount: withVAT(pkg.price),
      ISOCoinId: pkg.currencyCode ?? 1,
      CardNumber: cardNumber,
      CardExpirationMMYY: expiry,
      CVV2: cvv,
      CustomerName: cardholderName || "",
    };

    // אם רוצים לשמור כרטיס - ליצור טוקן
    if (saveCard) {
      requestBody.Advanced = { IsCreateToken: true };
    }

    const response = await axios.post(
      cardcomConfig.doTransactionUrl,
      requestBody,
    );

    const data = response.data;

    if (data.ResponseCode !== 0) {
      throw new Error(data.Description || "העסקה נדחתה");
    }

    console.log("✅ Direct Payment Success:", {
      transactionId: data.TransactionId,
    });

    // שמירת טוקן אם נוצר
    const tokenInfo =
      saveCard && data.Token
        ? {
            token: data.Token,
            last4: cardNumber.slice(-4),
            expiry: expiry,
          }
        : null;

    return {
      success: true,
      transactionId: data.TransactionId,
      coins: pkg.coins,
      tokenInfo,
    };
  } catch (error) {
    console.error("❌ Direct Payment Error:", error.message);
    throw new Error(
      error.response?.data?.Description ||
        error.message ||
        "שגיאה בחיוב הכרטיס",
    );
  }
};

// --- חיוב אסימון שמור ---
exports.chargeToken = async (paymentData) => {
  const { phone, packageId, token, cardExpiry, overridePrice } = paymentData;

  const pkg = await getPackageById(packageId);
  if (!pkg) {
    throw new Error("חבילת מטבעות לא תקינה");
  }

  const effectivePrice = overridePrice != null ? overridePrice : pkg.price;

  console.log("🔑 Token Payment:", { phone, packageId, amount: effectivePrice, originalPrice: pkg.price });

  try {
    //      ISOCoinId: 2 = dollar, 1 = shekel.
    const requestBody = {
      TerminalNumber: Number(cardcomConfig.terminal),
      ApiName: cardcomConfig.apiName,
      Amount: withVAT(effectivePrice),
      ISOCoinId: pkg.currencyCode ?? 1,
      Token: token,
      CardExpirationMMYY: cardExpiry,
    };

    const response = await axios.post(
      cardcomConfig.doTransactionUrl,
      requestBody,
    );

    const data = response.data;

    if (data.ResponseCode !== 0) {
      throw new Error(data.Description || "העסקה נדחתה");
    }

    console.log("✅ Token Payment Success:", {
      transactionId: data.TransactionId,
    });

    return {
      success: true,
      transactionId: data.TransactionId,
      coins: pkg.coins,
    };
  } catch (error) {
    console.error("❌ Token Payment Error:", error.message);
    throw new Error(
      error.response?.data?.Description ||
        error.message ||
        "שגיאה בחיוב האסימון",
    );
  }
};

/* --- חיוב טוקן גנרי (סכום חופשי) — לחידוש מנויים ---
   Unlike chargeToken (which is bound to the coin-package catalog), this
   charges an arbitrary amount against a saved card token. Used by the
   subscription renewal sweep. Charges the exact amount (no VAT added) so a
   "$300/month" plan is billed exactly $300. */
exports.chargeSavedToken = async ({ token, cardExpiry, amount, currency, phone, productName }) => {
  if (!token) throw new Error("missing token");
  if (!amount || amount <= 0) throw new Error("invalid amount");
  try {
    const requestBody = {
      TerminalNumber: Number(cardcomConfig.terminal),
      ApiName: cardcomConfig.apiName,
      Amount: amount,
      ISOCoinId: currency ?? 1,     // 2 = USD, 1 = ILS
      Token: token,
      CardExpirationMMYY: cardExpiry,
    };
    const response = await axios.post(cardcomConfig.doTransactionUrl, requestBody);
    const data = response.data;
    if (data.ResponseCode !== 0) throw new Error(data.Description || "העסקה נדחתה");
    console.log(`✅ chargeSavedToken success ${phone || ""} ${amount} (cur ${currency ?? 1}) txn=${data.TransactionId}`);
    return { success: true, transactionId: data.TransactionId };
  } catch (error) {
    console.error("❌ chargeSavedToken Error:", error.response?.data?.Description || error.message);
    return { success: false, error: error.response?.data?.Description || error.message };
  }
};

// --- ביטול מנוי ---
exports.cancelSubscription = async (subscriptionToken) => {
  if (!subscriptionToken) {
    throw new Error("Missing subscription token");
  }

  console.log("🛑 Cancelling Subscription:", subscriptionToken);

  try {
    const cancelBody = {
      TerminalNumber: cardcomConfig.terminal,
      ApiName: cardcomConfig.apiName,
      ApiPassword: cardcomConfig.apiPassword,
      LowProfileCode: subscriptionToken, // הטוקן ששמרנו
    };

    // API לביטול
    const CANCEL_URL =
      "https://secure.cardcom.solutions/api/v11/LowProfile/Cancel";

    const response = await axios.post(CANCEL_URL, cancelBody);

    if (response.data.ResponseCode === 0) {
      console.log("✅ Subscription Cancelled Successfully");
      return { success: true, message: "המנוי בוטל בהצלחה" };
    } else {
      throw new Error(response.data.Description || "שגיאה בביטול המנוי");
    }
  } catch (error) {
    console.error("❌ Cancel Error:", error.message);
    throw error;
  }
};

// --- בדיקת סטטוס מנוי ---
exports.getSubscriptionStatus = async (subscriptionToken) => {
  if (!subscriptionToken) {
    return { active: false };
  }

  try {
    const requestBody = {
      TerminalNumber: cardcomConfig.terminal,
      ApiName: cardcomConfig.apiName,
      ApiPassword: cardcomConfig.apiPassword,
      LowProfileCode: subscriptionToken,
    };

    const STATUS_URL =
      "https://secure.cardcom.solutions/api/v11/LowProfile/GetInfo";
    const response = await axios.post(STATUS_URL, requestBody);

    if (response.data.ResponseCode === 0) {
      return {
        active: true,
        details: response.data,
      };
    }

    return { active: false };
  } catch (error) {
    console.error("❌ Status Check Error:", error.message);
    return { active: false };
  }
};
