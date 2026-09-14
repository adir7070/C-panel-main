const express = require("express");
const router = express.Router();
const leadsController = require("../controllers/leads.controller");
const postsController = require("../controllers/posts.controller");

// ─────────────────────────────────────────────
// POSTS (draft campaigns)
// ─────────────────────────────────────────────

/**
 * @swagger
 * /api/leads/posts:
 *   get:
 *     summary: Get all draft posts for a user
 *     description: Returns all campaign posts with status=draft for the given page_id, sorted newest first.
 *     tags: [Posts]
 *     parameters:
 *       - in: query
 *         name: page_id
 *         required: true
 *         schema:
 *           type: string
 *         example: "123456789"
 *     responses:
 *       200:
 *         description: List of draft posts
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Post'
 *       400:
 *         description: Missing page_id
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get("/posts", postsController.getDraftPosts);

/**
 * @swagger
 * /api/leads/posts:
 *   post:
 *     summary: Save a new campaign as a draft
 *     description: |
 *       Creates a new post with status=draft. The server sets status, created_at, updated_at automatically.
 *       **Save the returned _id** — required to call execute later.
 *     tags: [Posts]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [page_id]
 *             properties:
 *               page_id:
 *                 type: string
 *                 example: "123456789"
 *               campaign:
 *                 $ref: '#/components/schemas/Campaign'
 *               ad_set:
 *                 $ref: '#/components/schemas/AdSet'
 *               ads:
 *                 type: array
 *                 items:
 *                   $ref: '#/components/schemas/Ad'
 *               campaign_settings:
 *                 $ref: '#/components/schemas/CampaignSettings'
 *               form:
 *                 $ref: '#/components/schemas/LeadForm'
 *     responses:
 *       201:
 *         description: Post saved. data._id is required for execute.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:    { $ref: '#/components/schemas/Post' }
 *       400:
 *         description: Missing page_id
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post("/posts", postsController.savePost);

/**
 * @swagger
 * /api/leads/posts/{id}/execute:
 *   patch:
 *     summary: Mark a draft post as executed (irreversible)
 *     description: |
 *       Moves post from draft → executed. **One-way — cannot be undone.**
 *       Returns **204 No Content** — do not call response.json() on a 204.
 *       404 = wrong _id, already executed, or page_id mismatch.
 *     tags: [Posts]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: MongoDB _id of the post
 *         example: "65f1a2b3c4d5e6f7a8b9c0d1"
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               page_id:
 *                 type: string
 *                 description: Recommended — validates ownership
 *                 example: "123456789"
 *     responses:
 *       204:
 *         description: Executed successfully. No response body.
 *       404:
 *         description: Post not found or page_id mismatch
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.patch("/posts/:id/execute", postsController.executePost);

/**
 * @swagger
 * /api/leads/posts/{id}:
 *   put:
 *     summary: Update an existing draft post with finalized campaign data
 *     description: |
 *       Replaces campaign/ad_set/ads/campaign_settings fields on an existing post.
 *       Ownership is verified by matching both **_id** and **page_id**.
 *       Status is NOT changed unless a top-level `status` field is explicitly provided.
 *       Returns the full updated document.
 *     tags: [Posts]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: MongoDB _id of the post
 *         example: "65f1a2b3c4d5e6f7a8b9c0d1"
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [page_id]
 *             properties:
 *               page_id:
 *                 type: string
 *                 description: Required — used for ownership verification
 *                 example: "123456789"
 *               job_id:
 *                 type: string
 *                 description: AI generation job ID
 *               status:
 *                 type: string
 *                 description: Only provide to explicitly change status (e.g. active | generating | paused)
 *               campaign:
 *                 type: object
 *                 properties:
 *                   id:          { type: string }
 *                   title:       { type: string }
 *                   is_active:   { type: boolean }
 *                   status:      { type: string, enum: [active, generating, paused] }
 *                   job_id:      { type: string }
 *                   page_id:     { type: string }
 *                   account_id:  { type: string, nullable: true }
 *                   is_demo:     { type: number, enum: [0, 1] }
 *                   spend_today: { type: number }
 *                   leads_today: { type: number }
 *                   cpa:         { type: number }
 *               ad_set:
 *                 type: object
 *                 properties:
 *                   id:           { type: string }
 *                   name:         { type: string }
 *                   status:       { type: number }
 *                   budget_daily: { type: number, nullable: true }
 *                   ads_count:    { type: number }
 *               ads:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     id:                     { type: string }
 *                     adset_id:               { type: string }
 *                     campaign_id:            { type: string }
 *                     name:                   { type: string }
 *                     status:                 { type: number }
 *                     effective_status:       { type: string }
 *                     creative_image_url:     { type: string, nullable: true }
 *                     creative_thumbnail_url: { type: string, nullable: true }
 *                     link_description:       { type: string, nullable: true }
 *                     link_message:           { type: string, nullable: true }
 *                     link_name:              { type: string, nullable: true }
 *               campaign_settings:
 *                 type: object
 *                 properties:
 *                   campaign_id:       { type: string }
 *                   title:             { type: string }
 *                   budget_daily:      { type: number }
 *                   interests:         { type: array, items: { type: string } }
 *                   ad_text:           { type: string }
 *                   image_urls:        { type: array, items: { type: string } }
 *                   age_min:           { type: number }
 *                   age_max:           { type: number }
 *                   locations_include: { type: array, items: { type: string } }
 *                   locations_exclude: { type: array, items: { type: string } }
 *                   gender:            { type: string, enum: [male, female, all] }
 *                   is_demo:           { type: boolean }
 *     responses:
 *       200:
 *         description: Post updated successfully. Returns full updated document.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:    { $ref: '#/components/schemas/Post' }
 *       400:
 *         description: Missing page_id
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: false }
 *                 message: { type: string }
 *       404:
 *         description: Post not found or page_id mismatch
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: false }
 *                 message: { type: string }
 *       500:
 *         description: Server error
 */
