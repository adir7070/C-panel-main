import { req } from "./client";

/* ── Admin Dashboard types ──────────────────────────────────────────── */

export interface AdminKpis {
  revenueToday: number;
  revenueMonth: number;
  revenueTotal: number;
  purchasesMonth: number;
  clientsTotal: number;
  managersTotal: number;
  managersActive: number;
  packagesByStatus: Record<string, number>;
}

export interface RevenueDay {

  date: string;   // YYYY-MM-DD
  total: number;
  count: number;
}

export interface PackageMixEntry {
  name: string;
  total: number;
  count: number;
}

export interface TopManagerEntry {
  agentId: string;
  name: string;
  total: number;
  count: number;
}

export interface DashboardAlert {
  kind: "rejection" | "stuck" | "awaiting" | string;
  urgency: "red" | "orange" | "yellow" | string;
  message: string;
}

export interface AdminDashboard {
  kpis: AdminKpis;
  revenueTrend: RevenueDay[];
  packageMix: PackageMixEntry[];
  topManagers: TopManagerEntry[];
  alerts: DashboardAlert[];
}

export function getAdminDashboard() {
  return req<AdminDashboard>("/cpanel/admin/dashboard");
}

/* ── Managers (spec sec 2.2) ────────────────────────────────────────── */

export interface ManagerListEntry {
  id: string;
  name: string;
  role: string;
  active: boolean;
  clientCount: number;
  revenue: { lifetime: number; month: number; deals: number };
  commissions: { earned: number; paid: number; unpaid: number };
  openTasks: number;
  lastActiveAt: string | null;
  createdAt: string | null;
}

export function listAdminManagers() {
  return req<{ managers: ManagerListEntry[]; total: number }>("/cpanel/admin/managers");
}

export interface ManagerClientRow {
  phone: string;
  name: string;
  revenue: number;
  deals: number;
  lastDealAt: string | null;
}

export interface ManagerCommissionRow {
  id: string;
  baseAmount: number;
  commissionAmount: number;
  commissionRate: number;
  sourceKind: string;
  clientPhone: string | null;
  description: string | null;
  earnedAt: string;
  status: string;
}

export interface ManagerDetail {
  manager: {
    id: string; name: string; role: string;
    email: string | null; phone: string | null;
    active: boolean;
    lastActiveAt: string | null; createdAt: string | null;
  };
  stats: {
    clients: number;
    revenueLifetime: number;
    revenueMonth: number;
    dealsLifetime: number;
    dealsMonth: number;
    commissionEarned: number;
    commissionPaid: number;
    commissionUnpaid: number;
  };
  clients: ManagerClientRow[];
  commissions: ManagerCommissionRow[];
}

export function getAdminManagerDetail(id: string) {
  return req<ManagerDetail>(`/cpanel/admin/managers/${encodeURIComponent(id)}`);
}

export type AdminPackageStatus =
  | "waiting_brief"
  | "sent_to_creation"
  | "waiting_manager_approval"
  | "sent_to_client"
  | "client_returned_corrections"
  | "in_correction"
  | "corrections_completed"
  | "corrections_done"
  | "client_approved"
  | "completed";

export interface RefundResult {
  success: boolean;
  refundId: string;
  paymentId: string;
  refundAmount: number;
  isFullRefund: boolean;
  packageRevoked: boolean;
  commissionsReversed: { count: number; total: number };
  issuedAt: string;
}

export function createAdminRefund(payload: {
  paymentId: string;
  amount: number;
  reason: string;
  revokePackage?: boolean;
}) {
  return req<RefundResult>("/cpanel/admin/refunds", {
    method: "POST",
    body: JSON.stringify({ ...payload, mode: "ledger_only" }),
  });
}

export interface AdminRefundRow {
  id: string;
  paymentId: string;
  phone: string;
  agentId: string | null;
  originalAmount: number;
  refundAmount: number;
  isFullRefund: boolean;
  reason: string;
  revokedPackage: boolean;
  issuedByName: string | null;
  issuedAt: string;
}

