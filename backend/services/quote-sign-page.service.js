/* The public signing page — /sign/<token>. Built for a phone first:
   three short steps (the quote → your details → sign) with one big sticky
   button, a finger-friendly signature pad with a full-screen mode, and the
   full agreement in a sheet. Vanilla HTML/CSS/JS so it loads fast on a
   phone without the panel bundle. Server side: routes/quote-sign.routes.js. */

const { logo, COMPANY } = require("./quote-document.service");

const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fm = n => Math.round(Number(n) || 0).toLocaleString("en-US") + " ₪";
const dfmt = iso => { if (!iso) return ""; const [y, m, d] = String(iso).split("-"); return `${d}.${m}.${y}`; };
const json = v => JSON.stringify(v).replace(/</g, "\\u003c");

const CSS = `
:root{--navy:#0C2347;--teal:#0B7F8C;--teal2:#12A5B5;--yellow:#F2B63C;--ink:#16233A;--muted:#54627A;--line:#D9E2E8;--bg:#F2F5F8;--red:#B4472B;--green:#15803D}
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-text-size-adjust:100%}
body{font-family:'Heebo','Rubik',Arial,sans-serif;background:var(--bg);color:var(--ink);font-size:16px;line-height:1.55;padding-bottom:calc(104px + env(safe-area-inset-bottom));-webkit-tap-highlight-color:transparent}
h1,h2,h3,.num,.btn{font-family:'Rubik','Heebo',Arial,sans-serif}
[hidden]{display:none!important}
.stripe{height:5px;display:flex}.stripe i{flex:1}
.top{background:#fff;border-bottom:1px solid var(--line)}
.top .in{max-width:560px;margin:0 auto;padding:10px 16px;display:flex;align-items:center;gap:10px}
.top img{height:38px;width:auto}
.top .co{font-weight:800;color:var(--navy);font-size:15px;line-height:1.2}
.top .co small{display:block;font-weight:500;color:var(--muted);font-size:12px}
.top .no{margin-inline-start:auto;text-align:left;font-size:12px;color:var(--muted);line-height:1.3}
.top .no b{display:block;color:var(--navy);font-size:14px}
.wrap{max-width:560px;margin:0 auto;padding:14px 16px 24px}
.prog{display:flex;align-items:center;gap:10px;margin:2px 0 14px}
.prog .bars{flex:1;display:flex;gap:5px}.prog .bars i{flex:1;height:5px;border-radius:5px;background:var(--line);transition:background .3s}
.prog .bars i.on{background:var(--teal2)}
.prog span{font-size:13px;color:var(--muted);white-space:nowrap}
h1{font-size:24px;line-height:1.25;color:var(--navy);font-weight:800}
h2{font-size:19px;color:var(--navy);font-weight:800;margin-bottom:4px}
.lead{color:var(--muted);font-size:15px;margin-top:4px}
.hero{background:var(--navy);color:#fff;border-radius:18px;padding:18px;margin-top:14px}
.hero small{display:block;color:#C5D6E4;font-size:13px}
.hero .big{font-size:34px;font-weight:800;color:var(--yellow);line-height:1.15;margin:2px 0}
.hero .n{font-size:12px;color:#9FB6CB}
.hero .row{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px;padding-top:14px;border-top:1px solid rgba(255,255,255,.14)}
.hero .row b{display:block;font-size:20px;font-weight:800;white-space:nowrap}
.card{background:#fff;border:1px solid var(--line);border-radius:16px;padding:16px;margin-top:12px}
.card h3{font-size:15px;color:var(--navy);display:flex;align-items:center;gap:8px;margin-bottom:6px}
.pill{display:inline-block;border-radius:20px;padding:1px 10px;font-size:12px;font-weight:700}
.p-s{background:#EAF5F7;color:var(--teal)}.p-m{background:var(--yellow);color:var(--navy)}
.svc{display:flex;justify-content:space-between;gap:12px;padding:11px 0;border-top:1px solid var(--line)}
.svc:first-of-type{border-top:0}
.svc b{display:block;color:var(--navy);font-size:15px}
.svc small{display:block;color:var(--muted);font-size:13px;line-height:1.4}
.svc .p{white-space:nowrap;font-weight:700;color:var(--navy);font-family:'Rubik',Arial}
.svc .p small{text-align:left}
.note{font-size:13px;color:var(--muted);margin-top:8px}
ul.terms{list-style:none;display:grid;gap:8px}
ul.terms li{display:flex;gap:10px;font-size:14px}
ul.terms li::before{content:"✓";flex:none;width:22px;height:22px;border-radius:50%;background:#EAF5F7;color:var(--teal);font-weight:800;font-size:12px;display:inline-flex;align-items:center;justify-content:center;margin-top:1px}
.btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;font-size:17px;font-weight:700;border:0;border-radius:14px;padding:15px 18px;min-height:54px;cursor:pointer;background:var(--navy);color:#fff;text-decoration:none;transition:transform .08s,opacity .2s}
.btn:active{transform:scale(.98)}
.btn:disabled{opacity:.45;cursor:not-allowed}
.btn.sec{background:#E7EEF3;color:var(--navy)}
.btn.ghost{background:#fff;color:var(--navy);border:1.5px solid var(--line)}
.btn.ok{background:var(--green)}
.bar{position:fixed;inset-inline:0;bottom:0;z-index:20;background:rgba(255,255,255,.96);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border-top:1px solid var(--line);padding:12px 16px calc(12px + env(safe-area-inset-bottom))}
.bar .in{max-width:560px;margin:0 auto;display:flex;gap:10px}
.bar .btn.sec{flex:0 0 auto;width:auto;padding-inline:20px}
.f{display:block;margin-top:14px}
.f>span{display:flex;align-items:center;gap:6px;font-size:14px;font-weight:700;color:var(--navy)}
.f>span em{font-style:normal;color:var(--red)}
.f>span .miss{margin-inline-start:auto;font-size:12px;font-weight:700;color:#8A5A00;background:#FFF3CF;border-radius:20px;padding:0 8px}
.i{width:100%;font:inherit;font-size:17px;padding:13px 14px;border:1.5px solid var(--line);border-radius:12px;background:#fff;color:var(--ink);margin-top:6px;-webkit-appearance:none;appearance:none}
.i:focus{outline:none;border-color:var(--teal2);box-shadow:0 0 0 4px rgba(18,165,181,.15)}
.f.missing .i{border-color:#F2B63C;background:#FFFCF1}
.f.err .i{border-color:var(--red);background:#FFF7F5}
.f .msg{display:block;color:var(--red);font-size:13px;margin-top:4px;min-height:0}
.f .warn{display:block;color:#8A5A00;font-size:13px;margin-top:4px}
.who{display:flex;gap:12px;align-items:flex-start;background:#EAF5F7;border-radius:14px;padding:12px 14px;margin-top:12px;font-size:14px}
.who b{color:var(--navy)}
.who button{margin-inline-start:auto;border:0;background:none;color:var(--teal);font:inherit;font-weight:700;font-size:14px;cursor:pointer;padding:0}
.chk{display:flex;gap:12px;align-items:flex-start;padding:14px;border:1.5px solid var(--line);border-radius:14px;margin-top:10px;cursor:pointer;background:#fff;font-size:15px;line-height:1.45}
.chk input{width:24px;height:24px;flex:none;accent-color:var(--navy);margin-top:1px}
.chk.on{border-color:var(--navy);background:#F5F8FB}
.padbox{margin-top:16px}
.padbox .lbl{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:8px}
.padbox .lbl b{font-size:15px;color:var(--navy)}
.pad{position:relative;border:2px dashed #AFC0CD;border-radius:16px;background:#fff;overflow:hidden;touch-action:none}
.pad.has{border-style:solid;border-color:var(--navy)}
.pad canvas{display:block;width:100%;aspect-ratio:2/1;touch-action:none;cursor:crosshair}
.pad .base{position:absolute;inset-inline:22px;bottom:26%;border-bottom:1.5px solid #CBD5DD;pointer-events:none}
.pad .x{position:absolute;inset-inline-start:24px;bottom:calc(26% + 4px);color:#B5C2CC;font-size:20px;pointer-events:none}
.pad .hint{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:8px;color:#97A6B3;font-size:17px;pointer-events:none}
.tools{display:flex;gap:8px;margin-top:8px}
.tools button{flex:1;border:1.5px solid var(--line);background:#fff;color:var(--navy);border-radius:12px;padding:10px;font:inherit;font-weight:700;font-size:15px;cursor:pointer;min-height:46px}
.alert{border-radius:12px;padding:12px 14px;margin-top:12px;font-size:14px;background:#FFF1EC;color:var(--red);border:1px solid #F5C9BB}
.done{text-align:center;padding-top:22px}
.done .ic{width:84px;height:84px;border-radius:50%;background:#DCF5E6;color:var(--green);font-size:46px;font-weight:800;display:inline-flex;align-items:center;justify-content:center;margin-bottom:14px;animation:pop .4s ease-out}
@keyframes pop{0%{transform:scale(.6);opacity:0}100%{transform:scale(1);opacity:1}}
.done .btn{margin-top:18px}
.contact{text-align:center;color:var(--muted);font-size:13px;margin-top:22px}
.contact a{color:var(--teal);text-decoration:none;font-weight:700}
.sheet{position:fixed;inset:0;z-index:50;background:#fff;display:flex;flex-direction:column}
.sheet .hd{display:flex;align-items:center;gap:10px;padding:10px 12px calc(10px);padding-top:calc(10px + env(safe-area-inset-top));border-bottom:1px solid var(--line)}
.sheet .hd b{font-size:16px;color:var(--navy)}
.sheet .hd button{margin-inline-start:auto;border:0;background:var(--navy);color:#fff;border-radius:12px;padding:10px 18px;font:inherit;font-weight:700;cursor:pointer}
.sheet iframe{flex:1;width:100%;border:0;background:#E6ECF0}
.fs{position:fixed;inset:0;z-index:60;background:var(--bg);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:calc(12px + env(safe-area-inset-top)) 12px calc(12px + env(safe-area-inset-bottom))}
.fs .t{font-weight:800;color:var(--navy);font-size:17px}
.fs .pad{width:100%}
.fs .tools{width:100%}
.fs .tools .btn{flex:1}
.spin{width:18px;height:18px;border-radius:50%;border:2.5px solid rgba(255,255,255,.4);border-top-color:#fff;animation:sp .7s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}
@media (min-width:600px){body{padding-bottom:120px}.wrap{padding-top:22px}}
`;

