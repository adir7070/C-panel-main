#!/usr/bin/env node
/* Creates a panel user, or updates an existing one — only the flags you
   pass are changed (re-running with just --password resets the password
   and leaves role/phone/nickname untouched).
   Usage:
     node server/seedAdmin.js --name admin --password 'secret' [--role admin|supervisor|account_manager] [--phone 05...] [--nickname ...]
   Reads MONGO_URI from the environment (.env is loaded by `npm run seed:admin`). */
import { getDb } from "./db.js";
import { hashPassword } from "./auth.js";

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const name = arg("--name");
const password = arg("--password");
const role = arg("--role");
const phone = arg("--phone");
const nickname = arg("--nickname");

if (!name || !password) {
  console.error("usage: node server/seedAdmin.js --name <name> --password <password> [--role admin] [--phone 05...] [--nickname ...]");
  process.exit(1);
}
if (role && !["admin", "supervisor", "account_manager"].includes(role)) {
  console.error("role must be admin | supervisor | account_manager");
  process.exit(1);
}

const db = await getDb();
const now = new Date();
const $set = { passwordHash: hashPassword(password), active: true, updatedAt: now };
if (role) $set.role = role;
if (phone !== undefined) $set.phone = phone;
if (nickname !== undefined) $set.nickname = nickname;
const r = await db.collection("agents").updateOne(
  { name },
  { $set, $setOnInsert: { createdAt: now, ...(role ? {} : { role: "admin" }) } },
  { upsert: true },
);
const finalRole = role || (r.upsertedCount ? "admin" : "(unchanged)");
console.log(r.upsertedCount ? `created agent "${name}" (${finalRole})` : `updated agent "${name}" — role ${finalRole}`);
process.exit(0);
