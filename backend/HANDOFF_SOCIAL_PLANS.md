# Handoff — Social Plans (mobile app wiring)

The server exposes a new tier of social-only packages. **Social plans
are NOT paid via Cardcom — they are redeemed by DEBITING the client's
existing coin balance.** This handoff describes the mobile wiring.

---

## What's new server-side

### 1. New `kind: "social"` in `cpanel_products`

Three docs are seeded + refreshed on every boot (idempotent — safe on
restart). On boot, the server runs `refreshSocialDefaults()` which
upserts these BY KEY, so any value drift is reset to the canonical
shape below:

| key                | name (he)  | price | coins | items (`social_ad`) | period   |
|--------------------|------------|-------|-------|---------------------|----------|
| `social_weekly`    | שבועי      | 349   | 349   | 5                   | week     |
| `social_biweekly`  | דו-שבועי   | 649   | 649   | 10                  | 2 weeks  |
| `social_monthly`   | חודשי      | 999   | 999   | 20                  | month    |

`price === coins` always — they represent the SAME number (cost in
coins), shown as the headline price on the card. The display "₪349"
on the card is informational; redemption never charges money.

Source of truth: [services/cpanel-products.service.js](services/cpanel-products.service.js) → `DEFAULT_SOCIAL`.

### 2. New mobile endpoints

```
GET  /api/packages/social
POST /api/packages/redeem-with-coins
```

**`GET /api/packages/social`** — returns the catalog (same response
shape as `GET /api/packages`):

```json
{
  "success": true,
  "packages": [
    {
      "_id": "...",
      "key": "social_weekly",
      "kind": "social",
      "name": "שבועי",
      "periodLabel": "שבועי",
      "price": 349,
      "coins": 349,
      "bullets": ["5 מודעות סושיאל", "מתאים לשבוע פעילות"],
      "items": { "ad": 0, "lp": 0, "video": 0, "logo": 0, "social_ad": 5 },
      "sortOrder": 1,
      "active": true
    },
    ...
  ]
}
```

**`POST /api/packages/redeem-with-coins`** — atomically debits coins
and activates the plan. Request:

```json
{ "phone": "0501234567", "packageKey": "social_weekly" }
```

Success response (HTTP 200):

```json
{
  "success": true,
  "packageName": "שבועי",
  "coinsCharged": 349,
  "coinsRemaining": 1234
}
```

Failure responses (HTTP 400/404):

```json
{
  "success": false,
  "reason": "insufficient_coins",
  "message": "אין מספיק טוקנים לרכישת החבילה",
  "coinsRequired":  349,
  "coinsAvailable": 80
}
```

```json
{ "success": false, "reason": "package_not_found", "message": "חבילה לא נמצאה" }
{ "success": false, "reason": "user_not_found",    "message": "לקוח לא נמצא" }
```

The debit is atomic (single `findOneAndUpdate` with `coins >= price`
guard), so two simultaneous taps can't double-spend. The second
firing returns `insufficient_coins` once the balance has dropped.

### 3. What gets written on success

- `users.coins` decremented by `price`.
- `users.coinsUsed` incremented by `price` (lifetime spend counter).
- `users.activePackage` set to `{ key, name, items, coins: 0, status: "waiting_brief", purchasedAt }`.
- `users.purchasedPackages` array gets the same entry pushed.
- `package_transactions` insert with `coinsCharged: price`, `coinsGranted: 0`, `source: "mobile-coins-redemption"`.
- `cpanel_pending_purchases` mirror row so the cPanel client history
  shows the redemption (with `coinsOverride: -price` to flag it as a debit).
- Manager notification (popup + WhatsApp/SMS) fired.
- Purchase webhook fired with `package.amount = 0`, `package.coinsGranted = -price`.

### 4. Cardcom is explicitly rejected for social plans

`POST /api/packages/purchase-iframe` and `/charge-token` will return
404 "חבילה לא נמצאה" if you pass a social `packageKey`. This is
deliberate — social plans must always go through the redeem endpoint.

---

## What you need to do in the mobile app

### Step 1 — Add two API calls

```ts
// Catalog
const socialPackages: SocialPackage[] = await fetch(`${API}/api/packages/social`)
  .then(r => r.json())
  .then(j => j.packages);

// Redeem (the buy button action)
const res = await fetch(`${API}/api/packages/redeem-with-coins`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ phone, packageKey }),
});
const data = await res.json();
if (data.success) {
  // show toast: "X coins charged, Y remaining", refresh user balance
} else if (data.reason === 'insufficient_coins') {
  // show: "need data.coinsRequired coins, you have data.coinsAvailable"
  // optionally route to the COINS top-up screen
} else {
  // show data.message
}
```