function servicesHtml(lines, monthly) {
  return lines.filter(l => (l.billing === "monthly") === monthly).map(l => `
    <div class="svc"><div><b>${esc(l.name)}${l.qty > 1 ? ` ×${l.qty}` : ""}</b><small>${esc(l.description)}</small></div>
    <div class="p">${fm(l.price * l.qty)}${monthly ? '<small>לחודש</small>' : ""}</div></div>`).join("");
}

/* view = "sign" | "signed" | "expired" */
function renderSignPage(quote, { view, validUntil, token }) {
  const T = quote.totals;
  const C = quote.client || {};
  const setupN = quote.lines.filter(l => l.billing !== "monthly").length;
  const monthlyN = quote.lines.length - setupN;
  const greetName = C.contact || C.name || "";
  const signedAt = quote.signed?.at
    ? new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(quote.signed.at))
    : "";
  const data = {
    token, view, version: new Date(quote.updatedAt).toISOString(),
    client: { name: C.name || "", id: C.id || "", address: C.address || "", phone: C.phone || "", email: C.email || "", contact: C.contact || "", role: C.role || "" },
  };
  const field = (k, label, attrs, required = true) => `
    <label class="f" data-f="${k}"><span>${label}${required ? " <em>*</em>" : ""}<i class="miss" hidden>חסר</i></span>
      <input class="i" name="${k}" value="${esc(data.client[k])}" ${attrs}>
      <i class="msg" role="alert"></i></label>`;

  return `<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow"><meta name="theme-color" content="#0C2347">
<title>הצעת מחיר ${esc(quote.quoteNo)} · דשן מדיה טק</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Rubik:wght@500;700;800&family=Heebo:wght@400;500;700&display=swap">
<style>${CSS}</style></head><body>
<header class="top"><div class="stripe">${["#F2603D", "#F7A832", "#F9DF3A", "#36C77F", "#2F84CF"].map(c => `<i style="background:${c}"></i>`).join("")}</div>
<div class="in">${logo() ? `<img src="${logo()}" alt="">` : ""}<div class="co">דשן מדיה טק<small>הצעת מחיר והסכם התקשרות</small></div>
<div class="no">הצעה מס׳<b>${esc(quote.quoteNo)}</b>${dfmt(quote.quoteDate)}</div></div></header>

<main class="wrap">
<noscript><div class="alert">כדי לחתום יש להפעיל JavaScript בדפדפן.</div></noscript>
<div class="prog" id="prog"${view === "sign" ? "" : " hidden"}><div class="bars"><i class="on"></i><i></i><i></i></div><span id="progT">שלב 1 מתוך 3</span></div>

<section id="s1"${view === "sign" ? "" : " hidden"}>
  <h1>${greetName ? `שלום ${esc(greetName)},` : "שלום,"}</h1>
  <p class="lead">הכנו עבור${C.name ? ` ${esc(C.name)}` : "כם"} הצעה של ${[
    setupN ? (setupN === 1 ? "שירות הקמה אחד" : `${setupN} שירותי הקמה`) : "",
    monthlyN ? (monthlyN === 1 ? "שירות חודשי אחד" : `${monthlyN} שירותים חודשיים`) : "",
  ].filter(Boolean).join(" ו")}. עברו עליה, השלימו פרטים וחתמו — זה לוקח דקה.</p>
  <div class="hero">
    <small>לתשלום בחתימה (הקמה)</small>
    <div class="big num">${fm(T.setup.total)}</div>
    <div class="n">כולל מע"מ ${esc(T.vatPct)}%</div>
    ${monthlyN ? `<div class="row"><div><small>תשלום חודשי</small><b class="num">${fm(T.monthly.total)}</b><span class="n">כולל מע"מ · ${esc(quote.commitMonths)} חודשים לפחות</span></div>
    <div><small>סה"כ ל-${esc(quote.commitMonths)} חודשים</small><b class="num">${fm(T.commitTotal)}</b><span class="n">הקמה + ${esc(quote.commitMonths)} תשלומים</span></div></div>` : ""}
  </div>
  ${setupN ? `<div class="card"><h3>שירותי הקמה <span class="pill p-s">חד-פעמי</span></h3>${servicesHtml(quote.lines, false)}</div>` : ""}
  ${monthlyN ? `<div class="card"><h3>שירותים חודשיים <span class="pill p-m">חודשי</span></h3>${servicesHtml(quote.lines, true)}</div>` : ""}
  <p class="note">המחירים לפני מע"מ${T.discountPct ? `, לפני הנחה של ${esc(T.discountPct)}% שכבר כלולה בסכומים למעלה` : ""}.</p>
  <div class="card"><h3>התנאים בקצרה</h3><ul class="terms">
    <li>תשלום ההקמה: 100% במועד החתימה</li>
    ${monthlyN ? `<li>תשלום חודשי מראש, התחייבות ל-${esc(quote.commitMonths)} חודשים; אחר כך חודש-בחודש עם הודעה של ${esc(quote.noticeDays)} יום</li>` : ""}
    <li>תקציב הפרסום לפלטפורמות (Meta, Google, TikTok) אינו כלול ומשולם ישירות על ידכם</li>
    <li>כל התוצרים, הדומיין וחשבונות הפרסום שלכם, אחרי תשלום מלא</li>
    <li>ההצעה בתוקף עד ${dfmt(validUntil)}</li>
  </ul></div>
  <button type="button" class="btn ghost" style="margin-top:12px" data-open-doc>📄 קריאת ההסכם המלא</button>
