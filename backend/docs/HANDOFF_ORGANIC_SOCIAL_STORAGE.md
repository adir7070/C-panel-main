# Handoff — Where to find organic-social images in MongoDB

Organic social images are produced by the `wow-organic-ads` pipeline.
The PNG bytes live on **Backblaze**; MongoDB holds the metadata + a
proxy URL pointing at the Backblaze object.

---

## TL;DR

| What | Where |
|---|---|
| Session + per-post metadata | Mongo collection: `wow_organic_ads_sessions` |
| Generated post images (PNG bytes) | Backblaze path: `wow-organic-ads/{phone}/{sessionId}/post_{n}.png` |
| Carousel slide images (PNG bytes) | Backblaze path: `wow-organic-ads/{phone}/{sessionId}/carousel_{postId}_slide_{slideId}.png` |
| URL stored in Mongo (proxy) | `/api/img?url={URL-encoded Backblaze path}` |
| Public image fetch (server resolves the proxy) | `GET https://api.iconiqmedia.co.il/api/img?url=<backblaze-path>` |

Final output size: every image is exactly **1024×1024 PNG**.

---

## MongoDB shape

### Collection: `wow_organic_ads_sessions`

Find the most recent session for a client by phone:

```js
db.wow_organic_ads_sessions.findOne(
  { phone: "0526706503" },
  { sort: { createdAt: -1 } }
)
```

Or by sessionId (printed in the cPanel and in server logs as
`worg_<...>_<...>`):

```js
db.wow_organic_ads_sessions.findOne({ sessionId: "worg_mp5hfs7d_numsdn" })
```

### Document fields you'll care about

```js
{
  sessionId:              "worg_mp5hfs7d_numsdn",
  phone:                  "0526706503",
  status:                 "done",        // generating_texts | generating_prompts | generating_images | done | error
  createdAt:              ISODate("..."),
  updatedAt:              ISODate("..."),
  totalPosts:             5,
  completedCount:         5,
  productStatus:          "sent_for_creation",
  productStatusUpdatedAt: ISODate("..."),

  /* The whole brief that fed the pipeline. Useful to verify what
     colors / logo / business field / services / target audience the
     generator saw at runtime. */
  brief: {
    businessName, businessField, businessNiche,
    about, services, targetAudience,
    preferredColors,                // { primary, secondary, accent, extra1, extra2, extra3 }
    logoUrl,                        // pulled from business_profiles.logoUrl
    images,                         // up to 5 client reference photos
    designStyle,
    organicSlots,                   // per-slot service binding from the manager
    avatar,                         // recurring presenter, if configured
    packageId,                      // links back to the active package
  },

  /* The actual generated posts. Index N in this array IS the post,
     ordered by id. */
  generatedPosts: [
    {
      id:           1,                          // 1..N stable
      type:         "tip",                      // chosen by the model from
                                                //   the allowed vocabulary
                                                //   (tip, educational, before_after,
                                                //    behind_the_scenes, testimonial,
                                                //    service_explanation, myth_vs_fact,
                                                //    checklist, brand_story,
                                                //    problem_solution, warning_signs,
                                                //    mistakes, maintenance_tips,
                                                //    why_choose_us, faq, carousel_cover,
                                                //    question, quote)
      headline:     "פתיח עברי",                // the post's main hook (Hebrew)
      description:  "גוף הפוסט בעברית, 2-3 משפטים",
      cta:          "שאלה לקהילה",
      nanoPrompt:   "<full English prompt that was sent to Gemini, plus
                     the architecture / Hebrew-rendering / subject-binding
                     blocks we deterministically append>",
      imageUrl:     "/api/img?url=wow-organic-ads%2F0526706503%2Fworg_mp5hfs7d_numsdn%2Fpost_1.png",
      regeneratedAt: "2026-05-14T14:31:00.000Z", // present only after a regen
      error:         "<message>",                // present only if image gen failed
    },
    /* ...one entry per post... */
  ],
}
```

### Carousel post variant

Posts with `type: "carousel_cover"` (or where the manager bound the
slot to a carousel) carry an extra `slides` array on the post:

```js
{
  id: 6,
  type: "carousel",
  headline: "...",
  description: "...",
  slides: [
    {
      id:        1,
      title:     "...",
      body:      "...",
      imageUrl:  "/api/img?url=wow-organic-ads%2F<phone>%2F<sessionId>%2Fcarousel_6_slide_1.png",
      nanoPrompt: "...",
    },
    /* ...more slides... */
  ],
}
```

---

## Backblaze paths

Direct B2 object keys for the images:

```
wow-organic-ads/{phone}/{sessionId}/post_{postId}.png
wow-organic-ads/{phone}/{sessionId}/carousel_{postId}_slide_{slideId}.png
```

After a regeneration the file is rewritten under a timestamped name so
the previous version remains accessible:

```
wow-organic-ads/{phone}/{sessionId}/post_{postId}_{timestamp}.png
wow-organic-ads/{phone}/{sessionId}/carousel_{postId}_slide_{slideId}_{timestamp}.png
```

The `imageUrl` field always points at the latest version.

---

## How to fetch the image bytes

### Easiest: from the browser / curl via the server proxy

The `imageUrl` already URL-encodes the Backblaze path:

```
GET https://api.iconiqmedia.co.il/api/img?url=wow-organic-ads%2F0526706503%2Fworg_xxx%2Fpost_1.png
```

Returns the PNG. No special auth for the org-side proxy.

### Direct from Backblaze

If you have B2 credentials:

```js
const b2 = require("./services/backblaze.service");
const { buffer } = await b2.downloadImageByPath(
  "wow-organic-ads/0526706503/worg_mp5hfs7d_numsdn/post_1.png",
);
```