export function listAdminRefunds() {
  return req<{ refunds: AdminRefundRow[]; total: number }>("/cpanel/admin/refunds");
}

export function forceClientStatus(phone: string, status: AdminPackageStatus, reason: string) {
  return req<{
    success: boolean;
    phone: string;
    previousStatus: string | null;
    newStatus: AdminPackageStatus;
    reason: string;
  }>(`/cpanel/admin/clients/${encodeURIComponent(phone)}/force-status`, {
    method: "PATCH",
    body: JSON.stringify({ status, reason }),
  });
}

/** Hard-delete a client. Removes the user document + every user-owned
 *  content row. PRESERVES financial records (cpanel_pending_purchases,
 *  coin_transactions, willbox_invoices) for accounting/legal retention.
 *  The full user doc is snapshotted to the audit log so an admin can
 *  reconstruct the client manually if the deletion was a mistake.
 *  `confirmName` must equal the client's exact name OR phone — the
 *  server rejects anything else as a safety check. */
export function deleteAdminClient(phone: string, reason: string, confirmName: string) {
  return req<{
    success: boolean;
    phone: string;
    deletionSummary: Record<string, number | string>;
    preserved: string[];
  }>(`/cpanel/admin/clients/${encodeURIComponent(phone)}`, {
    method: "DELETE",
    body: JSON.stringify({ reason, confirmName }),
  });
}

export function transferManagerClients(fromAgentId: string, toAgentId: string, phones?: string[]) {
  return req<{
    success: boolean;
    moved: number;
    attempted: number;
    from: { id: string; name: string };
    to: { id: string; name: string };
  }>(`/cpanel/admin/managers/${encodeURIComponent(fromAgentId)}/transfer-clients`, {
    method: "POST",
    body: JSON.stringify({ toAgentId, phones }),
  });
}

/* ── Clients global (spec sec 2.3) ──────────────────────────────────── */

export interface AdminClientRow {
  phone: string;
  name: string;
  logoUrl: string | null;
  agentId: string | null;
  managerName: string;
  tier: string;
  packageName: string | null;
  packageStatus: string | null;
  hasPaymentToken: boolean;
  revenue: number;
  deals: number;
  lastDealAt: string | null;
  lastChatAt: string | null;
  createdAt: string | null;
}

export interface AdminClientFilters {
  manager?: string;
  status?: string;
  tier?: string;
  search?: string;
  source?: string; // e.g. "promo49" — clients from the ₪49 landing promo
  limit?: number;
}

export function listAdminClients(filters: AdminClientFilters = {}) {
  const qs = new URLSearchParams();
  Object.entries(filters).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  });
  const tail = qs.toString() ? `?${qs}` : "";
  return req<{ clients: AdminClientRow[]; total: number }>(`/cpanel/admin/clients${tail}`);
}

/* ── Finance (spec sec 2.4) ─────────────────────────────────────────── */

export interface RevenueMonth { month: string; total: number; count: number }
export interface RevenueByName { name: string; total: number; count: number }
export interface RevenueByMgr { agentId: string; name: string; total: number; count: number }
export interface RevenueByTier { tier: string; total: number; count: number }

export interface FinanceRevenue {
  summary: {
    revenueTotal: number;
    dealsTotal: number;
    revenueMonth: number;
    revenueLastMonth: number;
    trendPct: number | null;
  };
  byMonth: RevenueMonth[];
  byPackage: RevenueByName[];
  byManager: RevenueByMgr[];
  byTier: RevenueByTier[];
}

export function getAdminFinanceRevenue(months = 12) {
  return req<FinanceRevenue>(`/cpanel/admin/finance/revenue?months=${months}`);
}

export interface PaymentRow {
  id: string;
  lowProfileId: string | null;
  phone: string;
  clientName: string;
  agentId: string | null;
  managerName: string;
  kind: string;
  description: string | null;
  amount: number;
  status: "completed" | "pending";
  createdAt: string;
  completedAt: string | null;
}