router.put("/posts/:id", postsController.updatePost);

/**
 * @swagger
 * /api/leads/posts/{id}:
 *   delete:
 *     summary: Delete a draft post (demo campaign only)
 *     description: |
 *       Permanently deletes a post with status=draft.
 *       **Cannot delete executed posts** — only drafts.
 *       Ownership is verified by matching both **_id** and **page_id**.
 *       Returns **204 No Content** on success.
 *     tags: [Posts]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: MongoDB _id of the post
 *         example: "65f1a2b3c4d5e6f7a8b9c0d1"
 *       - in: query
 *         name: page_id
 *         required: true
 *         schema:
 *           type: string
 *         description: Required — validates ownership
 *         example: "123456789"
 *     responses:
 *       204:
 *         description: Post deleted successfully. No response body.
 *       400:
 *         description: Missing id or page_id
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Post not found, already executed, or page_id mismatch
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.delete("/posts/:id", postsController.deletePost);

// ─────────────────────────────────────────────
// LEADS
// ─────────────────────────────────────────────

/**
 * @swagger
 * /api/leads/stats:
 *   get:
 *     summary: Get lead status statistics for a page
 *     tags: [Leads]
 *     parameters:
 *       - in: query
 *         name: page_id
 *         required: true
 *         schema:
 *           type: string
 *         example: "123456789"
 *     responses:
 *       200:
 *         description: Stats grouped by status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     stats: { type: object, example: { "new": 5, "contacted": 3 } }
 *                     total: { type: integer, example: 8 }
 *       400:
 *         description: Missing page_id
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get("/stats", leadsController.getStats);

/**
 * @swagger
 * /api/leads:
 *   get:
 *     summary: Get leads with optional filters
 *     tags: [Leads]
 *     parameters:
 *       - in: query
 *         name: page_id
 *         required: true
 *         schema: { type: string }
 *         example: "123456789"
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [new, in_progress, closed, rejected, not_closed] }
 *       - in: query
 *         name: since
 *         schema: { type: string, format: date-time }
 *         description: Return only leads updated after this timestamp
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50 }
 *       - in: query
 *         name: skip
 *         schema: { type: integer, default: 0 }
 *     responses:
 *       200:
 *         description: Paginated list of leads
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/Lead' }
 *                 pagination:
 *                   type: object
 *                   properties:
 *                     total: { type: integer }
 *                     limit: { type: integer }
 *                     skip:  { type: integer }
 *       400:
 *         description: Missing page_id
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.get("/", leadsController.getLeads);

/**
 * @swagger
 * /api/leads:
 *   post:
 *     summary: Create a new lead
 *     tags: [Leads]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [page_id]
 *             properties:
 *               page_id:       { type: string, example: "123456789" }
 *               name:          { type: string, example: "ישראל ישראלי" }
 *               email:         { type: string, example: "israel@example.com" }
 *               phone:         { type: string, example: "0501234567" }
 *               status:        { type: string, example: "new" }
 *               custom_fields: { type: object, example: { city: "תל אביב" } }
 *     responses:
 *       201:
 *         description: Lead created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:    { $ref: '#/components/schemas/Lead' }
 *       400:
 *         description: Missing page_id
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
// ─── Referral (חבר מביא חבר) ──────────────────────────────────────────────────
router.post("/referral",                 leadsController.createReferralLead);
router.get("/referrals/admin",           leadsController.getAllReferralLeads);
router.get("/referrals/by-user/:phone",  leadsController.getReferralsByUser);
router.patch("/:id/referral-approve",    leadsController.approveReferralLead);
router.patch("/:id/referral-close",      leadsController.closeReferralLead);

router.post("/", leadsController.createLead);

/**
 * @swagger
 * /api/leads/batch:
 *   post:
 *     summary: Batch upsert leads
 *     description: Upsert multiple leads at once. All leads must belong to the given page_id.
 *     tags: [Leads]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [page_id, leads]
 *             properties:
 *               page_id: { type: string, example: "123456789" }
 *               leads:
 *                 type: array
 *                 items: { $ref: '#/components/schemas/Lead' }
 *     responses:
 *       200:
 *         description: Batch result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     inserted: { type: integer }
 *                     updated:  { type: integer }
 *                     total:    { type: integer }
 *       400:
 *         description: Invalid input
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.post("/batch", leadsController.batchUpsert);

/**
 * @swagger
 * /api/leads/chat-sync:
 *   post:
 *     summary: Sync leads from Facebook when chat is opened
 *     description: Called by the mobile app when a user opens the support chat. Upserts all leads (delta since last sync) into MongoDB and logs the sync event.
 *     tags: [Leads]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [pageId, forms]
 *             properties:
 *               userId:    { type: string, example: "user_0501234567" }
 *               pageId:    { type: string, example: "123456789" }
 *               since:     { type: integer, example: 1700000000 }
 *               syncedAt:  { type: integer, example: 1700086400 }
 *               forms:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     formId:     { type: string }
 *                     formName:   { type: string }
 *                     formStatus: { type: string }
 *                     leads:
 *                       type: array
 *                       items: { type: object }
 *     responses:
 *       200:
 *         description: Sync result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     inserted: { type: integer }
 *                     updated:  { type: integer }
 *                     total:    { type: integer }
 *       400:
 *         description: Invalid input
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.post("/sync", leadsController.syncLeads);

/**
 * @swagger
 * /api/leads/chat-context/{phone}:
 *   get:
 *     summary: Get all leads data for a user by phone
 *     description: Returns the advertiser's profile and all their accumulated Facebook leads, looked up by their phone number.
 *     tags: [Leads]
 *     parameters:
 *       - in: path
 *         name: phone
 *         required: true
 *         schema: { type: string }
 *         example: "0501234567"
 *     responses:
 *       200:
 *         description: User profile + all leads
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     profile: { type: object }
 *                     leads:
 *                       type: array
 *                       items: { type: object }
 *       404:
 *         description: No data found for this phone
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.get("/by-phone/:phone", leadsController.getLeadsByPhone);

/**
 * @swagger
 * /api/leads/{id}:
 *   put:
 *     summary: Update a lead
 *     tags: [Leads]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               page_id:       { type: string }
 *               name:          { type: string }
 *               email:         { type: string }
 *               phone:         { type: string }
 *               status:        { type: string }
 *               custom_fields: { type: object }
 *     responses:
 *       200:
 *         description: Updated lead
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:    { $ref: '#/components/schemas/Lead' }
 *       404:
 *         description: Lead not found
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.put("/:id", leadsController.updateLead);

/**
 * @swagger
 * /api/leads/{id}/status:
 *   patch:
 *     summary: Update only the status of a lead
 *     tags: [Leads]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [status]
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [new, in_progress, closed, rejected, not_closed]
 *                 example: "in_progress"
 *               page_id:
 *                 type: string
 *                 description: Recommended — validates ownership
 *                 example: "123456789"
 *     responses:
 *       200:
 *         description: Lead with updated status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:    { $ref: '#/components/schemas/Lead' }
 *       400:
 *         description: Missing or invalid status
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       404:
 *         description: Lead not found
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.get("/statuses", leadsController.getLeadStatuses);
router.patch("/:id/status", leadsController.updateLeadStatus);
router.patch("/:id/notes", leadsController.updateLeadNotes);

/**
 * @swagger
 * /api/leads/{id}:
 *   delete:
 *     summary: Soft-delete a lead (sets status=deleted)
 *     tags: [Leads]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: page_id
 *         schema: { type: string }
 *         description: Validates ownership
 *     responses:
 *       200:
 *         description: Lead deleted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 message: { type: string }
 *       404:
 *         description: Lead not found
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.delete("/:id", leadsController.deleteLead);

// ─── DEV: Test lead notification ──────────────────────────────────────────────
// POST /api/leads/test-notify   { phone, leadId }
router.post("/test-notify", async (req, res) => {
  const { phone, leadId } = req.body;
  if (!phone || !leadId) return res.status(400).json({ error: "phone and leadId required" });
  try {
    const { notifyUser } = require("../services/push-notification.service");
    const sent = await notifyUser(phone, "ליד חדש!", "לחץ לצפייה בפרטי הליד", { leadId });
    res.json({ success: sent, phone, leadId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// WhatsApp click tracker — public POST endpoint
// Hit by wa-tracker.js on landing pages via sendBeacon (no auth, CORS *).
// ─────────────────────────────────────────────
const waClicksController = require("../controllers/wa-clicks.controller");
router.post("/wa-click", waClicksController.trackClick);

module.exports = router;
