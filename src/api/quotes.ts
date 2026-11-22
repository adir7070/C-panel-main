import { req } from "./client";

/* ── Quotes in the Dashen format ───────────────────────────────────────
   Backend: backend/controllers/quotes.controller.js + services/quote.service.js.
   A quote lives in personal_packages with kind "quote" and is listed by
   getPersonalCatalog() next to older packages. The server recomputes every
   total on save; computeQuoteTotals() below is the same arithmetic, for the
   builder's live preview. */

export type ServiceBilling = "setup" | "monthly";

export interface CatalogService {
  _id: string;
  key: string;
  kind: "service";
  name: string;
  description: string;
  category: string;
  categoryName: string;
  categoryOrder: number;
  role: "core" | "addon";
  billing: ServiceBilling;
  onDemand: boolean;
  price: number;
  keywords?: string;
  sortOrder: number;
}

export interface ServiceCategory { key: string; order: number; name: string }
export interface QuickStart { key: string; name: string; description: string; services: string[] }
export interface ServiceCombo { services: string[]; solves: string }

export interface ServiceCatalog {
  services: CatalogService[];
  categories: ServiceCategory[];
  quickStarts: QuickStart[];
  combos: ServiceCombo[];
  quoteRules: { maxDiscountPct: number; vatPct: number };
}

export interface QuoteLine {
  key: string | null;
  custom: boolean;
  name: string;
  description: string;
  billing: ServiceBilling;
  onDemand?: boolean;
  price: number;
  qty: number;
  category?: string;
  role?: "core" | "addon";
}

export interface QuoteClient {
  name: string;
  id: string;
  contact: string;
  role: string;
  phone: string;
  email: string;
  address: string;
}

export interface QuoteBlock { count: number; sub: number; disc: number; net: number; vat: number; total: number }

export interface QuoteTotals {
  discountPct: number;
  vatPct: number;
  setup: QuoteBlock;
  monthly: QuoteBlock;
  commitMonths: number;
  commitNet: number;
  commitTotal: number;
}

export interface Quote {
  _id: string;
  phone: string;
  kind: "quote";
  quoteNo: string;
  name: string;
  agentName?: string;
  lines: QuoteLine[];
  client: QuoteClient;
  discountPct: number;
  vatPct: number;
  commitMonths: number;
  validDays: number;
  noticeDays: number;
  quoteDate: string;
  notes: string;
  totals: QuoteTotals;
  purchased: boolean;
  /** Signing link (/sign/<signToken>) — created the first time it's copied. */
  signToken?: string;
  signLinkAt?: string;
  lastViewedAt?: string;
  viewCount?: number;
  /** Set when the client signed — the frozen copy is in signed_documents. */
  signed?: { at: string; name: string; role?: string; ip?: string; sha256?: string; signingId?: string } | null;
  createdAt: string;
  updatedAt: string;
}

/** What the builder sends: catalog lines by key, custom lines in full. */
export type QuoteLineInput =
  | { key: string; qty: number }
  | { custom: true; name: string; description: string; billing: ServiceBilling; price: number; qty: number };

export interface QuoteInput {
  lines: QuoteLineInput[];
  client: QuoteClient;
  discountPct: number;
  commitMonths: number;
  validDays: number;
  quoteDate: string;
  notes: string;
}

export async function getServiceCatalog(): Promise<ServiceCatalog> {
  const r = await req<Partial<ServiceCatalog>>(`/cpanel/products`);
  return {
    services: r.services ?? [],
    categories: r.categories ?? [],
    quickStarts: r.quickStarts ?? [],
    combos: r.combos ?? [],
    quoteRules: r.quoteRules ?? { maxDiscountPct: 10, vatPct: 18 },
  };
}

export interface QuoteDefaults {
  client: QuoteClient;
  quoteDate: string;
  validDays: number;
  commitMonths: number;
  noticeDays: number;
  maxDiscountPct: number;
  vatPct: number;
}

export function getQuoteDefaults(phone: string) {
  return req<QuoteDefaults>(`/cpanel/clients/${encodeURIComponent(phone)}/quotes/defaults`);
}

export function createQuote(phone: string, input: QuoteInput) {
  return req<Quote>(`/cpanel/clients/${encodeURIComponent(phone)}/quotes`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateQuote(phone: string, id: string, input: Partial<QuoteInput>) {
  return req<Quote>(`/cpanel/clients/${encodeURIComponent(phone)}/quotes/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function createSignLink(phone: string, id: string) {
  return req<{ token: string; path: string; signed: boolean; expired: boolean; validUntil: string }>(
    `/cpanel/clients/${encodeURIComponent(phone)}/quotes/${encodeURIComponent(id)}/sign-link`,
    { method: "POST" },
  );
}

/** Opens the printable quote document — or, with `signed`, the frozen
 *  signed copy — in a new tab. The tab is opened synchronously (before the
 *  fetch) so pop-up blockers allow it. */
export async function openQuoteDocument(phone: string, id: string, { signed = false } = {}) {
  const win = window.open("", "_blank");
  try {
    const token = localStorage.getItem("cpanel_token");
    const base = (import.meta.env.VITE_API_BASE as string | undefined) ?? "/api";
    const res = await fetch(`${base}/cpanel/clients/${encodeURIComponent(phone)}/quotes/${encodeURIComponent(id)}/${signed ? "signed-document" : "document"}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`שגיאה ${res.status} בטעינת ההצעה`);
    const html = await res.text();
    if (!win) throw new Error("הדפדפן חסם את החלון — אפשר חלונות קופצים לאתר הזה");
    win.document.open();
    win.document.write(html);
    win.document.close();
  } catch (err) {
    win?.close();
    throw err;
  }
}

/* Same arithmetic as backend computeTotals(). */
export function computeQuoteTotals(
  lines: Pick<QuoteLine, "billing" | "price" | "qty">[],
  { discountPct = 0, vatPct = 18, commitMonths = 3, maxDiscountPct = 10 } = {},
): QuoteTotals {
  const pct = Math.min(maxDiscountPct, Math.max(0, Number(discountPct) || 0));
  const block = (monthly: boolean): QuoteBlock => {
    const its = lines.filter(l => (l.billing === "monthly") === monthly);
    const sub = its.reduce((s, l) => s + l.price * l.qty, 0);
    const disc = Math.round(sub * pct / 100);
    const net = sub - disc;
    const vat = Math.round(net * vatPct / 100);
    return { count: its.length, sub, disc, net, vat, total: net + vat };
  };
  const setup = block(false);
  const monthly = block(true);
  return {
    discountPct: pct, vatPct, setup, monthly, commitMonths,
    commitNet: setup.net + commitMonths * monthly.net,
    commitTotal: setup.total + commitMonths * monthly.total,
  };
}

export function formatIls(n: number): string {
  return `${Math.round(Number(n) || 0).toLocaleString("en-US")} ₪`;
}

export function todayISO(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(new Date());
}

export function formatQuoteDate(iso: string): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}
