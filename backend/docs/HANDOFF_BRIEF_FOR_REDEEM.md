# Server Change Request — Brief Data in `redeem-with-coins`

## Background

The mobile app collects brief answers from the client **before** calling
`POST /api/packages/redeem-with-coins`. We need the endpoint to accept
and persist that brief so the assigned manager can see the client's
intent when the purchase appears in cPanel.

---

## What needs to change

### 1. Accept `brief` in the request body

Current accepted body:
```json
{ "phone": "0501234567", "packageKey": "social_weekly" }
```

New accepted body (brief is **optional** — existing callers without it must still work):
```json
{
  "phone": "0501234567",
  "packageKey": "social_weekly",
  "brief": {
    "concept":       "מבצע קיץ על שמלות",
    "importantInfo": ["מחירים", "כתובת העסק"],
    "cta":           "דברו איתנו"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `concept` | `string` | Free-text campaign concept entered by the client |
| `importantInfo` | `string[]` | Array of info items selected by the client |
| `cta` | `string` | Call-to-action text |

---

### 2. Persist the brief alongside the package activation

When the brief is present, save it as part of the same atomic write.
Two places to write it:

**a) `users.activePackage`** — add a `brief` sub-document:
```js
activePackage: {
  key:         pkg.key,
  name:        pkg.name,
  items:       pkg.items,
  coins:       0,
  status:      "waiting_brief",
  purchasedAt: new Date(),
  brief: brief ?? null,   // ← new field
}
```

**b) `cpanel_pending_purchases`** mirror row — add the same `brief` field:
```js
{
  // ... existing fields ...
  brief: brief ?? null,   // ← new field
}
```

No separate collection or endpoint needed — just store it inline.

---

### 3. Include brief in the manager notification / webhook

The `notifyManagerOfPurchase` call and the purchase webhook already
fire on every redemption. Pass the brief through so it appears in the
cPanel popup and the Make.com webhook payload.

**Manager notification** — add to the existing payload:
```js
notifyManagerOfPurchase({
  clientPhone:   phone,
  businessName:  user.businessName,
  packageName:   pkg.name,
  amount:        0,
  coinsGranted:  0,
  brief,          // ← add this
});
```

**Purchase webhook** — add to the existing `package` object:
```js
{
  // ... existing fields ...
  brief: brief ?? null,   // ← add this
}
```

---

## Minimal code diff (pseudocode)

```js
exports.redeemWithCoins = async (req, res) => {
  const { phone, packageKey, brief } = req.body;   // ← destructure brief

  // --- existing validation & coin debit logic unchanged ---

  // Write activePackage (add brief)
  await db.collection("users").findOneAndUpdate(
    { phone, coins: { $gte: pkg.price } },
    {
      $inc: { coins: -pkg.price, coinsUsed: pkg.price },
      $set: {
        activePackage: {
          key:         pkg.key,
          name:        pkg.name,
          items:       pkg.items,
          coins:       0,
          status:      "waiting_brief",
          purchasedAt: new Date(),
          brief:       brief ?? null,   // ← new
        },
      },
      $push: { purchasedPackages: { /* same object */ } },
    },
  );

  // cpanel_pending_purchases (add brief)
  await db.collection("cpanel_pending_purchases").insertOne({
    // ... existing fields ...
    brief: brief ?? null,   // ← new
  });

  // Notify manager (pass brief)
  notifyManagerOfPurchase({ ..., brief });   // ← new

  // Webhook (pass brief)
  fireWebhook({ ..., brief });              // ← new

  return res.json({ success: true, packageName: pkg.name, coinsCharged: pkg.price, coinsRemaining: user.coins });
};
```

---

## What does NOT change

- The coin debit logic is untouched.
- `brief` is fully optional — if the caller omits it the endpoint works exactly as before.
- No new routes, collections, or migrations needed.
- The `GET /api/packages/social` endpoint is unchanged.
- Response shape is unchanged.

---

## Verification

After the change, run:

```bash
curl -X POST https://api.iconiqmedia.co.il/api/packages/redeem-with-coins \
  -H 'Content-Type: application/json' \
  -d '{
    "phone": "<test-phone-with-coins>",
    "packageKey": "social_weekly",
    "brief": {
      "concept": "test concept",
      "importantInfo": ["מחירים"],
      "cta": "דברו איתנו"
    }
  }'
```

Expected result:
1. `success: true`, `coinsCharged: 349`.
2. `db.users.findOne({ phone })` → `activePackage.brief.concept === "test concept"`.
3. `db.cpanel_pending_purchases.findOne(...)` → `brief` field present.
4. Manager notification includes the brief text.
5. Webhook payload includes `brief`.

---

*Questions → ping before shipping.*
