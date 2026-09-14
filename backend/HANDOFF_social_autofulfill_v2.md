# Handoff — Social auto-fulfill v2 (service focus + tracking)

Two improvements to the mobile **fully-automatic social campaign** (`redeem-with-coins` with a `schedule` → `autoFulfillSocialCampaign`). The mobile app is already wired/works; these are **server-side** changes for you to implement + deploy. File:line anchors are from the current `main`.

---

## B1 — Generate from the SELECTED service only (fix "generic posts")

**Problem:** `autoFulfillSocialCampaign` builds the generation `subject` from `brief.concept` + `importantInfo`, and passes **all** `business_profiles.services` as the `services` arg. So even when the client picked one service ("חופשות רומנטיות באירופה"), the posts come out generic.

**Stopgap already shipped in the app:** it folds the selected service (title — description — uniqueFeature) into `brief.concept`, so the subject now mentions it. This helps but the model still gets the full service list as context.

**Server change for tight targeting:** accept an explicit `focusService` and use **only** it.

1. `controllers/packages.controller.js:82` `redeemWithCoins`
   ```js
   const { phone, packageKey, brief, schedule, facebook, instagram, focusService } = req.body || {};
   const result = await require("../services/social-redeem.service").redeem({
     phone, packageKey, brief, schedule, facebook, instagram, focusService, source: "mobile",
   });
   ```
2. `services/social-redeem.service.js:45` `redeem({...})` — add `focusService = null` to the destructured args and forward it:
   ```js
   .autoFulfillSocialCampaign({ phone, pkg, brief: safeBrief, schedule, facebook, instagram, focusService })
   ```
3. `services/social-campaign.service.js:67` `autoFulfillSocialCampaign({...})` — add `focusService`, and where it currently does `services: prof.services` in the `generateHqSocialPosts(...)` call (~line 98) plus the `subject` build (~line 81), prefer `focusService`:
   ```js
   const focusStr = focusService
     ? `${focusService.title}${focusService.description ? ` — ${focusService.description}` : ""}`
     : null;
   const subject = [focusStr || brief?.concept || "", importantInfo.length ? `שלב במידת הצורך: ${importantInfo.join(", ")}` : ""].filter(Boolean).join(" · ");
   // ...
   services: focusStr || prof.services,   // ← only the selected service when provided
   ```
   `generateHqSocialPosts` params: `post-generation-quality.js:617` (`subject`, `services`, `cta`, etc.).

**App follow-up (after this ships):** the app will send `focusService: { title, description, uniqueFeature }` in the redeem body instead of folding it into `concept`. Until then, the concept-fold keeps it working.

---

## B2 — Return a tracking handle + status endpoint (fix "launch and forget")

**Problem:** `autoFulfillSocialCampaign` is fire-and-forget and writes `wow_organic_ads_sessions` **only at the very end** (`social-campaign.service.js:143`, `status:"done"`, all posts at once). `redeem` returns only `{success, packageName, coinsCharged, coinsRemaining}` (`social-redeem.service.js:216`). So the app has no id to track and blind-polls `GET /api/app/posts/:phone`.

**Goal:** the app gets a `sessionId` immediately and can poll a status endpoint to know when the batch is done (used for *reliable* refresh — **no progress UI/banner** is needed).

1. **Create `sessionId` up front** (in `redeem` before firing autoFulfill, or generate inside autoFulfill and pass back synchronously). Write the session row at the **start** of `autoFulfillSocialCampaign`, not the end:
   ```js
   const sessionId = `worg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`;
   await getDB().collection("wow_organic_ads_sessions").insertOne({
     sessionId, phone, status: "generating", productStatus: "generating",
     totalPosts: count, completedCount: 0, generatedPosts: [],
     source: "mobile-social-auto", createdAt: now, updatedAt: now,
   });
   ```
2. **Return `sessionId` from redeem immediately** — do NOT await generation:
   - `social-redeem.service.js:132` keep autoFulfill fire-and-forget, but generate the `sessionId` here (or have autoFulfill accept a passed-in id) so it's available synchronously.
   - `social-redeem.service.js:216` add `sessionId` to the returned object; it flows out via `packages.controller.js:90` (`res.json(result)`).
3. **Increment `completedCount`** inside the generation loop as each image uploads to Backblaze (`social-campaign.service.js`, around the `[Backblaze] ✅` upload), then set the final `status:"done"`, `completedCount = totalPosts`, and fill `generatedPosts`/the order as today.
4. **Add an app-facing status route** (mounted under `/api/app`, no auth — mirror `routes/app.routes.js` → `routes/posts.routes.js`):
   ```
   GET /api/app/social-status/:sessionId
   → { sessionId, status: "generating"|"done"|"failed", totalPosts, completedCount }
   ```
   Read `wow_organic_ads_sessions` by `sessionId`. Mirror the response style of `controllers/wow-organic-ads.controller.js:187` `getOrganicAdsStatus`.

**App follow-up (after this ships):** `utils/serverReq.ts` adds `sessionId?` to `RedeemSuccess` (~line 2537) + a `getSocialStatus(sessionId)` helper (mirror `getAdImagesJobStatus`, line 2026). The app stores the `sessionId` and polls the status endpoint to stop polling precisely when `status==="done"` (replacing the current 15-min time-window heuristic). Still no banner — used only for reliable refresh.

---

## Notes / gotchas
- **Do not block redeem on generation** — gpt-image-2 × N can take minutes; awaiting it would hit the request timeout. Keep generation in the background; only the session-row write + `sessionId` return are synchronous.
- **Fallback unchanged:** keep `fallbackToManager` on failure (`social-campaign.service.js:204`); also set the session `status:"failed"` so the app stops polling.
- **Throughput:** rapid re-submits queue 7-image batches sequentially on one dyno (observed ~9+ min backlog). Consider a concurrency guard or parallelizing image calls — optional, but it's the main perceived-speed bottleneck.