export interface PaymentFilters {
  from?: string; to?: string;
  manager?: string; status?: "completed" | "pending";
  search?: string; limit?: number;
}

export function getAdminPayments(f: PaymentFilters = {}) {
  const qs = new URLSearchParams();
  Object.entries(f).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  });
  const tail = qs.toString() ? `?${qs}` : "";
  return req<{ payments: PaymentRow[]; total: number }>(`/cpanel/admin/finance/payments${tail}`);
}

export interface CommissionRow {
  id: string;
  agentId: string | null;
  managerName: string;
  clientPhone: string | null;
  clientName: string;
  baseAmount: number;
  commissionAmount: number;
  commissionRate: number;
  sourceKind: string;
  description: string | null;
  earnedAt: string;
  status: string;
  paidAt: string | null;
  paidBatchId: string | null;
}

export interface CommissionFilters {
  manager?: string; status?: "earned" | "paid";
  from?: string; to?: string; limit?: number;
}

export function payCommission(id: string) {
  return req<{ success: boolean; id: string; paidAt: string }>(
    `/cpanel/admin/finance/commissions/${encodeURIComponent(id)}/pay`,
    { method: "POST", body: "{}" },
  );
}

export function batchPayCommissions(ids: string[], batchNote?: string) {
  return req<{
    success: boolean;
    batchId: string;
    paidAt: string;
    count: number;
    totalAmount: number;
    skipped: number;
  }>(
    `/cpanel/admin/finance/commissions/batch-pay`,
    { method: "POST", body: JSON.stringify({ ids, batchNote }) },
  );
}

export function getAdminCommissions(f: CommissionFilters = {}) {
  const qs = new URLSearchParams();
  Object.entries(f).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  });
  const tail = qs.toString() ? `?${qs}` : "";
  return req<{
    commissions: CommissionRow[]; total: number;
    summary: { earned: number; paid: number; unpaid: number };
  }>(`/cpanel/admin/finance/commissions${tail}`);
}

/* ── Tasks (admin global, spec sec 2.6) ─────────────────────────────── */

export type TaskUrgency = "normal" | "yellow" | "orange" | "red" | "blink";

export interface AdminTask {
  id: string;
  clientPhone: string;
  clientName: string;
  agentId: string | null;
  managerName: string;
  packageName: string;
  taskType: string;
  taskLabel: string;
  description: string;
  since: string;
  elapsedHours: number;
  urgency: TaskUrgency;
}

export interface AdminManagerTaskRollup {
  agentId: string | null;
  managerName: string;
  total: number;
  byUrgency: Record<TaskUrgency, number>;
}

export function getAdminTasks() {
  return req<{
    tasks: AdminTask[];
    total: number;
    byUrgency: Record<TaskUrgency, number>;
    byManager: AdminManagerTaskRollup[];
  }>("/cpanel/admin/tasks");
}

/* ── Catalog (spec sec 2.11) ────────────────────────────────────────── */

export interface CatalogItem {
  _id?: string;
  key: string;
  kind: "item" | "prebuilt" | "coins";
  active?: boolean;
  sortOrder?: number;
  /* item: */
  label?: string;
  emoji?: string;
  unitPrice?: number;
  isPermission?: boolean;
  /* prebuilt + coins: */
  name?: string;
  price?: number;
  discountPct?: number;
  badge?: string;
  bullets?: string[];
  coins?: number;
  /* prebuilt only: */
  items?: Record<string, number>;   /* { ad, lp, video, logo, social_ad } */
  createdAt?: string;
  updatedAt?: string;
}

export function getAdminCatalog() {
  return req<{ items: CatalogItem[]; prebuilt: CatalogItem[]; coins: CatalogItem[] }>(
    "/cpanel/admin/catalog",
  );
}

export function upsertAdminCatalogItem(item: CatalogItem) {
  return req<{ success: boolean; product: CatalogItem }>(
    "/cpanel/admin/catalog",
    { method: "POST", body: JSON.stringify(item) },
  );
}

