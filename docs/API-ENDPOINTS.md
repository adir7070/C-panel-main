# API Endpoints Reference

All endpoints we built (or use) for the cpanel + client product flow.
For wiring the mobile app or any other consumer to the iconiq backend.

**Base URL:** `https://api.iconiqmedia.co.il`
**Auth:** Manager-facing routes need `Authorization: Bearer <JWT>` from `POST /api/agents/login`. Public review routes (token in URL) need NO auth — the token IS the credential.

All bodies + responses are JSON unless noted.

---

## Table of contents

1. [Auth](#auth)
2. [Clients](#clients)
3. [Package + Coins](#package--coins) — drives the products tab
4. [Wow Ads](#wow-ads) — manager-facing (phone-keyed)
5. [Wow Landing Page](#wow-landing-page) — manager-facing (phone-keyed)
6. [Wow Organic](#wow-organic) — manager-facing (phone-keyed)
7. [Consolidated Product Review](#consolidated-product-review) — send all to client
8. [Public Client Review](#public-client-review) — what the client app calls
9. [Facebook / Campaigns / Leads](#facebook--campaigns--leads)
10. [Misc](#misc)
11. [Error codes](#error-codes)

---

## Auth

### `POST /api/agents/login`
Auth: none.
```json
// Request
{ "name": "ariel", "password": "asd123" }

// Response 200
{
  "agent": { "id": "...", "name": "ariel", "nickname": "...", "role": "admin", "phone": "..." },
  "token": "eyJhbGciOi..."     // store in localStorage as "cpanel_token"
}
// Response 401: invalid credentials
```

### `GET /api/agents/me`
Auth: Bearer.
```json
{ "agent": { "id": "...", "name": "...", "role": "..." } }
```

---

## Clients

### `GET /api/cpanel/clients?search=<optional>`
Returns up to 200 clients, filtered by manager's scope.
```ts
Client[] = Array<{
  id: string;
  name: string;
  phone: string;
  logoUrl?: string;
  status: string;
  accountManagerId?: string;
  accountManagerName?: string;
  lastActive?: string;        // ISO
  hasPaymentToken: boolean;
  paymentLast4?: string;
  unread?: boolean;
  tier?: "GOLD" | "VIP" | "PRO" | "PLUS" | "SILVER" | "REGULAR";
  tierUpdatedAt?: string;
}>
```

### `POST /api/cpanel/clients/add`
```json
// Request
{ "phone": "0501234567" }

// Response
{ "success": true, "phone": "...", "name": "...", "alreadyExisted": false }
```

### `GET /api/cpanel/clients/:phone`
```ts
{
  chat: { id, name, phone, status, accountManagerId?, accountManagerName?, notes } | null;
  profile: object | null;       // business profile (characterization)
  payment: { hasToken: boolean; last4?: string; expiry?: string };
  adAccountId?: string;
  pageId?: string;
}
```

### `PUT /api/cpanel/clients/:phone/credentials`
Update FB credentials.
```json
{ "pageId": "1234", "adAccountId": "act_5678" }
// → { "success": true }
```

### `PUT /api/cpanel/clients/:phone/tier`
```json
{ "tier": "GOLD" }
// → { "success": true, "tier": "GOLD" }
```

### `GET /api/cpanel/clients/:phone/characterization`
```json
{ "businessProfile": { ... } | null, "adBrief": { ... } | null }
```

### `PUT /api/cpanel/clients/:phone/characterization`
```json
{ "businessProfile": { ... }, "adBriefAnswers": { ... } }
// → { "success": true }
```

### `GET /api/cpanel/clients/:phone/messages`
```ts
{ chatId: string | null; messages: ChatMessage[] }
```

### `GET /api/cpanel/clients/:phone/activity?limit=30`
```ts
{ events: ActivityEvent[] }
```

### `GET /api/cpanel/clients/:phone/presence`
```ts
{ online: boolean; lastSeenAt: string | null }
```

### `GET /api/cpanel/clients/:phone/app-data`
```ts
{ status, waSession, expoToken, waAutoMessage }
```

---

## Package + Coins

### `GET /api/cpanel/clients/:phone/package`
Returns the active package, or 404 if none.
```ts
{
  id: string;          // "platinum" | "premium" | "basic" | "custom"
  name: string;        // "חבילת פלטינום"
  purchasedAt: string; // ISO
  items: {
    paidAds:    number;  // ADS ads from FB/IG campaigns
    organicAds: number;  // organic social posts
    videos:     number;
    lps:        number;  // landing pages
    logos:      number;
  };
  coins:          number;
  coinsUsed:      number;
  coinsRemaining: number;
}
// 404: { "error": "No active package" }
```

### `POST /api/cpanel/clients/:phone/spend-coins`
Manual coin debit. Most product actions debit automatically; this is for ad-hoc.
```json
// Request
{ "amount": 25, "reason": "manual: extra revisions" }

// Response 200
{ "success": true, "balance": 1475 }

// Response 402 — Insufficient
{ "error": "Insufficient coins", "balance": 30 }
```

### `POST /api/cpanel/clients/:phone/package-payment-link`
Send a Cardcom payment link for a custom package.
```json
// Request
{
  "adsCount": 15,
  "landingPagesCount": 1,
  "videosCount": 1,
  "logosCount": 0,
  "socialAdsCount": 20,
  "totalOverride": 3490,                 // optional
  "descriptionOverride": "חבילת פלטינום",  // optional
  "coinsOverride": 1500,                  // optional
  "kind": "platinum"                      // optional package id
}

// Response
{ "success": true, "url": "https://secure.cardcom.solutions/...?lp=..." }
```
On payment success, Cardcom hits `payment-notify` webhook which writes `users.activePackage` and `$inc`s `users.coins`.

### `POST /api/cpanel/clients/:phone/package-charge-iframe`
Same but returns iframe-embeddable URL.

### `POST /api/cpanel/clients/:phone/charge`
Direct charge of saved card (no link).
```json
{ "amount": 200, "description": "..." }
// → { "success": true, "transactionId": "...", "receiptUrl": "..." }
```

---

## Wow Ads

All routes phone-keyed. Behind the scenes the bridge looks up `cpanel_wow_sessions` to find the underlying `sessionId`.

### `GET /api/cpanel/clients/:phone/wow-ads`
```ts
{
  session: {
    sessionId: string;
    status: "generating_texts" | "generating_prompts" | "generating_images" | "done" | "error";
    totalAds: number;
    completedCount: number;
    generatedAds: Array<{
      id: number;
      type: "regular" | "crazy" | "carousel";
      headline: string;
      description: string;
      cta: string;
      nanoPrompt?: string | null;
      imageUrl?: string | null;
      regeneratedAt?: string;
      editedAt?: string | null;
      managerApprovedAt?: string | null;
      error?: string;
    }>;
    error?: string;
    createdAt: string;
    updatedAt: string;
    clientApprovalStatus: "draft" | "sent" | "approved" | "rejected" | null;
    clientFeedback: string | null;
    clientApprovalToken: string | null;
    clientApprovedAt: string | null;
  } | null
}
```

### `GET /api/cpanel/clients/:phone/wow-ads/status`
Lighter polling endpoint.
```ts
{
  sessionId?: string;
  status?: "done" | "generating_images";
  totalAds?: number;
  completedCount?: number;
  hasImages?: number;
  session?: null;   // when no session exists
}
```

### `POST /api/cpanel/clients/:phone/wow-ads/generate`
**Cost: 50 coins.** Runs OpenAI text + Gemini image pipeline async.
```json
// Response 200
{ "success": true, "sessionId": "...", "status": "generating_texts" }

// 403: { "error": "NO_PACKAGE: client must purchase a package..." }
// 402: { "error": "INSUFFICIENT_COINS", "balance": 30, "cost": 50 }
// 400: { "error": "INCOMPLETE_PROFILE: businessName required" }
```

### `PUT /api/cpanel/clients/:phone/wow-ads/:adId`
Edit text fields (no AI).
```json
// Request — any subset of:
{ "headline": "...", "description": "...", "cta": "..." }

// Response
{ "success": true, "ad": { ... } }
```

### `POST /api/cpanel/clients/:phone/wow-ads/:adId/regenerate`
**Cost: 5 coins.** Re-runs Gemini for one ad.
```json
// Response
{ "success": true, "ad": { ... } }
```

### `POST /api/cpanel/clients/:phone/wow-ads/:adId/approve`
Toggle manager approval.
```json
// Request
{ "approved": true }

// Response
{ "success": true, "ad": { ..., "managerApprovedAt": "2026-..." } }
```

### `POST /api/cpanel/clients/:phone/wow-ads/:adId/image`
Upload manual replacement image. **Multipart form-data.**
```
Field 'image' = File (PNG/JPG, max 20 MB)
```
```json
// Response
{ "success": true, "ad": { ..., "imageUrl": "https://b2.backblazeb2.com/...", "uploadedFile": true } }
```

### `POST /api/cpanel/clients/:phone/wow-ads/send-approval`
Per-kind send (legacy — use the consolidated `/products/send-for-approval` instead).
```json
{ "success": true, "token": "uuid", "previewUrl": "...", "approvedCount": 7, "sentChannels": ["sms"] }
```

---

## Wow Landing Page

### `GET /api/cpanel/clients/:phone/wow-lp`
```ts
{
  session: {
    sessionId: string;
    status: "generating_content" | "generating_images" | "done" | "error";
    brand_strategy: object | null;
    landing_page: object | null;
    design_theme: object | null;
    images: Array<{ id: number; section: string; url?: string; error?: string; regeneratedAt?: string }>;
    totalImages: number;
    completedImages: number;
    approvalStatus: "draft" | "sent" | "approved" | "rejected";
    approvalToken: string;
    sentForApprovalAt: string;
    clientResponseAt: string;
    clientFeedback: string;
    error: string;
    createdAt: string;
    updatedAt: string;
  } | null
}
```

### `POST /api/cpanel/clients/:phone/wow-lp/generate`
**Cost: 100 coins.** Runs runGeminiPipeline async.
```json
{ "success": true, "sessionId": "...", "status": "generating_content" }
```

### `PATCH /api/cpanel/clients/:phone/wow-lp`
Apply manager edits to the landing_page JSON.
```json
// Request
{
  "patches": [
    { "path": ["header", "logoText"], "value": "MY BRAND" },
    { "path": ["sections", 0, "title"], "value": "..." }
  ]
}

// Response — full updated session
{ "session": { ... } }
```

### `POST /api/cpanel/clients/:phone/wow-lp/regenerate-image`
**Cost: 10 coins.** Re-gen single section image.
```json
// Request
{ "section": "hero-img" }

// Response
{ "success": true, "image": { "section": "hero-img", "url": "..." } }
```

### `POST /api/cpanel/clients/:phone/wow-lp/set-image`
Pick existing URL for a section.
```json
{ "section": "about-img", "url": "https://..." }
// → { "success": true, "image": { ... } }
```

### `POST /api/cpanel/clients/:phone/wow-lp/upload-image`
Upload manual file. **Multipart form-data.**
```
section = "hero-img"          (form field)
image   = <file>
```
```json
{ "success": true, "image": { "section": "hero-img", "url": "..." } }
```

### `POST /api/cpanel/clients/:phone/wow-lp/send-approval`
Per-kind send (legacy — use consolidated).

---

## Wow Organic

Same shape as wow-ads, but for organic social posts.

### `GET /api/cpanel/clients/:phone/wow-organic`
```ts
{
  session: {
    sessionId: string;
    status: "generating_texts" | "generating_images" | "done" | "error";
    totalPosts: number;
    completedCount: number;
    generatedPosts: Array<{
      id: number;
      type: "tip" | "story" | "behind" | "testimonial" | "question" | "carousel";
      headline: string;
      description: string;
      cta: string;
      imageUrl?: string;
      managerApprovedAt?: string | null;
      editedAt?: string | null;
      slides?: Array<{ id; imageUrl; title; body; caption }>;  // when type=carousel
    }>;
    clientApprovalStatus: "draft" | "sent" | "approved" | "rejected" | null;
    clientFeedback: string | null;
    clientApprovalToken: string | null;
    clientApprovedAt: string | null;
  } | null
}
```

### `POST /api/cpanel/clients/:phone/wow-organic/generate`
**Cost: 30 coins.**
```json
{ "success": true, "sessionId": "...", "status": "generating_texts" }
```

### `PUT  /api/cpanel/clients/:phone/wow-organic/:postId`
### `POST /api/cpanel/clients/:phone/wow-organic/:postId/regenerate` — **Cost: 3 coins**
### `POST /api/cpanel/clients/:phone/wow-organic/:postId/approve`
### `POST /api/cpanel/clients/:phone/wow-organic/:postId/image` — multipart
### `POST /api/cpanel/clients/:phone/wow-organic/send-approval` — legacy

(Same request/response shapes as the wow-ads equivalents.)

---

## Consolidated Product Review

This is the **primary** approval flow — one button, one SMS, all approved products in one client-facing review page.

### `POST /api/cpanel/clients/:phone/products/send-for-approval`
Manager-side. Gathers everything `managerApproved` across ads/organic/lp, creates one master token, sends one SMS.
```json
// Request body — empty
{}

// Response
{
  "success": true,
  "token": "uuid",
  "previewUrl": "https://app.iconiqmedia.co.il/products-review/<token>",
  "summary": { "adsApproved": 7, "organicApproved": 5, "lpApproved": true },
  "sentChannels": ["sms"]
}

// 400 — nothing approved yet
{ "error": "אין מוצרים מאושרים לשליחה — אשר תחילה לפחות פריט אחד" }
```

### `GET /api/cpanel/clients/:phone/products/latest-review`
Manager-side. Most recent review (or null). Drives the status badge in the cpanel banner.
```ts
{
  review: {
    token: string;
    status: "sent" | "approved" | "rejected";
    sentAt: string;
    respondedAt: string | null;
    feedback: string | null;
    summary: { ads: number; organic: number; lp: boolean };
  } | null
}
```

---

## Public Client Review

**No auth required — token IS the auth.** This is what the client mobile app (or the cpanel's public review page) calls when the client opens the SMS link.

### `GET /api/cpanel/review/products/:token`
The consolidated review — what the client should see.
```ts
{
  kind: "products";
  phone: string;
  status: "sent" | "approved" | "rejected";
  sentAt: string;
  respondedAt: string | null;
  feedback: string | null;
  ads:     WowAdItem[];          // only managerApproved ones
  organic: WowOrganicPost[];     // only managerApproved ones
  lp: {
    sessionId: string;
    landingPage: object | null;
    images: Array<{ section: string; url: string }>;
    html: string | null;          // <iframe srcDoc> ready
  } | null;
}

// 404: { "error": "Token not found or expired" }
```

### `POST /api/cpanel/review/products/:token/approve`
Empty body. Records `status="approved"`, `respondedAt=<now>`.
```json
{ "success": true }
```

### `POST /api/cpanel/review/products/:token/reject`
```json
// Request
{ "feedback": "צבעים לא מתאימים" }

// Response
{ "success": true }
```

### Per-kind public review endpoints (less commonly used)
For the legacy single-kind send-approval flow:
- `GET /api/cpanel/review/wow-ads/:token`     ↔ `POST .../approve` ↔ `POST .../reject`
- `GET /api/cpanel/review/wow-organic/:token` ↔ `POST .../approve` ↔ `POST .../reject`
- `GET /api/cpanel/review/wow-lp/:token`      ↔ `POST .../approve` ↔ `POST .../reject`

---

## Facebook / Campaigns / Leads

### `GET /api/cpanel/clients/:phone/campaigns`
Live FB Ads campaigns. **Soft-fails** to `{ campaigns: [], error: "..." }` if FB token missing.
```ts
{
  campaigns: Array<{
    id; name; status; effectiveStatus;
    dailyBudget?; spendToday; leadsToday;
    objective?;
  }>;
  error?: string;
}
```

### `GET /api/cpanel/clients/:phone/leads?days=7|14|30`
**Soft-fails** the same way.
```ts
{
  total: number;
  trend: Array<{ date: string; leads: number; spend: number }>;
  days: number;
  error?: string;
}
```

### `GET /api/cpanel/clients/:phone/fb-token-status`
Cheap token health check. Probes `/me` with the stored token.
```ts
{
  status: "valid" | "expired" | "missing";
  valid: boolean;
  message?: string;
  code?: number;
  errorSubcode?: number;
  userId?: string;
  name?: string;
  adAccountId?: string | null;
}
```

### `GET /api/cpanel/clients/:phone/fb-account-health`
Detailed FB ad-account health. Returns `null` if not linked.

### `GET /api/cpanel/clients/:phone/fb-assets`
```ts
{ accounts: FbPairedAccount[]; pages: FbPage[]; adAccounts: FbAdAccount[] }
```

### `GET /api/cpanel/clients/:phone/fb-lead-forms`
### `GET /api/cpanel/clients/:phone/fb-leads?formId=...&days=...&limit=200`
### `POST /api/cpanel/clients/:phone/fb-leads/:leadId/followed-up`
```json
{ "followedUp": true }
// → { "success": true }
```

### `POST /api/cpanel/clients/:phone/budget`
```json
{ "campaignId": "...", "dailyBudgetIls": 100 }
// → { "success": true }
```

### `POST /api/cpanel/clients/:phone/campaign-status`
```json
{ "campaignId": "...", "status": "ACTIVE" | "PAUSED" }
// → { "success": true }
```

---

## Misc

### `POST /api/cpanel/payment-notify`
**No auth — Cardcom webhook.** Writes `users.activePackage` and `$inc`s `users.coins` when payment succeeds.

### `GET /api/cpanel/stats`
```ts
{ totalClients: number; unreadMessages: number }
```

### `GET /api/cpanel/account-managers`
```ts
Array<{ id, name, phone }>
```

### `GET /api/cpanel/clients/:phone/files`
Backblaze-backed client files.

### `POST /api/cpanel/clients/:phone/files/upload-url`
Returns presigned upload URL.

### `DELETE /api/cpanel/clients/:phone/files/:fileId`

---

## Error codes

Errors return `4xx` or `5xx` with `{ "error": "<message>" }`. Special codes the UI translates:

| HTTP | Server message starts with | Meaning | UI message (Hebrew) |
|---|---|---|---|
| 400 | `INCOMPLETE_PROFILE: ...` | Required characterization field missing | "האיפיון לא שלם — מלא את כל השדות בטאב 'איפיון'" |
| 402 | `INSUFFICIENT_COINS` | Coin balance below action cost | "אין מספיק מטבעות לפעולה זו" |
| 403 | `NO_PACKAGE` | Client never bought a package | "ללקוח אין חבילה פעילה — רכוש חבילה בטאב 'חיוב'" |
| 404 | `Not found` / `Token not found` | Resource missing | (per-context message) |

402 also returns `{ "balance": 30, "cost": 50 }` so the client can show the gap.

---

## Coin price reference

Server is the source of truth — these are the values the server deducts on each action:

```js
GENERATE_ADS         50   // POST /wow-ads/generate
REGENERATE_AD         5   // POST /wow-ads/:id/regenerate
GENERATE_ORGANIC     30   // POST /wow-organic/generate
REGENERATE_ORGANIC    3   // POST /wow-organic/:id/regenerate
GENERATE_LP         100   // POST /wow-lp/generate
REGENERATE_LP_IMAGE  10   // POST /wow-lp/regenerate-image
GENERATE_VIDEO      200   // (future)
```

Frontend mirror: `import { COIN_COSTS } from "src/api/client.ts"`.

---

## Quick integration recipe (for the client app)

When the client clicks the SMS link `https://app.iconiqmedia.co.il/products-review/<token>`:

```js
// 1. Load review
const review = await fetch(`https://api.iconiqmedia.co.il/api/cpanel/review/products/${token}`)
  .then(r => r.json());

// review.ads[]      → render as image carousel
// review.organic[]  → render as social-post cards
// review.lp.html    → drop into <iframe srcDoc=...>
// review.status === "approved" / "rejected" → already responded, show readonly screen

// 2. Approve
await fetch(`.../review/products/${token}/approve`, { method: "POST" });

// 3. Reject with feedback
await fetch(`.../review/products/${token}/reject`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ feedback: "צבעים לא מתאימים" })
});
```

The cpanel has its own version of this page at `/products-review/:token` — your partner can reference `src/pages/ProductsReviewPage.tsx` for the UX pattern.
