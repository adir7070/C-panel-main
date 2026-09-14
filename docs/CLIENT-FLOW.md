# Client Detail — Flow

The core operational flow for an account manager working a single client.
This document describes **what each screen shows**, **what every control does**,
and **how data flows between screens**. Updated whenever the flow changes.

---

## Top-level layout

```
Sidebar (sticky)             Main area
┌───────────────────┐  ┌──────────────────────────────────────┐
│ logo              │  │ Header: client name, phone, badges,  │
│ דף הבית            │  │  + "back" + "assign manager" button   │
│ לקוחות (active)    │  ├──────────────────────────────────────┤
│ צ'אט כללי         │  │ Tabs (in this order):                 │
│ שליחה רחבה        │  │  1. פרופיל                            │
│ לידים              │  │  2. חיוב                              │
│ מייפליין           │  │  3. איפיון                            │
│ משימות            │  │  4. מוצרים    ← gated by 2            │
│ פגישות            │  │  5. קמפיינים                          │
│ ארנק וכספים       │  │  6. לידים                             │
│ AI דייג'סט         │  │  7. פעולות                            │
│ לוגים              │  │  8. ארנק                              │
│ admin: Fireberry │  │  9. אפליקציה                          │
└───────────────────┘  └──────────────────────────────────────┘
```

The first 4 tabs are **the core flow**, in order. Everything after them is
analytics + admin.

---

## 1. פרופיל (Profile + Chat) — `/clients/:phone` tab=overview

**Layout:** split into 2 columns. RTL: right column = profile content,
left column = embedded chat (sticky, scrollable).

### Right column — profile content

