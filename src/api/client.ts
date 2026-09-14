const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "/api";

/* Optional comma-separated list of old backend hostnames whose absolute
   image URLs are still baked into migrated DB rows (e.g. if data is ever
   imported from a previous backend). Empty by default — a fresh install
   has nothing to rewrite. Set VITE_LEGACY_IMG_HOSTS="old-host.example.com"
   after a data migration if old absolute URLs start showing up broken. */
const LEGACY_IMG_HOSTS = ((import.meta.env.VITE_LEGACY_IMG_HOSTS as string | undefined) ?? "")
  .split(",").map(h => h.trim()).filter(Boolean);

/**
 * Converts a server-returned image URL into one the browser can actually load.
 *
 * Two cases:
 *  1. Relative `/api/img?...` URL — when VITE_API_BASE is a full origin we
 *     prepend it so the image loads against that backend.
 *  2. Legacy absolute URL pointing at a host listed in VITE_LEGACY_IMG_HOSTS
 *     (only relevant right after migrating data from an old backend). Some
 *     browser networks can't resolve an arbitrary old hostname directly
 *     (e.g. corporate VPN with split DNS) even though the server can —
 *     which produces `net::ERR_NAME_NOT_RESOLVED`. We rewrite to the
 *     same-origin `/api/...` path so the request goes through the C-panel
 *     Express proxy, which DOES resolve and forward it. Same-origin also
 *     avoids any CORS hop.
 */
export function resolveImgUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  /* Reject file:// — a mobile client occasionally saves the picker's local
     cache path (e.g. file:///var/mobile/.../ImagePicker/...png) as the
     remote logoUrl when the upload step silently fails. The browser
     blocks file:// URLs from remote pages (blocked:other), which renders
     as a broken-image icon. Returning undefined here lets the UI show
     the empty-logo state ("העלה לוגו") instead, prompting a fresh
     upload. The backend should also stop accepting file:// — see the
     server-side guard next to the logoUrl write paths. */
  if (url.startsWith("file://")) return undefined;
  /* Legacy host rewrite — keep BEFORE the relative-URL branch so the rewritten
     path can also benefit from the absolute-origin prefix when applicable. */
  if (LEGACY_IMG_HOSTS.length) {
    const legacy = url.match(/^https?:\/\/([^/]+)(\/.*)$/);
    if (legacy && LEGACY_IMG_HOSTS.includes(legacy[1])) {
      url = legacy[2].startsWith("/api") ? legacy[2] : `/api${legacy[2]}`;
    }
  }
  if (url.startsWith("/api") && BASE.startsWith("http")) {
    try { return new URL(url, BASE).href; } catch { /* fall through */ }
  }
  return url;
}

/** The backend answers 503 `fb_unavailable` for every Meta-backed route
 *  while the Facebook integration is switched off (no client tokens are
 *  stored since the CRM was retired). Screens render this as a calm
 *  "לא זמין" panel instead of an error. */
export function isFbUnavailable(err: unknown): boolean {
  return err instanceof ApiError && err.code === "fb_unavailable";
}

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("cpanel_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Error thrown by `req` for non-2xx responses. Carries the HTTP status and
 * the server's `error` code so callers can branch on specific failures
 * (e.g. `code === "not_your_client"` for the ownership gate) without
 * string-matching message text.
 */
export class ApiError extends Error {
  status: number;
  code: string;
  data: Record<string, unknown>;
  constructor(message: string, status: number, code: string, data: Record<string, unknown> = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

export async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...authHeaders(), ...(opts.headers ?? {}) },
  });
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) {
    const text = await res.text();
    throw new ApiError(`שגיאת שרת ${res.status}: ${text.slice(0, 300)}`, res.status, "non_json");
  }
  const json = await res.json();
  if (!res.ok) {
    const code = typeof json?.error === "string" ? json.error : "server_error";
    const message = json?.message || json?.error || "Server error";
    throw new ApiError(message, res.status, code, json);
  }
  return json;
}

// ── Auth ─────────────────────────────────────────────────────────────
export function login(name: string, password: string) {
  return req<{ agent: Agent; token: string }>("/agents/login", {
    method: "POST",
    body: JSON.stringify({ name, password }),
  });
}

export function getMe() {
  return req<{ agent: Agent }>("/agents/me");
}

// ── Clients ──────────────────────────────────────────────────────────
export function getClients(search?: string) {
  const qs = search ? `?search=${encodeURIComponent(search)}` : "";
  return req<Client[]>(`/cpanel/clients${qs}`);
}

export function getClientDetail(phone: string) {
  return req<ClientDetail>(`/cpanel/clients/${encodeURIComponent(phone)}`);
}

/** Save manager-facing free-text notes about the client. Stored on the
 *  client's support_chats row. Accepts up to 4000 chars. */
export function updateClientNotes(phone: string, notes: string) {
  return req<{ success: boolean; notes: string }>(
    `/cpanel/clients/${encodeURIComponent(phone)}/notes`,
    { method: "PUT", body: JSON.stringify({ notes }) },
  );
}

/**
 * Wrap a fetch in a soft-fail. If the backend errors out (commonly 500 when
 * Facebook credentials are missing for a client), return the
 * supplied fallback so the UI renders an empty state instead of crashing.
 */
async function softFetch<T>(p: Promise<T>, fallback: T, label: string): Promise<T> {
  try { return await p; }
  catch (err) {
    /* `fb_unavailable` is a deliberate switch, not a backend hiccup — let it
       through so the screen can render the "לא זמין" panel instead of an
       empty state that looks like "this client has no campaigns". */
    if (isFbUnavailable(err)) throw err;
    console.warn(`[client.ts] ${label} failed:`, err instanceof Error ? err.message : err);
    return fallback;
  }
}

export function getClientCampaigns(phone: string) {
  return softFetch(
    req<{ campaigns: Campaign[]; error?: string }>(`/cpanel/clients/${encodeURIComponent(phone)}/campaigns`),
    { campaigns: [], error: "Backend unavailable" },
    `getClientCampaigns(${phone})`,
  );
}

export function getClientLeads(phone: string, days = 30) {
  return softFetch(
    req<{ total: number; trend: TrendPoint[]; error?: string }>(`/cpanel/clients/${encodeURIComponent(phone)}/leads?days=${days}`),
    { total: 0, trend: [], error: "Backend unavailable" },
    `getClientLeads(${phone})`,
  );
}


export function toggleCampaignStatus(phone: string, campaignId: string, status: "ACTIVE" | "PAUSED") {
  return req<{ success: boolean }>(`/cpanel/clients/${encodeURIComponent(phone)}/campaign-status`, {
    method: "POST",
    body: JSON.stringify({ campaignId, status }),
  });
}

/* ── Products catalog (DB-backed) ──────────────────────────────────── */

export interface ProductItem {
  _id: string;
  key: string;          // "ad" | "lp" | "video" | "logo" | "social_ad" | ...
  kind: "item";
  label: string;
  emoji?: string;
  unitPrice: number;
  sortOrder: number;
  active?: boolean;
  isPermission?: boolean;
}

export interface ProductPrebuilt {
  _id: string;
  key: string;          // "platinum" | "premium" | "basic" | ...
  kind: "prebuilt";
  name: string;
  price: number;
  discountPct?: number;
  badge?: string;
  bullets: string[];
  items: Record<string, number>;   // { ad: 35, lp: 1, ... }
  coins: number;
  sortOrder: number;
  active?: boolean;
}

export interface ProductSocial {
  _id: string;
  key: string;          // "social_weekly" | "social_biweekly" | "social_monthly"
  kind: "social";
  name: string;
  price: number;
  discountPct?: number;
  badge?: string;
  periodLabel?: string; // "שבועי" | "דו-שבועי" | "חודשי"
  bullets: string[];
  items: Record<string, number>;
  coins: number;
  sortOrder: number;
  active?: boolean;
}

export interface ProductCoins {
  _id: string;
  key: string;
  kind: "coins";
  name: string;
  price: number;
  coins: number;
  sortOrder: number;
  active?: boolean;
}

export interface ProductsCatalog {
  items: ProductItem[];
  prebuilt: ProductPrebuilt[];
  social: ProductSocial[];
  coins: ProductCoins[];
}

export function getProducts() {
  return req<ProductsCatalog>(`/cpanel/products`);
}

export function getAccountManagers() {
  return req<AccountManager[]>("/cpanel/account-managers");
}

export interface AddClientResult {
  success: boolean;
  phone: string;
  name: string;
  alreadyExisted: boolean;
}

export function addClient(phone: string) {
  return req<AddClientResult>("/cpanel/clients/add", {
    method: "POST",
    body: JSON.stringify({ phone }),
  });
}

export function assignManager(chatId: string, agentId: string | null) {
  return req<{ success: boolean }>(`/agents/users/${encodeURIComponent(chatId)}/assign-manager`, {
    method: "PUT",
    body: JSON.stringify({ agentId }),
  });
}

/* ── Claim a client (transfer from another manager to me) ──────────────
   Triggered from the access-denied screen. Any logged-in manager may
   claim — server enforces auth but not current ownership for this
   specific endpoint. */
export function claimClient(phone: string) {
  return req<{
    success: boolean;
    alreadyOwned?: boolean;
    newAgentId?: string;
    newAgentName?: string;
    previousAgentName?: string | null;
  }>(`/cpanel/clients/${encodeURIComponent(phone)}/claim`, {
    method: "POST",
  });
}

export function getStats() {
  return req<{ totalClients: number; unreadMessages: number }>("/cpanel/stats");
}


export function getMessages(phone: string) {
  return req<{ chatId: string | null; messages: ChatMessage[] }>(`/cpanel/clients/${encodeURIComponent(phone)}/messages`);
}

/* ── Social-post scheduler ──────────────────────────────────────────────
 * Hands an already-approved batch of WowOrganic posts to the shared
 * ai-creation-order pipeline. The server creates one "social_schedule"
 * order with a slot per item; the existing publish-creatives cron picks
 * it up every 15 minutes and posts to Facebook/Instagram via Graph API.
 */
export interface ScheduleSocialItem {
  imageUrl: string;
  description: string;
  scheduledAt: number;   // Unix ms — server converts to Asia/Jerusalem date+time
}

export function scheduleSocialPosts(payload: {
  phone: string;
  items: ScheduleSocialItem[];
}) {
  return req<{ success: boolean; orderId: string }>(
    `/ai-creation-order/schedule-social`,
    {
      method: "POST",
      body: JSON.stringify({
        phone:    payload.phone,
        facebook: {},   // server-side cron resolves the client's tokens at publish time
        instagram: {},
        items:    payload.items,
      }),
    },
  );
}


export interface FbTokenStatus {
  status: "valid" | "expired" | "missing";
  valid: boolean;
  message?: string;
  code?: number;
  errorSubcode?: number;
  userId?: string;
  name?: string;
  adAccountId?: string | null;
}

export function getClientFbTokenStatus(phone: string) {
  return softFetch<FbTokenStatus>(
    req<FbTokenStatus>(`/cpanel/clients/${encodeURIComponent(phone)}/fb-token-status`),
    { status: "missing", valid: false, message: "Backend unavailable or endpoint not implemented" },
    `getClientFbTokenStatus(${phone})`,
  );
}

export function getCharacterization(phone: string) {
  return req<Characterization>(`/cpanel/clients/${encodeURIComponent(phone)}/characterization`);
}

export function updateCharacterization(
  phone: string,
  businessProfile: Partial<BusinessProfile>,
  adBriefAnswers?: Record<string, string>
) {
  return req<{ success: boolean }>(`/cpanel/clients/${encodeURIComponent(phone)}/characterization`, {
    method: "PUT",
    body: JSON.stringify({ businessProfile, adBriefAnswers }),
  });
}

/** "סיים איפיון": the server re-checks the required fields, records the
 *  completion and sends the client the "איפיון הושלם" WhatsApp message
 *  (once per client). */