---

## Diagnostic: dump the latest session's prompts + image URLs

This repo ships a script that does exactly what you'd write by hand
the first time:

```bash
node scripts/dump-latest-organic-prompt.js                       # newest session anywhere
node scripts/dump-latest-organic-prompt.js --phone=0526706503    # newest for one client
node scripts/dump-latest-organic-prompt.js --session=worg_xxx    # specific session
```

It prints, per post: `id`, `type`, `headline`, `description`, `cta`,
`imageUrl`, the full `nanoPrompt` that was sent to Gemini, and a
checklist confirming the design-architecture + Hebrew-rendering +
subject-binding blocks made it into the prompt.

---

## Useful related collections

| Collection | Why it matters |
|---|---|
| `business_profiles` | The source of truth for `brief` data (colors, logo URL, business field, services). What the agent saves in the Characterization tab lives here. |
| `cpanel_clients` | Lightweight client roster — phone → name + assigned agent. |
| `support_chats` | Whatsapp conversation history, account-manager assignment. |
| `wow_ads_sessions` | The PAID-ads equivalent (`/wow-ads/...` Backblaze paths). Same shape, different content. |
| `wow_lp_sessions` | Landing-page generations. |

Same query pattern works on each — sort `createdAt: -1` and read
`generatedPosts[].imageUrl` (organic), `generatedAds[].imageUrl` (paid),
or `images[].url` (LP).

---

## Sample one-liner: list every image URL in the latest organic session for a phone

```js
const sess = await db.collection("wow_organic_ads_sessions").findOne(
  { phone: "0526706503" },
  { sort: { createdAt: -1 } },
);
console.log(sess.generatedPosts.map(p => p.imageUrl));
```

---

## Social plans catalog (`cpanel_products` · `kind: "social"`)

The social plans are the coin-redeem packages an agent activates from
the client's Billing tab. They live alongside the rest of the
catalog in a different collection from the session above.

```js
db.cpanel_products.find({ kind: "social", active: true }).sort({ sortOrder: 1 })
```

### Document shape

```js
{
  key:          "social_weekly",       // stable id, used in API calls
  kind:         "social",
  name:         "שבועי",                // customer-facing Hebrew name
  periodLabel:  "שבועי",                // small caption shown on the card
  price:        349,                    // COIN cost (price === coins always)
  coins:        349,                    // same number as `price`
  bullets:      [                       // 1–3 short Hebrew lines on the card
    "5 מודעות סושיאל",
    "מתאים לשבוע פעילות",
  ],
  items: {                              // what the package grants on activation
    ad: 0, lp: 0, video: 0, logo: 0,
    social_ad: 5,                       // → bumps the client's social-ad quota
  },
  badge:        "הכי משתלם",            // optional; shown as a pill on the card
  sortOrder:    1,                      // display order in the cpanel grid
  active:       true,                   // soft-deleted plans flip to false
  createdAt, updatedAt,
}
```

### The 3 canonical plans

| key | name | period | price = coins | social ads | badge |
|---|---|---|---|---|---|
| `social_weekly`   | שבועי     | שבועי    | 349 | 5  | — |
| `social_biweekly` | דו-שבועי  | דו-שבועי | 649 | 10 | — |
| `social_monthly`  | חודשי     | חודשי    | 999 | 20 | הכי משתלם |

> **Heads up — current Mongo state may differ:** the canonical 3 plans
> above are the design intent. A short-lived rename swapped them for 2
> plans (`social_standard` 500 / `social_pro` 1000) and the
> `refreshSocialDefaults()` helper on startup currently upserts that
> 2-plan shape. To restore the 3-plan list above, edit `DEFAULT_SOCIAL`
> in [services/cpanel-products.service.js](../services/cpanel-products.service.js)
> back to the `social_weekly` / `social_biweekly` / `social_monthly`
> objects, and flip the stale-keys list in `refreshSocialDefaults` to
> deactivate `social_standard` / `social_pro` instead. Next server boot
> picks up the new shape.

### How a plan is redeemed (not a Cardcom purchase)

Social plans are paid in **coins**, not money. Two endpoints share the
same service (`services/social-redeem.service.js → redeem({...})`):

```
POST /api/packages/redeem-with-coins                     ← mobile
POST /api/cpanel/clients/:phone/redeem-social-package    ← cpanel agent
```

Body (both endpoints): `{ packageKey, brief? }`. Optional `brief`
object captured by the mobile app (`{ concept, importantInfo[], cta }`)
is persisted on `users.activePackage.brief` and the
`cpanel_pending_purchases` mirror row, plus passed through to the
manager popup + purchase webhook.

Atomic debit: a single `findOneAndUpdate` with `coins >= price` guard
— two simultaneous taps can't double-spend.

### On a successful redemption the server writes to:

| Collection | Field / change |
|---|---|
| `users` | `coins` -= price · `coinsUsed` += price · `activePackage` set · `purchasedPackages[]` push |
| `package_transactions` | new row · `source: "<source>-coins-redemption"` · `coinsCharged` = price · `coinsGranted` = 0 |
| `cpanel_pending_purchases` | new row · `kind: "social_redemption"` · `coinsOverride: -price` · `totalAmount: 0` |
| (manager) | popup + WhatsApp/SMS via `wow-manager-notify` |
| (webhook) | `purchase_success` with `package.amount: 0`, `package.coinsGranted: -price` |

### Listing the plans from the API

For the mobile app (no auth):
```
GET /api/packages/social
```
For the cpanel UI (admin auth, returns the full catalog):
```
GET /api/cpanel/products
```
Both surface the same `social` array — same shape as the Mongo
documents above.

---

Questions → ping me.
