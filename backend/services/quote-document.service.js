/* Renders a quote (services/quote.service.js) as the Dashen "הצעת מחיר
   והסכם התקשרות" document — the layout, CSS and agreement text of the
   original deshen-quote-agreement.html, filled from the stored quote.
   Self-contained HTML (logo inlined) that prints to A4 / "Save as PDF".

   The static parts below (CSS, about, work process, agreement) were taken
   verbatim from that HTML; edit them here to change the document text. */

const fs = require("fs");
const path = require("path");

const COMPANY = {
  legal: "דשן מדיה טק",
  id: "517319612",
  signer: "נתנאל דגמי",
  role: 'מנכ"ל',
  address: "יהושפט 11, רמת גן",
  phone: "054-507-1101",
  email: "hi@deshen.co",
  site: "deshen.co",
};

/* backend/assets images, inlined so the document is self-contained. */
const assetCache = new Map();
function asset(file) {
  if (!assetCache.has(file)) {
    try {
      assetCache.set(file, `data:image/png;base64,${fs.readFileSync(path.join(__dirname, "..", "assets", file)).toString("base64")}`);
    } catch {
      assetCache.set(file, "");
    }
  }
  return assetCache.get(file);
}
const logo = () => asset("deshen-quote-logo.png");
/* Dashen's stamp + Netanel's signature — on every quote (user request
   2026-11-22). Cut from a photo, paper made transparent. */
const stamp = () => asset("deshen-stamp.png");

