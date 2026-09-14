import crypto from "crypto";
import { promisify } from "util";
import express from "express";
import { ObjectId } from "mongodb";
import { getDb } from "./db.js";

const scryptAsync = promisify(crypto.scrypt);

/* ── Password hashing (scrypt, per-user salt, no external deps) ─────── */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export async function verifyPassword(password, stored) {
  if (!stored || typeof stored !== "string") return false;
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const candidate = await scryptAsync(String(password), salt, 64); // async: never blocks the event loop
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

/* ── Tokens (HMAC-signed, JWT-shaped, no external deps) ─────────────── */
const AUTH_SECRET = process.env.AUTH_SECRET || "";
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

function b64url(input) {
  return Buffer.from(input).toString("base64url");
}

export function signToken(payload) {
  if (!AUTH_SECRET) throw new Error("AUTH_SECRET חסר ב-.env");
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS }));
  const sig = crypto.createHmac("sha256", AUTH_SECRET).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

export function verifyToken(token) {
  if (!AUTH_SECRET || !token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = crypto.createHmac("sha256", AUTH_SECRET).update(`${header}.${body}`).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function publicAgent(doc) {
  return {
    id: String(doc._id),
    name: doc.name,
    nickname: doc.nickname || undefined,
    role: doc.role || "account_manager",
    phone: doc.phone || undefined,
  };
}

/* Agent ids: the panel's own seed script writes ObjectIds, while agents
   created by the main backend (iconiq-server's initAdmin / admin UI) use
   UUID strings for _id. Match either form. */
export function agentIdQuery(id) {
  const s = String(id ?? "");
  const or = [{ _id: s }];
  try { or.push({ _id: new ObjectId(s) }); } catch { /* not an ObjectId — fine */ }
  return { $or: or };
}

/* LOCAL_AUTH=0 → the main backend (behind API_TARGET) owns login and mints
   opaque tokens stored on agents.token; we validate against that same
   collection in the SHARED MongoDB instead of our HMAC tokens. */
const LOCAL_AUTH = process.env.LOCAL_AUTH !== "0";

/* Generic 500 — log the real error server-side, never echo it (Mongo URIs,
   config state and stack details must not reach the browser). */
export function serverError(res, err, ctx = "") {
  console.error(`[server-error]${ctx ? " " + ctx : ""}:`, err?.message || err);
  return res.status(500).json({ error: "server_error", message: "שגיאת שרת — נסה שוב מאוחר יותר" });
}

/* ── Login rate limit (in-memory, per IP + username) ─────────────────── */
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginAttempts = new Map(); // key → { count, resetAt }

function loginKey(req, name) {
  return `${req.ip}|${String(name || "").toLowerCase()}`;
}

function loginLimited(req, name) {
  const now = Date.now();
  const k = loginKey(req, name);
  const e = loginAttempts.get(k);
  if (e && e.resetAt > now && e.count >= LOGIN_MAX_ATTEMPTS) return true;
  if (loginAttempts.size > 10_000) loginAttempts.clear(); // crude memory cap
  return false;
}

function loginFailed(req, name) {
  const now = Date.now();
  const k = loginKey(req, name);
  const e = loginAttempts.get(k);
  if (!e || e.resetAt <= now) loginAttempts.set(k, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  else e.count++;
}

/* ── Middleware ──────────────────────────────────────────────────────── */
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "unauthorized", message: "נדרשת התחברות" });
  try {
    const db = await getDb();
    let agent = null;
    if (LOCAL_AUTH) {
      const payload = verifyToken(token);
      if (!payload?.id) return res.status(401).json({ error: "unauthorized", message: "נדרשת התחברות" });
      agent = await db.collection("agents").findOne({ ...agentIdQuery(payload.id), active: { $ne: false } });
    } else {
      // Opaque token minted by the main backend's /api/agents/login
      agent = await db.collection("agents").findOne({ token, active: { $ne: false } });
    }
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

/* ── Routes ──────────────────────────────────────────────────────────── */
export const authRouter = express.Router();
/* NOTE: the JSON body parser is attached per-route on purpose. A router-
   level `.use(express.json())` would drain the body of EVERY request that
   passes through here — including /api/** calls that fall through to the
   backend proxy — and the proxy would then forward an empty stream. */
const json = express.json({ limit: "64kb" });

// POST /api/agents/login  { name, password } → { agent, token }
authRouter.post("/api/agents/login", json, async (req, res) => {
  const { name, password } = req.body ?? {};
  if (!name || !password) return res.status(400).json({ error: "bad_request", message: "שם משתמש וסיסמה נדרשים" });
  if (loginLimited(req, name)) {
    return res.status(429).json({ error: "rate_limited", message: "יותר מדי ניסיונות התחברות — נסה שוב בעוד כמה דקות" });
  }
  try {
    const db = await getDb();
    const agent = await db.collection("agents").findOne({ name: String(name).trim() });
    const ok = agent ? await verifyPassword(password, agent.passwordHash) : false;
    if (!ok) {
      loginFailed(req, name);
      return res.status(401).json({ error: "invalid_credentials", message: "שם משתמש או סיסמה שגויים" });
    }
    if (agent.active === false) {
      return res.status(403).json({ error: "inactive", message: "המשתמש מנוטרל" });
    }
    loginAttempts.delete(loginKey(req, name));
    await db.collection("agents").updateOne({ _id: agent._id }, { $set: { lastActiveAt: new Date() } });
    const pub = publicAgent(agent);
    res.json({ agent: pub, token: signToken({ id: pub.id, role: pub.role }) });
  } catch (err) {
    serverError(res, err, "login");
  }
});

// GET /api/agents/me → { agent }
authRouter.get("/api/agents/me", requireAuth, (req, res) => {
  res.json({ agent: req.agent });
});

// GET /api/cpanel/account-managers → [{ id, name, phone }]
authRouter.get("/api/cpanel/account-managers", requireAuth, async (_req, res) => {
  try {
    const db = await getDb();
    const rows = await db.collection("agents")
      .find({ active: { $ne: false }, role: { $ne: "admin" } })
      .sort({ name: 1 }).toArray();
    res.json(rows.map(a => ({ id: String(a._id), name: a.name, phone: a.phone || "" })));
  } catch (err) {
    serverError(res, err, "account-managers");
  }
});

async function leadCountsByAgent(db) {
  const rows = await db.collection("leads").aggregate([
    { $match: { assignedTo: { $ne: null } } },
    { $group: { _id: "$assignedTo", n: { $sum: 1 } } },
  ]).toArray();
  return Object.fromEntries(rows.map(r => [r._id, r.n]));
}

function managerEntry(a, leadCount) {
  return {
    id: String(a._id),
    name: a.name,
    role: a.role || "account_manager",
    active: a.active !== false,
    clientCount: leadCount || 0,
    revenue: { lifetime: 0, month: 0, deals: 0 },
    commissions: { earned: 0, paid: 0, unpaid: 0 },
    openTasks: 0,
    lastActiveAt: a.lastActiveAt ? new Date(a.lastActiveAt).toISOString() : null,
    createdAt: a.createdAt ? new Date(a.createdAt).toISOString() : null,
  };
}

// GET /api/cpanel/admin/managers → { managers, total }  (shape the admin UI expects;
// revenue/commission figures are zero here — they lived in the old backend)
authRouter.get("/api/cpanel/admin/managers", requireAuth, requireAdmin, async (_req, res) => {
  try {
    const db = await getDb();
    const [rows, countBy] = await Promise.all([
      db.collection("agents").find({}).sort({ name: 1 }).toArray(),
      leadCountsByAgent(db),
    ]);
    const managers = rows.map(a => managerEntry(a, countBy[String(a._id)]));
    res.json({ managers, total: managers.length });
  } catch (err) {
    serverError(res, err, "admin/managers");
  }
});