export function markCharacterizationComplete(phone: string) {
  return req<{ success: boolean }>(`/cpanel/clients/${encodeURIComponent(phone)}/characterization/complete`, {
    method: "POST",
    body: "{}",
  });
}

// ── Facebook Connect ──────────────────────────────────────────────────

export interface FbConnectStart {
  status: "connecting" | "setup" | "two_factor" | "method_picker" | "checkpoint" | "failed";
  sessionId?: string;
  options?: { label: string; value: string }[];
  reason?: string;
}

export interface FbStatus {
  status: "none" | "connected" | "error";
  connectedAt?: string;
  fbPostifyProfileId?: string;
  fbUserId?: string;
}

export function startFbConnect(phone: string): Promise<FbConnectStart> {
  return req<FbConnectStart>(`/cpanel/clients/${encodeURIComponent(phone)}/fb-connect/start`, { method: "POST" });
}

export function getFbStatus(phone: string): Promise<FbStatus> {
  return req<FbStatus>(`/cpanel/clients/${encodeURIComponent(phone)}/fb-status`);
}

export function submitFbCode(phone: string, sessionId: string, code: string) {
  return req(`/cpanel/clients/${encodeURIComponent(phone)}/fb-connect/${sessionId}/code`, {
    method: "POST", body: JSON.stringify({ code }),
  });
}

export function pickFbMethod(phone: string, sessionId: string, method: string) {
  return req(`/cpanel/clients/${encodeURIComponent(phone)}/fb-connect/${sessionId}/pick-method`, {
    method: "POST", body: JSON.stringify({ method }),
  });
}

export function saveFbResult(phone: string, result: { fbPostifyProfileId?: string; fbUserId?: string }) {
  return req(`/cpanel/clients/${encodeURIComponent(phone)}/fb-connect/result`, {
    method: "POST", body: JSON.stringify(result),
  });
}

// ── AI (server proxies OpenAI / Gemini) ──────────────────────────────

export interface AiReplySuggestion {
  text: string;
  tone: "warm" | "professional" | "concise";
}

export function aiSuggestReplies(phone: string, lastN = 12) {
  return req<{ suggestions: AiReplySuggestion[] }>(`/cpanel/ai/suggest-replies`, {
    method: "POST",
    body: JSON.stringify({ phone, lastN }),
  });
}

export function aiSummarizeChat(phone: string) {
  return req<{ summary: string; sentiment: "positive" | "neutral" | "negative"; intents: string[] }>(`/cpanel/ai/summarize-chat`, {
    method: "POST",
    body: JSON.stringify({ phone }),
  });
}

export function aiDailyDigest() {
  return req<{ items: AiDigestItem[]; generatedAt: string }>(`/cpanel/ai/daily-digest/run`, {
    method: "POST",
  });
}

export interface AiDigestItem {
  kind: "stale_chat" | "low_credit" | "missed_appointment" | "high_intent" | "churn_risk";
  clientPhone: string;
  clientName: string;
  reason: string;
  severity: "low" | "med" | "high";
  /** Manager-assigned tier — used to prioritize/highlight items. */
  tier?: "GOLD" | "VIP" | "PRO" | "PLUS" | "SILVER" | "REGULAR";
}

export function aiGenerateAdCopy(phone: string, count = 10) {
  return req<{ ads: { headline: string; body: string; cta: string }[] }>(`/cpanel/ai/ad-copy`, {
    method: "POST",
    body: JSON.stringify({ phone, count }),
  });
}

// ── Broadcast (server uses SMS4Free + Green API) ──────────────────────

export interface BroadcastResult {
  jobId: string;
  total: number;
  channel: "sms" | "whatsapp" | "both";
  scheduledAt?: string;
}