const CSS = "*{box-sizing:border-box;margin:0;padding:0}\nhtml{-webkit-print-color-adjust:exact;print-color-adjust:exact}\nbody{font-family:'Heebo','Rubik',Arial,sans-serif;color:#16233A;font-size:14.5px;line-height:1.65;background:#E6ECF0}\nh1,h2,h3,h4,.big,.eyebrow,.num{font-family:'Rubik','Heebo',Arial,sans-serif}\n.wrap{display:grid;grid-template-columns:minmax(0,1fr) 380px;gap:22px;max-width:1340px;margin:0 auto;padding:22px}\n#doc{min-width:0}\n.page{background:#F8FAFB;padding:54px 56px;margin:0 0 22px;border-radius:14px;box-shadow:0 2px 14px rgba(12,35,71,.08);position:relative;overflow:hidden}\n.stripe{position:absolute;top:0;right:0;left:0;height:7px;display:flex} .stripe i{flex:1}\n.eyebrow{color:#0B7F8C;font-weight:700;font-size:12.5px;letter-spacing:.3px;margin-bottom:6px}\nh2{font-size:32px;font-weight:800;line-height:1.15;color:#0C2347;margin-bottom:14px}\nh3{font-size:17px;font-weight:700;color:#0C2347;margin:26px 0 10px}\nh4{font-size:14.5px;font-weight:700;color:#0C2347}\np{margin:0 0 10px} .lead{font-size:15px;color:#54627A;max-width:720px}\n.grid{display:grid;gap:12px;margin:12px 0} .g2{grid-template-columns:1fr 1fr} .g3{grid-template-columns:repeat(3,1fr)} .g4{grid-template-columns:repeat(4,1fr)}\n.card{background:#EAF5F7;border-radius:10px;padding:14px 16px;break-inside:avoid} .card h4{margin-bottom:3px;display:flex;gap:8px;align-items:center} .card p{font-size:13px;color:#54627A;margin:0}\n.card.w{background:#fff;border:1px solid #D9E2E8}\n.badge{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:22px;border-radius:50%;background:#0C2347;color:#fff;font-size:12px;font-weight:700;font-family:'Rubik',Arial;flex:none}\n.pill{display:inline-block;border-radius:20px;padding:1px 10px;font-size:11.5px;font-weight:700;white-space:nowrap}\n.p-m{background:#F2B63C;color:#0C2347} .p-s{background:#EAF5F7;color:#0B7F8C}\n.stat{background:#fff;border:1px solid #D9E2E8;border-radius:12px;padding:14px 16px;break-inside:avoid} .stat .big{font-size:28px;font-weight:800;color:#0B7F8C;line-height:1.15} .stat p{font-size:12.5px;color:#54627A;margin:3px 0 0}\n/* cover */\n.cover{min-height:1010px;display:flex;flex-direction:column}\n.cover .top{display:flex;justify-content:space-between;align-items:flex-start;margin-top:10px}\n.cover .logo{width:190px} .cover .qn{text-align:left;font-size:12.5px;color:#54627A} .cover .qn b{display:block;font-family:'Rubik',Arial;font-size:15px;color:#0C2347}\n.cover .mid{flex:1;display:flex;flex-direction:column;justify-content:center;padding:30px 0}\n.cover h1{font-size:54px;font-weight:800;color:#0C2347;line-height:1.08;margin:6px 0 10px} .cover h1 span{color:#12A5B5}\n.cover .for{font-family:'Rubik',Arial;font-size:22px;font-weight:700;color:#0C2347} .cover .sub{color:#54627A;margin-top:4px}\n.hero{background:#0C2347;color:#fff;border-radius:14px;padding:24px 28px;margin:24px 0 0;display:grid;grid-template-columns:1fr 1fr 1fr;gap:18px}\n.hero small{color:#C5D6E4;display:block;font-size:12.5px} .hero .big{font-size:27px;font-weight:800;white-space:nowrap} .hero .big.y{color:#F2B63C} .hero .n{font-size:11.5px;color:#9FB6CB}\n.meta{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;border-top:1px solid #D9E2E8;padding-top:16px} .meta small{color:#54627A;font-size:12px;display:block} .meta b{color:#0C2347}\n/* tables */\ntable{width:100%;border-collapse:collapse;margin:8px 0 4px;font-size:13.5px}\nth{text-align:right;font-family:'Rubik',Arial;font-size:11.5px;font-weight:700;color:#0B7F8C;padding:8px 8px;border-bottom:2px solid #0C2347}\ntd{padding:10px 8px;border-bottom:1px solid #D9E2E8;vertical-align:top} tr{break-inside:avoid} thead{display:table-header-group}\ntd.nm b{color:#0C2347;display:block} td.nm small{color:#54627A;font-size:12px}\ntd.c,th.c{text-align:center;width:60px} td.pr,th.pr{text-align:left;white-space:nowrap;width:110px} td.pr{font-family:'Rubik',Arial;font-weight:700;color:#0C2347} td.pr.t{color:#0B7F8C;font-weight:800}\n.sum{margin:10px 0 0 auto;width:min(100%,380px);border:1px solid #D9E2E8;border-radius:12px;overflow:hidden;break-inside:avoid;background:#fff}\n.sum .r{display:flex;justify-content:space-between;padding:9px 16px;border-bottom:1px solid #D9E2E8;font-size:13.5px} .sum .r span:last-child{font-family:'Rubik',Arial;font-weight:700;white-space:nowrap}\n.sum .r.d span:last-child{color:#B4472B} .sum .r.k{background:#0C2347;color:#fff;border:0;padding:12px 16px} .sum .r.k span:last-child{font-size:20px;font-weight:800} .sum .r.k small{display:block;color:#C5D6E4;font-size:11.5px;font-weight:400}\n.blockhd{display:flex;align-items:center;gap:10px;margin:26px 0 2px;break-after:avoid} .blockhd h4{font-size:17px}\n.commit{background:#EAF5F7;border-radius:14px;padding:18px 22px;margin-top:26px;display:grid;grid-template-columns:repeat(3,1fr);gap:14px;break-inside:avoid}\n.commit small{display:block;color:#54627A;font-size:12px} .commit b{font-family:'Rubik',Arial;font-size:20px;color:#0C2347} .commit .t b{color:#0B7F8C}\n.note{font-size:12.5px;color:#54627A;margin-top:10px}\n/* terms + process */\n.terms .card h4 .ic{width:26px;height:26px;border-radius:50%;background:#0C2347;color:#F2B63C;display:inline-flex;align-items:center;justify-content:center;font-size:13px;flex:none}\n.steps{margin:8px 0} .step{display:flex;gap:14px;align-items:flex-start;padding:11px 0;border-bottom:1px solid #D9E2E8;break-inside:avoid} .step b{min-width:150px;color:#0C2347} .step .t{color:#54627A;font-size:13.5px}\n/* agreement */\n.agr{font-size:13.6px;line-height:1.75;counter-reset:sec}\n.agr h3{counter-increment:sec;counter-reset:cl;margin:22px 0 6px;font-size:15.5px;break-after:avoid} .agr h3::before{content:counter(sec) \". \"}\n.agr ol{list-style:none} .agr li{counter-increment:cl;position:relative;padding:2px 42px 4px 0;text-align:justify}\n.agr li::before{content:counter(sec) \".\" counter(cl);position:absolute;right:0;top:2px;font-family:'Rubik',Arial;font-weight:700;color:#0B7F8C;font-size:12.5px}\n.parties{border:1px solid #D9E2E8;background:#fff;border-radius:12px;padding:16px 20px;margin:14px 0 18px}\n.parties .pt{display:grid;grid-template-columns:54px 1fr auto;gap:12px;padding:10px 0;border-top:1px solid #D9E2E8} .parties .pt .lbl{font-weight:700;color:#0C2347} .parties .pt .side{color:#54627A;font-size:12.5px;align-self:end}\n.center{text-align:center} .end{margin-top:22px}\n.bd{font-weight:700;color:#0C2347}\n.blank{display:inline-block;min-width:150px;border-bottom:1px solid #16233A;height:1.1em;vertical-align:baseline}\nmark.chk{background:#FDE9B8;color:inherit;border-radius:3px;padding:0 2px} body.nohl mark.chk{background:none;padding:0}\n/* signature */\n.sig{display:grid;grid-template-columns:1fr 1fr;gap:36px;margin-top:18px}\n.sig h4{font-size:17px;margin-bottom:6px} .fld{margin:16px 0 0} .fld small{display:block;font-family:'Rubik',Arial;font-weight:700;color:#0C2347;font-size:13px}\n.fld .ln{height:32px;overflow:hidden;white-space:nowrap;padding:4px 2px;border-bottom:3px solid transparent;border-image:linear-gradient(90deg,#2F84CF,#12A5B5) 1;font-size:14px}\n.fld.tall .ln{height:64px} .confirm b{white-space:nowrap}\n.confirm{background:#fff;border:1px solid #D9E2E8;border-radius:12px;padding:14px 18px;margin-top:20px;font-size:13.5px}\n.box{display:inline-block;width:13px;height:13px;border:1.5px solid #0C2347;border-radius:3px;vertical-align:-2px;margin-left:6px}\n\n@media print{\n body{background:#F8FAFB;font-size:10.3pt} #panel{display:none} .wrap{display:block;padding:0;max-width:none}\n .page{box-shadow:none;border-radius:0;margin:0;padding:0;overflow:visible;break-before:page} .page:first-child{break-before:auto}\n .stripe{display:none} .cover{min-height:250mm} .cover .stripe{display:flex;position:static;height:6px;margin-bottom:8mm}\n mark.chk{background:none;padding:0} h3{break-after:avoid} .agr{font-size:9.9pt} h2{font-size:23pt} .cover h1{font-size:38pt}\n}";
const ABOUT_HTML = "<p class=\"lead\">דשן מדיה טק היא חברת טכנולוגיה שמתמחה בבינה מלאכותית (AI) ובפיתוח מוצרים ומערכות בהתאמה אישית לעסקים. אנחנו בונים אתרים, מערכות, פורטלים ואוטומציות שמותאמים בדיוק לצרכים של העסק. ולצד הטכנולוגיה, אנחנו גם חברת שיווק: קמפיינים, קידום אורגני ותוכן שמביאים לקוחות.</p>\n<div class=\"grid g4\"><div class=\"card\"><h4>שקיפות מלאה</h4><p>דיווח, נתונים ותהליכים גלויים כדי שתדעו בדיוק מה קורה.</p></div><div class=\"card\"><h4>חדשנות טכנולוגית</h4><p>כלים מתקדמים וטכנולוגיות עדכניות שמקנות יתרון.</p></div><div class=\"card\"><h4>שיתוף פעולה</h4><p>אנחנו עובדים יחד איתכם כשותפים אמיתיים לדרך.</p></div><div class=\"card\"><h4>ממוקדים בתוצאות</h4><p>כל פעילות מתוכננת כדי להביא תוצאות מדידות.</p></div></div>";
const PROCESS_HTML = "<div class=\"steps\">\n<div class=\"step\"><span class=\"badge\">1</span><b>חתימה ותשלום ההקמה</b><span class=\"t\">חתימה על ההסכם ותשלום שירותי ההקמה. מכאן מתחילים לעבוד.</span></div>\n<div class=\"step\"><span class=\"badge\">2</span><b>היכרות ומטרות</b><span class=\"t\">שיחת עבודה להגדרת יעדים, קהלי יעד ומדדי הצלחה.</span></div>\n<div class=\"step\"><span class=\"badge\">3</span><b>מחקר ואבחון</b><span class=\"t\">הכרת השוק והמתחרים, ניתוח הנכסים הדיגיטליים ואיתור הזדמנויות.</span></div>\n<div class=\"step\"><span class=\"badge\">4</span><b>אסטרטגיה מותאמת</b><span class=\"t\">בניית תוכנית עבודה מפורטת עם ערוצים, תקציב ולוחות זמנים.</span></div>\n<div class=\"step\"><span class=\"badge\">5</span><b>יישום וביצוע</b><span class=\"t\">הפעלת הקמפיינים והנכסים, בדיקות ואופטימיזציה שוטפת.</span></div>\n<div class=\"step\"><span class=\"badge\">6</span><b>צמיחה מתמשכת</b><span class=\"t\">דוחות חודשיים, אופטימיזציה מתמדת והרחבה של מה שעובד.</span></div>\n</div>";
const AGREEMENT_HTML = "<div class=\"parties\">\n<p class=\"center\"><b>שנערך ונחתם ביום <span class=\"bd\" data-b=\"date\"></span></b></p>\n<div class=\"pt\"><span class=\"lbl\">בין:</span><div><span class=\"bd\" data-b=\"companyLegal\"></span>, ח.פ./ע.מ. <span class=\"bd\" data-b=\"companyId\"></span><br>מרחוב יהושפט 11, רמת גן<br>(להלן: <b>\"החברה\"</b> או <b>\"דשן מדיה טק\"</b>)</div><span class=\"side\">מצד אחד</span></div>\n<div class=\"pt\"><span class=\"lbl\">לבין:</span><div><span class=\"bd\" data-b=\"client\"></span>, ח.פ./ע.מ. <span class=\"bd\" data-b=\"clientId\"></span><br>מ-<span class=\"bd\" data-b=\"clientAddress\"></span><br>(להלן: <b>\"הלקוח\"</b>)</div><span class=\"side\">מצד שני</span></div>\n</div>\n<p><b>הואיל</b> והחברה עוסקת במתן שירותי טכנולוגיה, פיתוח מערכות, בינה מלאכותית ושיווק דיגיטלי לעסקים;</p>\n<p><b>והואיל</b> והלקוח מעוניין לקבל מהחברה את השירותים המפורטים בהצעת המחיר המצורפת להסכם זה, והחברה מעוניינת לספקם, הכל בהתאם לתנאי הסכם זה;</p>\n<p><b>לפיכך הוסכם, הותנה והוצהר בין הצדדים כדלקמן:</b></p><h3>מבוא, נספחים ופרשנות</h3><ol><li>המבוא להסכם זה, הצעת המחיר ופירוט החיוב המצורפים לו (להלן: <b>\"נספח פירוט החיוב\"</b>) מהווים חלק בלתי נפרד ממנו.</li><li>בכל מקרה של סתירה בין הוראות ההסכם לבין נספח פירוט החיוב, יגברו הוראות הנספח בכל הנוגע להיקף השירותים ולמחירם, והוראות ההסכם בכל עניין אחר.</li><li>כותרות הסעיפים נועדו לנוחות בלבד ולא ישמשו לפרשנות ההסכם. האמור בלשון זכר מתייחס גם ללשון נקבה, ולהפך.</li></ol><h3>השירותים</h3><ol><li>החברה תספק ללקוח את השירותים המפורטים בנספח פירוט החיוב בלבד (להלן: <b>\"השירותים\"</b>). שירות שאינו מפורט בנספח אינו כלול בהסכם זה, ויסופק רק לפי הצעת מחיר נפרדת ובכתב.</li><li>השירותים מתחלקים לשני סוגים: (א) <b>שירותי הקמה</b>, המסופקים פעם אחת, כגון בניית אתר או דף נחיתה, הקמת מערכות וחיבורן; (ב) <b>שירותים חודשיים</b>, המסופקים באופן שוטף לאורך תקופת ההתקשרות, כגון ניהול קמפיינים, ניהול רשתות חברתיות ותחזוקה.</li><li>לוחות הזמנים לביצוע שירותי ההקמה ייקבעו בתוכנית העבודה שתגובש עם הלקוח לאחר חתימת ההסכם, ויהיו כפופים לקבלת החומרים והאישורים הנדרשים מהלקוח במועד.</li><li>שירותי ההקמה כוללים שני (2) סבבי תיקונים. תיקונים נוספים, או שינויים מהותיים באפיון לאחר שאושר, יחויבו בנפרד ובתיאום מראש.</li><li>החברה רשאית להיעזר בעובדים, בקבלני משנה ובכלים טכנולוגיים, לרבות כלי בינה מלאכותית, לצורך מתן השירותים, ותישא באחריות לשירותים כלפי הלקוח גם כאשר נעזרה בהם.</li><li>תכנים ותוצרים שנוצרו בעזרת כלי בינה מלאכותית ייבדקו על ידי צוות החברה לפני שיימסרו ללקוח או יפורסמו.</li></ol><h3>התמורה ותנאי התשלום</h3><ol><li>בתמורה לשירותים ישלם הלקוח לחברה את הסכומים המפורטים בנספח פירוט החיוב (להלן: <b>\"התמורה\"</b>).</li><li>כל המחירים הנקובים בהסכם ובנספח אינם כוללים מע\"מ. מע\"מ יתווסף לכל תשלום בשיעור הקבוע בדין במועד התשלום (במועד חתימת ההסכם: <span class=\"bd\" data-b=\"vat\"></span>).</li><li>התמורה עבור שירותי ההקמה תשולם במלואה (100%) במועד חתימת ההסכם. החברה תתחיל בביצוע השירותים לאחר קבלת התשלום.</li><li>התמורה עבור השירותים החודשיים תשולם מראש, בתחילת כל חודש, החל מהחודש שבו מתחיל מתן השירותים החודשיים.</li><li>התשלום יבוצע בכרטיס אשראי, בהוראת קבע או בהעברה בנקאית. החברה תנפיק ללקוח חשבונית מס כדין עבור כל תשלום.</li><li>המחירים בנספח פירוט החיוב, לרבות הנחה ככל שניתנה, קבועים לכל תקופת ההתחייבות. לאחר תום תקופת ההתחייבות רשאית החברה לעדכן את מחירי השירותים החודשיים בהודעה מראש של <span class=\"bd\" data-b=\"notice\"></span>.</li><li>תקציב הפרסום המשולם לפלטפורמות הפרסום אינו כלול בתמורה, וישולם על ידי הלקוח ישירות לפלטפורמות כמפורט בסעיף 6 להלן.</li><li>עלויות של צדדים שלישיים שאינן מפורטות בנספח פירוט החיוב, כגון חידוש דומיין, אחסון, רישיונות תוכנה ומנויים לכלים חיצוניים, יחולו על הלקוח, וישולמו על ידו ישירות לספק או באמצעות החברה, לאחר אישורו מראש.</li><li>לא שולם תשלום במועדו, רשאית החברה, לאחר התראה בכתב של 7 ימים, להשהות את מתן השירותים עד להסדרת התשלום, ולא יהיה בכך משום הפרה של ההסכם מצדה.</li></ol><h3>תקופת ההתקשרות וסיומה</h3><ol><li>ההסכם נכנס לתוקף במועד חתימתו על ידי שני הצדדים.</li><li>השירותים החודשיים יסופקו לתקופת התחייבות מינימלית של <span class=\"bd\" data-b=\"commit\"></span>, שתחילתה במועד תחילת מתן השירותים החודשיים (להלן: <b>\"תקופת ההתחייבות\"</b>).</li><li>בתום תקופת ההתחייבות יימשך ההסכם מחודש לחודש, וכל צד רשאי לסיימו בהודעה בכתב לצד השני, <span class=\"bd\" data-b=\"notice\"></span> מראש.</li><li>לקוח שיבקש לסיים את ההסכם לפני תום תקופת ההתחייבות ישלם את התמורה החודשית עבור יתרת החודשים שנותרו עד תום תקופת ההתחייבות.</li><li>כל צד רשאי לבטל את ההסכם לאלתר, בהודעה בכתב, אם הצד השני הפר אותו הפרה יסודית ולא תיקן את ההפרה בתוך 14 ימים מקבלת התראה בכתב.</li><li>תמורה ששולמה עבור שירותי הקמה שהחברה החלה בביצועם לא תוחזר.</li><li>עם סיום ההסכם, מכל סיבה: (א) הלקוח ישלם את כל הסכומים שמועד תשלומם הגיע; (ב) החברה תעביר ללקוח את הנכסים, ההרשאות והחומרים כמפורט בסעיף 7 להלן, בכפוף לתשלום מלא; (ג) החברה תפסיק את הקמפיינים שבניהולה, אלא אם הלקוח ביקש אחרת בכתב.</li></ol><h3>התחייבויות הלקוח</h3><ol><li>הלקוח ימסור לחברה במועד את כל החומרים, המידע, הגישות וההרשאות הנדרשים למתן השירותים, ויאשר תוצרים בתוך זמן סביר. עיכוב מצד הלקוח ידחה את לוחות הזמנים בהתאם, ולא יהווה הפרה מצד החברה.</li><li>הלקוח מצהיר כי הוא בעל הזכויות בכל חומר שהוא מוסר לחברה, כגון טקסטים, תמונות, סרטונים, סימני מסחר ורשימות לקוחות, וכי השימוש בהם לצורך השירותים אינו מפר זכות של צד שלישי.</li><li>הלקוח אחראי לנכונות המידע על העסק, המוצרים, המחירים והמבצעים המוצגים בפרסום ובאתר, ולעמידתם בדין, לרבות דיני הגנת הצרכן.</li><li>הלקוח אחראי לכך שכל נמען של הודעה שיווקית (SMS, WhatsApp או דוא\"ל) שתישלח עבורו נתן את הסכמתו כנדרש בחוק התקשורת (בזק ושידורים), התשמ\"ב-1982, ובכל דין אחר.</li><li>הלקוח ימנה איש קשר מטעמו, שאישוריו והחלטותיו בקשר עם השירותים יחייבו את הלקוח.</li></ol><h3>פלטפורמות פרסום וצדדים שלישיים</h3><ol><li>קמפיינים ממומנים יופעלו בחשבונות פרסום הרשומים על שם הלקוח, או בחשבונות שיועברו לבעלותו כמפורט בסעיף 7 להלן.</li><li>תקציב הפרסום ייקבע בתיאום עם הלקוח וישולם על ידו ישירות לפלטפורמה (כגון Meta, Google ו-TikTok), באמצעי תשלום שלו.</li><li>השירותים נשענים על פלטפורמות וכלים של צדדים שלישיים, כגון Meta, Google, TikTok, WhatsApp וספקי אחסון וסליקה. החברה אינה אחראית לשינויים במדיניות, במחירים או בזמינות של פלטפורמות אלה, לחסימת חשבונות או לדחיית מודעות על ידן, אך תפעל במאמץ סביר לפתרון כל בעיה כאמור.</li><li>השימוש בכלים ובפלטפורמות של צדדים שלישיים כפוף לתנאי השימוש שלהם.</li></ol><h3>קניין רוחני ובעלות על הנכסים</h3><ol><li>בכפוף לתשלום מלא של כל התמורה, כל הזכויות בתוצרים שהחברה יצרה עבור הלקוח במסגרת הסכם זה, לרבות האתר, דפי הנחיתה, התכנים, העיצובים, המודעות והקוד שפותח במיוחד עבורו, יהיו בבעלות הלקוח.</li><li>הדומיין, חשבונות הפרסום, עמודי הרשתות החברתיות וחשבונות המערכות שהוקמו עבור הלקוח יירשמו על שמו, או יועברו לבעלותו המלאה, בכפוף לתשלום מלא.</li><li>תוכנות, תוספים, ערכות עיצוב, גופנים ושירותים של צדדים שלישיים ששולבו בתוצרים כפופים לתנאי הרישיון של בעליהם, והלקוח יקבל זכות שימוש בהם בהתאם לאותם תנאים בלבד.</li><li>עד לתשלום מלא יישארו הזכויות בתוצרים בידי החברה, והלקוח יהיה רשאי להשתמש בהם לצורך עסקו כל עוד הוא עומד בתנאי התשלום.</li><li>עם סיום ההתקשרות, ולפי בקשת הלקוח, תמסור לו החברה את פרטי הגישה וההרשאות לכל הנכסים שבבעלותו.</li><li>החברה רשאית להציג את העבודה שביצעה עבור הלקוח בתיק העבודות ובחומרי השיווק שלה, אלא אם הלקוח ביקש אחרת בכתב.</li></ol><h3>סודיות והגנת מידע</h3><ol><li>כל צד ישמור בסודיות כל מידע עסקי של הצד השני שהגיע אליו במסגרת ההסכם, ולא ישתמש בו אלא לצורך ביצוע ההסכם. חובה זו תחול גם לאחר סיום ההסכם.</li><li>מידע אישי של לקוחות ולידים של הלקוח, שיעבור דרך מערכות שהחברה מפעילה עבורו, יעובד לצורך מתן השירותים בלבד ובהתאם לחוק הגנת הפרטיות, התשמ\"א-1981 ולתקנות שהותקנו מכוחו. הלקוח הוא בעל המאגר והאחראי לו, והחברה תפעל לפי הנחיותיו ותנקוט אמצעי אבטחה סבירים.</li><li>עם סיום ההתקשרות תעביר החברה ללקוח, לפי בקשתו, את המידע שנאסף עבורו, ותמחק את העותקים שבידיה, אלא אם היא נדרשת לשמרם על פי דין.</li></ol><h3>אחריות והגבלת אחריות</h3><ol><li>החברה תספק את השירותים במקצועיות, בנאמנות ובהתאם לסטנדרטים המקובלים בתחום.</li><li>תוצאות שיווקיות, כגון מספר לידים, עלות לליד, דירוג בגוגל, מכירות והכנסות, תלויות בגורמים רבים שאינם בשליטת החברה, לרבות השוק, התחרות ומדיניות הפלטפורמות. לכן החברה אינה מתחייבת לתוצאה עסקית מסוימת, וכל תחזית או יעד שהוצגו ללקוח הם הערכה בלבד.</li><li>החברה לא תהיה אחראית לנזק עקיף או תוצאתי, לרבות אובדן רווח או הכנסה, שנגרם ללקוח בקשר עם השירותים.</li><li>למעט במקרה של מעשה בזדון, אחריות החברה כלפי הלקוח בקשר עם הסכם זה לא תעלה על סך התמורה ששולמה לה בפועל בשלושת החודשים שקדמו לאירוע שבגינו נטענה האחריות.</li><li>אם שירות התאמת נגישות לא נכלל בנספח פירוט החיוב, האחריות להתאמת האתר לדרישות הנגישות שבדין חלה על הלקוח.</li></ol><h3>יחסי הצדדים</h3><ol><li>החברה היא קבלן עצמאי. אין בהסכם זה כדי ליצור יחסי עובד ומעביד, שותפות או סוכנות בין הצדדים, או בין הלקוח לבין מי מטעם החברה.</li></ol><h3>כללי</h3><ol><li>הסכם זה ונספחיו ממצים את ההסכמות בין הצדדים, ומבטלים כל הצעה, מצג או הסכמה קודמים, בכתב או בעל פה.</li><li>שינוי בהסכם יהיה תקף רק אם נעשה בכתב ונחתם על ידי שני הצדדים.</li><li>הלקוח לא יהיה רשאי להעביר לאחר את זכויותיו או חובותיו לפי ההסכם, אלא בהסכמת החברה מראש ובכתב.</li><li>הודעות לפי הסכם זה יישלחו לפרטי הקשר המופיעים בעמוד החתימה. הודעה שנשלחה בדוא\"ל תיחשב כאילו התקבלה ביום העסקים שלאחר שליחתה. אישורי תוצרים ותיאומים שוטפים יכולים להינתן גם בדוא\"ל או ב-WhatsApp מאיש הקשר של כל צד.</li><li>ויתור, הימנעות או שיהוי של צד בהפעלת זכות מזכויותיו לא יהוו ויתור על אותה זכות.</li><li>על הסכם זה יחול הדין הישראלי בלבד. סמכות השיפוט הבלעדית בכל עניין הנוגע להסכם נתונה לבתי המשפט המוסמכים במחוז תל אביב-יפו.</li><li>ההסכם ייחתם בחתימה ידנית, סרוקה או אלקטרונית, וכל עותק חתום יחייב כמקור.</li></ol><p class=\"end\"><b>ולראיה באו הצדדים על החתום.</b> החתימות בעמוד \"אישור וחתימה\" שבסוף מסמך זה.</p>";