</section>

<section id="s2" hidden>
  <h2>הפרטים שלכם להסכם</h2>
  <p class="lead">מילאנו מה שידענו. שדות שמסומנים "חסר" — נשמח שתשלימו.</p>
  <form id="form" novalidate autocomplete="on">
    ${field("name", "שם העסק / הלקוח", 'autocomplete="organization" enterkeyhint="next"')}
    ${field("id", "ח.פ. / ע.מ. (לא חובה)", 'inputmode="numeric" autocomplete="off" enterkeyhint="next" dir="ltr" style="text-align:right"', false)}
    ${field("address", "כתובת", 'autocomplete="street-address" enterkeyhint="next"')}
    ${field("phone", "טלפון", 'type="tel" inputmode="tel" autocomplete="tel" enterkeyhint="next" dir="ltr" style="text-align:right"')}
    ${field("email", 'דוא"ל', 'type="email" inputmode="email" autocomplete="email" enterkeyhint="next" dir="ltr" style="text-align:right"')}
    ${field("contact", "שם החותם/ת", 'autocomplete="name" enterkeyhint="next"')}
    ${field("role", "תפקיד", 'autocomplete="organization-title" enterkeyhint="done" placeholder="למשל: בעלים, מנכ״ל"', false)}
  </form>
</section>