export function sendBroadcast(payload: {
  channel: "sms" | "whatsapp" | "both";
  audience: { kind: "all" } | { kind: "selected"; phones: string[] } | { kind: "filter"; tags?: string[]; status?: string };
  message: string;
  scheduleAt?: string;
}) {
  return req<BroadcastResult>(`/cpanel/broadcast`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function sendClientSms(phone: string, message: string) {
  return req<{ sentCount: number; failCount: number }>(`/cpanel/broadcast`, {
    method: "POST",
    body: JSON.stringify({ phones: [phone], message, channel: "sms" }),
  });
}

export function getBroadcastTemplates() {
  return req<{ templates: BroadcastTemplate[] }>(`/cpanel/broadcast/templates`);
}

export interface BroadcastTemplate {
  id: string;
  name: string;
  channel: "sms" | "whatsapp" | "both";
  body: string;
}

export function getBroadcastHistory() {
  return req<{ items: BroadcastHistoryItem[] }>(`/cpanel/broadcast/history`);
}

export interface BroadcastHistoryItem {
  jobId: string;
  channel: "sms" | "whatsapp" | "both";
  total: number;
  delivered: number;
  failed: number;
  pending: number;
  bodyPreview: string;
  createdAt: string;
  status: "scheduled" | "sending" | "done" | "canceled";
}

// ── Files (server uses Backblaze B2) ──────────────────────────────────


// ── Agent wallet / commission ledger ──────────────────────────────────

export interface WalletCommission {
  id: string;
  clientPhone: string | null;
  baseAmount: number;
  commissionAmount: number;
  commissionRate: number;
  sourceKind: "direct_charge" | "payment_link" | "package" | string;
  transactionId?: string | null;
  description?: string | null;
  earnedAt: string;
  status: "earned" | "paid";
  paidAt?: string | null;
}

export interface AgentWallet {
  /** Current available balance (totalEarned − totalPaid). */
  balance: number;
  /** Lifetime commissions earned. */
  totalEarned: number;
  /** Lifetime commissions paid out to the manager. */
  totalPaid: number;
  /** Sum of base amounts charged (the gross volume the manager moved). */
  totalCharged: number;
  /** Lifetime base amounts (alias of totalCharged for backward compat). */
  totalChargedBase?: number;
  /** Commissions earned this calendar month. */
  monthEarned: number;
  /** Effective commission rate (decimal — 0.10 = 10%). */
  commissionRate: number;
  currency: string;
  /** Daily aggregate of the last 30 days. */
  trend: { date: string; earned: number; count: number }[];
  /** Last ~50 commission rows, newest first. */
  recent: WalletCommission[];
  /** Backward-compat: same as `recent` mapped to legacy shape. */
  transactions: { id: string; amount: number; description: string; date: string; phone: string }[];
}

export function getAgentWallet() {
  return req<AgentWallet>(`/cpanel/wallet`);
}

export function markCommissionPaid(id: string) {
  return req<{ commission: WalletCommission }>(`/cpanel/wallet/commissions/${encodeURIComponent(id)}/mark-paid`, {
    method: "POST",
  });
}

// ── Facebook Lead Ads (server proxies Meta Marketing API per client token) ──

export interface FbLeadForm {
  id: string;
  name: string;
  status: "ACTIVE" | "ARCHIVED" | string;
  leadsCount?: number;
  createdAt?: string;
}

export interface FbLead {
  id: string;
  formId: string;
  formName?: string;
  createdAt: string;
  fields: Record<string, string>;   // {full_name: "...", phone_number: "...", email: "...", custom_q_X: "..."}
  campaignId?: string;
  campaignName?: string;
  adId?: string;
  adName?: string;
  isFollowedUp?: boolean;
}

export function getClientFbLeadForms(phone: string) {
  return softFetch(
    req<{ forms: FbLeadForm[] }>(`/cpanel/clients/${encodeURIComponent(phone)}/fb-lead-forms`),
    { forms: [] },
    `getClientFbLeadForms(${phone})`,
  );
}

export function getClientFbLeads(phone: string, opts: { formId?: string; days?: number; limit?: number } = {}) {
  const qs = new URLSearchParams();
  if (opts.formId) qs.set("formId", opts.formId);
  if (opts.days !== undefined) qs.set("days", String(opts.days));
  if (opts.limit) qs.set("limit", String(opts.limit));
  const tail = qs.toString() ? `?${qs}` : "";
  return softFetch(
    req<{ leads: FbLead[]; nextCursor?: string }>(`/cpanel/clients/${encodeURIComponent(phone)}/fb-leads${tail}`),
    { leads: [] },
    `getClientFbLeads(${phone})`,
  );
}

export function markFbLeadFollowedUp(phone: string, leadId: string, followedUp: boolean) {
  return req<{ success: boolean }>(`/cpanel/clients/${encodeURIComponent(phone)}/fb-leads/${encodeURIComponent(leadId)}/followed-up`, {
    method: "POST",
    body: JSON.stringify({ followedUp }),
  });
}

// ── Pipeline (server-stored CRM stages) ───────────────────────────────

export type PipelineStage = "new" | "qualified" | "proposal" | "won" | "lost";

export interface PipelineCard {
  clientId: string;
  clientPhone: string;
  clientName: string;
  stage: PipelineStage;
  value?: number;
  notes?: string;
  updatedAt: string;
  movedAt: string;
}

export function getPipeline() {
  return req<{ cards: PipelineCard[] }>(`/cpanel/pipeline`);
}

export function updatePipelineStage(clientPhone: string, stage: PipelineStage, value?: number) {
  return req<{ success: boolean }>(`/cpanel/pipeline/${encodeURIComponent(clientPhone)}`, {
    method: "PUT",
    body: JSON.stringify({ stage, value }),
  });
}

// ── AI digest schedule (server-side cron) ─────────────────────────────

export interface DigestSchedule {
  enabled: boolean;
  hour: number;          // 0-23 in agent's local timezone
  channels: ("inapp" | "email" | "sms" | "whatsapp")[];
  lastRunAt?: string;
  nextRunAt?: string;
}

export function getDigestSchedule() {
  return req<DigestSchedule>(`/cpanel/ai/daily-digest/schedule`);
}

export function setDigestSchedule(payload: Partial<DigestSchedule>) {
  return req<DigestSchedule>(`/cpanel/ai/daily-digest/schedule`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function runDigestNow() {
  return req<{ items: AiDigestItem[]; generatedAt: string }>(`/cpanel/ai/daily-digest/run`, {
    method: "POST",
  });
}

// ── Appointments (server-side CRUD) ───────────────────────────────────

export type AppointmentStatus = "pending" | "confirmed" | "done" | "canceled";

export interface Appointment {
  id: string;
  clientPhone: string;
  clientName: string;
  scheduledAt: string;
  durationMin: number;
  type: string;
  status: AppointmentStatus;
  notes?: string;
  createdAt: string;
}

// Server uses different field names than the frontend model
interface ServerAppt {
  _id: string;
  customerPhone: string;
  scheduledStart: string;
  callPurpose?: string;
  durationMin?: number;
  status?: AppointmentStatus;
  notes?: string;
  clientName?: string;
  name?: string;
  createdAt: string;
}

function mapServerAppt(a: ServerAppt): Appointment {
  return {
    id: a._id,
    clientPhone: a.customerPhone ?? "",
    clientName: a.clientName ?? a.name ?? a.customerPhone ?? "",
    scheduledAt: a.scheduledStart,
    durationMin: a.durationMin ?? 30,
    type: a.callPurpose ?? "",
    status: a.status ?? "pending",
    notes: a.notes,
    createdAt: a.createdAt,
  };
}

function flattenGrouped(data: Record<string, ServerAppt[]>): Appointment[] {
  return Object.values(data ?? {}).flat().map(mapServerAppt);
}

function apptDateRange(range: "today" | "week" | "month" | "all") {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const fmt = (d: Date) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;

  if (range === "month") {
    const s = new Date(now.getFullYear(), now.getMonth(), 1);
    const e = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return { from: fmt(s), to: fmt(e), path: "/appointments/month" };
  }
  if (range === "all") {
    const s = new Date(now); s.setMonth(s.getMonth() - 1); s.setDate(1);
    const e = new Date(now); e.setMonth(e.getMonth() + 3); e.setDate(1);
    return { from: fmt(s), to: fmt(e), path: "/appointments/month" };
  }
  // week or today
  const s = new Date(now); s.setHours(0, 0, 0, 0); s.setDate(s.getDate() - s.getDay());
  const e = new Date(s); e.setDate(e.getDate() + 7);
  return { from: fmt(s), to: fmt(e), path: "/appointments/week" };
}

export function getAppointments(range: "today" | "week" | "month" | "all" = "week") {
  const { from, to, path } = apptDateRange(range);
  return req<{ success: boolean; data: Record<string, ServerAppt[]> }>(
    `${path}?from=${from}&to=${to}`
  ).then(res => ({ items: flattenGrouped(res.data) }));
}

export function createAppointment(payload: {
  clientPhone: string;
  scheduledAt: string;
  durationMin: number;
  type: string;
  notes?: string;
}) {
  return req<ServerAppt>(`/appointments`, {
    method: "POST",
    body: JSON.stringify({
      customerPhone: payload.clientPhone,
      scheduledStart: payload.scheduledAt,
      callPurpose: payload.type,
      durationMin: payload.durationMin,
      notes: payload.notes,
    }),
  }).then(mapServerAppt);
}

export function updateAppointment(id: string, patch: Partial<Pick<Appointment, "scheduledAt" | "durationMin" | "type" | "notes" | "status">>) {
  const body: Record<string, unknown> = {};
  if (patch.scheduledAt !== undefined) body.scheduledStart = patch.scheduledAt;
  if (patch.durationMin !== undefined) body.durationMin = patch.durationMin;
  if (patch.type !== undefined) body.callPurpose = patch.type;
  if (patch.notes !== undefined) body.notes = patch.notes;
  if (patch.status !== undefined) body.status = patch.status;
  return req<ServerAppt>(`/appointments/${encodeURIComponent(id)}/update`, {
    method: "PATCH",
    body: JSON.stringify(body),
  }).then(mapServerAppt);
}

export function deleteAppointment(id: string) {
  return req<{ success: boolean }>(`/appointments/${encodeURIComponent(id)}/cancel`, {
    method: "PATCH",
    body: "{}",
  });
}

// ── Aggregate analytics for dashboard ─────────────────────────────────

export interface DashboardSummary {
  clients: { total: number; active7d: number; atRisk: number; outOfCredit: number };
  messages: { unread: number; sent7d: number; received7d: number; missed: number };
  pipeline: { leads: number; qualified: number; proposals: number; won: number };
  spend7d: number;
  revenue7d: number;
  trends: {
    leads: { label: string; value: number }[];
    spend: { label: string; value: number }[];
    revenue: { label: string; value: number }[];
  };
  byCategory: { label: string; value: number }[];
  byManager?: { label: string; value: number }[];
}

export function getDashboardSummary(days = 7) {
  return req<DashboardSummary>(`/cpanel/dashboard?days=${days}`);
}

// ── Types ─────────────────────────────────────────────────────────────
export interface Agent {
  id: string;
  name: string;
  nickname?: string;
  role: string;
  phone?: string;
}

export interface Client {
  id: string;
  name: string;
  phone: string;
  logoUrl?: string;
  status: string;
  accountManagerId?: string;
  accountManagerName?: string;
  lastActive?: string;
  hasPaymentToken: boolean;
  paymentLast4?: string;
  unread?: boolean;
  /** Manager-assigned tier — drives sort priority + UI accents. */
  tier?: "GOLD" | "VIP" | "PRO" | "PLUS" | "SILVER" | "REGULAR";
  tierUpdatedAt?: string | null;
}

export interface ClientDetail {
  chat: { id: string; name: string; phone: string; status: string; accountManagerId?: string; accountManagerName?: string; notes: string } | null;
  profile: Record<string, unknown> | null;
  payment: { hasToken: boolean; last4?: string; expiry?: string };
  adAccountId?: string;
  pageId?: string;
  /** Current coin balance pulled from `users.coins`. 0 if the user doc is missing. */
  coins?: number;
  /** Lifetime coins spent (`users.coinsUsed`). 0 if absent. */
  coinsUsed?: number;
  referral?: { leadId: string; referredBy: string | null; status: string } | null;
}

export interface Campaign {
  id: string;
  name: string;
  status: string;
  effectiveStatus: string;
  dailyBudget?: number;
  spendToday: number;
  leadsToday: number;
  objective?: string;
  imageUrl?: string;
  impressions?: number;
  clicks?: number;
  ctr?: number;
}

export interface AggregatedCampaign extends Campaign {
  clientPhone: string;
  clientName: string;
  imageUrl?: string;
  reach?: number;
  impressions?: number;
  clicks?: number;
  ctr?: number;
  platform?: "facebook" | "instagram" | "both";
  weeklyLeadsTrend?: number[];
}

export function getAllCampaigns() {
  return req<{ campaigns: AggregatedCampaign[] }>("/cpanel/campaigns");
}

export interface AdCreative {
  id: string;
  imageUrl?: string;
  videoUrl?: string;
  thumbnailUrl?: string;
  title?: string;
  body?: string;
  callToAction?: string;
}

export interface AdInsights {
  impressions: number;
  clicks: number;
  spend: number;
  ctr: number;
  cpm: number;
  reach: number;
  leads: number;
  costPerLead?: number;
}

export interface Ad {
  id: string;
  name: string;
  status: "ACTIVE" | "PAUSED" | "DELETED" | string;
  effectiveStatus: string;
  adSetId?: string;
  adSetName?: string;
  creative: AdCreative;
  insights?: AdInsights;
}

export interface AdAudience {
  ageMin?: number;
  ageMax?: number;
  genders?: number[];
  /** Locations carry the FB `type` so the server can route them into
   *  the right `geo_locations` bucket (countries / regions / cities). */
  locations?: { name: string; key: string; type: "country" | "region" | "city" | "subcity" | "neighborhood"; radiusKm?: number; include?: boolean }[];
  interests?: { name: string; id: string }[];
  customAudiences?: { name: string; id: string }[];
  excludedAudiences?: { name: string; id: string }[];
  placements?: string[];
}

/** A single hit returned by the FB targeting-search proxy. */
export interface FbTargetingHit {
  /** FB's internal key — must be sent back verbatim on save. */
  key: string;
  /** FB's id (numeric string) for interest results. */
  id?: string;
  /** Display name. */
  name: string;
  /** Geo type: "city" | "region" | "country" | "subcity" | "neighborhood". */
  type?: string;
  /** Region/country context shown in the dropdown ("Tel Aviv, Israel"). */
  country_name?: string;
  region?: string;
  /** Estimated audience size (interest hits only). */
  audience_size_lower_bound?: number;
  audience_size_upper_bound?: number;
}

/** Search FB's targeting taxonomy (cities, regions, interests, …) via
 *  the server proxy. The server signs the request with the client's
 *  FB user token, so authentication is invisible to the caller. */
export function searchFbTargeting(
  phone: string,
  type: "adgeolocation" | "adinterest" | "adlocale",
  q: string,
): Promise<FbTargetingHit[]> {
  if (!q.trim()) return Promise.resolve([]);
  const qs = new URLSearchParams({ type, q });
  return req<FbTargetingHit[]>(`/cpanel/clients/${encodeURIComponent(phone)}/fb-targeting/search?${qs}`);
}

export function getCampaignAds(phone: string, campaignId: string) {
  return req<{ ads: Ad[] }>(`/cpanel/clients/${encodeURIComponent(phone)}/campaigns/${encodeURIComponent(campaignId)}/ads`);
}

export function updateAd(phone: string, adId: string, updates: {
  status?: string;
  title?: string;
  body?: string;
  callToAction?: string;
}) {
  return req<{ success: boolean }>(`/cpanel/clients/${encodeURIComponent(phone)}/ads/${encodeURIComponent(adId)}`, {
    method: "PUT",
    body: JSON.stringify(updates),
  });
}

export function deleteAd(phone: string, adId: string) {
  return req<{ success: boolean }>(`/cpanel/clients/${encodeURIComponent(phone)}/ads/${encodeURIComponent(adId)}`, {
    method: "DELETE",
  });
}

export function updateAdAudience(phone: string, adSetId: string, audience: AdAudience) {
  return req<{ success: boolean }>(`/cpanel/clients/${encodeURIComponent(phone)}/adsets/${encodeURIComponent(adSetId)}/audience`, {
    method: "PUT",
    body: JSON.stringify(audience),
  });
}

/* ── WOW Organic Ads — 5 organic social posts ──────────────────────── */

export interface WowOrganicSlide {
  id: number;
  imageUrl?: string;
  /** Slide-level overlay copy (used by the carousel UI). */
  title?: string;
  body?: string;
  caption?: string;
  nanoPrompt?: string | null;
  regeneratedAt?: string;
  error?: string;
}

export interface WowOrganicPost {
  id: number;
  type: "tip" | "story" | "behind" | "testimonial" | "question" | "carousel" | string;
  headline: string;
  description: string;
  cta: string;
  nanoPrompt?: string | null;
  imageUrl?: string;
  regeneratedAt?: string;
  /** Manager edit timestamp — set when account manager edits the post copy. */
  editedAt?: string | null;
  error?: string;
  /** Manager approval timestamp — set when account manager approves the post. */
  managerApprovedAt?: string | null;
  /** When this post is a carousel, holds the 3 slides (each with its own image). */
  slides?: WowOrganicSlide[];
  /** Rich promotion-ready post body for Instagram/Facebook copy-paste,
   *  generated on-demand. Does NOT appear on the image. */
  promotionDescription?: string;
  promotionDescriptionGeneratedAt?: string;
  /** Set true while the server is regenerating this post in the background. */
  regenerating?: boolean;
}

export interface WowOrganicSession {
  sessionId: string;
  status: WowAdsStatus;
  totalPosts: number;
  completedCount: number;
  generatedPosts: WowOrganicPost[];
  error?: string;
  createdAt: string;
  updatedAt: string;
  /** Client review state once the manager dispatches the set for approval. */
  clientApprovalStatus?: "draft" | "sent" | "approved" | "rejected" | null;
  /** Free-text feedback the client left when rejecting. */
  clientFeedback?: string | null;
  clientApprovalToken?: string | null;
  clientApprovedAt?: string | null;
}

export function generateWowOrganic(phone: string) {
  return req<{ success: boolean; sessionId: string; status: WowAdsStatus }>(
    `/cpanel/clients/${encodeURIComponent(phone)}/wow-organic/generate`,
    { method: "POST", body: "{}" }
  );
}

export function resetWowOrganicSessions(phone: string) {
  return req<{ success: boolean }>(
    `/cpanel/clients/${encodeURIComponent(phone)}/wow-organic/sessions`,
    { method: "DELETE" }
  );
}
export function getWowOrganic(phone: string) {
  return req<{ session: WowOrganicSession | null }>(`/cpanel/clients/${encodeURIComponent(phone)}/wow-organic`);
}
export function regenerateWowOrganicPost(phone: string, postId: number, userChangeRequest?: string) {
  return req<{ success: boolean; post: WowOrganicPost }>(
    `/cpanel/clients/${encodeURIComponent(phone)}/wow-organic/${postId}/regenerate`,
    { method: "POST", body: JSON.stringify(userChangeRequest ? { userChangeRequest } : {}) }
  );
}

/* ── WOW Landing Page — AI-generated LP ─────────────────────────────── */

export type WowLpStatus = "generating_content" | "generating_images" | "done" | "error";
export type WowLpApprovalStatus = "draft" | "sent" | "approved" | "rejected";

export interface WowLpImage { id: number; section: string; url?: string; error?: string; regeneratedAt?: string }

export interface WowLpSession {
  sessionId: string;
  status: WowLpStatus;
  brand_strategy?: any;
  landing_page?: any;
  design_theme?: any;
  images?: WowLpImage[];
  totalImages?: number;
  completedImages?: number;
  approvalStatus?: WowLpApprovalStatus;
  approvalToken?: string;
  sentForApprovalAt?: string;
  clientResponseAt?: string;
  clientFeedback?: string;
  error?: string;
  createdAt?: string;
  updatedAt?: string;
  /* v2 engine fields — sess.html is the fully-rendered template
     HTML, templateName is the AI-picked template, engine is "v2"
     for the new pipeline and undefined for legacy v1 sessions. */
  html?: string;
  templateName?: string;
  engine?: "v1" | "v2";
  v2?: {
    templateName?: string;
    placeholderCount?: number;
    valueCount?: number;
    imagesGenerated?: number;
    imagesTotal?: number;
    sectionsBefore?: number;
    sectionsAdded?: number;
    sectionsTotal?: number;
    renderedAt?: string;
  };
  /* Netlify cache — set after the first successful deploy and
     reused on every subsequent click so the public URL stays
     stable. Null/undefined until the manager publishes for the
     first time. */
  netlifySiteId?: string;
  netlifySiteUrl?: string;
  netlifyDeployId?: string;
  netlifyDeployedAt?: string;
}

/** Names of the 11 templates the v2 engine ships with — kept in sync
 *  with the keys in services/wow-lp-v2.service.js TEMPLATE_DESCRIPTIONS. */
export const WOW_LP_V2_TEMPLATES = [
  { id: "maim-zahim",      label: "Maim Zahim — שירות / טכנאות / טיולים" },
  { id: "gal-coach",       label: "Gal Coach — מותג אישי / קואצ'ינג" },
  { id: "IGO",             label: "IGO — מוצר טכנולוגי / B2B" },
  { id: "interior-design", label: "Interior Design — מעצב פנים / סטודיו" },
  { id: "kilq",            label: "Kilq — אפליקציה / SaaS / שיווק דיגיטלי" },
  { id: "lugassy-demo",    label: "Lugassy — מותג יוקרה / חייטות" },
  { id: "yassu",           label: "Yassu — אפליקציה חברתית / אירועים" },
  { id: "mentor-cosmetic", label: "Mentor Cosmetic — קליניקה / קוסמטיקה" },
  { id: "la-maree",        label: "La Marée — מאפיה / קפה / מסעדה" },
  { id: "lior-beauty",     label: "Lior Beauty — איפור קבוע / יופי" },
  { id: "ceramica",        label: "Ceramica — קרמיקה / חומרי בניה" },
] as const;
export type WowLpV2TemplateId = typeof WOW_LP_V2_TEMPLATES[number]["id"];

/** Optional `template` forces a specific v2 template instead of letting
 *  the AI pick. Omitted → AI picks based on brief.  */
export function generateWowLp(phone: string, template?: WowLpV2TemplateId | null) {
  return req<{ success: boolean; sessionId: string; status: WowLpStatus; engine?: string; forcedTemplate?: string | null }>(
    `/cpanel/clients/${encodeURIComponent(phone)}/wow-lp/generate`,
    { method: "POST", body: JSON.stringify(template ? { template } : {}) }
  );
}
/** "🚀 פרסם ל-Netlify" — zips sess.html and pushes it as a 1-file
 *  static site. Idempotent: re-clicking redeploys to the same site
 *  (URL stays stable). 500 with `error: "...NETLIFY_API_TOKEN..."`
 *  when the server token isn't configured. */
export function deployLpToNetlify(phone: string) {
  return req<{
    success:    boolean;
    siteId:     string;
    url:        string;
    deployId:   string;
    deployedAt: string;
  }>(
    `/cpanel/clients/${encodeURIComponent(phone)}/wow-lp/deploy-netlify`,
    { method: "POST", body: "{}" },
  );
}

export function getWowLp(phone: string) {
  return req<{ session: WowLpSession | null }>(`/cpanel/clients/${encodeURIComponent(phone)}/wow-lp`);
}
export function patchWowLp(phone: string, patches: { path: (string | number)[]; value: unknown }[]) {
  return req<{ session: WowLpSession }>(`/cpanel/clients/${encodeURIComponent(phone)}/wow-lp`, {
    method: "PATCH",
    body: JSON.stringify({ patches }),
  });
}
export function regenerateWowLpImage(phone: string, section: string) {
  return req<{ success: boolean; image: { section: string; url: string } }>(
    `/cpanel/clients/${encodeURIComponent(phone)}/wow-lp/regenerate-image`,
    { method: "POST", body: JSON.stringify({ section }) }
  );
}

export async function uploadWowLpImage(phone: string, section: string, file: File): Promise<{ success: boolean; image: { section: string; url: string } }> {
  const fd = new FormData();
  fd.append("section", section);
  fd.append("image", file);
  const token = localStorage.getItem("cpanel_token");
  const res = await fetch(`/api/cpanel/clients/${encodeURIComponent(phone)}/wow-lp/upload-image`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: fd,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || "Upload failed");
  return json;
}
export function sendWowLpForApproval(phone: string) {
  return req<{ success: boolean; token: string; previewUrl: string }>(
    `/cpanel/clients/${encodeURIComponent(phone)}/wow-lp/send-approval`,
    { method: "POST", body: "{}" }
  );
}

/* ── WOW Ads — 10 marketing ads ──────────────────────────────────────── */

export interface WowAdItem {
  id: number;
  type: "regular" | "crazy" | "carousel" | string;
  headline: string;
  description: string;
  cta: string;
  nanoPrompt?: string | null;
  imageUrl?: string;
  regeneratedAt?: string;
  /** Timestamp set when manager edits text fields. */
  editedAt?: string | null;
  /** Timestamp set when manager approves the ad creative. */
  managerApprovedAt?: string | null;
  /** Set true while the server is regenerating this ad in the background.
   *  Server clears it on success/failure. Frontend polls until false. */
  regenerating?: boolean;
  /** For ad.type === "carousel": 4 separately-generated full-bleed slides
   *  the user can swipe through on Facebook/Instagram. Index 0 is also
   *  mirrored into ad.imageUrl for legacy UI paths. */
  slides?: { id: number; imageUrl?: string; nanoPrompt?: string; error?: string }[];
  /** Rich promotion-ready ad copy generated on-demand. Goes alongside
   *  the image when posting to Meta Ads Manager / Facebook — does NOT
   *  appear on the image. Manager copies it directly. */
  promotionDescription?: string;
  promotionDescriptionGeneratedAt?: string;
  error?: string;
}

export type WowAdsStatus =
  | "generating_texts"
  | "generating_prompts"
  | "generating_images"
  | "done"
  | "error";

export interface WowAdsSession {
  sessionId: string;
  status: WowAdsStatus;
  totalAds: number;
  completedCount: number;
  generatedAds: WowAdItem[];
  error?: string;
  createdAt: string;
  updatedAt: string;
  /** Approval flow state. */
  clientApprovalStatus?: "draft" | "sent" | "approved" | "rejected" | null;
  clientFeedback?: string | null;
  clientApprovalToken?: string | null;
  clientApprovedAt?: string | null;
  /** Campaign metadata — set only for one-off campaigns started via
   *  the cpanel "🎯 קמפיין מיוחד" flow. */
  slotKey?: string | null;
  campaignName?: string | null;
  campaignOverrides?: WowAdsCampaignOverrides | null;
  campaignCreatedAt?: string | null;
}

/* One-off-campaign overrides — partial brief fields that override
 * the client's permanent characterization JUST for this session.
 * The client's saved business_profile is untouched. */
export interface WowAdsCampaignOverrides {
  /** Override the brand palette. Only the keys set here override —
   *  the client's other color slots stay intact. */
  preferredColors?: Partial<{ primary: string; secondary: string; accent: string; extra1: string; extra2: string; extra3: string }>;
  /** Replacement services / products list for the ad copy. */
  services?: string;
  /** Replacement promotion / offer text (e.g. "World Cup 22:00..."). */
  promotion?: string;
  /** Replacement design-style hint. */
  designStyle?: string;
  /** Replacement target audience array. */
  targetAudience?: string[];
  /** Replacement business niche string. */
  businessNiche?: string;
  /** Replacement "about the business" blurb. */
  about?: string;
  /** Reference photo URLs for the campaign (uploaded via
   *  uploadCampaignSpecialImage). Server caps at 3; passes them to
   *  the wow-ads pipeline as image refs. */
  images?: string[];
}

/** Optional campaign payload — pass to run a one-off campaign that
 *  overrides the client's saved characterization for this session
 *  only. Default behavior (omit campaign) keeps existing semantics:
 *  ads generated from the client's permanent brief. */
export interface WowAdsGenerateOptions {
  slotKey?: string;
  /** How many ads to generate. Defaults to the package quota (10).
   *  Pass 1 to produce a preview ad for approval before committing
   *  to the rest. */
  quota?: number;
  /** Display name for the campaign (shown in the cpanel campaign
   *  list / preview card). */
  campaignName?: string;
  /** Fields to override on top of the brief just for this session. */
  overrides?: WowAdsCampaignOverrides;
}

export function generateWowAds(phone: string, opts: string | WowAdsGenerateOptions = {}) {
  const o: WowAdsGenerateOptions = typeof opts === "string" ? { slotKey: opts } : (opts || {});
  const qs = o.slotKey ? `?slotKey=${encodeURIComponent(o.slotKey)}` : "";
  const body: Record<string, unknown> = {};
  if (o.slotKey)      body.slotKey      = o.slotKey;
  if (o.quota != null) body.quota        = o.quota;
  if (o.campaignName) body.campaignName = o.campaignName;
  if (o.overrides && Object.keys(o.overrides).length > 0) body.overrides = o.overrides;
  return req<{
    success:      boolean;
    sessionId:    string;
    status:       WowAdsStatus;
    quota?:       number;
    slotKey?:     string;
    campaignName?: string | null;
    hasOverrides?: boolean;
  }>(
    `/cpanel/clients/${encodeURIComponent(phone)}/wow-ads/generate${qs}`,
    { method: "POST", body: Object.keys(body).length ? JSON.stringify(body) : "{}" }
  );
}

export function resetWowAdsSessions(phone: string) {
  return req<{ success: boolean }>(
    `/cpanel/clients/${encodeURIComponent(phone)}/wow-ads/sessions`,
    { method: "DELETE" }
  );
}

export function getWowAds(phone: string, slotKey?: string) {
  const qs = slotKey ? `?slotKey=${encodeURIComponent(slotKey)}` : "";
  return req<{ session: WowAdsSession | null }>(
    `/cpanel/clients/${encodeURIComponent(phone)}/wow-ads${qs}`
  );
}

export function getWowAdsStatus(phone: string, slotKey?: string) {
  const qs = slotKey ? `?slotKey=${encodeURIComponent(slotKey)}` : "";
  return req<{
    sessionId?: string;
    status?: WowAdsStatus;
    totalAds?: number;
    completedCount?: number;
    hasImages?: number;
    error?: string;
    session?: null;
  }>(`/cpanel/clients/${encodeURIComponent(phone)}/wow-ads/status${qs}`);
}

/** Generate rich Hebrew "promotion-ready" ad copy that goes alongside
 *  the image when posting to Meta Ads Manager / Facebook. Doesn't touch
 *  the image. Returns the updated ad with `ad.promotionDescription` set. */
export function generateAdPromotionDescription(phone: string, adId: number, slotKey?: string) {
  const qs = slotKey ? `?slotKey=${encodeURIComponent(slotKey)}` : "";
  return req<{ success: boolean; ad: WowAdItem }>(
    `/cpanel/clients/${encodeURIComponent(phone)}/wow-ads/${adId}/promotion-description${qs}`,
    { method: "POST" },
  );
}

export function regenerateWowAd(phone: string, adId: number, userChangeRequest?: string, slotKey?: string) {
  const qs = slotKey ? `?slotKey=${encodeURIComponent(slotKey)}` : "";
  return req<{ success: boolean; ad: WowAdItem }>(
    `/cpanel/clients/${encodeURIComponent(phone)}/wow-ads/${adId}/regenerate${qs}`,
    { method: "POST", body: JSON.stringify({ ...(userChangeRequest ? { userChangeRequest } : {}), ...(slotKey ? { slotKey } : {}) }) }
  );
}

export function updateCampaignBudget(phone: string, campaignId: string, dailyBudget: number) {
  return req<{ success: boolean }>(`/cpanel/clients/${encodeURIComponent(phone)}/campaigns/${encodeURIComponent(campaignId)}/budget`, {
    method: "PUT",
    body: JSON.stringify({ dailyBudget }),
  });
}

export interface TrendPoint {
  date: string;
  leads: number;
  spend: number;
}

export interface AccountManager {
  id: string;
  name: string;
  phone: string;
}


export interface ServiceItem {
  id?: string;
  title?: string;
  description?: string;
  price?: string;
  uniqueFeature?: string;
  notes?: string;
  images?: unknown[];
  /** Featured service image used in ads / LP cards. */
  imageUrl?: string;
  /** Optional active promotion specific to this service. */
  promotion?: string;
  /** Per-service Meta campaign objective. */
  campaignType?: string;
  /** Legacy simple-chip target audience (kept for backward compat). */
  targetAudience?: string[];
  /** Full Facebook-style targeting spec — replaces the simple chips. */
  targetingDetailed?: FbTargeting;
}

/* ─────────────────────────────────────────────────────────────────────
   Facebook Ads targeting spec — mirrors the fields available in the
   Facebook Ads Manager audience builder. Each service can have its own.
─────────────────────────────────────────────────────────────────────── */

export type FbGender = "all" | "male" | "female";

export interface FbLocation {
  /** Geographic granularity. */
  type: "country" | "region" | "city" | "address";
  /** Display name (Hebrew preferred). */
  name: string;
  /** Optional Facebook key/id for API submissions later. */
  key?: string;
  /** Radius in km (only for city/address types). 1–80. */
  radiusKm?: number;
  /** Inclusion vs exclusion in the audience. */
  include: boolean;
}

export interface FbInterest {
  /** Facebook interest/behavior/demographic id. */
  id: string;
  /** Hebrew display name. */
  name: string;
  /** Top-level category for grouping in summaries. */
  category?: string;
  /** Discriminator: which detailed-targeting bucket this came from. */
  kind: "interest" | "behavior" | "demographic";
}

export interface FbCustomAudience {
  id: string;
  name: string;
  type: "include" | "exclude";
}

export interface FbTargeting {
  /** Inclusive minimum age. 13–65. */
  ageMin?: number;
  /** Inclusive maximum age. 13–65 (65 means 65+). */
  ageMax?: number;
  /** Genders selected. Empty / undefined = all. */
  genders?: FbGender[];
  /** Spoken languages (FB language codes, e.g., "he", "ar", "en"). */
  languages?: string[];
  /** Geo locations (cities / regions / countries / addresses). */
  locations?: FbLocation[];
  /** Detailed targeting (interests, behaviors, demographics — all in one spec). */
  detailed?: FbInterest[];
  /** Free-text custom interests the manager typed (FB API search-fallback). */
  customInterests?: string[];
  /** Page-connection state (Facebook page-fans targeting). */
  connection?: "any" | "connected" | "not_connected" | "friends_of";
  /** Custom audiences (saved/lookalike) — populated from FB account assets. */
  customAudiences?: FbCustomAudience[];
}

/** One organic-post slot in the Social planner — links a service to a future organic ad. */
export interface OrganicSlot {
  /** id of the linked service (undefined = empty slot). */
  serviceId?: string;
  /** Generation mode chosen by the manager. */
  mode?: "service" | "ai";
  /** Free-text hook the manager wants the AI to honor. */
  hook?: string;
}

/** AI presenter that appears as the spokesperson across organic posts. */
export interface AvatarConfig {
  visualStyle?: "caricature" | "realistic" | "semiReal" | "3d" | "vector" | "anime" | "pixel" | "mascot" | "myPhoto";
  description?: "preciseMe" | "upgradedMe" | "fictional" | "professional";
  gender?: "male" | "female" | "other";
  age?: string;
  skinTone?: string;
  hair?: string;
  extras?: string;
  energy?: "calm" | "energetic" | "authoritative" | "smiling" | "mysterious" | "light";
  dress?: "formal" | "casual" | "sport" | "luxury" | "futuristic" | "professional";
  inspirationUrl?: string;
}

export interface BusinessProfile {
  businessName?: string;
  businessPhone?: string;
  address?: string;
  email?: string;
  categoryKey?: string;
  subCategoryKeys?: string[];
  subCategoryCustom?: string;
  services?: ServiceItem[];
  about?: string;
  targetAudience?: string[];
  socialLinks?: { instagram?: string; facebook?: string; tiktok?: string };
  promotion?: string;
  designStyle?: string;
  pageGoal?: string;
  preferredColors?: Record<string, string>;
  logoUrl?: string;
  images?: string[];
  /** 5 organic-post planner slots — each can be linked to a service or marked AI. */
  organicSlots?: OrganicSlot[];
  /** Optional avatar/presenter config used across organic posts. */
  avatar?: AvatarConfig;
  /** Surface the business phone on every generated ad. Default false —
   *  most clients don't want a phone burned into the creative. */
  includePhoneInAds?: boolean;
  /** Surface the business address on every generated ad. Default false. */
  includeAddressInAds?: boolean;
  /** Facebook Business Manager login credentials. */
  facebookUsername?: string;
  facebookPassword?: string;
}

/** "✨ הרחב עם AI" button on the Characterization tab — three jobs
 *  in one call: expand the about text, pick the best matching
 *  categoryKey from the supplied list, and pick a sub-category key
 *  inside it. Pass the full canonical CATEGORIES list so the server
 *  can validate the picks against it (never returns a hallucinated
 *  key). 400 with `error: "...ריק..."` when about is empty. */
export function expandAboutWithAI(
  phone: string,
  about: string,
  categories?: Array<{ key: string; label: string; subCategories: Array<{ key: string; label: string }> }>,
) {
  return req<{
    success: boolean;
    expanded: string;
    categoryKey: string | null;
    subCategoryKey: string | null;
  }>(
    `/cpanel/clients/${encodeURIComponent(phone)}/expand-about`,
    { method: "POST", body: JSON.stringify({ about, categories }) },
  );
}

/** Hebrew spelling/typo correction for characterization free-text (about +
 *  service title/description/…). Returns the corrected strings in the SAME
 *  order/length; fixes spelling only, never rewrites meaning. Typos in the
 *  איפיון otherwise propagate into ad/post generation. */
export function spellcheckTexts(phone: string, texts: string[]) {
  return req<{ success: boolean; corrected: string[] }>(
    `/cpanel/clients/${encodeURIComponent(phone)}/spellcheck`,
    { method: "POST", body: JSON.stringify({ texts }) },
  );
}

/** "✨ הוסף שירותים עם AI" button on the שירותים panel — drafts 3
 *  services (title / description / uniqueFeature / per-service
 *  targetAudience array) from the businessName + about + optional
 *  field/niche the manager already filled. The frontend should
 *  append these to the existing services list, not replace. */
export function suggestServicesWithAI(phone: string, payload: {
  businessName?: string;
  about?: string;
  businessField?: string;
  businessNiche?: string;
}) {
  return req<{
    success: boolean;
    services: Array<{
      title: string;
      description: string;
      uniqueFeature: string;
      targetAudience: string[];
      /** One of the 7 Meta campaign objective IDs the UI exposes
       *  (LEAD_GENERATION / CONVERSIONS / MESSAGES / TRAFFIC /
       *  REACH / BRAND_AWARENESS / ENGAGEMENT). "" when the model
       *  couldn't pick confidently. */
      campaignType: string;
      /** Pre-filled FB targeting — age range, genders, default
       *  location (Israel), and free-text customInterests the
       *  manager can refine via the targeting editor. */
      targetingDetailed: FbTargeting;
    }>;
  }>(
    `/cpanel/clients/${encodeURIComponent(phone)}/suggest-services`,
    { method: "POST", body: JSON.stringify(payload) },
  );
}

export interface AdBriefAnswer {
  raw?: string;
  score?: number;
  status?: string;
  savedAt?: string;
}

export interface Characterization {
  businessProfile: BusinessProfile | null;
  adBrief: { answers?: Record<string, AdBriefAnswer>; briefStatus?: string; createdAt?: string } | null;
}

export interface ChatMessage {
  _id: string | number;
  text: string;
  type: string;
  fromRole: "user" | "agent";
  createdAt: string;
  user?: { _id: string; name: string };
  imageUrl?: string;
  videoUrl?: string;
  fileUrl?: string;
  fileName?: string;
}

/* ─────────────────────────────────────────────────────────────────────
   CPanel logs (unified, per-agent across all assigned clients).
─────────────────────────────────────────────────────────────────────── */

export interface CpanelLogEvent {
  _id: string;
  type: string;
  name?: string;
  phone: string;
  clientName?: string;
  createdAt?: string;
  timestamp?: string;
  meta?: Record<string, unknown>;
}

export function getCpanelLogs(opts: { range?: "24h" | "7d" | "30d"; limit?: number } = {}) {
  const params = new URLSearchParams();
  if (opts.range) params.set("range", opts.range);
  if (opts.limit) params.set("limit", String(opts.limit));
  const qs = params.toString();
  return req<{ events: CpanelLogEvent[]; scanned: number; total: number }>(
    `/cpanel/logs${qs ? `?${qs}` : ""}`,
  );
}

export interface LogRecord {
  _id: string;
  phone?: string;
  level?: string;
  message?: string;
  msg?: string;
  timestamp?: string;
  createdAt?: string;
  clientName?: string;
  type?: string;
  name?: string;
  meta?: Record<string, unknown>;
}

export function getLogs(opts: {
  phone?: string;
  level?: string;
  from?: string;
  to?: string;
  limit?: number;
  skip?: number;
  search?: string;
} = {}) {
  const params = new URLSearchParams();
  if (opts.phone)             params.set("phone",  opts.phone);
  if (opts.level)             params.set("level",  opts.level);
  if (opts.from)              params.set("from",   opts.from);
  if (opts.to)                params.set("to",     opts.to);
  if (opts.limit)             params.set("limit",  String(opts.limit));
  if (opts.skip !== undefined) params.set("skip",  String(opts.skip));
  if (opts.search)            params.set("search", opts.search);
  const qs = params.toString();
  return req<{ success: boolean; data: LogRecord[]; total: number }>(`/log${qs ? `?${qs}` : ""}`);
}

/* ─────────────────────────────────────────────────────────────────────
   CPanel tasks (per-agent personal task list).
─────────────────────────────────────────────────────────────────────── */

export interface CpanelTask {
  _id: string;
  title: string;
  description?: string;
  dueAt: string;
  done: boolean;
  clientPhone?: string | null;
  createdAt: string;
  updatedAt?: string;
}

/* ── Per-product lifecycle status ─────────────────────────────────────
   Each AI-generated product (ads / organic / lp) carries its own
   `productStatus` independent of the package-level status. 9 stages
   from "pending_characterization" through "completed". */

export type ProductStatus =
  | "pending_characterization"
  | "sent_for_creation"
  | "pending_manager_approval"
  | "sent_to_client"
  | "client_returned_corrections"
  | "in_correction"
  | "corrections_completed"
  | "client_approved"
  | "completed";

export type ProductType = "ads" | "organic" | "lp";

export interface ProductStatusEntry {
  productStatus: ProductStatus;
  sessionExists: boolean;
  /** Per-item manager-approval progress for ads / organic sessions.
   *  Null for lp (single-flag model) and for sessions that don't exist
   *  yet. The status panel uses this to show "X/Y מאושר" while in
   *  pending_manager_approval and to swap the badge to "אושר על ידי
   *  מנהל ✓" once approved === total. */
  approval?: { approved: number; total: number } | null;
}

export function getProductStatuses(phone: string) {
  return req<{
    ads:     ProductStatusEntry;
    organic: ProductStatusEntry;
    lp:      ProductStatusEntry;
  }>(`/cpanel/clients/${encodeURIComponent(phone)}/products/status`);
}

export function sendProductToClient(phone: string, type: ProductType) {
  return req<{
    success: boolean;
    productType: ProductType;
    productStatus: ProductStatus;
    pushSent: boolean;
    pushReason: string | null;
  }>(
    `/cpanel/clients/${encodeURIComponent(phone)}/products/${type}/send-to-client`,
    { method: "POST", body: "{}" },
  );
}

export function updateProductStatus(phone: string, type: ProductType, status: ProductStatus) {
  return req<{ success: boolean; current: ProductStatus }>(
    `/cpanel/clients/${encodeURIComponent(phone)}/products/${type}/status`,
    { method: "PUT", body: JSON.stringify({ status }) },
  );
}

/* ── Auto-derived tasks (status-driven) ──────────────────────────────
   Server walks every client of this manager whose activePackage status
   is in an actionable state (waiting_brief, sent_to_creation, ...) and
   builds one task per stuck package, with urgency by elapsed time. */

export type TaskUrgency = "normal" | "yellow" | "orange" | "red" | "blink";

export interface Task {
  id:           string;
  clientPhone:  string;
  clientName:   string;
  packageName:  string;
  taskType:     string;
  taskLabel:    string;
  description:  string;
  since:        string;
  elapsedHours: number;
  urgency:      TaskUrgency;
}

export function getTasks() {
  return req<{
    tasks:     Task[];
    total:     number;
    byUrgency: Record<TaskUrgency, number>;
  }>(`/cpanel/tasks`);
}

/** Legacy personal manual tasks (server moved them to /personal-tasks). */
export function listTasks() {
  return req<{ tasks: CpanelTask[] }>(`/cpanel/personal-tasks`);
}

export function createTask(body: { title: string; description?: string; dueAt: string; clientPhone?: string }) {
  return req<{ task: CpanelTask }>(`/cpanel/tasks`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function patchTask(id: string, body: Partial<{ title: string; description: string; dueAt: string; clientPhone: string | null; done: boolean }>) {
  return req<{ task: CpanelTask }>(`/cpanel/tasks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function deleteTask(id: string) {
  return req<{ success: true }>(`/cpanel/tasks/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

/* ─────────────────────────────────────────────────────────────────────
   Daily digest (GET — saved version with cache, vs aiDailyDigest = POST run).
─────────────────────────────────────────────────────────────────────── */

export function getDailyDigest(force = false) {
  return req<{ items: AiDigestItem[]; generatedAt: string; cached?: boolean }>(
    `/cpanel/ai/daily-digest${force ? "?force=1" : ""}`,
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Per-agent leads aggregate — feeds the LeadsPage charts.
─────────────────────────────────────────────────────────────────────── */

export interface CpanelLeadsRow {
  client: { id: string; phone: string; name: string };
  total: number;
  spend: number;
  trend: TrendPoint[];
  cpl: number | null;
  error?: string;
}

export function getCpanelLeadsAggregate(days = 30, sample = 25) {
  return req<{ rows: CpanelLeadsRow[]; scanned: number; total: number }>(
    `/cpanel/leads?days=${days}&sample=${sample}`,
  );
}

/* ─────────────────────────────────────────────────────────────────────
   WOW Ads — manager edit / approve / send-for-approval / upload
─────────────────────────────────────────────────────────────────────── */

export function updateWowAdText(
  phone: string,
  adId: number,
  fields: Partial<{ headline: string; description: string; cta: string }>,
  slotKey?: string,
) {
  const qs = slotKey ? `?slotKey=${encodeURIComponent(slotKey)}` : "";
  return req<{ success: boolean; ad: WowAdItem }>(
    `/cpanel/clients/${encodeURIComponent(phone)}/wow-ads/${adId}${qs}`,
    { method: "PUT", body: JSON.stringify(fields) },
  );
}

export function approveWowAd(phone: string, adId: number, approved: boolean, slotKey?: string) {
  const qs = slotKey ? `?slotKey=${encodeURIComponent(slotKey)}` : "";
  return req<{ success: boolean; ad: WowAdItem }>(
    `/cpanel/clients/${encodeURIComponent(phone)}/wow-ads/${adId}/approve${qs}`,
    { method: "POST", body: JSON.stringify({ approved }) },
  );
}

export function sendWowAdsForApproval(phone: string) {
  return req<{ success: boolean; token: string; previewUrl?: string; approvedCount: number; sentChannels: string[] }>(
    `/cpanel/clients/${encodeURIComponent(phone)}/wow-ads/send-approval`,
    { method: "POST", body: "{}" },
  );
}

export async function uploadWowAdImage(phone: string, adId: number, file: File, slotKey?: string): Promise<{ success: boolean; ad: WowAdItem }> {
  const fd = new FormData();
  fd.append("image", file);
  const token = localStorage.getItem("cpanel_token");
  const qs = slotKey ? `?slotKey=${encodeURIComponent(slotKey)}` : "";
  const res = await fetch(`/api/cpanel/clients/${encodeURIComponent(phone)}/wow-ads/${adId}/image${qs}`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: fd,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.error || "upload failed");
  return json;
}

/* ─────────────────────────────────────────────────────────────────────
   WOW Organic — manager edit / approve / send / upload / carousel
─────────────────────────────────────────────────────────────────────── */

export function updateWowOrganicPostText(
  phone: string,
  postId: number,
  fields: Partial<{ headline: string; description: string; cta: string }>,
) {
  return req<{ success: boolean; post: WowOrganicPost }>(
    `/cpanel/clients/${encodeURIComponent(phone)}/wow-organic/${postId}`,
    { method: "PUT", body: JSON.stringify(fields) },
  );
}

/** Generate rich Hebrew promotion-ready post body for an organic post.
 *  Mirror of generateAdPromotionDescription. */
export function generateOrganicPromotionDescription(phone: string, postId: number) {
  return req<{ success: boolean; post: WowOrganicPost }>(
    `/cpanel/clients/${encodeURIComponent(phone)}/wow-organic/${postId}/promotion-description`,
    { method: "POST" },
  );
}

export function approveWowOrganicPost(phone: string, postId: number, approved: boolean) {
  return req<{ success: boolean; post: WowOrganicPost }>(
    `/cpanel/clients/${encodeURIComponent(phone)}/wow-organic/${postId}/approve`,
    { method: "POST", body: JSON.stringify({ approved }) },
  );
}

export function sendWowOrganicForApproval(phone: string) {
  return req<{ success: boolean; token: string; previewUrl?: string; approvedCount: number; sentChannels: string[] }>(
    `/cpanel/clients/${encodeURIComponent(phone)}/wow-organic/send-approval`,
    { method: "POST", body: "{}" },
  );
}

export async function uploadWowOrganicPostImage(phone: string, postId: number, file: File): Promise<{ success: boolean; post: WowOrganicPost }> {
  const fd = new FormData();
  fd.append("image", file);
  const token = localStorage.getItem("cpanel_token");
  const res = await fetch(`/api/cpanel/clients/${encodeURIComponent(phone)}/wow-organic/${postId}/image`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: fd,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.error || "upload failed");
  return json;
}

export function generateWowOrganicCarousel(phone: string) {
  return req<{ success: boolean; post: WowOrganicPost }>(
    `/cpanel/clients/${encodeURIComponent(phone)}/wow-organic/carousel/generate`,
    { method: "POST", body: "{}" },
  );
}

export function regenerateWowOrganicSlide(phone: string, postId: number, slideId: number) {
  return req<{ success: boolean; post: WowOrganicPost; slide: WowOrganicSlide }>(
    `/cpanel/clients/${encodeURIComponent(phone)}/wow-organic/carousel/${postId}/slides/${slideId}/regenerate`,
    { method: "POST", body: "{}" },
  );
}

/* ─────────────────────────────────────────────────────────────────────
   WOW LP — set section image (manager picks an existing client image
   for a specific section instead of uploading new).
─────────────────────────────────────────────────────────────────────── */

export function setWowLpSectionImage(phone: string, section: string, url: string) {
  return req<{ success: boolean; image: { section: string; url: string } }>(
    `/cpanel/clients/${encodeURIComponent(phone)}/wow-lp/set-image`,
    { method: "POST", body: JSON.stringify({ section, url }) },
  );
}


/* ─────────────────────────────────────────────────────────────────────
   Custom categories — manager-extensible category list. The cpanel
   ships a curated default list in src/data/categories.ts; these
   endpoints store the delta (custom categories + custom sub-categories
   added on the fly from the Characterization tab).
─────────────────────────────────────────────────────────────────────── */

export interface CustomSubCategory {
  key: string;
  label: string;
  custom?: boolean;
  createdAt?: string;
}

export interface CustomCategoryDoc {
  key: string;
  /** null → extension to a built-in parent (use built-in label). */
  label: string | null;
  subCategories: CustomSubCategory[];
  custom: boolean;
  extendsBuiltIn?: boolean;
  createdAt?: string;
}

export function listCustomCategories() {
  return req<{ categories: CustomCategoryDoc[] }>(`/cpanel/categories`);
}

export function addCustomCategory(label: string) {
  return req<{ category: CustomCategoryDoc }>(`/cpanel/categories`, {
    method: "POST",
    body: JSON.stringify({ label }),
  });
}

export function addCustomSubCategory(catKey: string, label: string) {
  return req<{ category: CustomCategoryDoc }>(`/cpanel/categories/${encodeURIComponent(catKey)}/subcategories`, {
    method: "POST",
    body: JSON.stringify({ label }),
  });
}

/* ─────────────────────────────────────────────────────────────────────
   Facebook ad-account health snapshot — used by ClientDetailPage to show
   balance, status, disable reason, and funding source for the linked
   client's ad account.
─────────────────────────────────────────────────────────────────────── */

export interface FbAccountHealth {
  id: string;
  account_status: number;
  amount_spent: string;
  balance: string;
  disable_reason: number;
  funding_source_details?: {
    id?: string;
    type?: number;
    display_string: string;
  };
  currency?: string;
  name?: string;
}

export async function getClientFbAccountHealth(phone: string): Promise<FbAccountHealth | null> {
  try {
    return await req<FbAccountHealth>(`/cpanel/clients/${encodeURIComponent(phone)}/fb-account-health`);
  } catch (err) {
    // No FB account linked / backend error — return null so UI can show empty state
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("404") || msg.includes("500") || msg.toLowerCase().includes("not found")) return null;
    throw err;
  }
}

export interface FbLiveStatus {
  success: boolean;
  page: { accessible: boolean; id?: string; name?: string; message?: string } | null;
  act:  { accessible: boolean; id?: string; name?: string; account_status?: number; message?: string } | null;
}

export function getClientFbLiveStatus(phone: string) {
  return req<FbLiveStatus>(`/cpanel/clients/${encodeURIComponent(phone)}/fb-live-status`);
}


/* ─────────────────────────────────────────────────────────────────────
   Active client package — drives which products are unlocked in the
   "מוצרים" tab. A client may own 0 or 1 active package at a time;
   buying a new one in the "חיוב" tab replaces the previous (or stacks,
   server-side decision).
─────────────────────────────────────────────────────────────────────── */

/** Lifecycle status values for an active package. Manager advances through
 *  these as the project moves from purchase to delivery. Mirror of server's
 *  PACKAGE_STATUSES list — keep in sync. */
export type PackageStatus =
  | "waiting_brief"
  | "sent_to_creation"
  | "waiting_manager_approval"
  | "sent_to_client"
  | "client_returned_corrections"
  | "in_correction"
  /* Server uses both names interchangeably depending on flow — accept both. */
  | "corrections_done"
  | "corrections_completed"
  | "client_approved"
  | "completed";

export interface ClientPackage {
  /** Stable id for the package SKU (e.g. "platinum" / "premium" / "basic" / "custom_<n>"). */
  id: string;
  /** Display name shown in the UI banner ("חבילת פלטינום"). */
  name: string;
  /** ISO timestamp the package was purchased / activated. */
  purchasedAt: string;
  /** Quantities purchased — drives which sections render in מוצרים tab and how many of each. */
  items: {
    paidAds:         number;   // ADS ads from FB/IG campaigns
    organicAds:      number;   // organic social posts (gantt)
    videos:          number;
    lps:             number;   // landing pages
    logos:           number;
    campaignTraffic?: number;  // קמפיין תנועה לאתר
    campaignLeads?:   number;  // קמפיין לידים
  };
  /** Coins originally granted with the package. */
  coins: number;
  /** Coins spent so far. */
  coinsUsed: number;
  /** coins - coinsUsed. */
  coinsRemaining: number;
  /** Project lifecycle status. Defaults to "waiting_brief" if missing. */
  status: PackageStatus;
  /** Services redeemed by spending the client's existing coin balance
   *  (NOT a new package purchase). Each entry adds an effective
   *  campaign slot that uses an existing approved-ads slotKey as the
   *  creative source. */
  coinRedemptions?: CoinRedemption[];
}

/** One coin-redemption record — manager spent COIN_REDEEM_COSTS[service]
 *  coins from the client's balance, which bumped the matching
 *  activePackage.items field (campaign_leads / campaign_traffic /
 *  organicAds) so a new section renders in the products tab. */
export interface CoinRedemption {
  service: "campaign_leads" | "campaign_traffic" | "social_ad_10";
  /** Coins debited. */
  cost: number;
  /** ISO timestamp. */
  redeemedAt: string;
  /** Agent id or name. */
  redeemedBy?: string | null;
}

/** A single approved-ads slot returned by getApprovedAdsSlots — used as
 *  dropdown options in the coin-redeem modal. */
export interface ApprovedAdsSlot {
  /** "__default__" for the legacy paid-ads session (slotKey === null). */
  slotKey: string;
  sessionId: string;
  /** Display name set when the slot was a campaign (or null for the
   *  default session / older sessions). */
  campaignName: string | null;
  approvedCount: number;
  totalAds: number;
  updatedAt: string | null;
}

/** A single entry in the client's full purchase HISTORY — used by
 *  ProductsTab to show "all packages I bought" cards, each with its
 *  own products inside. Same shape as ClientPackage but without
 *  coin-balance info (those only make sense for the active package). */
export interface ClientPackageHistoryEntry {
  id:          string;
  name:        string;
  purchasedAt: string;
  items: {
    paidAds:         number;
    organicAds:      number;
    videos:          number;
    lps:             number;
    logos:           number;
    campaignTraffic?: number;
    campaignLeads?:   number;
  };
  coins:       number;
  /** Stable per-package fingerprint matching the server's pkgId convention.
   *  `pkg_<kind>_<purchasedAt with [:.] → '-'>`. Used to filter product
   *  sessions to a specific package. */
  pkgId:       string;
  /** MongoDB _id of the cpanel_pending_purchases row. Useful when you need
   *  to act on the row itself (refunds, etc). */
  purchaseId:  string;
  totalAmount: number;
  kind:        "package" | "custom" | "coins" | string;
  /** Marks the most recently purchased package — the one the manager is
   *  actively working on. Older packages render as read-only history. */
  isActive:    boolean;
}

export function listClientPackages(phone: string) {
  return req<{ packages: ClientPackageHistoryEntry[]; total: number }>(
    `/cpanel/clients/${encodeURIComponent(phone)}/packages`,
  );
}

/* ── Historical package products (read-only drill-down) ────────────────
   The "Products" tab's older-package cards expand to show what was
   actually generated under that package. Server figures out which
   sessions belong by matching `packageId` (forward-compat) or falling
   back to a purchasedAt → next.purchasedAt time window (legacy). */
export interface PackageProductsAdsSession {
  sessionId:      string;
  status:         string;
  totalAds:       number;
  completedCount: number;
  generatedAds:   Array<{
    id:           number;
    headline?:    string;
    primaryText?: string;
    description?: string;
    imageUrl?:    string;
    [extra: string]: unknown;
  }>;
  createdAt:      string;
  packageId:      string | null;
}
export interface PackageProductsOrganicSession {
  sessionId:       string;
  status:          string;
  totalPosts:      number;
  completedCount:  number;
  generatedPosts:  Array<{
    id:           number;
    caption?:     string;
    imageUrl?:    string;
    [extra: string]: unknown;
  }>;
  createdAt:       string;
  packageId:       string | null;
}
export interface PackageProductsLpSession {
  sessionId:  string;
  status:     string;
  lp:         Record<string, unknown> | null;
  slug:       string | null;
  previewUrl: string | null;
  createdAt:  string;
  packageId:  string | null;
}
export interface PackageProducts {
  pkgId:   string;
  window:  { from: string; to: string };
  ads:     PackageProductsAdsSession | null;
  organic: PackageProductsOrganicSession | null;
  lp:      PackageProductsLpSession | null;
}

export function getClientPackageProducts(phone: string, pkgId: string) {
  return req<PackageProducts>(
    `/cpanel/clients/${encodeURIComponent(phone)}/packages/${encodeURIComponent(pkgId)}/products`,
  );
}

/* ── Project detail (full content + status, used by status banner + buttons) ── */

export interface EditRequest {
  requestedAt:  string;
  instructions: { title?: string; subtitle?: string; cta?: string; image?: string };
  geminiResult?: string | null;
  newImageUrl?:  string | null;
}

export interface ProductItem {
  id:       string;
  imageUrl: string | null;
  headline: string;
  body?:    string;
  status:   "pending" | "approved" | "rejected";
  /* Edit-tracking spec — per-item client lifecycle. */
  clientStatus?:     "pending" | "approved" | "rejected";
  clientApprovedAt?: string | null;
  clientRejectedAt?: string | null;
  editCount?:        number;
  editRequests?:     EditRequest[];
}

export interface ProjectDetail {
  id:            string;
  name:          string | null;
  date:          string;
  overallStatus: PackageStatus;
  ads_sponsored: ProductItem[];
  ads_social:    ProductItem[];
  carousels:     ProductItem[];
  logo:          ProductItem[];
  landing_page:  ProductItem[];
  video:         ProductItem[];
}

/** Full project detail (status + every item with its imageUrl). For pkg_*
 *  ids the server collects items across all sessions; for session ids the
 *  server returns just that session's items. */
export function getProjectDetail(phone: string, projectId: string) {
  return req<ProjectDetail>(
    `/client/project-detail?phone=${encodeURIComponent(phone)}&projectId=${encodeURIComponent(projectId)}`,
  );
}

/** Manager-side: advance the package's lifecycle status. projectId must
 *  start with "pkg_" (server enforces this). */
export function updatePackageStatus(phone: string, projectId: string, status: PackageStatus) {
  return req<{ success: boolean; id: string; status: PackageStatus; matched: number; modified: number }>(
    `/client/project-detail/${encodeURIComponent(projectId)}/status`,
    { method: "PATCH", body: JSON.stringify({ phone, status }) },
  );
}

/** List all wow-ads slots for a client that have at least one
 *  manager-approved ad. Used by the coin-redeem modal as the
 *  dropdown of "where do the creatives come from". */
export function getApprovedAdsSlots(phone: string) {
  return req<{ slots: ApprovedAdsSlot[] }>(
    `/cpanel/clients/${encodeURIComponent(phone)}/wow-ads/approved-slots`,
  );
}

/** Upload one reference photo for a "🎯 קמפיין מיוחד" brief. Returns
 *  the B2-hosted URL — the caller stores it in the modal's images
 *  list and passes it to generateWowAds via overrides.images. */
export async function uploadCampaignSpecialImage(phone: string, file: File): Promise<{ url: string }> {
  const fd = new FormData();
  fd.append("image", file);
  const token = localStorage.getItem("cpanel_token") || "";
  const res = await fetch(`${BASE}/cpanel/clients/${encodeURIComponent(phone)}/campaign-special/upload-image`, {
    method:  "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body:    fd,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.error || `העלאת תמונה נכשלה (${res.status})`);
  }
  return res.json();
}

/** Lightweight coin balance read — works even when the client has no
 *  activePackage (their coins still live on user.coins). Used by the
 *  catalog tab to gate the '🪙 מימוש מטבעות' button independently of
 *  the active-package state. */
export function getClientCoins(phone: string) {
  return req<{ coins: number; coinsUsed: number; coinsRemaining: number }>(
    `/cpanel/clients/${encodeURIComponent(phone)}/coins`,
  );
}

/** Spend coins on a campaign / social slot — 1000 coins per service
 *  per the user's rate card. On success: balance drops by cost and the
 *  matching activePackage.items field is bumped (campaign_leads /
 *  campaign_traffic / organicAds) so the existing ProductsTab logic
 *  renders a new section for it. The caller should reload the package
 *  so the new balance + items appear in the UI. */
export function redeemCoinsForService(
  phone: string,
  service: CoinRedemption["service"],
) {
  return req<{
    success:        boolean;
    service:        CoinRedemption["service"];
    cost:           number;
    coinsRemaining: number;
    redemption:     CoinRedemption;
  }>(
    `/cpanel/clients/${encodeURIComponent(phone)}/coin-redeem`,
    { method: "POST", body: JSON.stringify({ service }) },
  );
}

/**
 * Returns the active package for the client, or null if none is active.
 * If the backend doesn't yet expose this endpoint (404), returns null
 * so the UI can show the "purchase a package first" empty state.
 */
export async function getClientPackage(phone: string): Promise<ClientPackage | null> {
  try {
    return await req<ClientPackage>(`/cpanel/clients/${encodeURIComponent(phone)}/package`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    /* Treat "no package yet" as null so the UI can render the friendly
       empty-state instead of a red error block. The server returns 404
       with body "No active package for this client." — the message string
       check covers cases where the HTTP status didn't make it into the
       error message. */
    if (
      msg.includes("404") ||
      msg.toLowerCase().includes("not found") ||
      msg.toLowerCase().includes("no active package")
    ) return null;
    throw err;
  }
}

/**
 * Debit coins from the client's wallet. Used by manager actions and app
 * activity hooks (e.g. generating a new ad batch costs 50 coins).
 * Returns the new balance, or throws if insufficient (HTTP 402).
 *
 * Note: most product-generation actions deduct coins automatically on the
 * server side. This helper is for ad-hoc/manual deductions only.
 */
export function spendCoins(phone: string, amount: number, reason: string) {
  return req<{ success: boolean; balance: number }>(
    `/cpanel/clients/${encodeURIComponent(phone)}/spend-coins`,
    { method: "POST", body: JSON.stringify({ amount, reason }) },
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Consolidated client review — ONE token covers all approved products
   (ads + organic + lp). The manager clicks "send all for approval",
   client gets ONE SMS, opens ONE link, sees everything.
─────────────────────────────────────────────────────────────────────── */

export interface ProductsReviewResponse {
  kind: "products";
  phone: string;
  status: "sent" | "approved" | "rejected";
  sentAt: string;
  respondedAt: string | null;
  feedback: string | null;
  ads: WowAdItem[];
  organic: WowOrganicPost[];
  lp: { sessionId: string; landingPage: any; images: any[]; html: string | null } | null;
}

/** Manager-side: send all approved products to the client in one SMS. */
export function sendProductsForApproval(phone: string) {
  return req<{ success: boolean; token: string; previewUrl: string; summary: { adsApproved: number; organicApproved: number; lpApproved: boolean }; sentChannels: string[] }>(
    `/cpanel/clients/${encodeURIComponent(phone)}/products/send-for-approval`,
    { method: "POST", body: "{}" },
  );
}

export interface LatestProductReview {
  token: string;
  status: "sent" | "approved" | "rejected";
  sentAt: string;
  respondedAt: string | null;
  feedback: string | null;
  summary: { ads: number; organic: number; lp: boolean };
}

/** Manager-side: most recent review for this client (or null). Drives the
 *  status badge in the PackageBanner so the manager sees client responses. */
export function getLatestProductReview(phone: string) {
  return softFetch<{ review: LatestProductReview | null }>(
    req<{ review: LatestProductReview | null }>(`/cpanel/clients/${encodeURIComponent(phone)}/products/latest-review`),
    { review: null },
    `getLatestProductReview(${phone})`,
  );
}

export interface ReviewListItem extends LatestProductReview {
  phone: string;
  clientName: string;
}

/** Manager-side: all consolidated reviews across this manager's clients.
 *  Drives the sidebar 'תגובות לקוחות' page. */
export function listProductReviews(opts: { status?: "pending" | "approved" | "rejected" | "all"; limit?: number } = {}) {
  const qs = new URLSearchParams();
  if (opts.status) qs.set("status", opts.status);
  if (opts.limit)  qs.set("limit", String(opts.limit));
  const tail = qs.toString() ? `?${qs}` : "";
  return softFetch<{ reviews: ReviewListItem[]; total: number }>(
    req<{ reviews: ReviewListItem[]; total: number }>(`/cpanel/reviews${tail}`),
    { reviews: [], total: 0 },
    `listProductReviews(${opts.status ?? "all"})`,
  );
}

/** Public (client-side): fetch the products to review. No auth required — token IS the auth. */
export function getProductsReview(token: string) {
  return req<ProductsReviewResponse>(`/cpanel/review/products/${encodeURIComponent(token)}`);
}

/** Public: client approves all products (legacy whole-session). */
export function approveProductsReview(token: string) {
  return req<{ success: boolean }>(`/cpanel/review/products/${encodeURIComponent(token)}/approve`, {
    method: "POST", body: "{}",
  });
}

/** Public: client rejects with feedback (legacy whole-session). */
export function rejectProductsReview(token: string, feedback: string) {
  return req<{ success: boolean }>(`/cpanel/review/products/${encodeURIComponent(token)}/reject`, {
    method: "POST", body: JSON.stringify({ feedback }),
  });
}

/* ─── Per-item approval (mobile-app endpoints) ─────────────────────
   These hit /api/client/project-detail/:id/{approve,reject} which
   accept an optional `itemId` to flip a single ad/post instead of
   the whole batch. Used by the cpanel review page when the user
   wants to approve some items and reject others.
─────────────────────────────────────────────────────────────────── */

export function approveProjectItem(projectId: string, phone: string, kind: string, itemId: string | number) {
  return req<{ success: boolean; itemId: string; status: "approved"; overall: string }>(
    `/client/project-detail/${encodeURIComponent(projectId)}/approve`,
    { method: "POST", body: JSON.stringify({ phone, kind, itemId: String(itemId) }) },
  );
}

export function rejectProjectItem(projectId: string, phone: string, kind: string, itemId: string | number, feedback: string) {
  return req<{ success: boolean; itemId: string; status: "rejected"; overall: string }>(
    `/client/project-detail/${encodeURIComponent(projectId)}/reject`,
    { method: "POST", body: JSON.stringify({ phone, kind, itemId: String(itemId), feedback }) },
  );
}

// ── Client Calendar ───────────────────────────────────────────────────────

export interface CalendarOrder {
  _id: string;
  businessName?: string;
  publish: { slots: Array<{ time?: string; days?: string[]; specificDate?: string }> };
  publishPointer?: number;
  creatives?: Array<{
    type: string;
    desc?: string;
    imageUrl?: string;
    publishLog: Array<{ publishedAt: string; overallStatus: string }>;
  }>;
  createdAt: string;
}

export function getClientCalendar(phone: string) {
  return req<{ success: boolean; orders: CalendarOrder[]; storedPosts?: unknown[] }>(
    `/cpanel/clients/${encodeURIComponent(phone)}/calendar`,
  );
}

export function rescheduleCreative(
  phone: string,
  orderId: string,
  creativeIndex: number,
  specificDate: string,
  time: string,
) {
  return req<{ success: boolean }>(
    `/cpanel/clients/${encodeURIComponent(phone)}/reschedule-creative`,
    { method: "PATCH", body: JSON.stringify({ orderId, creativeIndex, specificDate, time }) },
  );
}

/** Delete (cancel) a scheduled calendar post. `order` events cancel the
 *  creative inside an ai_creation_orders doc (cron skips it, slot cleared);
 *  `stored` events delete a standalone instagram_posts doc. Only
 *  not-yet-published posts can be removed. */
export function cancelCalendarEvent(
  phone: string,
  payload:
    | { source: "order"; orderId: string; creativeIndex: number }
    | { source: "stored"; storedPostId: string },
) {
  return req<{ success: boolean }>(
    `/cpanel/clients/${encodeURIComponent(phone)}/calendar-event/delete`,
    { method: "POST", body: JSON.stringify(payload) },
  );
}

export async function calendarScheduleUpload(
  phone: string,
  file: File,
  specificDate: string,
  time: string,
  description: string,
): Promise<{ success: boolean; orderId: string; imageUrl: string }> {
  const fd = new FormData();
  fd.append("image", file);
  fd.append("specificDate", specificDate);
  fd.append("time", time);
  fd.append("description", description);
  const token = localStorage.getItem("cpanel_token");
  const res = await fetch(`${(import.meta.env.VITE_API_BASE as string | undefined) ?? "/api"}/cpanel/clients/${encodeURIComponent(phone)}/calendar-upload`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: fd,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || "העלאה נכשלה");
  return json;
}

// ─── Referral (חבר מביא חבר) ─────────────────────────────────────────────────

export function approveReferralClient(phone: string) {
  return req<{ success: boolean; new_balance: number }>(
    `/cpanel/clients/${encodeURIComponent(phone)}/referral-approve`,
    { method: "PATCH" }
  );
}

export function closeReferralClient(phone: string) {
  return req<{ success: boolean; new_balance: number }>(
    `/cpanel/clients/${encodeURIComponent(phone)}/referral-close`,
    { method: "PATCH" }
  );
}

/* ── Personal Catalog ────────────────────────────────────────────────── */

export interface PersonalPackage {
  _id: string;
  phone: string;
  agentId: string;
  name: string;
  items: Record<string, number>;
  bullets: string[];
  basePrice: number;
  discountPct: number;
  finalPrice: number;
  coins: number;
  notes?: string;
  active: boolean;
  purchased: boolean;
  purchasedAt?: string;
  /* webinar subscription offers: priced in USD (currencyCode 2), billed
     without VAT; yearly cycle shows the per-month price */
  currencyCode?: number; // 1 = ILS (default), 2 = USD
  isSubscription?: boolean;
  billingCycle?: "monthly" | "yearly";
  monthlyPrice?: number;
  priceIncludesVat?: boolean; // price is final — no VAT added at charge
  // First-month intro promo (e.g. PRO ₪49 first month, then ₪249/mo)
  introEnabled?: boolean;
  introPrice?: number;
  introMonths?: number;
  contractCoinPackage?: {
    packageId: string;
    name: string;
    coins: number;
    price: number;
    purchasedAt: string;
  } | null;
  createdAt: string;
  updatedAt: string;
}

export type PersonalPackageDraft = Omit<PersonalPackage, "_id" | "phone" | "agentId" | "purchased" | "purchasedAt" | "createdAt" | "updatedAt">;

export function getPersonalCatalog(phone: string) {
  return req<PersonalPackage[]>(
    `/cpanel/clients/${encodeURIComponent(phone)}/personal-catalog`,
  );
}

export function createPersonalPackage(phone: string, data: PersonalPackageDraft) {
  return req<PersonalPackage>(
    `/cpanel/clients/${encodeURIComponent(phone)}/personal-catalog`,
    { method: "POST", body: JSON.stringify(data) },
  );
}

export function updatePersonalPackage(phone: string, id: string, data: Partial<PersonalPackageDraft>) {
  return req<PersonalPackage>(
    `/cpanel/clients/${encodeURIComponent(phone)}/personal-catalog/${encodeURIComponent(id)}`,
    { method: "PATCH", body: JSON.stringify(data) },
  );
}

export function deletePersonalPackage(phone: string, id: string) {
  return req<{ success: boolean }>(
    `/cpanel/clients/${encodeURIComponent(phone)}/personal-catalog/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
}

export function launchFacebookCampaign(
  phone: string,
  type: "TRAFFIC" | "LEADS",
  websiteUrl?: string,
  slotKey?: string,
) {
  return req<{ success: boolean; campaignId: string; adSetId: string; adCount: number; campaignUrl?: string }>(
    `/cpanel/clients/${encodeURIComponent(phone)}/campaigns/launch`,
    { method: "POST", body: JSON.stringify({ type, websiteUrl, ...(slotKey ? { slotKey } : {}) }) },
  );
}

export function chargePersonalPackageIframe(phone: string, id: string) {
  return req<{ success: boolean; url: string; lowProfileId: string }>(
    `/cpanel/clients/${encodeURIComponent(phone)}/personal-catalog/${encodeURIComponent(id)}/charge-iframe`,
    { method: "POST" },
  );
}

/** Asks the server to check the Cardcom page of this package's latest
 *  charge and, if it was paid, apply the purchase everywhere. Safe to call
 *  repeatedly — used while the charge window is open and on return from
 *  Cardcom, since the webhook can't reach a local server. */
export function confirmPersonalPayment(phone: string, id: string) {
  return req<{ status: "paid" | "pending" | "processing" | "no_charge" | "invalid" | "mismatch"; already?: boolean; packageName?: string }>(
    `/cpanel/clients/${encodeURIComponent(phone)}/personal-catalog/${encodeURIComponent(id)}/confirm-payment`,
    { method: "POST" },
  );
}

/** Checks every open Cardcom page of the client (any package) and applies
 *  the paid ones. `paid` lists the package ids that just became purchased. */
export function confirmOpenCharges(phone: string) {
  return req<{ status: "paid" | "none"; paid: string[] }>(
    `/cpanel/clients/${encodeURIComponent(phone)}/personal-catalog/confirm-open-charges`,
    { method: "POST" },
  );
}

/* ── Webinar monitoring tab ──────────────────────────────────────────
   Read-only feed of everyone who registered through the webinar
   onboarding form: profile, gallery, and generated ads. */
export interface WebinarAdItem {
  id: number | string;
  headline: string;
  imageUrl: string | null;
  managerApproved: boolean;
}
export interface WebinarParticipant {
  phone: string;
  customerName: string | null;
  businessName: string | null;
  categoryKey: string | null;
  about: string;
  logoUrl: string | null;
  images: string[];
  servicesCount: number;
  targetAudience: string[];
  profileUpdatedAt: string | null;
  packageName: string | null;
  registeredAt: string | null;
  adsSession: {
    sessionId: string;
    status: string;
    createdAt: string;
    totalAds: number;
    readyAds: number;
    clientApprovalStatus: string | null;
  } | null;
  ads: WebinarAdItem[];
}
export function listWebinarParticipants(agent = "webinar") {
  return req<{ participants: WebinarParticipant[]; total: number }>(
    `/cpanel/webinar/participants?agent=${encodeURIComponent(agent)}`,
  );
}

/**
 * Reference price list — what each manager action costs in coins.
 * Server is the source of truth (deducts on the actual route); these
 * mirror the server values so the UI can show "this will cost X coins"
 * tooltips before the user confirms an expensive action.
 */
export const COIN_COSTS = {
  GENERATE_ADS:        50,   // POST /wow-ads/generate
  REGENERATE_AD:        5,   // POST /wow-ads/:id/regenerate
  GENERATE_ORGANIC:    30,   // POST /wow-organic/generate
  REGENERATE_ORGANIC:   3,   // POST /wow-organic/:id/regenerate
  GENERATE_LP:        100,   // POST /wow-lp/generate
  REGENERATE_LP_IMAGE: 10,   // POST /wow-lp/regenerate-image
  GENERATE_VIDEO:     200,   // (future) video generation
} as const;