const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fm = n => Math.round(Number(n) || 0).toLocaleString("en-US") + " ₪";
const dfmt = iso => { if (!iso) return ""; const [y, m, d] = String(iso).split("-"); return `${d}.${m}.${y}`; };
const addDays = (iso, n) => { const d = new Date(`${iso}T12:00:00`); d.setDate(d.getDate() + Number(n || 0)); return d.toISOString().slice(0, 10); };
const blank = '<span class="blank"></span>';
const val = v => (v != null && String(v).trim() ? esc(v) : blank);

function stripe() {
  return '<div class="stripe">' + ["#F2603D", "#F7A832", "#F9DF3A", "#36C77F", "#2F84CF"].map(c => `<i style="background:${c}"></i>`).join("") + "</div>";
}

function split(q) {
  const lines = q.lines || [];
  return { s: lines.filter(l => l.billing !== "monthly"), m: lines.filter(l => l.billing === "monthly") };
}

function cover(q, T, L) {
  const C = q.client || {};
  return `<section class="page cover">${stripe()}<div class="top">${logo() ? `<img class="logo" src="${logo()}" alt="דשן מדיה טק">` : "<b>DESHEN</b>"}<div class="qn">הצעה מס׳<b>${esc(q.quoteNo)}</b>${dfmt(q.quoteDate)}</div></div>
 <div class="mid"><div class="eyebrow" style="font-size:15px">הצעת מחיר והסכם התקשרות</div><h1>צמיחה שמתחילה <span>במספרים</span></h1>
 <div class="for">הוכן עבור: ${C.name ? esc(C.name) : '<span class="blank" style="min-width:260px"></span>'}</div>
 <div class="sub">${L.s.length} שירותי הקמה · ${L.m.length} שירותים חודשיים · התחייבות ${esc(q.commitMonths)} חודשים</div>
 <div class="hero"><div><small>לתשלום בחתימה (הקמה)</small><div class="big y">${fm(T.setup.total)}</div><div class="n">כולל מע"מ ${esc(T.vatPct)}%</div></div>
 <div><small>תשלום חודשי</small><div class="big">${fm(T.monthly.total)}</div><div class="n">כולל מע"מ · למשך ${esc(q.commitMonths)} חודשים לפחות</div></div>
 <div><small>סה"כ לתקופת ההתחייבות</small><div class="big">${fm(T.commitTotal)}</div><div class="n">הקמה + ${esc(q.commitMonths)} תשלומים חודשיים</div></div></div></div>
 <div class="meta"><div><small>לכבוד</small><b>${val(C.name)}</b>${C.contact ? `<div style="font-size:12.5px;color:#54627A">${esc(C.contact)}${C.role ? ", " + esc(C.role) : ""}</div>` : ""}</div>
 <div><small>מאת</small><b>${esc(COMPANY.legal)}</b><div style="font-size:12.5px;color:#54627A">${esc(COMPANY.signer)}, ${esc(COMPANY.role)}</div></div>
 <div><small>תוקף ההצעה</small><b>עד ${dfmt(addDays(q.quoteDate, q.validDays))}</b><div style="font-size:12.5px;color:#54627A">${esc(q.validDays)} יום מיום ההצעה</div></div>
 <div><small>יצירת קשר</small><b>${esc(COMPANY.phone)}</b><div style="font-size:12.5px;color:#54627A">${esc(COMPANY.email)} · ${esc(COMPANY.site)}</div></div></div></section>`;
}