export function deleteAdminCatalogItem(key: string) {
  return req<{ success: boolean }>(
    `/cpanel/admin/catalog/${encodeURIComponent(key)}`,
    { method: "DELETE" },
  );
}

/* ── Subscription tiers (REGULAR/PRO/VIP — the app's monthly plans) ──── */

export interface SubscriptionPlan {
  _id?: string;
  tier?: string;
  name: string;
  description?: string;
  monthlyPrice: number;
  yearlyPrice?: number;
  coinsIncluded: number;
  isActive?: boolean;
  sortOrder?: number;
  color?: string;
  // First-month intro promo (e.g. ₪49 first month, then monthlyPrice)
  introEnabled?: boolean;
  introPrice?: number;
  introMonths?: number;
}

export async function getSubscriptionPlans(): Promise<SubscriptionPlan[]> {
  const r = await req<{ success: boolean; data: SubscriptionPlan[] }>("/subscription-plans");
  return r.data ?? [];
}

export function createSubscriptionPlan(plan: SubscriptionPlan) {
  return req<{ success: boolean; data: SubscriptionPlan }>("/subscription-plans", {
    method: "POST",
    body: JSON.stringify(plan),
  });
}

export function updateSubscriptionPlan(id: string, plan: Partial<SubscriptionPlan>) {
  return req<{ success: boolean; data: SubscriptionPlan }>(
    `/subscription-plans/${encodeURIComponent(id)}`,
    { method: "PUT", body: JSON.stringify(plan) },
  );
}