<section id="s3" hidden>
  <h2>חתימה על ההסכם</h2>
  <div class="who"><div id="who"></div><button type="button" data-go="2">עריכה</button></div>
  <label class="chk"><input type="checkbox" id="c1"><span>קראתי את ההסכם ואת נספח פירוט החיוב, הבנתי אותם ואני מסכים/ה לכל תנאיהם. <a href="#" data-open-doc style="color:var(--teal);font-weight:700">להסכם המלא</a></span></label>
  <label class="chk"><input type="checkbox" id="c2"><span>אני מאשר/ת תשלום של <b>${fm(T.setup.total)}</b> (כולל מע"מ) עבור שירותי ההקמה במועד החתימה${monthlyN ? `, ותשלום חודשי של <b>${fm(T.monthly.total)}</b> (כולל מע"מ) למשך ${esc(quote.commitMonths)} חודשים לפחות` : ""}.</span></label>
  <div class="padbox">
    <div class="lbl"><b>החתימה שלך</b><span class="note" style="margin:0">חתמו באצבע בתוך המסגרת</span></div>
    <div class="pad" id="pad"><canvas aria-label="משטח חתימה"></canvas><div class="base"></div><div class="x">✕</div><div class="hint">✍️ חתמו כאן</div></div>
    <div class="tools"><button type="button" data-clear>ניקוי</button><button type="button" data-fs>⤢ חתימה במסך מלא</button></div>
  </div>
  <div class="alert" id="err" role="alert" hidden></div>
</section>

<section id="done"${view === "signed" ? "" : " hidden"} class="done">
  <div class="ic">✓</div>
  <h1 id="doneT">ההסכם נחתם בהצלחה</h1>
  <p class="lead" id="doneL">${view === "signed" ? `ההסכם נחתם ב-${esc(signedAt)}${quote.signed?.name ? ` על ידי ${esc(quote.signed.name)}` : ""}.` : ""} עותק חתום של ההסכם נשמר במערכת של דשן מדיה טק.</p>
  <a class="btn" href="/sign/${esc(token)}/signed" target="_blank" rel="noopener">📄 הצגת ההסכם החתום</a>
</section>

<section id="expired"${view === "expired" ? "" : " hidden"} class="done">
  <div class="ic" style="background:#FFF3CF;color:#8A5A00">!</div>
  <h1>תוקף ההצעה הסתיים</h1>
  <p class="lead">ההצעה הייתה בתוקף עד ${dfmt(validUntil)}. נשמח לחדש אותה עבורכם — דברו איתנו.</p>
</section>

<p class="contact">שאלות? <a href="tel:${esc(COMPANY.phone.replace(/\D/g, ""))}" dir="ltr">${esc(COMPANY.phone)}</a> · <a href="mailto:${esc(COMPANY.email)}">${esc(COMPANY.email)}</a></p>
</main>

<div class="bar" id="bar"${view === "sign" ? "" : " hidden"}><div class="in">
  <button type="button" class="btn sec" id="back" hidden>חזרה</button>
  <button type="button" class="btn" id="next">המשך להשלמת פרטים</button>
</div></div>

<div class="sheet" id="sheet" hidden role="dialog" aria-modal="true" aria-label="ההסכם המלא">
  <div class="hd"><b>ההסכם המלא · הצעה ${esc(quote.quoteNo)}</b><button type="button" data-close-doc>סגירה</button></div>
  <iframe title="ההסכם המלא" referrerpolicy="no-referrer"></iframe>
</div>

<div class="fs" id="fs" hidden role="dialog" aria-modal="true" aria-label="חתימה במסך מלא">
  <div class="t">חתמו כאן באצבע</div>
  <div class="pad" id="padFs"><canvas aria-label="משטח חתימה"></canvas><div class="base"></div><div class="x">✕</div></div>
  <div class="tools"><button type="button" data-clear>ניקוי</button><button type="button" class="btn" data-fs-done>סיום</button></div>
</div>

<script type="application/json" id="data">${json(data)}</script>
<script>${CLIENT_JS}</script>
</body></html>`;
}

