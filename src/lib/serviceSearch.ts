import type { CatalogService } from "../api/quotes";

/* Smart search over the 64-service price list (quote builder).

   • Hebrew-aware: final letters (ך/כ…), geresh/quotes and punctuation are
     normalized, so "צאטבוט", "צ'אטבוט" and "צ’אטבוט" all match.
   • Synonyms: "פייסבוק" finds Meta, "ווטסאפ" finds WhatsApp, "וידאו" finds
     סרטונים, English and Hebrew names find each other.
   • Every word must match (AND); a word matches as a prefix, inside a word,
     or — for words of 4+ letters — with one typo.
   • Ranked: a hit in the name beats keywords, category, then description.
   • Price filters inside the query: "עד 1000", "מתחת ל-500", "<800",
     "מעל 2000", ">1500".
   • Labels are searchable too: "חודשי", "הקמה", "מרכזי", "משלים", "לפי הזמנה".

   normalize() keeps string length (it only replaces characters), so match
   ranges found on normalized text map 1:1 onto the original for highlighting. */

const FINALS: Record<string, string> = { "ך": "כ", "ם": "מ", "ן": "נ", "ף": "פ", "ץ": "צ" };

export function normalize(s: string): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[֑-ׇ]/g, " ")            // niqqud / cantillation
    .replace(/[ךםןףץ]/g, c => FINALS[c])
    .replace(/['"`’‘״׳“”\-–—_/+.,:;()[\]!?|&]/g, " ");
}

const SYNONYM_GROUPS: string[][] = [
  ["פייסבוק", "facebook", "fb", "מטא", "meta"],
  ["אינסטגרם", "אינסטה", "instagram", "insta", "meta"],
  ["טיקטוק", "tiktok"],
  ["גוגל", "google"],
  ["וואטסאפ", "ווטסאפ", "וואצאפ", "ווצאפ", "whatsapp", "וטסאפ"],
  ["אתר", "אתרים", "website", "site", "wordpress"],
  ["נחיתה", "landing", "lp"],
  ["קידום", "seo", "אורגני"],
  ["בוט", "צאטבוט", "chatbot", "bot", "צאט"],
  ["ai", "בינה", "סוכן"],
  ["סרטון", "סרטונים", "וידאו", "video", "רילס", "reels"],
  ["עיצוב", "design", "גרפי", "גרפיקה"],
  ["תשלום", "תשלומים", "סליקה", "אשראי", "payment"],
  ["חשבונית", "חשבוניות", "קבלה", "קבלות", "invoice"],
  ["דוח", "דוחות", "dashboard", "דשבורד", "נתונים", "דאטה", "report"],
  ["אוטומציה", "אוטומציות", "automation", "אוטומטי", "אוטומטית"],
  ["מייל", "מיילים", "אימייל", "email", "דואל"],
  ["sms", "מסרון", "מסרונים"],
  ["crm", "סיארם"],
  ["חנות", "איקומרס", "ecommerce", "shop", "store", "עגלה", "עגלות"],
  ["תור", "תורים", "הזמנות", "booking", "יומן", "פגישה"],
  ["אבטחה", "security", "הגנה", "פריצות"],
  ["גיבוי", "גיבויים", "backup"],
  ["קמפיין", "קמפיינים", "campaign", "ממומן", "פרסום", "ads", "מודעות"],
  ["סושיאל", "social", "רשתות"],
  ["תוכן", "content", "פוסט", "פוסטים"],
  ["ליד", "לידים", "lead", "leads"],
  ["make", "zapier", "זאפייר", "מייק"],
].map(g => g.map(normalize));

const BILLING_LABEL = { setup: "הקמה", monthly: "חודשי" } as const;

interface Indexed {
  service: CatalogService;
  name: string;
  keywords: string;
  category: string;
  description: string;
  labels: string;
  nameWords: string[];
  keywordWords: string[];
}

function words(s: string): string[] {
  return s.split(/\s+/).filter(Boolean);
}

const indexCache = new WeakMap<CatalogService[], Indexed[]>();

function buildIndex(services: CatalogService[]): Indexed[] {
  const cached = indexCache.get(services);
  if (cached) return cached;
  const idx = services.map(service => {
    const labels = [
      BILLING_LABEL[service.billing],
      service.onDemand ? "לפי הזמנה" : "",
      service.role === "core" ? "מרכזי" : "משלים",
    ].join(" ");
    const name = normalize(service.name);
    const keywords = normalize(service.keywords || "");
    return {
      service,
      name,
      keywords,
      category: normalize(service.categoryName || ""),
      description: normalize(service.description || ""),
      labels: normalize(labels),
      nameWords: words(name),
      keywordWords: words(keywords),
    };
  });
  indexCache.set(services, idx);
  return idx;
}

/* One edit (insert / delete / substitute) between a and b. */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (la > lb) i++;
    else if (lb > la) j++;
    else { i++; j++; }
  }
  return edits + (la - i) + (lb - j) <= 1;
}