export function deleteSubscriptionPlan(id: string) {
  return req<{ success: boolean }>(
    `/subscription-plans/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
}

/* ── System Settings (spec sec 2.15) ────────────────────────────────── */

export type SettingValue = string | number | boolean;

export interface SettingsDoc {
  coins: Record<string, number>;
  commissions: Record<string, number>;
  sla: Record<string, number>;
  ui: Record<string, string>;
  flags: Record<string, boolean>;
}

export function getAdminSettings() {
  return req<{ settings: SettingsDoc; defaults: SettingsDoc }>(`/cpanel/admin/settings`);
}

export function patchAdminSettings(section: keyof SettingsDoc, values: Record<string, SettingValue>) {
  return req<{ success: boolean; section: string; values: Record<string, SettingValue> }>(
    `/cpanel/admin/settings`,
    { method: "PATCH", body: JSON.stringify({ section, values }) },
  );
}

/* ── AI Usage (spec sec 2.7) ────────────────────────────────────────── */

export interface AiUsageClientRow {
  phone: string;
  clientName: string;
  agentId: string | null;
  managerName: string;
  coinsUsed: number;
  coinsBalance: number;
  coinsGranted: number;
  packageName: string | null;
}

export interface AiUsageManagerRow {
  agentId: string;
  managerName: string;
  coinsUsed: number;
  clientCount: number;
}

export interface AiUsageReport {
  summary: {
    clientsWithPackage: number;
    coinsGranted: number;
    coinsUsed: number;
    coinsBalance: number;
    utilizationPct: number;
  };
  regenerations: { ads: number; organic: number; lp: number };
  topClients: AiUsageClientRow[];
  byManager: AiUsageManagerRow[];
}

export function getAdminAiUsage() {
  return req<AiUsageReport>("/cpanel/admin/ai-usage");
}

/* ── Reviews & approval analytics (spec sec 2.8) ────────────────────── */

export interface ReviewsTypeRollup {
  sent: number;
  approved: number;
  rejected: number;
  pending: number;
  approvalRate: number;        // 0-100
  avgResponseHours: number | null;
  itemsApproved: number;
  itemsRejected: number;
}

export interface ReviewsManagerRollup {
  agentId: string | null;
  managerName: string;
  sent: number;
  approved: number;
  rejected: number;
  pending: number;
  approvalRate: number;        // 0-100
  avgResponseHours: number | null;
}

export interface ReviewsRecentRejection {
  phone: string;
  clientName: string;
  managerName: string;
  kind: "ads" | "organic" | "lp";
  rejectedAt: string | null;
  responseHours: number | null;
}

export interface ReviewsAnalytics {
  summary: {
    totalSent: number;
    totalApproved: number;
    totalRejected: number;
    totalPending: number;
    approvalRatePct: number;
  };
  byType: { ads: ReviewsTypeRollup; organic: ReviewsTypeRollup; lp: ReviewsTypeRollup };
  byManager: ReviewsManagerRollup[];
  recentRejections: ReviewsRecentRejection[];
}

export function getAdminReviewsAnalytics() {
  return req<ReviewsAnalytics>("/cpanel/admin/reviews-analytics");
}

/* ── Pipeline global (spec sec 2.9) ─────────────────────────────────── */

export type PipelineStage = "new" | "qualified" | "proposal" | "won" | "lost";

export interface PipelineGlobalCard {
  phone: string;
  clientName: string;
  logoUrl: string | null;
  stage: PipelineStage;
  agentId: string | null;
  managerName: string;
  value: number;
  notes: string | null;
  movedAt: string | null;
  updatedAt: string | null;
}

export interface PipelineGlobalManagerRollup {
  agentId: string | null;
  managerName: string;
  counts: Record<PipelineStage, number>;
  total: number;
  totalValue: number;
  winRate: number;       // 0-100
}

export interface PipelineVelocityEntry {
  stage: PipelineStage;
  count: number;
  avgHours: number | null;   // avg time current cards have spent in this stage
}

export interface PipelineGlobal {
  summary: {
    totalCards: number;
    totalOpen: number;
    totalWon: number;
    totalLost: number;
    totalValue: number;
    wonValue: number;
    overallWinRate: number;
  };
  byStage: Record<PipelineStage, PipelineGlobalCard[]>;
  byManager: PipelineGlobalManagerRollup[];
  velocity: PipelineVelocityEntry[];
}

export function getAdminPipelineGlobal() {
  return req<PipelineGlobal>("/cpanel/admin/pipeline-global");
}

/* ── Support chats global (spec sec 2.10) ───────────────────────────── */

export interface AdminChatRow {
  phone: string;
  clientName: string;
  logoUrl: string | null;
  agentId: string | null;
  managerName: string;
  messageCount: number;
  lastMessage: { text: string; fromRole: string | null; createdAt: string | null } | null;
  lastMsgAt: string | null;
  isUnread: boolean;
}

export function getAdminChats(filters: { search?: string; manager?: string; unreadOnly?: boolean } = {}) {
  const qs = new URLSearchParams();
  if (filters.search) qs.set("search", filters.search);
  if (filters.manager) qs.set("manager", filters.manager);
  if (filters.unreadOnly) qs.set("unreadOnly", "true");
  const tail = qs.toString() ? `?${qs}` : "";
  return req<{ chats: AdminChatRow[]; total: number; unreadCount: number }>(`/cpanel/admin/chats${tail}`);
}

/* ── Integrations health (spec sec 2.12) ────────────────────────────── */

export type IntegrationStatus = "ok" | "warn" | "error" | "unknown";

export interface IntegrationCheck {
  name: string;
  status: IntegrationStatus;
  detail: string;
  meta: Record<string, unknown>;
  lastCheck: string;
}

export interface IntegrationsReport {
  integrations: IntegrationCheck[];
  summary: { total: number; ok: number; warn: number; error: number };
  checkedAt: string;
}

export function getAdminIntegrations() {
  return req<IntegrationsReport>("/cpanel/admin/integrations");
}

/* ── Admin Broadcasts (spec sec 2.14) ───────────────────────────────── */

export type BroadcastChannel = "sms" | "whatsapp";

export type BroadcastSegment =
  | { kind: "all" }
  | { kind: "manager"; agentId: string }
  | { kind: "package"; packageId: string }
  | { kind: "tier"; tier: string }
  | { kind: "phones"; phones: string[] };

export interface AdminBroadcastRow {
  id: string;
  message: string;
  channel: BroadcastChannel;
  segment: BroadcastSegment;
  targetCount: number;
  sentCount: number;
  failCount: number;
  sentBy: string | null;
  sentAt: string;
}

export function listAdminBroadcasts() {
  return req<{ broadcasts: AdminBroadcastRow[]; total: number }>("/cpanel/admin/broadcasts");
}

export function sendAdminBroadcast(payload: {
  message: string;
  channel: BroadcastChannel;
  segment: BroadcastSegment;
  dryRun?: boolean;
}) {
  return req<{
    success?: boolean;
    id?: string;
    targetCount: number;
    sentCount?: number;
    failCount?: number;
    dryRun?: boolean;
    phones?: string[];
  }>("/cpanel/admin/broadcasts", { method: "POST", body: JSON.stringify(payload) });
}

/* ── Agent management (Tier A #5) ───────────────────────────────────── */

export type AgentRole = "admin" | "supervisor" | "account_manager" | "finance";

export interface AgentRow {
  id: string;
  name: string | null;
  nickname: string | null;
  email: string | null;
  phone: string | null;
  role: AgentRole;
  active: boolean;
  station: string | null;
  team: string | null;
  avatarUrl: string | null;
  bio: string | null;
  createdAt: string | null;
  lastLogin: string | null;
  lastActiveAt: string | null;
}

export function listAdminAgents() {
  return req<{ agents: AgentRow[]; total: number }>("/cpanel/admin/agents");
}

/* Upload (or replace) a manager's profile image. Used on /admin/users
   so admin can put a face on every account_manager. */
export async function uploadAdminAgentAvatar(id: string, file: File): Promise<{ avatarUrl: string }> {
  const fd = new FormData();
  fd.append("avatar", file);
  const token = localStorage.getItem("cpanel_token");
  const res = await fetch(`${(import.meta.env.VITE_API_BASE as string | undefined) ?? "/api"}/cpanel/admin/agents/${encodeURIComponent(id)}/avatar`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: fd,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error || json?.message || "Server error");
  return { avatarUrl: json.avatarUrl as string };
}

export function createAdminAgent(payload: {
  name: string;
  password: string;
  role: AgentRole;
  nickname?: string;
  email?: string;
  phone?: string;
}) {
  return req<{ success: boolean; agent: { id: string; name: string; nickname: string | null; role: AgentRole; active: boolean; createdAt: string } }>(
    "/cpanel/admin/agents",
    { method: "POST", body: JSON.stringify(payload) },
  );
}

export function updateAdminAgent(id: string, payload: Partial<{
  name: string; nickname: string; email: string; phone: string;
  role: AgentRole; active: boolean; password: string; station: string; team: string;
  bio: string;
}>) {
  return req<{ success: boolean; id: string }>(
    `/cpanel/admin/agents/${encodeURIComponent(id)}`,
    { method: "PATCH", body: JSON.stringify(payload) },
  );
}

export function forceLogoutAgent(id: string, reason?: string) {
  return req<{ success: boolean }>(
    `/cpanel/admin/agents/${encodeURIComponent(id)}/force-logout`,
    { method: "POST", body: JSON.stringify({ reason }) },
  );
}

/* ── Audit log types ────────────────────────────────────────────────── */

export interface AuditEntry {
  _id: string;
  actor: { id: string | null; name: string | null; role: string | null } | null;
  action: string;
  target: { kind?: string; id?: string; label?: string } | null;
  before: unknown;
  after: unknown;
  meta: unknown;
  at: string;
}

export interface AuditFilters {
  actor?: string;
  action?: string;
  kind?: string;
  id?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export function getAuditLog(filters: AuditFilters = {}) {
  const qs = new URLSearchParams();
  Object.entries(filters).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  });
  const tail = qs.toString() ? `?${qs}` : "";
  return req<{ entries: AuditEntry[]; total: number }>(`/cpanel/admin/audit${tail}`);
}

/* ── Lead distribution (admin) ──────────────────────────────────────────
   Moved to src/api/leads.ts — leads are now served by the local backend
   (server/leads.js) instead of being pulled from an external CRM. */

// ─── Referral (חבר מביא חבר) ─────────────────────────────────────────────────

export interface ReferralLeadRow {
  _id: string;
  name: string;
  business_name?: string;
  phone: string;
  referred_by: string;
  referral_status: 0 | 1 | 2;
  created_at: string;
}

export function listReferralLeads() {
  return req<{ success: boolean; data: ReferralLeadRow[] }>("/leads/referrals/admin");
}

export function approveReferralLead(id: string) {
  return req<{ success: boolean; new_balance: number }>(`/leads/${encodeURIComponent(id)}/referral-approve`, {
    method: "PATCH",
  });
}

export function closeReferralLead(id: string) {
  return req<{ success: boolean; new_balance: number }>(`/leads/${encodeURIComponent(id)}/referral-close`, {
    method: "PATCH",
  });
}

/* ── AI-agent escalations (client hand-offs the agent routed to a human) ─── */
export interface EscalationItem { category: string; summary: string; clientMessage: string; at: string; }
export interface Escalation {
  _id: string;
  clientPhone: string;
  businessName: string | null;
  managerName: string | null;
  managerPhone: string | null;
  category: string;
  lastCategory: string;
  summary: string;
  items: EscalationItem[];
  status: "open" | "resolved";
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  // control-view fields (derived from the client's agent_chats thread)
  handlingStatus?: "resolved" | "human" | "stale" | "waiting";
  handlingNow?: "ai" | "human";
  handledByName?: string | null;
  humanTakeoverAt?: string | null;
  responseMs?: number | null;
  ageMs?: number;
}

export function getAgentEscalations(status: "open" | "resolved" = "open") {
  // NB: lives under /agent (not /cpanel/admin); req already prepends /api.
  return req<{ escalations: Escalation[] }>(`/agent/escalations?status=${status}&limit=200`);
}

export function resolveAgentEscalation(id: string) {
  return req<{ ok: boolean; error?: string }>("/agent/escalations/resolve", {
    method: "POST",
    body: JSON.stringify({ id, by: "admin-boss" }),
  });
}

/* ── Agent tech-report ("עדכונים מהסוכן") — recurring technical failures + fixes ─ */
export interface TechReportSample { at: string; clientPhone: string; error?: string; args?: any; }
export interface TechReportItem {
  tool: string;
  errorSample: string;
  count: number;
  clients?: string[];
  clientsAffected: number;
  firstAt?: string;
  lastAt: string;
  samples?: TechReportSample[];
  implNote?: string | null;
  severity?: "high" | "medium" | "low";
  title?: string;
  detail?: string;
  impact?: string;
  rootCause?: string;
  steps?: string[];
  codePointers?: string;
}
export interface TechReport {
  generatedAt: string | null;
  windowDays: number;
  totalFailures: number;
  items: TechReportItem[];
  cached?: boolean;
  generating?: boolean;
}
export function getAgentTechReport(days = 7, force = false) {
  return req<TechReport>(`/agent/tech-report?days=${days}${force ? "&force=1" : ""}`);
}

/* Auto-resolve: re-run the affected clients' failed requests through the agent. */
export function resolveAgentTechIssue(tool: string, errorPrefix = "") {
  return req<{ ok: boolean; started?: boolean; clientsAffected?: number; error?: string }>(
    "/agent/tech-report/resolve",
    { method: "POST", body: JSON.stringify({ tool, errorPrefix }) },
  );
}

/* ── Unified AI-agent chat (client profile "צ'אט עם הלקוח") ─────────────
   The client-profile chat reads/writes the SAME WhatsApp thread the AI
   assistant manages (agent_chats, merged with legacy support history).
   Sending uses ANNOUNCE mode: the manager's message lands in the thread as a
   named human bubble + push, WITHOUT pausing the AI. */