function included(L) {
  const card = l => `<div class="card w"><h4>${esc(l.name)}${l.qty > 1 ? " ×" + l.qty : ""}</h4><p>${esc(l.description)}</p></div>`;
  let h = "";
  if (L.s.length) h += `<div class="blockhd"><span class="pill p-s">הקמה חד-פעמית</span></div><div class="grid g3">${L.s.map(card).join("")}</div>`;
  if (L.m.length) h += `<div class="blockhd"><span class="pill p-m">חודשי</span></div><div class="grid g3">${L.m.map(card).join("")}</div>`;
  return `<section class="page"><div class="eyebrow">01 · מי אנחנו ומה כלול</div><h2>דשן מדיה טק</h2>${ABOUT_HTML}<h3>מה כלול בהצעה</h3>${h || '<p class="lead">עדיין לא נבחרו שירותים.</p>'}</section>`;
}

function table(lines, monthly) {
  return `<table><thead><tr><th>שירות</th><th class="c">כמות</th><th class="pr">מחיר יחידה</th><th class="pr">סה"כ${monthly ? " לחודש" : ""}</th></tr></thead><tbody>` +
    lines.map(l => `<tr><td class="nm"><b>${esc(l.name)}</b><small>${esc(l.description)}</small></td><td class="c">${l.qty}</td><td class="pr">${fm(l.price)}</td><td class="pr t">${fm(l.price * l.qty)}</td></tr>`).join("") +
    "</tbody></table>";
}