### Step 2 — Render the new "Social" section ABOVE PACKAGES

Section header: **`חבילות סושיאל`** (eyebrow: `Social`)
Subtitle: `הפעלה בתשלום טוקנים מיתרת הלקוח — ללא חיוב בכרטיס אשראי`

Card visual: same as the existing prebuilt cards — `name`, `price`
(display "₪349" or "🪙 349", your call — the price IS the coin cost),
`bullets`, `items`. Optional `periodLabel` chip for "שבועי" /
"דו-שבועי" / "חודשי".

Order in the screen, top to bottom:
1. **Social** (new — 3 cards, redeem with coins)
2. Packages (existing — Cardcom paid)
3. Coins (existing — Cardcom paid)

### Step 3 — Wire the "הפעל בטוקנים" / "קנה עכשיו" button

**Crucial:** show a confirmation dialog before calling redeem — once
the call succeeds, coins are gone. Example:

```ts
const ok = await confirm(
  `לחייב ${pkg.price} טוקנים מהיתרה עבור ${pkg.name}?`,
);
if (!ok) return;
const res = await redeemWithCoins(phone, pkg.key);
// handle as above
```

After success, **refresh the user's coin balance in your local
store** so the wallet UI updates instantly. The server has already
committed the debit.

### Step 4 — TypeScript type

```ts
export interface SocialPackage {
  _id: string;
  key: 'social_weekly' | 'social_biweekly' | 'social_monthly';
  kind: 'social';
  name: string;
  price: number;     // === coins
  coins: number;     // === price
  bullets: string[];
  items: Record<string, number>;
  periodLabel?: string;
  discountPct?: number;
  badge?: string;
  sortOrder: number;
}

export interface RedeemSuccess {
  success: true;
  packageName: string;
  coinsCharged: number;
  coinsRemaining: number;
}

export interface RedeemFailure {
  success: false;
  reason: 'insufficient_coins' | 'package_not_found' | 'user_not_found' | 'bad_input';
  message: string;
  coinsRequired?: number;
  coinsAvailable?: number;
}
```

---

## How to verify end-to-end

1. **Catalog visible** — `curl https://api.iconiqmedia.co.il/api/packages/social`
   returns the 3 plans with `price === coins`.
2. **Redeem happy path** — pick a test user with `coins >= 349`:
   ```
   curl -X POST https://api.iconiqmedia.co.il/api/packages/redeem-with-coins \
     -H 'Content-Type: application/json' \
     -d '{"phone":"0501234567","packageKey":"social_weekly"}'
   ```
   Expect `success: true`, `coinsCharged: 349`. Check that `users` doc
   shows `coins` dropped by 349 and `activePackage.key === "social_weekly"`.
3. **Insufficient coins** — drain the user's coins below 349 and retry.
   Expect HTTP 400 with `reason: "insufficient_coins"`,
   `coinsRequired: 349`, `coinsAvailable: <actual>`.
4. **Double-tap race** — fire the redeem twice in parallel. Exactly
   one should succeed; the other should return `insufficient_coins`
   (the balance is no longer ≥ 349 after the first debit).
5. **Cardcom blocked** — confirm `POST /api/packages/purchase-iframe`
   with `{ phone, packageKey: "social_weekly" }` returns 404.
6. **cPanel history** — the redemption appears in the client's
   billing history (with `coinsOverride: -349` for the negative grant).
7. **Manager notify + webhook** — the assigned manager gets the
   purchase popup + the purchase webhook fires with
   `package.amount: 0` and `package.coinsGranted: -349`.

---

## Edge cases / gotchas

- **No money UI.** The mobile screen should NOT route to Cardcom for
  social plans. Use only the redeem endpoint.
- **Refresh balance after redeem.** The user's `coins` field changed
  server-side; mirror it in your store or refetch the user.
- **Confirm before redeem.** Coins disappear immediately on success —
  always confirm with the user first.
- **Refund flow** — not implemented for redemption. If you need to
  reverse a redemption, do it via the admin refund endpoint AND
  manually credit the coins back; the existing
  `/api/cpanel/admin/refunds` flow assumes a money payment exists, so
  it will not work for a coin redemption out of the box.
- **Re-pricing** — admin can edit a social plan via
  `POST /api/cpanel/admin/catalog`, but note `refreshSocialDefaults()`
  runs on every boot and may overwrite the change. If you need
  persistent custom pricing, that migration needs an opt-out flag
  added — ping me.

Questions → ping me before shipping the mobile build.
