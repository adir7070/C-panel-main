/**
 * pdf-contract.service.js
 *
 * Assembles a signed service agreement PDF for a personal package.
 * Pages are PNG images from /pdf/pages/ combined with a dynamic pricing table.
 * Signature + signer name are overlaid on the last page (17_signature.png).
 *
 * Page inclusion rules:
 *   Fixed (always):  01_cover, 02_app_desc,
 *                    10_fixed, 14_coins (if pkg.coins>0),
 *                    15_terms_1, 16_terms_2, 17_signature,
 *                    00_social_content ("בלדום") — page 18, very last
 *   social_cmp:      03_social_cmp_1, 04_social_cmp_2, 05_social_cmp_3
 *   ad:              06_ad_campaign, 09_fb_ads
 *   web_cmp:         07_web_cmp
 *   social_ad:       08_social_ads
 *   lp:              12_lp
 *   variable (11):   both ad+web_cmp → 11c, web_cmp only → 11a, ad only → 11b
 *   Dynamic page:    PRICING TABLE (generated HTML, replaces static 13)
 */

"use strict";

const path  = require("path");
const fs    = require("fs");
const puppeteer = require("puppeteer");
const { downloadFileById } = require("./backblaze.service");

const PAGES_DIR = path.join(__dirname, "../pdf/pages");

// ─── helpers ──────────────────────────────────────────────────────────────────

// Populated before PDF generation with JPEG-compressed versions, then cleared.
const _jpegCache = new Map();