function sumBox(b, T, label, sub) {
  return `<div class="sum"><div class="r"><span>סכום ביניים</span><span>${fm(b.sub)}</span></div>` +
    (T.discountPct ? `<div class="r d"><span>הנחה ${esc(T.discountPct)}%</span><span>-${fm(b.disc)}</span></div>` : "") +
    `<div class="r"><span>לפני מע"מ</span><span>${fm(b.net)}</span></div><div class="r"><span>מע"מ ${esc(T.vatPct)}%</span><span>${fm(b.vat)}</span></div>` +
    `<div class="r k"><span>${label}<small>${sub}</small></span><span>${fm(b.total)}</span></div></div>`;
}

function billing(q, T, L) {
  let h = "";
  if (L.s.length) h += `<div class="blockhd"><span class="badge">א</span><h4>שירותי הקמה</h4><span class="pill p-s">תשלום חד-פעמי</span></div>` + table(L.s, false) + sumBox(T.setup, T, "לתשלום בחתימה", "100% במועד חתימת ההסכם");
  if (L.m.length) h += `<div class="blockhd"><span class="badge">${L.s.length ? "ב" : "א"}</span><h4>שירותים חודשיים</h4><span class="pill p-m">תשלום חודשי</span></div>` + table(L.m, true) + sumBox(T.monthly, T, "תשלום חודשי", `למשך ${esc(q.commitMonths)} חודשים לפחות`);
  if (L.m.length) h += `<div class="commit"><div><small>הקמה (כולל מע"מ)</small><b>${fm(T.setup.total)}</b></div><div><small>${esc(q.commitMonths)} חודשים × ${fm(T.monthly.total)}</small><b>${fm(T.monthly.total * q.commitMonths)}</b></div><div class="t"><small>סה"כ לתקופת ההתחייבות (כולל מע"מ)</small><b>${fm(T.commitTotal)}</b></div></div>`;
  h += '<p class="note">תקציב הפרסום המשולם לפלטפורמות (Meta, Google, TikTok) אינו כלול בהצעה, ומשולם על ידי הלקוח ישירות לפלטפורמה.</p>';
  return `<section class="page"><div class="eyebrow">02 · פירוט חיוב</div><h2>פירוט חיוב</h2><p class="lead">המחירים בשקלים ואינם כוללים מע"מ. מע"מ בשיעור ${esc(T.vatPct)}% מתווסף בשורת הסיכום.</p>${(L.s.length || L.m.length) ? h : '<p class="lead">עדיין לא נבחרו שירותים.</p>'}</section>`;
}