| Section | Source | Manager controls |
|---|---|---|
| Business profile (name, phone, address, email, category, sub-categories, audience, page goal, design style) | `business_profiles` collection (filled in **איפיון** tab) | Read-only here. Edit in **איפיון** |
| About / promotion | same | Read-only. Edit in **איפיון** |
| Notes (manager's free-text notes about the client) | `support_chats.notes` | (Read-only currently. Future: inline-edit) |
| Social links (IG / FB / TikTok) | `business_profiles.socialLinks` | Click to open in new tab |
| **Meta connection** — Facebook page + ad account picker | `users.page_id`, `users.ad_account_id` | Click row → modal lists FB pages/accounts the client connected → pick one. Auto-pairs page↔ad-account if both linked in FB |

### Left column — embedded chat

The same component that previously was the standalone "צ'אט" tab.
Auto-loads the message history, joins the WebSocket room for live messages,
sends manager replies via `socket.io`. Sticky positioning so it stays
visible while the manager scrolls profile content.

### Navigation out of this tab

- "פתח את טאב האיפיון" (from anywhere a missing-data warning appears) → tab=characterization
- "פתח את טאב החיוב" (from products empty state) → tab=billing
- Click client name in chat sender → already on this client; no-op

---

## 2. חיוב (Billing) — tab=billing

**Purpose:** charge the client. Every product the manager will produce
in **מוצרים** must first be paid for here.

### What's on screen

- Saved card on file (last 4 of card, expiry)
- Free-form payment link sender (amount + description)
- Three pre-built packages: **Platinum / Premium / Basic** (one-click charge)
- Three coin-only packs: same tiers, coins instead of products
- Custom package builder (pick ads / LPs / videos / logos / social manually)
- Direct charge of saved card (no link, immediate)
- Refund last transaction
- Recent transactions list

### What happens when a package is bought

1. Manager clicks "שלח קישור תשלום" or "חייב כרטיס"
2. Server creates a row in `cpanel_pending_purchases` with all 5 counts
   (`adsCount`, `landingPagesCount`, `videosCount`, `logosCount`,
   `socialAdsCount`) + total + `kind` (e.g. "platinum") + `name` (description)
3. Cardcom returns a payment URL → sent to client by SMS + chat
4. Client pays → Cardcom hits the `paymentNotify` webhook
5. Webhook writes to `users.activePackage`:
   ```
   { id, name, purchasedAt, items: { paidAds, organicAds, videos, lps, logos }, coins }
   ```
6. Webhook also `$inc`s `users.coins` by the granted amount
7. **The מוצרים tab now unlocks** (next time it's loaded)

### Backfill

Existing clients fulfilled before `activePackage` existed can be hydrated
once with `node scripts/backfill-active-packages.js --dry-run` then for real.
Idempotent — never overwrites.

---

## 3. איפיון (Characterization) — tab=characterization

**Purpose:** capture everything the AI needs to generate quality content.

Unchanged from the previous version. The data filled here is what the
**מוצרים** tab feeds into the wow pipelines (ads / LP / organic).

### Critical fields (gate the products tab)

The **מוצרים** tab won't even render product sections until these are filled:

- `businessName`
- `categoryKey`
- ≥ 1 `subCategoryKeys` (excluding "other_input")
- ≥ 1 `services`
- `designStyle`
- ≥ 1 `targetAudience`
- `pageGoal`

If any are missing, **מוצרים** shows a list of gaps with a "פתח את טאב האיפיון" button.

### Other fields

`logoUrl` (used by both UI logo display and server-side image overlays),
business images, avatar config, social links, organic-post planner slots,
AI ad-brief Q&A.

---

## 4. מוצרים (Products) — tab=products

**Purpose:** generate the actual deliverables (ads, LP, organic posts,
video) that the client paid for.

### Two gates before anything renders

1. **איפיון complete?** No → lock state with list of missing fields
2. **חבילה פעילה?** No → empty state: *"עדיין לא נרכשה חבילה"* with CTA
   button "פתח את טאב החיוב"

### When both gates pass

A package banner shows:
- Package name + purchase date
- Coins remaining / total + colored progress bar (green > 25%, yellow > 10%, red below)
- Item-count chips (e.g. "15 מודעות ADS · 20 מודעות אורגניות · 1 דף נחיתה")
- Collapsible "עלות מטבעות לפעולות" reference table

Below the banner, **only the sections the client actually purchased** render.
A platinum buyer sees 4 sections; a basic buyer might see 1.

### Section: WowAdsPanel (paid ADS)

Renders if `package.items.paidAds > 0`.

| Control | Action | Coin cost |
|---|---|---|
| "ייצר N מודעות" (N = quota) | `POST /wow-ads/generate` — builds brief from איפיון + logo, runs OpenAI text + Gemini image pipeline. Async — returns immediately, polls every 3.5s for progress | **50** |
| "מכסה מולאה" (disabled) | Shown when `ads.length >= quota` | — |
| Per-ad: "ערוך" | Inline edit headline / description / CTA. `PUT /wow-ads/:id`. No AI involved | — |
| Per-ad: "אשר מודעה" | Toggles `managerApprovedAt`. `POST /wow-ads/:id/approve` | — |
| Per-ad: "רענן" | Re-runs Gemini image for this ad. `POST /wow-ads/:id/regenerate` | **5** |
| Per-ad: "הורד" | Direct download of the generated PNG | — |
| (Future) "שלח לאישור לקוח" | Sends approved ads to client via SMS link → token-gated review page | — |

Background pipeline: OpenAI writes 10 ad copies → OpenAI writes 10 nano-prompts → Gemini generates 1080×1080 image per ad → `sharp` overlays the client logo top-right + headline/CTA SVG text → Backblaze stores the final PNG → URL written into `wow_ads.generatedAds[i].imageUrl`.

### Section: WowOrganicPanel (organic social)

Renders if `package.items.organicAds > 0`.

| Control | Coin cost |
|---|---|
| "ייצר N פוסטים" | **30** |
| Per-post regenerate | **3** |
| Per-post edit text | — |
| Per-post approve | — |

Pipeline: OpenAI writes N posts in 5 types cycling (tip / story / behind / testimonial / question), Hebrew RTL → Gemini image per post (square 1:1, lifestyle/gallery aesthetic, no logo overlay so it reads as organic).

### Section: VideoPlaceholder

Renders if `package.items.videos > 0`. Currently a placeholder card —
video pipeline not yet wired to the cpanel bridge.

### Section: WowLpPanel (Landing Page)

Renders if `package.items.lps > 0`.

| Control | Coin cost |
|---|---|
| "ייצר דף נחיתה" | **100** |
| Per-section image regenerate | **10** |
| Section image upload (manager picks file) | — |
| Section image set (pick existing client image) | — |
| Inline section edit (header logo, hero copy, sections) | — |
| "שלח לאישור לקוח" | — |

Pipeline: `runGeminiPipeline` (existing service) — OpenAI writes brand strategy + LP content + theme → Gemini generates 6 hero/section images → composes into HTML+CSS+JS LP. Logo from `users.logoUrl` appears in HeaderBar + FooterBar.

---

## Coin economy

| Action | Cost |
|---|---|
| Generate ADS batch | 50 |
| Regenerate one ad | 5 |
| Generate organic batch | 30 |
| Regenerate one organic post | 3 |
| Generate LP | 100 |
| Regenerate LP image | 10 |
| (Future) Generate video | 200 |

Server is the source of truth — every endpoint deducts coins **before**
running, returns 402 if insufficient. Frontend mirrors prices in
`COIN_COSTS` for display only. Every debit is logged to the
`coin_ledger` collection with `{ phone, amount: -X, reason, sessionId, agentId, createdAt }`.

Server error → coins not deducted (the `$inc` happens after the gate but
before the long-running pipeline; if the pipeline crashes mid-run, the
coins are still spent — this matches the cost of the API calls already
made to OpenAI/Gemini).

---

## Server error codes the UI translates

| Code | Hebrew toast |
|---|---|
| `NO_PACKAGE` (HTTP 403) | "ללקוח אין חבילה פעילה — רכוש חבילה בטאב חיוב" |
| `INSUFFICIENT_COINS` (HTTP 402) | "אין מספיק מטבעות לפעולה זו" |
| `INCOMPLETE_PROFILE: ...` (HTTP 400) | "האיפיון לא שלם — מלא את כל השדות בטאב 'איפיון'" |
| any other 4xx/5xx | server's error message verbatim |

---

## Architecture summary

```
┌─────────────┐                  ┌──────────────────────┐
│  Browser    │  /api/...        │  Cpanel server.js    │
│             ├─────────────────▶│  (thin Express       │
│  React SPA  │                  │   proxy on Heroku)   │
└─────────────┘                  └──────────┬───────────┘
                                            │ proxies all /api/* to:
                                            ▼
                              ┌─────────────────────────┐
                              │ api.iconiqmedia.co.il   │
                              │  (iconiq-server-main)    │
                              │                         │
                              │  routes/cpanel.routes   │
                              │  controllers/cpanel-*   │
                              │  services/wow/*         │
                              │  ├─ ads.service          │
                              │  ├─ organic.service     │
                              │  ├─ gemini-pipeline     │
                              │  └─ gemini-image        │
                              │                         │
                              │  Mongo collections:     │
                              │   users (activePackage, │
                              │     coins, logoUrl)     │
                              │   business_profiles     │
                              │   cpanel_wow_sessions   │
                              │     (phone↔sessionId)   │
                              │   wow_briefs            │
                              │   wow_sessions          │
                              │   wow_ads               │
                              │   wow_organic           │
                              │   coin_ledger           │
                              │   cpanel_pending_       │
                              │     purchases           │
                              └─────────────────────────┘
```

### Bridge collection: `cpanel_wow_sessions`

The cpanel UI is **phone-keyed** (a manager works on one client at a time
identified by phone number). The wow pipelines are **sessionId-keyed**
(internal IDs created when a brief is generated). The bridge collection
stores the mapping:

```
{ phone, kind: "ads"|"lp"|"organic", briefId, sessionId, createdAt, updatedAt }
```

Every cpanel-prefixed route looks up the mapping for its phone+kind,
delegates to the underlying wow service using the sessionId, then
reformats the result into the shape the cpanel UI's TypeScript types
expect.

---

## Tabs after the core 4 (briefly)

These are analytics/admin and don't drive the workflow:

- **קמפיינים** — Facebook Ads campaigns (live data via FB Graph API). Read-only spend/leads dashboard.
- **לידים** — leads count + trend over last 30 days. Live FB Lead Forms.
- **פעולות** — manual action buttons (send message, set tag, etc.)
- **ארנק** — commission ledger for this client (how much the manager has earned)
- **אפליקציה** — client's mobile app status (online, last seen, push token)

Each is independent and doesn't depend on tabs 1–4. They can be reordered
or removed without affecting the core flow.

---

## What changes when

| Trigger | Effect |
|---|---|
| Manager fills איפיון | מוצרים unlocks gate 1 |
| Client pays for package | מוצרים unlocks gate 2 + coins added |
| Manager generates ads | -50 coins, ads pipeline starts, polls every 3.5s |
| Pipeline finishes | `wow_ads.generatedAds` populated, UI shows ads with logo overlay |
| Manager regenerates one ad | -5 coins, single-ad re-run |
| Coin balance hits 0 | next action returns 402, UI shows "אין מספיק מטבעות" |
| Manager hits quota | generate button disables with "מכסה מולאה" |
| Client approval token created | client gets SMS with `/wow-{kind}-review/:token` link |
