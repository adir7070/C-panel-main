/**
 * package-lifecycle.service — small helpers for the package-status kanban.
 *
 * The "שלח לצוות יצירה" button used to be the only way to flip
 * users.activePackage.status from "waiting_brief" → "sent_to_creation".
 * Since the manager IS the creation team in practice, we now bump
 * automatically the first time they kick off any AI generation pipeline
 * (ads / LP / organic / logo). The button still works for manual control,
 * but managers no longer need to click it.
 */

const { getDB } = require("../config/db");

/**
 * Flip activePackage.status to "sent_to_creation" if the client currently
 * sits at "waiting_brief". No-op for any other state. Soft-fails on errors
 * so it never blocks the actual generation pipeline that called it.
 *
 * @param {string} phone Client phone — primary key on users
 * @param {string} [reason] short label for the audit/log trail
 */
async function autoBumpToSentToCreation(phone, reason = "ai-generate") {
  if (!phone) return { skipped: "no-phone" };
  try {
    const db = getDB();
    const result = await db.collection("users").updateOne(
      { phone, "activePackage.status": "waiting_brief" },
      {
        $set: {
          "activePackage.status":          "sent_to_creation",
          "activePackage.statusUpdatedAt": new Date().toISOString(),
          "activePackage.autoBumpReason":  reason,
        },
      },
    );
    if (result.modifiedCount > 0) {
      console.log(`[lifecycle] ${phone}: waiting_brief → sent_to_creation (${reason})`);
      return { bumped: true };
    }
    return { bumped: false };
  } catch (err) {
    console.warn(`[lifecycle] auto-bump failed for ${phone}:`, err.message);
    return { error: err.message };
  }
}

module.exports = { autoBumpToSentToCreation };