/* Runs in the client's browser. */
const CLIENT_JS = String.raw`(function(){
"use strict";
var D=JSON.parse(document.getElementById("data").textContent);
if(D.view!=="sign")return;
var $=function(s,r){return (r||document).querySelector(s)}, $$=function(s,r){return Array.prototype.slice.call((r||document).querySelectorAll(s))};
var step=1, idWarned="";
var REQ=["name","address","phone","email","contact"];
var LABEL={1:"המשך להשלמת פרטים",2:"המשך לחתימה",3:"חתימה ואישור ההסכם"};

/* ── steps ── */
function show(n){
  step=n;
  ["s1","s2","s3"].forEach(function(id,i){ $("#"+id).hidden = (i+1)!==n; });
  $$("#prog .bars i").forEach(function(b,i){ b.classList.toggle("on", i<n); });
  $("#progT").textContent="שלב "+n+" מתוך 3";
  $("#back").hidden = n===1;
  $("#next").textContent=LABEL[n];
  if(n===2) markMissing();
  if(n===3){ fillWho(); setTimeout(function(){ pads.forEach(function(p){p.resize();}); },0); }
  updateNext();
  window.scrollTo({top:0,behavior:"smooth"});
}
$("#next").addEventListener("click",function(){
  if(step===1) return show(2);
  if(step===2){ if(validate()) show(3); return; }
  submit();
});
$("#back").addEventListener("click",function(){ show(step-1); });
$$("[data-go]").forEach(function(b){ b.addEventListener("click",function(){ show(Number(b.getAttribute("data-go"))); }); });

/* ── details ── */
function val(k){ return ($("#form [name="+k+"]").value||"").trim(); }
function client(){ var c={}; Object.keys(D.client).forEach(function(k){ c[k]=val(k); }); return c; }
function setErr(k,msg){ var f=$('.f[data-f="'+k+'"]'); f.classList.toggle("err",!!msg); $(".msg",f).textContent=msg||""; }
function markMissing(){ Object.keys(D.client).forEach(function(k){ var f=$('.f[data-f="'+k+'"]'); var miss=REQ.indexOf(k)>=0 && !val(k); f.classList.toggle("missing",miss); $(".miss",f).hidden=!miss; }); }
function idChecksum(v){ var d=v.replace(/\D/g,""); if(d.length<5||d.length>9) return false; d=("000000000"+d).slice(-9); var s=0; for(var i=0;i<9;i++){ var x=Number(d[i])*((i%2)+1); s+= x>9?x-9:x; } return s%10===0; }
function validate(){
  var ok=true, first=null, c=client();
  REQ.forEach(function(k){ setErr(k, c[k]?"":"שדה חובה"); if(!c[k]){ ok=false; first=first||k; } });
  var idd=c.id.replace(/\D/g,"");
  if(c.id && (idd.length<5||idd.length>9)){ setErr("id","5–9 ספרות"); ok=false; first=first||"id"; }
  if(c.phone && c.phone.replace(/\D/g,"").length<9){ setErr("phone","מספר טלפון לא תקין"); ok=false; first=first||"phone"; }
  if(c.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(c.email)){ setErr("email",'כתובת דוא"ל לא תקינה'); ok=false; first=first||"email"; }
  var f=$('.f[data-f="id"]'), w=$(".warn",f);
  if(ok && c.id && !idChecksum(c.id) && idWarned!==c.id){
    idWarned=c.id;
    if(!w){ w=document.createElement("i"); w.className="warn"; f.appendChild(w); }
    w.textContent="המספר לא עבר בדיקת ספרת ביקורת — בדקו שהוא נכון. אם כן, לחצו שוב על המשך.";
    ok=false; first="id";
  } else if(w && idChecksum(c.id)) w.remove();
  if(!ok && first){ var inp=$("#form [name="+first+"]"); inp.focus(); inp.scrollIntoView({block:"center",behavior:"smooth"}); }
  return ok;
}
$$("#form .i").forEach(function(inp){
  inp.addEventListener("input",function(){ setErr(inp.name,""); markMissing(); });
  inp.addEventListener("keydown",function(e){ if(e.key==="Enter"){ e.preventDefault(); var all=$$("#form .i"), i=all.indexOf(inp); if(i<all.length-1) all[i+1].focus(); else $("#next").click(); } });
});
function fillWho(){
  var c=client();
  $("#who").innerHTML="";
  var b=document.createElement("b"); b.textContent=c.contact+(c.role?", "+c.role:"");
  var s=document.createElement("div"); s.style.color="var(--muted)"; s.textContent="בשם "+c.name+(c.id?" · ח.פ./ע.מ. "+c.id:"");
  $("#who").appendChild(b); $("#who").appendChild(s);
}

/* ── signature pad (strokes shared by the inline and full-screen pads;
      points are relative to the pad width, so both draw the same shape) ── */
var strokes=[];
function curve(ctx,s,W){
  if(s.length===1){ ctx.beginPath(); ctx.arc(s[0].x*W,s[0].y*W,ctx.lineWidth/2,0,Math.PI*2); ctx.fill(); return; }
  ctx.beginPath(); ctx.moveTo(s[0].x*W,s[0].y*W);
  for(var i=1;i<s.length-1;i++){ var mx=(s[i].x+s[i+1].x)/2*W, my=(s[i].y+s[i+1].y)/2*W; ctx.quadraticCurveTo(s[i].x*W,s[i].y*W,mx,my); }
  var l=s[s.length-1]; ctx.lineTo(l.x*W,l.y*W); ctx.stroke();
}
function style(ctx,W){ ctx.lineCap="round"; ctx.lineJoin="round"; ctx.strokeStyle="#0C2347"; ctx.fillStyle="#0C2347"; ctx.lineWidth=Math.max(2.2,W*0.0072); }
function Pad(box){
  var canvas=$("canvas",box), ctx=canvas.getContext("2d"), W=0, H=0, cur=null, raf=0;
  function resize(){
    var r=canvas.getBoundingClientRect(); if(!r.width) return;
    W=r.width; H=r.height||r.width/2; var dpr=Math.max(1,window.devicePixelRatio||1);
    canvas.width=Math.round(W*dpr); canvas.height=Math.round(H*dpr); ctx.setTransform(dpr,0,0,dpr,0,0); draw();
  }
  function draw(){ ctx.clearRect(0,0,W,H); style(ctx,W); strokes.forEach(function(s){ curve(ctx,s,W); }); box.classList.toggle("has",strokes.length>0); var h=$(".hint",box); if(h) h.hidden=strokes.length>0; }
  function pos(e){ var r=canvas.getBoundingClientRect(); return {x:(e.clientX-r.left)/W, y:(e.clientY-r.top)/W}; }
  canvas.addEventListener("pointerdown",function(e){ e.preventDefault(); if(!W) resize(); try{canvas.setPointerCapture(e.pointerId);}catch(_){} cur=[pos(e)]; strokes.push(cur); draw(); });
  canvas.addEventListener("pointermove",function(e){ if(!cur) return; e.preventDefault(); var evs=e.getCoalescedEvents?e.getCoalescedEvents():[e]; if(!evs.length) evs=[e]; evs.forEach(function(ev){ cur.push(pos(ev)); }); if(!raf) raf=requestAnimationFrame(function(){ raf=0; draw(); }); });
  function end(){ if(!cur) return; cur=null; draw(); changed(); }
  canvas.addEventListener("pointerup",end); canvas.addEventListener("pointercancel",end); canvas.addEventListener("lostpointercapture",end);
  return {resize:resize, draw:draw};
}
var pads=[Pad($("#pad")), Pad($("#padFs"))];
function redrawAll(){ pads.forEach(function(p){ p.draw(); }); }
function changed(){ redrawAll(); updateNext(); }
$$("[data-clear]").forEach(function(b){ b.addEventListener("click",function(){ strokes=[]; changed(); }); });
function signaturePng(){
  var pts=[].concat.apply([],strokes); if(pts.length<6) return null;
  var minX=1e9,minY=1e9,maxX=-1e9,maxY=-1e9;
  pts.forEach(function(p){ minX=Math.min(minX,p.x); maxX=Math.max(maxX,p.x); minY=Math.min(minY,p.y); maxY=Math.max(maxY,p.y); });
  var W=900, bw=(maxX-minX)*W, bh=(maxY-minY)*W; if(bw<40&&bh<40) return null;
  var c=document.createElement("canvas"), x=c.getContext("2d"); style(x,W); var pad=x.lineWidth*2;
  c.width=Math.ceil(bw+pad*2); c.height=Math.ceil(bh+pad*2); style(x,W);
  x.translate(pad-minX*W, pad-minY*W); strokes.forEach(function(s){ curve(x,s,W); });
  return c.toDataURL("image/png");
}
function fsOpen(){ $("#fs").hidden=false; document.body.style.overflow="hidden"; fitFs(); }
function fsClose(){ $("#fs").hidden=true; document.body.style.overflow=""; setTimeout(function(){ pads[0].resize(); },0); }
function fitFs(){ var box=$("#padFs"); var w=Math.min(window.innerWidth-24,(window.innerHeight-170)*2); box.style.width=Math.max(260,w)+"px"; pads[1].resize(); }
$("[data-fs]").addEventListener("click",fsOpen); $("[data-fs-done]").addEventListener("click",fsClose);
window.addEventListener("resize",function(){ pads[0].resize(); if(!$("#fs").hidden) fitFs(); });

/* ── consents + submit ── */
["c1","c2"].forEach(function(id){ var c=$("#"+id); c.addEventListener("change",function(){ c.closest(".chk").classList.toggle("on",c.checked); updateNext(); }); });
function ready(){ return $("#c1").checked && $("#c2").checked && !!signaturePng(); }
function updateNext(){ $("#next").disabled = step===3 && !ready(); }
function err(msg){ var e=$("#err"); e.textContent=msg; e.hidden=!msg; if(msg) e.scrollIntoView({block:"center",behavior:"smooth"}); }
var busy=false;
function submit(){
  if(busy) return; err("");
  var sig=signaturePng();
  if(!sig){ err("נא לחתום בתוך המסגרת"); return; }
  if(!$("#c1").checked||!$("#c2").checked){ err("יש לסמן את שני האישורים"); return; }
  busy=true; var btn=$("#next"); btn.disabled=true; btn.innerHTML='<span class="spin"></span> שומר את החתימה…';
  fetch("/sign/"+encodeURIComponent(D.token),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({version:D.version,client:client(),signature:sig,agreeTerms:true,agreePayment:true})})
    .then(function(r){ return r.json().catch(function(){return {};}).then(function(b){ return {ok:r.ok,status:r.status,b:b}; }); })
    .then(function(res){
      busy=false;
      if(res.ok || (res.status===409 && res.b.error==="already_signed")){
        $("#prog").hidden=true; $("#bar").hidden=true; ["s1","s2","s3"].forEach(function(id){ $("#"+id).hidden=true; });
        if(!res.ok) $("#doneL").textContent="ההסכם כבר נחתם. עותק חתום שמור במערכת של דשן מדיה טק.";
        $("#done").hidden=false; window.scrollTo({top:0}); return;
      }
      btn.textContent=LABEL[3]; updateNext();
      if(res.b.error==="missing_details" && res.b.fields){ show(2); Object.keys(res.b.fields).forEach(function(k){ setErr(k,res.b.fields[k]); }); return; }
      if(res.b.error==="expired"){ location.reload(); return; }
      err(res.b.message||"החתימה לא נשמרה — נסו שוב");
    })
    .catch(function(){ busy=false; btn.textContent=LABEL[3]; updateNext(); err("אין חיבור לאינטרנט — בדקו את החיבור ונסו שוב"); });
}

/* ── full agreement sheet ── */
$$("[data-open-doc]").forEach(function(b){ b.addEventListener("click",function(e){ e.preventDefault(); var f=$("#sheet iframe"); if(!f.src) f.src="/sign/"+encodeURIComponent(D.token)+"/document"; $("#sheet").hidden=false; document.body.style.overflow="hidden"; }); });
$("[data-close-doc]").addEventListener("click",function(){ $("#sheet").hidden=true; document.body.style.overflow=""; });
document.addEventListener("keydown",function(e){ if(e.key==="Escape"){ if(!$("#sheet").hidden) $("[data-close-doc]").click(); else if(!$("#fs").hidden) fsClose(); } });

show(1);
})();`;

function renderMessagePage(title, message) {
  return `<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow"><title>${esc(title)} · דשן מדיה טק</title>
<style>${CSS}</style></head><body style="padding-bottom:0"><main class="wrap"><section class="done">
<div class="ic" style="background:#FFF1EC;color:var(--red)">!</div><h1>${esc(title)}</h1><p class="lead">${esc(message)}</p>
<p class="contact">שאלות? <a href="tel:${esc(COMPANY.phone.replace(/\D/g, ""))}" dir="ltr">${esc(COMPANY.phone)}</a></p></section></main></body></html>`;
}

module.exports = { renderSignPage, renderMessagePage };