function expand(token: string): string[] {
  const out = new Set([token]);
  for (const group of SYNONYM_GROUPS) {
    if (group.some(g => g === token || (token.length >= 3 && g.startsWith(token)))) {
      group.forEach(g => out.add(g));
    }
  }
  return [...out];
}

function hasWordPrefix(text: string, term: string): boolean {
  return text.startsWith(term) || text.includes(" " + term);
}

/* Score of the best way one query word (with its synonyms) hits a service;
   0 = no hit. */
function scoreToken(ix: Indexed, alternatives: string[], token: string): number {
  let best = 0;
  for (const t of alternatives) {
    const exact = t === token;
    const w = exact ? 1 : 0.8; // a synonym counts a little less than the word typed
    if (ix.name.startsWith(t)) best = Math.max(best, 12 * w);
    else if (hasWordPrefix(ix.name, t)) best = Math.max(best, 10 * w);
    else if (t.length >= 2 && ix.name.includes(t)) best = Math.max(best, 7 * w);
    if (hasWordPrefix(ix.keywords, t)) best = Math.max(best, 6 * w);
    if (hasWordPrefix(ix.category, t)) best = Math.max(best, 4 * w);
    if (hasWordPrefix(ix.description, t)) best = Math.max(best, 4 * w);
    else if (t.length >= 3 && ix.description.includes(t)) best = Math.max(best, 2.5 * w);
    if (hasWordPrefix(ix.labels, t)) best = Math.max(best, 3 * w);
  }
  if (best === 0 && token.length >= 4) {
    // one typo, against name and keyword words only
    if (ix.nameWords.some(nw => withinOneEdit(token, nw.slice(0, token.length + 1)) || withinOneEdit(token, nw))) best = 5;
    else if (ix.keywordWords.some(kw => withinOneEdit(token, kw))) best = 3;
  }
  return best;
}

export interface PriceFilter { max?: number; min?: number }

/* Pulls "עד 1000" / "<1000" / "מעל 2000" / ">2000" out of the query. */
export function parsePriceFilter(query: string): { text: string; price: PriceFilter } {
  const price: PriceFilter = {};
  let text = query;
  const take = (re: RegExp, set: (n: number) => void) => {
    text = text.replace(re, (_m, n: string) => { set(Number(n.replace(/,/g, ""))); return " "; });
  };
  take(/(?:עד|מתחת\s*ל?-?|פחות\s*מ-?|<=?)\s*₪?\s*([\d,]+)\s*₪?/g, n => { price.max = n; });
  take(/(?:מעל|יותר\s*מ-?|לפחות|>=?)\s*₪?\s*([\d,]+)\s*₪?/g, n => { price.min = n; });
  return { text, price };
}

export interface SearchHit {
  service: CatalogService;
  score: number;
  /** normalized terms that matched — for highlighting */
  terms: string[];
}

export function searchServices(services: CatalogService[], query: string): SearchHit[] {
  const { text, price } = parsePriceFilter(query);
  const tokens = words(normalize(text));
  const idx = buildIndex(services);
  const inPrice = (s: CatalogService) =>
    (price.max === undefined || s.price <= price.max) && (price.min === undefined || s.price >= price.min);

  if (tokens.length === 0) {
    return idx.filter(ix => inPrice(ix.service)).map(ix => ({ service: ix.service, score: 0, terms: [] }));
  }
  const expanded = tokens.map(t => ({ token: t, alts: expand(t) }));
  const hits: SearchHit[] = [];
  for (const ix of idx) {
    if (!inPrice(ix.service)) continue;
    let total = 0;
    let ok = true;
    for (const { token, alts } of expanded) {
      const s = scoreToken(ix, alts, token);
      if (s === 0) { ok = false; break; }
      total += s;
    }
    if (!ok) continue;
    if (ix.service.role === "core") total += 0.5; // tie-break toward the main services
    hits.push({ service: ix.service, score: total, terms: expanded.flatMap(e => e.alts) });
  }
  return hits.sort((a, b) => b.score - a.score || a.service.sortOrder - b.service.sortOrder);
}

/* [start, end) ranges of `terms` inside `text` (merged), for <mark>. */
export function matchRanges(text: string, terms: string[]): [number, number][] {
  if (!terms.length) return [];
  const n = normalize(text);
  const ranges: [number, number][] = [];
  for (const t of terms) {
    if (t.length < 2) continue;
    let from = 0;
    for (;;) {
      const i = n.indexOf(t, from);
      if (i < 0) break;
      // only at a word start, so "ai" doesn't light up inside other words
      if (i === 0 || n[i - 1] === " ") ranges.push([i, i + t.length]);
      from = i + 1;
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}