// Fetch a remote URL and return its content as a Buffer (no extra deps).
function _fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? require("https") : require("http");
    mod.get(url, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

function imgB64(filename) {
  if (_jpegCache.has(filename)) return _jpegCache.get(filename);
  const fpath = path.join(PAGES_DIR, filename);
  if (!fs.existsSync(fpath)) return null;
  const buf = fs.readFileSync(fpath);
  return `data:image/png;base64,${buf.toString("base64")}`;
}

// storageUrlMap: Map<fileName, backblazeUrl> — used to fetch files missing from local disk.
async function _warmJpegCache(storageUrlMap = new Map()) {
  const sharp = require("sharp");
  const localFiles = fs.readdirSync(PAGES_DIR).filter(f => f.endsWith(".png"));
  const localSet   = new Set(localFiles);

  // Files referenced in storageUrlMap but not present on local disk
  const remoteFiles = [...storageUrlMap.keys()].filter(f => !localSet.has(f));

  await Promise.all([
    ...localFiles.map(async f => {
      try {
        const buf = await sharp(path.join(PAGES_DIR, f))
          .jpeg({ quality: 85, mozjpeg: true })
          .toBuffer();
        _jpegCache.set(f, `data:image/jpeg;base64,${buf.toString("base64")}`);
      } catch { /* keep PNG fallback */ }
    }),
    ...remoteFiles.map(async f => {
      try {
        // Download via the AUTHENTICATED B2 SDK (which uses the correct download host)
        // rather than a plain GET on storageUrl. The stored b2_download_file_by_id URL
        // may carry the wrong cluster host and return 401; downloadFileById only needs
        // the fileId, so it works regardless of the host baked into the stored URL.
        const { buffer: pngBuf } = await downloadFileById(storageUrlMap.get(f));
        const jpegBuf = await sharp(pngBuf).jpeg({ quality: 85, mozjpeg: true }).toBuffer();
        _jpegCache.set(f, `data:image/jpeg;base64,${jpegBuf.toString("base64")}`);
      } catch { /* file unavailable — page will be silently skipped */ }
    }),
  ]);
}

function imgTag(filename) {
  const b64 = imgB64(filename);
  if (!b64) return "";
  return `<div class="page"><img src="${b64}" /></div>`;
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ─── pricing table HTML ───────────────────────────────────────────────────────

function buildPricingTable(pkg, catalogItems, coinPackageData = null) {
  const date = new Date().toLocaleDateString("he-IL", {
    year: "numeric", month: "long", day: "numeric",
  });

  /* Subscription packages (חבילת וובינר) are priced in their own currency
     (currencyCode 2 = USD) and bill the exact price — no VAT is added, and
     the ILS catalog unit prices are irrelevant to them. */
  const sym   = pkg.currencyCode === 2 ? "$" : "₪";
  const isSub = pkg.isSubscription === true;
  const money = n => `${sym}${Number(n || 0).toLocaleString("he-IL")}`;

  let lines = [];
  if (isSub) {
    const yearly = pkg.billingCycle === "yearly";
    if (yearly && pkg.monthlyPrice) {
      lines.push({
        label:    `${esc(pkg.name)} — מנוי שנתי (${money(pkg.monthlyPrice)} לחודש, בתשלום אחד)`,
        qty:      12,
        unit:     pkg.monthlyPrice,
        subtotal: pkg.finalPrice || pkg.monthlyPrice * 12,
      });
    } else {
      lines.push({
        label:    `${esc(pkg.name)} — מנוי חודשי מתחדש`,
        qty:      1,
        unit:     pkg.finalPrice || 0,
        subtotal: pkg.finalPrice || 0,
      });
    }
    // What the subscription includes — informational rows, no price
    for (const b of (pkg.bullets || [])) {
      lines.push({ label: esc(b), qty: 1, included: true });
    }
  } else {
    // Build line items — deduplicate by label
    const lineMap = new Map();
    for (const [key, qty] of Object.entries(pkg.items || {})) {
      if (!qty || qty <= 0) continue;
      const cat    = catalogItems.find(c => c.key === key);
      const label  = cat?.label ?? key;
      const unit   = cat?.unitPrice ?? 0;
      if (lineMap.has(label)) {
        const existing = lineMap.get(label);
        existing.qty      += qty;
        existing.subtotal += unit * qty;
      } else {
        lineMap.set(label, { label, qty, unit, subtotal: unit * qty });
      }
    }
    lines = [...lineMap.values()];

    // Coins row — price derived from basePrice − items total
    const itemsTotal = lines.reduce((s, l) => s + l.subtotal, 0);
    const coinsPrice = (pkg.basePrice || 0) - itemsTotal;
    if ((pkg.coins || 0) > 0 && coinsPrice > 0) {
      lines.push({ label: `${(pkg.coins).toLocaleString("he-IL")} מטבעות`, qty: 1, unit: coinsPrice, subtotal: coinsPrice });
    }

    // Extra coin package upsell row
    if (coinPackageData) {
      const cpPrice = coinPackageData.price || 0;
      lines.push({
        label:    `${(coinPackageData.coins || 0).toLocaleString("he-IL")} מטבעות נוספים — ${esc(coinPackageData.name || "")}`,
        qty:      1,
        unit:     cpPrice,
        subtotal: cpPrice,
        isExtra:  true,
      });
    }
  }

  // Discount row
  const basePrice    = pkg.basePrice   || 0;
  const discountPct  = pkg.discountPct || 0;
  const pkgFinal     = pkg.finalPrice  || basePrice;
  const coinExtra    = (!isSub && coinPackageData) ? (coinPackageData.price || 0) : 0;
  const finalPrice   = pkgFinal + coinExtra;
  const saved        = basePrice - pkgFinal;
  /* priceIncludesVat (חבילת דף נחיתה): the package price is final — VAT
     applies only to a coin add-on */
  const inclVat      = pkg.priceIncludesVat === true;
  const vat          = isSub ? 0
                     : inclVat ? Math.round(coinExtra * 0.18)
                     : Math.round(finalPrice * 0.18);
  const totalWithVat = finalPrice + vat;

  const rowsHtml = lines.map(l => l.included ? `
    <tr>
      <td class="service">${l.label}</td>
      <td class="center">—</td>
      <td class="money gray">—</td>
      <td class="money gray">כלול</td>
    </tr>` : `
    <tr${l.isExtra ? ' style="background:#FFF9E6"' : ""}>
      <td class="service">${l.label}</td>
      <td class="center">${l.qty}</td>
      <td class="money gray">${money(l.unit)}</td>
      <td class="money"${l.isExtra ? ' style="color:#F59E0B"' : ""}>${money(l.subtotal)}</td>
    </tr>`).join("");

  const discountRow = discountPct > 0 ? `
    <tr class="discount-row">
      <td colspan="3" class="service green">הנחה ${discountPct}%</td>
      <td class="money green">−${money(saved)}</td>
    </tr>` : "";

  const vatRows = isSub ? `
      <div class="pt-total-row" style="font-size:13px;opacity:0.75">
        <span class="pt-total-label">${pkg.billingCycle === "yearly" ? "חיוב שנתי אחד — המחיר סופי" : "חיוב חודשי מתחדש — המחיר סופי"}</span>
        <span id="pt-final-val">${money(finalPrice)}</span>
      </div>` : inclVat ? `
      <div class="pt-total-row" style="font-size:13px;opacity:0.75">
        <span class="pt-total-label">מחיר החבילה — כולל מע"מ</span>
        <span id="pt-final-val">${money(pkgFinal)}</span>
      </div>
      ${coinExtra > 0 ? `
      <div class="pt-total-row" style="font-size:13px;opacity:0.75">
        <span class="pt-total-label">מע"מ 18% (על תוספת מטבעות)</span>
        <span id="pt-vat-val">${money(vat)}</span>
      </div>` : ""}` : `
      <div class="pt-total-row" style="font-size:13px;opacity:0.75">
        <span class="pt-total-label">לפני מע"מ</span>
        <span id="pt-final-val">${money(finalPrice)}</span>
      </div>
      <div class="pt-total-row" style="font-size:13px;opacity:0.75">
        <span class="pt-total-label">מע"מ 18%</span>
        <span id="pt-vat-val">${money(vat)}</span>
      </div>`;

  return `
  <div class="pricing-page" data-base-final="${finalPrice}">
    <div class="pt-header">
      <div class="pt-logo">K</div>
      <div>
        <div class="pt-title">פירוט חיוב</div>
        <div class="pt-subtitle">${esc(pkg.name)} · ${date}</div>
      </div>
    </div>

    <table class="pt-table">
      <thead>
        <tr>
          <th>שירות</th>
          <th>כמות</th>
          <th>מחיר יחידה</th>
          <th>סה"כ</th>
        </tr>
      </thead>
      <tbody id="pt-tbody">
        ${rowsHtml}
        ${discountRow}
      </tbody>
    </table>

    <div class="pt-total-box">
      ${discountPct > 0 ? `<div class="pt-original">מחיר לפני הנחה: <span class="strike">${money(basePrice)}</span></div>` : ""}
      ${vatRows}
      <div class="pt-total-row">
        <span class="pt-total-label">סה"כ לתשלום</span>
        <span class="pt-total-amount" id="pt-total-val">${money(totalWithVat)}</span>
      </div>
    </div>
  </div>`;
}

// ─── signature overlay ────────────────────────────────────────────────────────
// Field positions as % of the page container (1414×2000 image = 100%)
// Tune these values to align precisely with 17_signature.png form fields.
const SIG = {
  // Row Y positions (top %)
  row1: 82.5,    // שם מזמין / טלפון
  row2: 87.5,    // ע.מ / דואל
  row3: 92.5,    // תאריך / חתימה
  sigImgTop: 90.0, sigImgH: 6.5,  // signature image bounds

  // Right column (שם, ע.מ, תאריך) — right-side fields in RTL form
  rcLeft: "51%", rcW: "26%",

  // Left column (טלפון, דואל, חתימה) — left-side fields in RTL form
  lcLeft: "5%",  lcW: "28%",

  fontSize: "11px",
  fontWeight: "600",
  color: "#111",
};

function sigField(top, left, width, value, align = "center", extra = "") {
  return `<div style="position:absolute;top:${top}%;left:${left};width:${width};`
    + `font-size:${SIG.fontSize};font-weight:${SIG.fontWeight};color:${SIG.color};`
    + `line-height:1;text-align:${align};white-space:nowrap;overflow:hidden;${extra}">`
    + `${esc(String(value ?? ""))}</div>`;
}

function buildSignaturePage(signerName, signatureBase64, pageName, phone, clientEmail, clientVatId) {
  const b64 = imgB64("17_signature.png");
  const date = new Date().toLocaleDateString("he-IL", {
    year: "numeric", month: "long", day: "numeric",
  });

  return `
  <div class="page sig-page" style="position:relative">
    ${b64 ? `<img class="bg-img" src="${b64}" />` : ""}

    ${sigField(SIG.row1, SIG.rcLeft, SIG.rcW, signerName ? `${pageName} / ${signerName}` : pageName, "right")}
    ${sigField(SIG.row1, SIG.lcLeft, SIG.lcW, phone,          "center")}

    ${sigField(SIG.row2, SIG.rcLeft, SIG.rcW, clientVatId || "", "left")}
    ${sigField(SIG.row2, SIG.lcLeft, SIG.lcW, clientEmail || "", "left")}

    ${sigField(SIG.row3, SIG.rcLeft, SIG.rcW, date,           "right")}

    <div style="position:absolute;top:${SIG.sigImgTop}%;left:${SIG.lcLeft};width:${SIG.lcW};height:${SIG.sigImgH}%">
      <img src="${signatureBase64}" style="height:100%;max-width:100%;object-fit:contain;object-position:right" />
    </div>
  </div>`;
}

// ─── page order builder ───────────────────────────────────────────────────────

// Pages that ALWAYS appear regardless of products — rules can never add these.
const ALWAYS_PAGES = new Set(["01_cover.png"]);

// Fixed closing pages appended to the VERY END of every contract (after the signature),
// in this exact order. Served from /pdf-pages (server disk / B2).
const TAIL_PAGES = ["end_1.png", "end_2.png", "end_3.png", "end_4.png", "end_5.png"];

// Fixed page(s) inserted right AFTER the cover on every contract.
const AFTER_COVER_PAGES = ["after_cover.png"];

// Build rule-based additional pages, skipping anything already queued.
// KEY LOGIC: "most specific wins" — if rule A's conditions are a strict subset of rule B's
// conditions, and both match, rule A is suppressed. This prevents single-product rules
// (web_cmp → permission_leads.png) from firing alongside a more specific combined rule
// (web_cmp + social_cmp → permission_leads_social.png) that already covers the intent.
// Aliases from ALL key formats (old normalized C-panel format, camelCase, snake_case)
// to the rule condition keys. Without this, packages built with different product
// key conventions never match any rule and only the cover page appears.
function normalizeItems(items) {
  const out = { ...items };
  const setIfMissing = (target, sources) => {
    if (Number(out[target] ?? 0) > 0) return;
    for (const s of sources) {
      const v = Number(out[s] ?? 0);
      if (v > 0) { out[target] = v; return; }
    }
  };
  setIfMissing("ad",         ["paidAds"]);
  setIfMissing("lp",         ["lps"]);
  setIfMissing("social_ad",  ["organicAds", "socialAd"]);
  setIfMissing("ad_lead_10", ["campaignLeads", "campaign_leads"]);
  setIfMissing("ad_10",      ["campaignTraffic", "campaign_traffic"]);
  return out;
}

function applyRules(rawItems, rules, alreadyAdded = new Set()) {
  const items = normalizeItems(rawItems);
  const has = key => Number(items[key] ?? 0) > 0;

  // 1. Find every rule whose conditions are fully satisfied
  const matching = (rules || []).filter(
    r => (r.conditions || []).length > 0 && (r.conditions || []).every(k => has(k))
  );

  // 2. Pre-compute condition sets for subset checks
  const condSets = matching.map(r => new Set(r.conditions));

  const seen = new Set([...ALWAYS_PAGES, ...alreadyAdded]);
  const pages = [];

  for (let i = 0; i < matching.length; i++) {
    const mySet = condSets[i];

    // 3. Suppress this rule if ANY other matching rule is a STRICT superset of its conditions.
    //    "Strict superset" = other has MORE conditions AND contains all of mine.
    const superseded = condSets.some((otherSet, j) => {
      if (j === i) return false;
      if (otherSet.size <= mySet.size) return false;          // must be strictly larger
      return [...mySet].every(k => otherSet.has(k));          // mine ⊂ other
    });

    if (superseded) continue;

    for (const p of (matching[i].pages || [])) {
      if (!seen.has(p)) { seen.add(p); pages.push(p); }
    }
  }

  return pages;
}

function buildPageOrder(pkg, signerName, signatureBase64, pageName, phone, catalogItems, clientEmail, clientVatId, coinPackageData = null, rules = [], alwaysPages = []) {
  const items = normalizeItems(pkg.items || {});

  // alwaysPages from DB (sorted by admin), split into head (before rules) and tail (signature-like)
  // Convention: pages with "signature" in the name go to the end; everything else goes to the start.
  const alwaysHead = alwaysPages.filter(p => !/signature/i.test(p));
  const alwaysTail = alwaysPages.filter(p =>  /signature/i.test(p));

  // Fallback to hardcoded defaults if DB has no always pages defined yet
  const headPages = alwaysHead.length > 0 ? alwaysHead : ["01_cover.png"];
  const tailPages = alwaysTail.length > 0 ? alwaysTail : [];

  const alreadyUsed = new Set([...headPages, ...tailPages]);

  const EARLY_KEYS = new Set(["ad_10","ad_lead_10","social_ad_10","web_cmp","lead_cmp","social_cmp","ad","social_ad","organicAds"]);
  const earlyRules = (rules || []).filter(r => r.conditions && r.conditions.every(k => EARLY_KEYS.has(k)));
  const lateRules  = (rules || []).filter(r => r.conditions && !r.conditions.every(k => EARLY_KEYS.has(k)));

  const earlyPages = applyRules(items, earlyRules, new Set(alreadyUsed));
  const latePages  = applyRules(items, lateRules,  new Set([...alreadyUsed, ...earlyPages]));

  return [
    ...headPages.map(p => imgTag(p)),
    ...AFTER_COVER_PAGES.map(p => imgTag(p)),
    ...earlyPages.map(p => imgTag(p)),
    ...latePages.map(p => imgTag(p)),
    buildPricingTable(pkg, catalogItems, coinPackageData),
    buildSignaturePage(signerName, signatureBase64, pageName, phone, clientEmail, clientVatId),
    ...tailPages.map(p => imgTag(p)),
    ...TAIL_PAGES.map(p => imgTag(p)),
  ].filter(Boolean).join("\n");
}

// ─── full HTML ────────────────────────────────────────────────────────────────

function buildContractHtml(pkg, signerName, signatureBase64, pageName, phone, catalogItems, clientEmail, clientVatId, coinPackageData = null, rules = [], alwaysPages = []) {
  const pages = buildPageOrder(pkg, signerName, signatureBase64, pageName, phone, catalogItems, clientEmail, clientVatId, coinPackageData, rules, alwaysPages);

  return `<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }

  body { font-family: 'Heebo', Arial, sans-serif; direction: rtl; background: #fff; }

  /* ── Image pages ── */
  .page {
    width: 210mm; height: 297mm;
    page-break-after: always;
    overflow: hidden;
    position: relative;
    display: block;
  }
  .page:last-child { page-break-after: auto; }
  .page > img { width: 100%; height: 100%; object-fit: fill; display: block; }

  /* ── Signature overlay ── */
  .sig-page { position: relative; }
  .bg-img   { position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: fill; z-index: 0; }
  .sig-overlay {
    position: absolute;
    bottom: 28mm;
    left: 15mm;
    right: 15mm;
    z-index: 10;
    background: rgba(255,255,255,0.92);
    border-radius: 8px;
    padding: 10px 14px;
    border: 1px solid #dde0f0;
  }
  .sig-field-row {
    display: flex;
    flex-direction: row-reverse;
    align-items: center;
    gap: 8px;
    padding: 5px 0;
    border-bottom: 1px solid #f0f0f8;
  }
  .sig-field-row:last-child { border-bottom: none; }
  .sig-field-lbl { font-size: 11px; font-weight: 600; color: #0000B2; min-width: 80px; text-align: right; }
  .sig-field-val { font-size: 12px; color: #222; flex: 1; text-align: right; }
  .sig-draw-row  { align-items: flex-start; padding-top: 8px; }
  .sig-draw      { height: 50px; max-width: 200px; object-fit: contain; object-position: right; }

  /* ── Pricing table page ── */
  .pricing-page {
    width: 210mm; height: 297mm;
    page-break-after: always;
    padding: 20mm 15mm;
    display: flex;
    flex-direction: column;
    gap: 16px;
    background: #fff;
  }
  .pt-header { display: flex; align-items: center; gap: 16px; margin-bottom: 8px; }
  .pt-logo {
    width: 56px; height: 56px; border-radius: 50%;
    background: linear-gradient(135deg, #0000B2, #0088FF);
    color: #fff; font-size: 28px; font-weight: 800;
    display: flex; align-items: center; justify-content: center;
  }
  .pt-title    { font-size: 26px; font-weight: 800; color: #0000B2; }
  .pt-subtitle { font-size: 13px; color: #888; margin-top: 2px; }

  .pt-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .pt-table thead tr { background: #0000B2; color: #fff; }
  .pt-table th { padding: 10px 12px; font-weight: 600; text-align: right; }
  .pt-table td { padding: 10px 12px; border-bottom: 1px solid #eef; text-align: right; }
  .pt-table tbody tr:nth-child(even) { background: #f8f9ff; }
  .discount-row td { color: #10B981 !important; font-weight: 700; }

  td.money  { font-weight: 700; color: #0000B2; }
  td.gray   { color: #888 !important; font-weight: 400 !important; }
  td.center { text-align: center; }
  td.service{ font-weight: 500; }
  td.green  { color: #10B981 !important; }
  .strike   { text-decoration: line-through; color: #aaa; }

  .pt-total-box {
    margin-top: auto;
    border: 2px solid #0000B2;
    border-radius: 12px;
    padding: 16px 20px;
    background: #f0f4ff;
  }
  .pt-original   { font-size: 13px; color: #888; margin-bottom: 8px; text-align: right; }
  .pt-total-row  { display: flex; justify-content: space-between; align-items: center; flex-direction: row-reverse; }
  .pt-total-label{ font-size: 16px; font-weight: 700; color: #0000B2; }
  .pt-total-amount{ font-size: 28px; font-weight: 800; color: #0000B2; }

  .pt-coins {
    background: #FEF3C7;
    border: 1px solid #F59E0B;
    border-radius: 8px;
    padding: 8px 14px;
    font-size: 13px;
    font-weight: 600;
    color: #92400E;
    text-align: center;
  }
</style>
</head>
<body>
${pages}
</body>
</html>`;
}

// ─── coin package selector (shown in contract when pkg.coins===0 and nothing selected yet) ───
// Selecting a coin card adds its price to the existing contract total (DOM update).
// A combined "Pay" button charges package + selected coins in one Cardcom session.

function buildCoinSelector(coinPackages, pkgId, phone, baseUrl, pkgFinalPrice, pendingCoinKey, baseIncludesVat = false) {
  if (!coinPackages || coinPackages.length === 0) return "";

  const baseFinal   = pkgFinalPrice || 0;
  /* baseIncludesVat (חבילת דף נחיתה): the package price is final — VAT is
     charged only on the coin add-on */
  const baseVat     = baseIncludesVat ? 0 : Math.round(baseFinal * 0.18);
  const baseTotal   = baseFinal + baseVat;

  const cards = coinPackages
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    .map(cp => {
      const price = cp.price || 0;
      const coins = cp.coins || 0;
      const name  = esc(cp.name || "");
      const key   = esc(cp.key || "");
      return `
    <div class="cs-card" data-key="${key}" data-price="${price}" data-coins="${coins}" data-name="${name}" onclick="selectCoinPkg(this)">
      <div class="cs-card-name">${name}</div>
      <div class="cs-card-coins">🪙 ${coins.toLocaleString("he-IL")} מטבעות</div>
      <div class="cs-card-price">+₪${price.toLocaleString("he-IL")} <span class="cs-card-incvat">לפני מע"מ</span></div>
      <button class="cs-card-btn" type="button">בחר</button>
    </div>`;
    }).join("");

  return `
<div class="cs-section">
  <div class="cs-header">
    <span class="cs-icon">🪙</span>
    <div>
      <div class="cs-title">הוסף מטבעות לחבילה שלך</div>
      <div class="cs-subtitle">המטבעות ישמשו ליצירת תוכן AI — מודעות, דפי נחיתה ועוד</div>
    </div>
  </div>

  <div class="cs-cards">${cards}</div>

  <div class="cs-pay-box">
    <div class="cs-pay-row">
      <span class="cs-pay-lbl">חבילת שירות</span>
      <span class="cs-pay-val">₪${baseFinal.toLocaleString("he-IL")}</span>
    </div>
    <div class="cs-pay-row" id="cs-coins-row" style="display:none">
      <span class="cs-pay-lbl" id="cs-coins-lbl">מטבעות</span>
      <span class="cs-pay-val cs-coins-price" id="cs-coins-val">₪0</span>
    </div>
    <div class="cs-pay-row cs-pay-vat-row">
      <span class="cs-pay-lbl">מע"מ 18%</span>
      <span class="cs-pay-val" id="cs-summary-vat">₪${baseVat.toLocaleString("he-IL")}</span>
    </div>
    <div class="cs-pay-divider"></div>
    <div class="cs-pay-row cs-pay-total-row">
      <span class="cs-pay-lbl cs-pay-total-lbl">סה"כ לתשלום</span>
      <span class="cs-pay-val cs-pay-total-amt" id="cs-summary-total">₪${baseTotal.toLocaleString("he-IL")}</span>
    </div>
    <button class="cs-pay-btn" id="cs-pay-btn" onclick="openContractPayment()">לתשלום →</button>
  </div>

  <div id="cs-iframe-overlay" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:9999;align-items:center;justify-content:center">
    <div style="background:#fff;border-radius:16px;width:min(520px,95vw);height:min(620px,92vh);display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,0.3)">
      <div style="display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-bottom:1px solid #eee;direction:rtl">
        <span style="font-weight:700;font-size:16px;color:#0000B2">תשלום מאובטח</span>
        <button onclick="closeCoinOverlay()" style="background:none;border:none;font-size:22px;cursor:pointer;color:#888;line-height:1">×</button>
      </div>
      <iframe id="cs-iframe" src="" style="flex:1;border:none;width:100%"></iframe>
    </div>
  </div>
</div>

<style>
.cs-section{max-width:595px;margin:0 auto 8px;background:#fff;padding:20px 24px 28px;direction:rtl}
.cs-header{display:flex;align-items:center;gap:14px;margin-bottom:18px}
.cs-icon{font-size:36px}
.cs-title{font-size:20px;font-weight:800;color:#0000B2}
.cs-subtitle{font-size:12px;color:#888;margin-top:2px}
.cs-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(145px,1fr));gap:12px;margin-bottom:22px}
.cs-card{border:2px solid #e5e7eb;border-radius:12px;padding:16px 12px;text-align:center;cursor:pointer;transition:all .2s;background:#fff}
.cs-card:hover{border-color:#0000B2;box-shadow:0 4px 16px rgba(0,0,180,.1)}
.cs-card.selected{border-color:#0000B2;background:#f0f4ff}
.cs-card-name{font-size:13px;font-weight:700;color:#111;margin-bottom:6px}
.cs-card-coins{font-size:15px;font-weight:800;color:#0000B2;margin-bottom:8px}
.cs-card-price{font-size:16px;font-weight:800;color:#374151;margin-bottom:4px}
.cs-card-incvat{font-size:10px;font-weight:400;color:#888}
.cs-card-btn{background:#0000B2;color:#fff;border:none;border-radius:8px;padding:7px 16px;font-size:13px;font-weight:700;cursor:pointer;width:100%;margin-top:8px;transition:background .2s}
.cs-card-btn:hover,.cs-card.selected .cs-card-btn{background:#0000cc}
.cs-pay-box{background:#f8faff;border:2px solid #dde3f8;border-radius:14px;padding:18px 20px;margin-top:4px}
.cs-pay-row{display:flex;justify-content:space-between;align-items:center;padding:5px 0;direction:rtl}
.cs-pay-lbl{font-size:13px;color:#555;font-weight:500}
.cs-pay-val{font-size:14px;font-weight:700;color:#111}
.cs-coins-price{color:#F59E0B}
.cs-pay-vat-row .cs-pay-lbl,.cs-pay-vat-row .cs-pay-val{font-size:12px;color:#888;font-weight:400}
.cs-pay-divider{height:1px;background:#dde3f8;margin:8px 0}
.cs-pay-total-lbl{font-size:15px;font-weight:800;color:#0000B2}
.cs-pay-total-amt{font-size:20px;font-weight:800;color:#0000B2}
.cs-pay-btn{width:100%;margin-top:16px;background:linear-gradient(135deg,#0000B2,#0055cc);color:#fff;border:none;border-radius:10px;padding:14px;font-size:16px;font-weight:800;cursor:pointer;transition:opacity .2s;letter-spacing:.3px}
.cs-pay-btn:hover{opacity:.9}
</style>

<script>
var CS_PHONE = '${esc(phone)}';
var CS_PKG_ID = '${esc(String(pkgId))}';
var CS_BASE_FINAL = ${baseFinal};
var CS_INCL_VAT = ${baseIncludesVat ? "true" : "false"};
var CS_SELECTED_KEY = null;

function selectCoinPkg(cardEl, skipSave) {
  var key   = cardEl.dataset.key;
  var price = parseInt(cardEl.dataset.price, 10);
  var coins = parseInt(cardEl.dataset.coins, 10);
  var name  = cardEl.dataset.name;

  // Deselect all, select this one
  document.querySelectorAll('.cs-card').forEach(function(c){ c.classList.remove('selected'); });
  cardEl.classList.add('selected');
  CS_SELECTED_KEY = key;

  // Save selection to backend so the payment (via app or our button) includes it
  if (!skipSave) {
    fetch('/api/packages/contract-save-coin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: CS_PHONE, personalPackageId: CS_PKG_ID, coinPackageId: key })
    }).catch(function(){});
  }

  // Update coin row in pay summary
  var coinsRow = document.getElementById('cs-coins-row');
  coinsRow.style.display = '';
  document.getElementById('cs-coins-lbl').textContent = coins.toLocaleString() + ' מטבעות';
  document.getElementById('cs-coins-val').textContent = '+₪' + price.toLocaleString('he-IL');

  // Recalculate totals — when the base price already includes VAT, VAT is
  // added only on the coin add-on
  var newFinal = CS_BASE_FINAL + price;
  var newVat   = CS_INCL_VAT ? Math.round(price * 0.18) : Math.round(newFinal * 0.18);
  var newTotal = newFinal + newVat;

  document.getElementById('cs-summary-vat').textContent   = '₪' + newVat.toLocaleString('he-IL');
  document.getElementById('cs-summary-total').textContent = '₪' + newTotal.toLocaleString('he-IL');

  // Update the pricing table totals above (if present)
  var tbody = document.getElementById('pt-tbody');
  if (tbody) {
    var existing = document.getElementById('cs-pt-row');
    if (existing) existing.remove();
    var tr = document.createElement('tr');
    tr.id = 'cs-pt-row';
    tr.style.background = '#FFF9E6';
    tr.innerHTML = '<td class="service">' + coins.toLocaleString() + ' מטבעות נוספים — ' + name + '</td>'
      + '<td class="center">1</td>'
      + '<td class="money gray">₪' + price.toLocaleString('he-IL') + '</td>'
      + '<td class="money" style="color:#F59E0B">₪' + price.toLocaleString('he-IL') + '</td>';
    tbody.appendChild(tr);

    var ptFinal = document.getElementById('pt-final-val');
    var ptVat   = document.getElementById('pt-vat-val');
    var ptTotal = document.getElementById('pt-total-val');
    // inclVat: pt-final-val shows the package-only price ("כולל מע"מ") — leave it
    if (ptFinal && !CS_INCL_VAT) ptFinal.textContent = '₪' + newFinal.toLocaleString('he-IL');
    if (ptVat)   ptVat.textContent   = '₪' + newVat.toLocaleString('he-IL');
    if (ptTotal) ptTotal.textContent = '₪' + newTotal.toLocaleString('he-IL');
  }
}

function openContractPayment() {
  fetch('/api/packages/contract-pay', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      phone: CS_PHONE,
      personalPackageId: CS_PKG_ID,
      coinPackageId: CS_SELECTED_KEY || undefined
    })
  })
  .then(function(r){ return r.json(); })
  .then(function(data){
    if (!data.iframeUrl) { alert(data.error || 'שגיאה ביצירת דף תשלום'); return; }
    document.getElementById('cs-iframe').src = data.iframeUrl;
    document.getElementById('cs-iframe-overlay').style.display = 'flex';
  })
  .catch(function(){ alert('שגיאת רשת, נסה שוב'); });
}

function closeCoinOverlay() {
  document.getElementById('cs-iframe-overlay').style.display = 'none';
  document.getElementById('cs-iframe').src = '';
}

window.addEventListener('message', function(e) {
  if (e.data && e.data.type === 'CONTRACT_PAID') {
    closeCoinOverlay();
    window.location.reload();
  }
});

// Auto-select any previously saved coin selection (restores state after page reload)
var CS_PRESELECTED = '${esc(pendingCoinKey || "")}';
if (CS_PRESELECTED) {
  var preCard = document.querySelector('.cs-card[data-key="' + CS_PRESELECTED + '"]');
  if (preCard) selectCoinPkg(preCard, true);
}
</script>`;
}  // end buildCoinSelector

// ─── main export ──────────────────────────────────────────────────────────────

/**
 * Generates the signed contract PDF as a Buffer.
 * @param {object} pkg             - personal_packages document
 * @param {string} signerName      - full name typed by signer
 * @param {string} signatureBase64 - data:image/png;base64,... from canvas
 * @param {string} pageName        - business name
 * @param {string} phone           - client phone
 * @param {Array}  catalogItems    - from cpanel-products.service listAll()
 * @returns {Promise<Buffer>}
 */
async function generateContractPdf(pkg, signerName, signatureBase64, pageName, phone, catalogItems, clientEmail, clientVatId, coinPackageData = null, rules = [], storageUrlMap = new Map(), alwaysPages = []) {
  // Pre-convert all PNG pages to JPEG 85 in parallel — reduces PDF size ~75%.
  // storageUrlMap provides Backblaze URLs for files that may not exist on this server's disk.
  await _warmJpegCache(storageUrlMap);

  const html = buildContractHtml(pkg, signerName, signatureBase64, pageName, phone, catalogItems, clientEmail, clientVatId, coinPackageData, rules, alwaysPages);
  _jpegCache.clear();

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 15000 });
    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    return pdfBuffer;
  } finally {
    await browser.close();
  }
}

