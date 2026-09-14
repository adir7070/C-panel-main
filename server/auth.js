import { ObjectId } from "mongodb";
import { getDb } from "./db.js";

/* Login lives in the backend (backend/controllers/agents.controller.js):
   it stores an opaque token on agents.token. The panel's own routes
   (leads, local ads) check that same token against the same database. */

export function publicAgent(doc) {
  return {
    id: String(doc._id),
    name: doc.name,
    nickname: doc.nickname || undefined,
    role: doc.role || "account_manager",
    phone: doc.phone || undefined,
  };
}

/* Agent ids: the backend's initAdmin / admin UI use UUID strings for _id,
   older agents may carry ObjectIds. Match either form. */
export function agentIdQuery(id) {
  const s = String(id ?? "");
  const or = [{ _id: s }];
  try { or.push({ _id: new ObjectId(s) }); } catch { /* not an ObjectId — fine */ }
  return { $or: or };
}

/* Generic 500 — log the real error server-side, never echo it (Mongo URIs,
   config state and stack details must not reach the browser). */
export function serverError(res, err, ctx = "") {
  console.error(`[server-error]${ctx ? " " + ctx : ""}:`, err?.message || err);
  return res.status(500).json({ error: "server_error", message: "שגיאת שרת — נסה שוב מאוחר יותר" });
}

/* ── Middleware ──────────────────────────────────────────────────────── */
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "unauthorized", message: "נדרשת התחברות" });
  try {
    const db = await getDb();
    const agent = await db.collection("agents").findOne({ token, active: { $ne: false } });
    if (!agent) return res.status(401).json({ error: "unauthorized", message: "המשתמש לא קיים או מנוטרל" });
    req.agent = publicAgent(agent);
    next();
  } catch (err) {
    serverError(res, err, "requireAuth");
  }
}

export function requireAdmin(req, res, next) {
  if (req.agent?.role !== "admin") {
    return res.status(403).json({ error: "forbidden", message: "פעולה זו זמינה למנהל מערכת בלבד" });
  }
  next();
}
