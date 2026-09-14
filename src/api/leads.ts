import { req } from "./client";

/* ── Local leads API (served by server.js → server/leads.js) ──────────
   Incoming leads land via POST /api/leads/intake (x-api-key), then get
   distributed to managers and worked through the statuses below. */

export type LeadStatus =
  | "new"
  | "call_again"
  | "not_relevant"
  | "in_process"
  | "to_charge"
  | "active_client";

export const LEAD_STATUSES: LeadStatus[] = [
  "new", "call_again", "not_relevant", "in_process", "to_charge", "active_client",
];

export const LEAD_STATUS_LABEL: Record<LeadStatus, string> = {
  new:           "חדש",
  call_again:    "להתקשר שוב",
  not_relevant:  "לא רלוונטי",
  in_process:    "בתהליך",
  to_charge:     "לסלוק",
  active_client: "לקוח פעיל",
};

export const LEAD_STATUS_COLOR: Record<LeadStatus, string> = {
  new:           "#0073EA",
  call_again:    "#F59E0B",
  not_relevant:  "#6B7280",
  in_process:    "#7C3AED",
  to_charge:     "#DB2777",
  active_client: "#16A34A",
};

export interface LeadNote {
  id: string;
  text: string;
  by: string;
  byName: string;
  at: string;
}

export interface LeadStatusChange {
  from: LeadStatus;
  to: LeadStatus;
  by: string;
  byName: string;
  at: string;
}

export interface Lead {
  id: string;
  name: string;
  phone: string;
  phoneRaw: string;
  email: string;
  business: string;
  field: string;
  source: string;
  message: string;
  campaign: string;
  status: LeadStatus;
  assignedTo: string | null;
  assignedToName: string | null;
  notes: LeadNote[];
  statusHistory: LeadStatusChange[];
  activatedAt: string | null;
  activatedBy: string | null;
  duplicateOf?: string | null;
  raw?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface LeadsFilters {
  status?: LeadStatus | "";
  search?: string;
  /** admin only: "me" | "unassigned" | "all" | <agentId> */
  assigned?: string;
  limit?: number;
  offset?: number;
}

export function listLeads(filters: LeadsFilters = {}) {
  const qs = new URLSearchParams();
  Object.entries(filters).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  });
  const tail = qs.toString() ? `?${qs}` : "";
  return req<{ leads: Lead[]; total: number }>(`/leads${tail}`);
}

export function getLeadStats() {
  return req<{ total: number; byStatus: Record<LeadStatus, number>; unassigned: number }>("/leads/stats");
}

export function getLead(id: string) {
  return req<{ lead: Lead }>(`/leads/${encodeURIComponent(id)}`);
}

export type LeadPatch = Partial<Pick<Lead, "name" | "phone" | "email" | "business" | "field" | "message" | "campaign" | "source" | "status">> & {
  assignedTo?: string | null;
};

export function updateLead(id: string, patch: LeadPatch) {
  return req<{ lead: Lead }>(`/leads/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function addLeadNote(id: string, text: string) {
  return req<{ lead: Lead; note: LeadNote }>(`/leads/${encodeURIComponent(id)}/notes`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
}

export function activateLead(id: string) {
  return req<{ lead: Lead }>(`/leads/${encodeURIComponent(id)}/activate`, { method: "POST" });
}

export function deleteLead(id: string) {
  return req<{ ok: boolean }>(`/leads/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function assignLeads(ids: string[], toAgentId: string) {
  return req<{ ok: boolean; assigned: number; skipped: number }>("/leads/assign", {
    method: "POST",
    body: JSON.stringify({ ids, toAgentId }),
  });
}

export function roundRobinLeads(ids: string[], agentIds: string[] = []) {
  return req<{ ok: boolean; assigned: number; skipped: number; distribution: Record<string, number> }>("/leads/round-robin", {
    method: "POST",
    body: JSON.stringify({ ids, agentIds }),
  });
}

export interface ImportLead {
  name?: string;
  phone?: string;
  email?: string;
  business?: string;
  field?: string;
  source?: string;
  message?: string;
}

export function importLeads(leads: ImportLead[], assignedTo?: string | null) {
  return req<{ ok: boolean; imported: number; skipped: number; assignedTo: string | null; assignedToName: string | null }>("/leads/import", {
    method: "POST",
    body: JSON.stringify({ leads, assignedTo: assignedTo ?? null }),
  });
}

export function formatLeadDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("he-IL", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function waLink(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  const intl = digits.startsWith("0") ? `972${digits.slice(1)}` : digits;
  return `https://wa.me/${intl}`;
}