function terms(q, T) {
  const t = [
    ["₪", "תשלום ההקמה", "100% במועד חתימת ההסכם"],
    ["↻", "תשלום חודשי", "משולם מראש בתחילת כל חודש"],
    [esc(q.commitMonths), "התחייבות", `${esc(q.commitMonths)} חודשים לשירותים החודשיים`],
    ["→", "אחרי ההתחייבות", `חודש-בחודש, סיום בהודעה של ${esc(q.noticeDays)} יום מראש`],
    ["%", 'מע"מ', `המחירים לפני מע"מ. מע"מ ${esc(T.vatPct)}% מתווסף`],
    ["✓", "בעלות", "כל התוצרים, הדומיין וחשבונות הפרסום שלכם, אחרי תשלום מלא"],
    ["◎", "תקציב פרסום", "משולם על ידכם ישירות לפלטפורמות"],
    ["⏱", "תוקף ההצעה", `${esc(q.validDays)} יום, עד ${dfmt(addDays(q.quoteDate, q.validDays))}`],
  ];
  return `<section class="page terms"><div class="eyebrow">03 · תנאים ותהליך</div><h2>התנאים בקצרה</h2><div class="grid g2">` +
    t.map(x => `<div class="card"><h4><span class="ic">${x[0]}</span>${x[1]}</h4><p>${x[2]}</p></div>`).join("") +
    `</div><h3>תהליך העבודה שלנו</h3>${PROCESS_HTML}</section>`;
}

