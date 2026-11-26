import { req } from "./client";

/* ── Call recordings (Extra Mobile) ────────────────────────────────────
   Backend: backend/controllers/calls.controller.js. Admins only — the server
   answers 403 to anyone else. A recording is played from a signed Extra link
   that lives 10 minutes, fetched when play is pressed. */

export interface CallRecord {
  id: string;
  type: string | null;
  direction: "in" | "out";
  answered: boolean;
  own: string | null;
  other: string | null;
  otherLocal: string;
  contactName: string | null;
  duration: number | null;
  startedAt: string | null;
  endedAt: string | null;
  hasRecording: boolean;
  recordingSkipReason: string | null;
  lead: { id: string; name: string | null; status: string | null } | null;
  client: { phone: string; name: string | null } | null;
}

export interface CallsStatus {
  apiKey: boolean;
  webhookSecret: boolean;
  key: "valid" | "rejected" | "unreachable" | "missing";
  keyExpires?: string | null;
  lastWebhookAt: string | null;
  lastSyncAt: string | null;
  lastSyncError: string | null;
}

export function getCalls(opts: { phone?: string; before?: string; limit?: number } = {}, signal?: AbortSignal) {
  const q = new URLSearchParams();
  if (opts.phone) q.set("phone", opts.phone);
  if (opts.before) q.set("before", opts.before);
  if (opts.limit) q.set("limit", String(opts.limit));
  const qs = q.toString();
  return req<CallRecord[]>(`/cpanel/calls${qs ? `?${qs}` : ""}`, { signal });
}

export function getCallRecordingUrl(id: string) {
  return req<{ url: string }>(`/cpanel/calls/${encodeURIComponent(id)}/recording`);
}

export function syncCalls(days?: number) {
  return req<{ saved?: number; error?: string; skipped?: string }>("/cpanel/calls/sync", { method: "POST", body: JSON.stringify(days ? { days } : {}) });
}

export function getCallsStatus(signal?: AbortSignal) {
  return req<CallsStatus>("/cpanel/calls/extra-status", { signal });
}

export function formatDuration(sec: number | null) {
  if (sec == null) return "—";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export const SKIP_REASON_LABEL: Record<string, string> = {
  line_off: "ההקלטה כבויה בקו",
  excluded: "המספר ברשימת החריגים",
  too_short: "שיחה קצרה מ-6 שניות",
};
