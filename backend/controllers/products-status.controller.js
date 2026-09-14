/**
 * Per-product status endpoints (independent of package-level lifecycle):
 *   GET  /cpanel/clients/:phone/products/status
 *   PUT  /cpanel/clients/:phone/products/:type/status
 *   POST /cpanel/clients/:phone/products/:type/send-to-client
 */

const { getDB } = require("../config/db");
const productStatusSvc = require("../services/product-status.service");
const { sendProductReadyPush } = require("../services/expo-push.service");

const TYPES = ["ads", "organic", "lp"];

/* GET — return all 3 product statuses for this client. */
exports.getProductStatuses = async (req, res) => {
  try {
    const { phone } = req.params;
    const [ads, organic, lp] = await Promise.all([
      productStatusSvc.getStatus("ads",     phone),
      productStatusSvc.getStatus("organic", phone),
      productStatusSvc.getStatus("lp",      phone),
    ]);
    res.json({ ads, organic, lp });
  } catch (err) {
    console.error("[products-status] getProductStatuses:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* PUT — manager manual transition (whitelisted). */
exports.updateProductStatus = async (req, res) => {
  try {
    const { phone, type } = req.params;
    const { status }      = req.body || {};
    if (!TYPES.includes(type)) {
      return res.status(400).json({ error: `type must be one of: ${TYPES.join(", ")}` });
    }
    const result = await productStatusSvc.applyManualTransition(type, phone, status);
    if (!result.ok) {
      const map = {
        BAD_TYPE:                  400,
        BAD_STATUS:                400,
        TRANSITION_NOT_ALLOWED:    409,
      };
      return res.status(map[result.code] || 400).json(result);
    }
    res.json({ success: true, current: result.current });
  } catch (err) {
    console.error("[products-status] updateProductStatus:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* POST — manager pushes a single product to the client for approval.
   Replaces the legacy whole-batch sendProductsForApproval flow per product. */
exports.sendProductToClient = async (req, res) => {
  try {
    const { phone, type } = req.params;
    if (!TYPES.includes(type)) {
      return res.status(400).json({ error: `type must be one of: ${TYPES.join(", ")}` });
    }

    const { productStatus, sessionExists } = await productStatusSvc.getStatus(type, phone);
    if (!sessionExists) {
      return res.status(400).json({ error: "NO_SESSION", productStatus });
    }
    if (productStatus !== "pending_manager_approval") {
      return res.status(400).json({ error: "STATUS_NOT_READY", productStatus });
    }

    /* For LP — ensure an approvalToken exists so the public /lp-preview
       URL works. The mobile app can't open the LP without this token. */
    if (type === "lp") {
      try {
        const wowLpSvc  = require("../services/wow-lp.service");
        const sess = await productStatusSvc.latestSession("lp", phone);
        if (sess && !sess.approvalToken && wowLpSvc.setApprovalToken) {
          await wowLpSvc.setApprovalToken(sess.sessionId);
        }
      } catch (e) {
        console.warn("[products-status] LP setApprovalToken failed (non-fatal):", e.message);
      }
    }

    /* Flip status — both productStatus and the legacy clientApprovalStatus
       (mirrored automatically inside setStatus). */
    await productStatusSvc.setStatus(type, phone, "sent_to_client");

    /* WhatsApp the client that this product is ready — the Expo push below
       only ever reached the retired mobile app. */
    await require("../services/client-notify.service").notify.productsReady(phone, { productType: type });

    /* Send Expo push (best-effort). */
    const user = await getDB().collection("users").findOne(
      { phone }, { projection: { expoToken: 1, expoPushToken: 1 } },
    );
    const token = user?.expoPushToken || user?.expoToken || null;
    const pushResult = await sendProductReadyPush(token, type);

    res.json({
      success:     true,
      productType: type,
      productStatus: "sent_to_client",
      pushSent:    !!pushResult.ok,
      pushReason:  pushResult.ok ? null : (pushResult.reason || pushResult.error || "unknown"),
    });
  } catch (err) {
    console.error("[products-status] sendProductToClient:", err.message);
    res.status(500).json({ error: err.message });
  }
};