function agreement(q, T) {
  const C = q.client || {};
  const b = {
    date: val(dfmt(q.quoteDate)), companyLegal: val(COMPANY.legal), companyId: val(COMPANY.id),
    client: val(C.name), clientId: val(C.id), clientAddress: val(C.address),
    vat: esc(T.vatPct) + "%", commit: esc(q.commitMonths) + " חודשים", notice: esc(q.noticeDays) + " יום",
  };
  const body = AGREEMENT_HTML.replace(/<span class="bd" data-b="(\w+)"><\/span>/g, (_, k) => `<span class="bd">${b[k] ?? ""}</span>`);
  return `<section class="page agr"><div class="eyebrow">04 · ההסכם</div><h2>הסכם התקשרות למתן שירותים</h2>${body}</section>`;
}

/* Israel-time "dd.mm.yyyy" and "HH:MM" of a Date. */
function ilParts(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jerusalem", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(date)).map(x => [x.type, x.value]));
  return { date: `${p.day}.${p.month}.${p.year}`, time: `${p.hour}:${p.minute}` };
}

/* signed: { at, name, role, signature (PNG data URL), ip, id } — present
   only on the frozen copy saved when the client signs. */
function signature(q, T, L, signed) {
  const C = q.client || {};
  const f = (l, v, tall, raw) => `<div class="fld${tall ? " tall" : ""}"><small>${l}</small><div class="ln">${raw || (v ? esc(v) : "")}</div></div>`;
  const box = `<span class="box${signed ? " on" : ""}"></span>`;
  const when = signed ? ilParts(signed.at) : null;
  const sigImg = signed && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(signed.signature || "")
    ? `<img class="sigimg" src="${signed.signature}" alt="חתימת הלקוח">` : "";
  const audit = signed
    ? `<div class="audit">נחתם אלקטרונית על ידי <b>${esc(signed.name)}</b>${signed.role ? `, ${esc(signed.role)}` : ""} בתאריך ${when.date} בשעה ${when.time} (שעון ישראל)${signed.ip ? ` · כתובת IP ${esc(signed.ip)}` : ""} · מזהה חתימה ${esc(signed.id || "")}</div>`
    : "";
  return `<section class="page"><div class="eyebrow">05 · אישור וחתימה</div><h2>אישור וחתימה</h2><p class="lead">בחתימתם מאשרים הצדדים את הסכם ההתקשרות ואת נספח פירוט החיוב (הצעה מס׳ ${esc(q.quoteNo)} מיום ${dfmt(q.quoteDate)}).</p>
 <div class="confirm">${box}הלקוח מאשר שקרא את ההסכם ואת נספח פירוט החיוב, הבין אותם ומסכים לכל תנאיהם.<br>${box}הלקוח מאשר תשלום של <b>${fm(T.setup.total)}</b> (כולל מע"מ) עבור שירותי ההקמה במועד החתימה${L.m.length ? `, ותשלום חודשי של <b>${fm(T.monthly.total)}</b> (כולל מע"מ) למשך ${esc(q.commitMonths)} חודשים לפחות` : ""}.</div>
 <div class="sig"><div><h4>הלקוח</h4>${f("שם העסק / הלקוח", C.name)}${f("ח.פ. / ע.מ.", C.id)}${f("כתובת", C.address)}${f("טלפון", C.phone)}${f('דוא"ל', C.email)}${f("שם החותם ותפקידו", [C.contact, C.role].filter(Boolean).join(", "))}${f("תאריך", when ? when.date : "")}${f("חתימה וחותמת", "", 1, sigImg)}</div>
 <div><h4>דשן מדיה טק</h4>${f("שם הישות", COMPANY.legal)}${f("ח.פ. / ע.מ.", COMPANY.id)}${f("כתובת", COMPANY.address)}${f("טלפון", COMPANY.phone)}${f('דוא"ל', COMPANY.email)}${f("שם החותם ותפקידו", `${COMPANY.signer}, ${COMPANY.role}`)}${f("תאריך", dfmt(q.quoteDate))}${f("חתימה וחותמת", "", 1, stamp() ? `<img class="stampimg" src="${stamp()}" alt="חותמת דשן מדיה טק">` : "")}</div></div>${audit}</section>`;
}

function pageCss(q) {
  const no = String(q.quoteNo || "").replace(/[^\w-]/g, "");
  return `@page{size:A4;margin:16mm 14mm 17mm;@top-right{content:'דשן מדיה טק · הצעת מחיר והסכם התקשרות';font:700 8.5pt Rubik,Arial;color:#0C2347}@top-left{content:'הצעה מס׳ ${no}';font:8.5pt Rubik,Arial;color:#54627A}@bottom-left{content:'עמוד ' counter(page) ' מתוך ' counter(pages);font:8.5pt Rubik,Arial;color:#54627A}@bottom-center{content:'ראשי תיבות הלקוח: ____________';font:8.5pt Rubik,Arial;color:#54627A}@bottom-right{content:'deshen.co';font:8.5pt Rubik,Arial;color:#54627A}}@page:first{@top-right{content:''}@top-left{content:''}@bottom-center{content:''}}`;
}

/* Toolbar shown on screen only (hidden when printing). */
const TOOLBAR_CSS = `.tb{position:sticky;top:0;z-index:5;display:flex;gap:8px;justify-content:center;padding:10px;background:rgba(230,236,240,.92);backdrop-filter:blur(6px)}
.tb button{font-family:'Rubik',Arial;font-weight:700;font-size:13px;border:0;border-radius:18px;padding:8px 18px;cursor:pointer;background:#0C2347;color:#fff}
.tb span{align-self:center;font-size:12.5px;color:#54627A}
.tb .ok{color:#15803D;font-weight:700}
.box.on{position:relative;background:#0C2347}.box.on::after{content:"✓";position:absolute;inset:-3px 0 0;color:#fff;font-size:11px;font-weight:800;text-align:center}
.fld.tall .ln{display:flex;align-items:flex-end;height:auto;min-height:64px;overflow:visible}.sigimg{max-height:60px;max-width:100%;object-fit:contain}
.stampimg{height:118px;max-width:100%;object-fit:contain;object-position:right bottom}
.audit{margin-top:22px;padding:10px 14px;border:1px dashed #9FB6CB;border-radius:10px;font-size:12px;color:#54627A;background:#fff}
@media screen{.wrap{display:block;max-width:900px}}
@media print{.tb{display:none}}`;

function renderQuoteHtml(q, { signed = null } = {}) {
  const T = q.totals;
  const L = split(q);
  const title = `${signed ? "הסכם חתום" : "הצעת מחיר"} ${q.quoteNo}${q.client?.name ? " · " + q.client.name : ""}`;
  return `<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Rubik:wght@400..800&family=Heebo:wght@400;500;700&display=swap">
<style>${CSS}\n${TOOLBAR_CSS}</style><style>${pageCss(q)}</style></head><body class="nohl">
<div class="tb"><button type="button" onclick="window.print()">הדפסה / שמירה כ-PDF</button><span>הצעה מס׳ ${esc(q.quoteNo)}</span>${signed ? `<span class="ok">✓ נחתם ${ilParts(signed.at).date}</span>` : ""}</div>
<div class="wrap"><main id="doc">${cover(q, T, L)}${included(L)}${billing(q, T, L)}${terms(q, T)}${agreement(q, T)}${signature(q, T, L, signed)}</main></div>
</body></html>`;
}

module.exports = { renderQuoteHtml, COMPANY, logo, addDays, ilParts };