// ─── HTML viewer (for WebView in app) ────────────────────────────────────────

/**
 * Builds the contract HTML using remote image URLs (served from /pdf-pages/).
 * Much lighter than the PDF version — no base64 embeds.
 * Used for in-app preview in the WebView.
 *
 * @param {object} pkg
 * @param {string} baseUrl   - e.g. "https://api.iconiqmedia.co.il"
 * @param {Array}  catalogItems
 * @param {string} [signerName]      - if provided, shows signature overlay
 * @param {string} [signatureBase64] - data:image/png;base64,...
 * @param {string} [pageName]
 * @param {string} [phone]
 */
function buildContractViewHtml(pkg, baseUrl, catalogItems, signerName, signatureBase64, pageName, phone, clientEmail, clientVatId, coinPackageData = null, rules = [], selectorCoinPackages = [], storageUrlMap = new Map(), alwaysPages = []) {
  const items  = normalizeItems(pkg.items || {});
  const has    = key => Number(items[key] ?? 0) > 0;

  const hasWebsite = ["lp", "katlog_web", "sale_site"].some(k => has(k));

  // Always serve images through the /pdf-pages route. That route returns the file from
  // local disk when present, otherwise proxies it from Backblaze using the AUTHENTICATED
  // client (correct host). We must NOT embed the raw storageUrl (b2_download_file_by_id)
  // directly: a browser fetch of that URL fails with 401 when the stored cluster host is
  // wrong — which is exactly why the contract images failed to load.
  const imgSrc  = name => `${baseUrl}/pdf-pages/${name}`;
  const img     = name => `<div class="page"><img src="${imgSrc(name)}" loading="lazy" /></div>`;
  const imgLink = name => `<div class="page"><a href="${baseUrl}/agent/works-catalog" target="_blank" rel="noopener" style="display:block;line-height:0"><img src="${imgSrc(name)}" loading="lazy" style="width:100%;height:auto;display:block" /></a></div>`;

  // Head always pages (non-signature), fallback to cover if none defined in DB
  const alwaysHead = (alwaysPages || []).filter(p => !/signature/i.test(p));
  const headPages  = alwaysHead.length > 0 ? alwaysHead : ["01_cover.png"];

  const alreadyUsed = new Set(headPages);

  const EARLY_KEYS = new Set(["ad_10","ad_lead_10","social_ad_10","web_cmp","lead_cmp","social_cmp","ad","social_ad","organicAds"]);
  const earlyRules = (rules || []).filter(r => r.conditions && r.conditions.every(k => EARLY_KEYS.has(k)));
  const lateRules  = (rules || []).filter(r => r.conditions && !r.conditions.every(k => EARLY_KEYS.has(k)));

  const earlyPages = applyRules(items, earlyRules, new Set(alreadyUsed));
  const latePages  = applyRules(items, lateRules, new Set([...alreadyUsed, ...earlyPages]));

  // Signature page — with precisely-positioned overlay if signed
  const sf = (top, left, width, value, align = "center", extra = "") =>
    `<div style="position:absolute;top:${top}%;left:${left};width:${width};`
    + `font-size:${SIG.fontSize};font-weight:${SIG.fontWeight};color:${SIG.color};`
    + `line-height:1;text-align:${align};white-space:nowrap;overflow:hidden;${extra}">`
    + `${esc(String(value ?? ""))}</div>`;

  const date = new Date().toLocaleDateString("he-IL", { year: "numeric", month: "long", day: "numeric" });

  const sigOverlay = signatureBase64 ? `
    <div class="page sig-page" style="position:relative;line-height:0">
      <img src="${baseUrl}/pdf-pages/17_signature.png" style="width:100%;height:auto;display:block" />
      ${sf(SIG.row1, SIG.rcLeft, SIG.rcW, signerName ? `${pageName} / ${signerName}` : (pageName || ""), "right")}
      ${sf(SIG.row1, SIG.lcLeft, SIG.lcW, phone || "",          "center")}
      ${sf(SIG.row2, SIG.rcLeft, SIG.rcW, clientVatId || "",    "left")}
      ${sf(SIG.row2, SIG.lcLeft, SIG.lcW, clientEmail || "",    "left")}
      ${sf(SIG.row3, SIG.rcLeft, SIG.rcW, date,                 "right")}
      <div style="position:absolute;top:${SIG.sigImgTop}%;left:${SIG.lcLeft};width:${SIG.lcW};height:${SIG.sigImgH}%">
        <img src="${signatureBase64}" style="height:100%;max-width:100%;object-fit:contain;object-position:right" />
      </div>
    </div>` : img("17_signature.png");

  const pages = [
    ...headPages.map(p => img(p)),
    ...AFTER_COVER_PAGES.map(p => img(p)),
    ...earlyPages.map(p => img(p)),
    ...latePages.map(p => (hasWebsite ? imgLink(p) : img(p))),
    buildPricingTable(pkg, catalogItems, coinPackageData),
    /* coin upsell is ILS+VAT math (hardcoded ₪) — only show it on a plain ILS
       package that has no coins yet. Skip for subscriptions, USD packages
       (e.g. the $2,880 one-time), or any package that already includes coins. */
    (pkg.isSubscription === true || (pkg.coins || 0) > 0 || (pkg.currencyCode ?? 1) !== 1)
      ? ""
      : buildCoinSelector(selectorCoinPackages, pkg._id, phone, baseUrl, pkg.finalPrice || pkg.basePrice || 0, pkg.pendingContractCoin?.key || "", pkg.priceIncludesVat === true),
    sigOverlay,
    ...TAIL_PAGES.map(p => img(p)),
  ].filter(Boolean).join("\n");

  return `<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#e8e8e8;font-family:Arial,sans-serif;direction:rtl}
  .page{width:100%;max-width:595px;margin:0 auto 8px;background:#fff;display:block;line-height:0}
  .page>img{width:100%;height:auto;display:block}
  .sfr{display:flex;flex-direction:row-reverse;align-items:center;padding:4px 0;border-bottom:1px solid #f0f0f8}
  .sfr:last-child{border-bottom:none}
  /* pricing table inside .page */
  .pricing-page{width:100%;max-width:595px;margin:0 auto 8px;background:#fff;padding:14px 24px 24px;direction:rtl}
  .pt-header{display:flex;align-items:center;gap:14px;margin-bottom:14px}
  .pt-logo{width:48px;height:48px;border-radius:50%;background:linear-gradient(135deg,#0000B2,#0088FF);color:#fff;font-size:24px;font-weight:800;display:flex;align-items:center;justify-content:center}
  .pt-title{font-size:22px;font-weight:800;color:#0000B2}
  .pt-subtitle{font-size:12px;color:#888;margin-top:2px}
  .pt-table{width:100%;border-collapse:collapse;font-size:13px;margin-bottom:20px}
  .pt-table thead tr{background:#0000B2;color:#fff}
  .pt-table th{padding:9px 10px;font-weight:600;text-align:right}
  .pt-table td{padding:9px 10px;border-bottom:1px solid #eef;text-align:right}
  .pt-table tbody tr:nth-child(even){background:#f8f9ff}
  td.money{font-weight:700;color:#0000B2} td.gray{color:#888!important;font-weight:400!important}
  td.center{text-align:center} td.green{color:#10B981!important} .strike{text-decoration:line-through;color:#aaa}
  .discount-row td{color:#10B981!important;font-weight:700}
  .pt-total-box{border:2px solid #0000B2;border-radius:12px;padding:14px 18px;background:#f0f4ff}
  .pt-original{font-size:13px;color:#888;margin-bottom:8px;text-align:right}
  .pt-total-row{display:flex;justify-content:space-between;align-items:center;flex-direction:row-reverse}
  .pt-total-label{font-size:15px;font-weight:700;color:#0000B2}
  .pt-total-amount{font-size:26px;font-weight:800;color:#0000B2}
  .pt-coins{background:#FEF3C7;border:1px solid #F59E0B;border-radius:8px;padding:8px 14px;font-size:13px;font-weight:600;color:#92400E;text-align:center;margin-top:14px}
</style>
</head>
<body>
${pages}
</body>
</html>`;
}

module.exports = { generateContractPdf, buildContractViewHtml };
