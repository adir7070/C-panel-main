/**
 * Facebook Ads targeting reference data — curated lists in Hebrew that mirror
 * what Facebook Ads Manager surfaces in its audience builder.
 *
 * Where Facebook IDs are known they are stored alongside; missing IDs are left
 * as the Hebrew label (the backend can resolve or accept free-text).
 *
 * This is intentionally curated (not exhaustive) — covers the 80% of targeting
 * decisions an Israeli account manager makes. Free-text fallback handles the
 * rest, and a future server proxy to Facebook's `/search?type=adinterest` API
 * can replace the static lists.
 */

import type { FbInterest } from "../api/client";

/* ── Languages ───────────────────────────────────────────────────────── */

export const FB_LANGUAGES: { code: string; label: string }[] = [
  { code: "he", label: "עברית" },
  { code: "ar", label: "ערבית" },
  { code: "en", label: "אנגלית" },
  { code: "ru", label: "רוסית" },
  { code: "fr", label: "צרפתית" },
  { code: "es", label: "ספרדית" },
  { code: "am", label: "אמהרית" },
  { code: "de", label: "גרמנית" },
  { code: "it", label: "איטלקית" },
  { code: "pt", label: "פורטוגזית" },
];

/* ── Israel — administrative regions (FB district keys) ─────────────── */

export const ISRAEL_REGIONS: { key: string; label: string }[] = [
  { key: "il_jerusalem", label: "מחוז ירושלים" },
  { key: "il_north",     label: "מחוז הצפון" },
  { key: "il_haifa",     label: "מחוז חיפה" },
  { key: "il_center",    label: "מחוז המרכז" },
  { key: "il_tel_aviv",  label: "מחוז תל אביב" },
  { key: "il_south",     label: "מחוז הדרום" },
  { key: "il_judea",     label: "יהודה ושומרון" },
];

/* ── Top Israeli cities (used for radius targeting) ─────────────────── */

export const ISRAEL_CITIES: { key: string; label: string }[] = [
  { key: "tel_aviv",       label: "תל אביב–יפו" },
  { key: "jerusalem",      label: "ירושלים" },
  { key: "haifa",          label: "חיפה" },
  { key: "rishon_lezion",  label: "ראשון לציון" },
  { key: "petah_tikva",    label: "פתח תקווה" },
  { key: "ashdod",         label: "אשדוד" },
  { key: "netanya",        label: "נתניה" },
  { key: "beer_sheva",     label: "באר שבע" },
  { key: "holon",          label: "חולון" },
  { key: "bnei_brak",      label: "בני ברק" },
  { key: "ramat_gan",      label: "רמת גן" },
  { key: "rehovot",        label: "רחובות" },
  { key: "bat_yam",        label: "בת ים" },
  { key: "ashkelon",       label: "אשקלון" },
  { key: "kfar_saba",      label: "כפר סבא" },
  { key: "herzliya",       label: "הרצליה" },
  { key: "hadera",         label: "חדרה" },
  { key: "modiin",         label: "מודיעין-מכבים-רעות" },
  { key: "lod",            label: "לוד" },
  { key: "raanana",        label: "רעננה" },
  { key: "ramla",          label: "רמלה" },
  { key: "rishpon",        label: "רישפון" },
  { key: "nazareth",       label: "נצרת" },
  { key: "kiryat_gat",     label: "קריית גת" },
  { key: "kiryat_ata",     label: "קריית אתא" },
  { key: "kiryat_motzkin", label: "קריית מוצקין" },
  { key: "kiryat_bialik",  label: "קריית ביאליק" },
  { key: "kiryat_yam",     label: "קריית ים" },
  { key: "eilat",          label: "אילת" },
  { key: "tiberias",       label: "טבריה" },
  { key: "afula",          label: "עפולה" },
  { key: "akko",           label: "עכו" },
  { key: "nahariya",       label: "נהריה" },
  { key: "givatayim",      label: "גבעתיים" },
  { key: "rosh_haayin",    label: "ראש העין" },
  { key: "yehud",          label: "יהוד-מונוסון" },
  { key: "or_yehuda",      label: "אור יהודה" },
  { key: "ness_ziona",     label: "נס ציונה" },
  { key: "yavne",          label: "יבנה" },
  { key: "dimona",         label: "דימונה" },
  { key: "sderot",         label: "שדרות" },
  { key: "ofakim",         label: "אופקים" },
  { key: "netivot",        label: "נתיבות" },
  { key: "karmiel",        label: "כרמיאל" },
  { key: "maalot",         label: "מעלות-תרשיחא" },
  { key: "tzfat",          label: "צפת" },
  { key: "kfar_yona",      label: "כפר יונה" },
  { key: "kadima_tzoran",  label: "קדימה-צורן" },
  { key: "pardes_hana",    label: "פרדס חנה-כרכור" },
  { key: "binyamina",      label: "בנימינה-גבעת עדה" },
];

/* ── Detailed targeting — Interests / Behaviors / Demographics ──────── */

/**
 * Each item has a Facebook id + Hebrew label + bucket discriminator.
 * IDs are real FB targeting IDs where confirmed; the rest use a "tag:"
 * prefix so the backend can route them through the search-fallback.
 */
export interface FbTargetingOption {
  id: string;
  name: string;
  category: string;
  kind: "interest" | "behavior" | "demographic";
}

export const FB_TARGETING_OPTIONS: FbTargetingOption[] = [
  /* — Family & Lifestyle — */
  { id: "6002714398172", name: "הורות",                    category: "משפחה ואורח חיים", kind: "interest" },
  { id: "tag:newborn_parents",   name: "הורים לתינוקות",   category: "משפחה ואורח חיים", kind: "demographic" },
  { id: "tag:parents_toddlers",  name: "הורים לפעוטות",     category: "משפחה ואורח חיים", kind: "demographic" },
  { id: "tag:parents_preteens",  name: "הורים לילדים בגיל ביה\"ס", category: "משפחה ואורח חיים", kind: "demographic" },
  { id: "tag:parents_teens",     name: "הורים לבני נוער",   category: "משפחה ואורח חיים", kind: "demographic" },
  { id: "tag:newly_engaged",     name: "אירוסין לאחרונה",   category: "משפחה ואורח חיים", kind: "demographic" },
  { id: "tag:newly_married",     name: "נשואים טריים",      category: "משפחה ואורח חיים", kind: "demographic" },
  { id: "tag:about_to_marry",    name: "לקראת חתונה",       category: "משפחה ואורח חיים", kind: "demographic" },
  { id: "tag:long_distance_relationship", name: "בקשר רחוק", category: "משפחה ואורח חיים", kind: "demographic" },
  { id: "tag:relationship",      name: "בזוגיות",           category: "משפחה ואורח חיים", kind: "demographic" },
  { id: "tag:single",            name: "רווקים/ות",         category: "משפחה ואורח חיים", kind: "demographic" },

  /* — Sports & Fitness — */
  { id: "6003107902433", name: "כדורגל",                   category: "ספורט וכושר", kind: "interest" },
  { id: "6003170029471", name: "כדורסל",                   category: "ספורט וכושר", kind: "interest" },
  { id: "6003251220851", name: "כושר ואימונים",            category: "ספורט וכושר", kind: "interest" },
  { id: "6003348604581", name: "ריצה",                     category: "ספורט וכושר", kind: "interest" },
  { id: "6003162418008", name: "יוגה",                     category: "ספורט וכושר", kind: "interest" },
  { id: "6003456392254", name: "פילאטיס",                  category: "ספורט וכושר", kind: "interest" },
  { id: "6003318078537", name: "אימוני כוח",               category: "ספורט וכושר", kind: "interest" },
  { id: "tag:cycling",           name: "רכיבה על אופניים", category: "ספורט וכושר", kind: "interest" },
  { id: "tag:swimming",          name: "שחייה",            category: "ספורט וכושר", kind: "interest" },
  { id: "tag:martial_arts",      name: "אומנויות לחימה",   category: "ספורט וכושר", kind: "interest" },
  { id: "tag:crossfit",          name: "קרוספיט",          category: "ספורט וכושר", kind: "interest" },
  { id: "tag:hiking",            name: "טיולים בטבע",      category: "ספורט וכושר", kind: "interest" },

  /* — Food & Drink — */
  { id: "6003277229371", name: "אוכל ומשקאות",             category: "אוכל ושתייה", kind: "interest" },
  { id: "6003172502064", name: "מסעדות",                   category: "אוכל ושתייה", kind: "interest" },
  { id: "tag:cooking",           name: "בישול",            category: "אוכל ושתייה", kind: "interest" },
  { id: "tag:wine",              name: "יין",              category: "אוכל ושתייה", kind: "interest" },
  { id: "tag:coffee",            name: "קפה",              category: "אוכל ושתייה", kind: "interest" },
  { id: "tag:vegan",             name: "טבעוני",           category: "אוכל ושתייה", kind: "interest" },
  { id: "tag:vegetarian",        name: "צמחוני",           category: "אוכל ושתייה", kind: "interest" },
  { id: "tag:kosher",            name: "כשר",              category: "אוכל ושתייה", kind: "interest" },
  { id: "tag:gourmet",           name: "אוכל גורמה",       category: "אוכל ושתייה", kind: "interest" },
  { id: "tag:bakery",            name: "מאפים וקונדיטוריה", category: "אוכל ושתייה", kind: "interest" },

  /* — Beauty & Fashion — */
  { id: "6003020834693", name: "אופנה",                    category: "יופי ואופנה", kind: "interest" },
  { id: "6003462346642", name: "קוסמטיקה",                 category: "יופי ואופנה", kind: "interest" },
  { id: "tag:hair_care",         name: "שיער ומספרות",     category: "יופי ואופנה", kind: "interest" },
  { id: "tag:nails",             name: "ציפורניים",        category: "יופי ואופנה", kind: "interest" },
  { id: "tag:makeup",            name: "איפור",            category: "יופי ואופנה", kind: "interest" },
  { id: "tag:luxury_fashion",    name: "אופנה יוקרתית",    category: "יופי ואופנה", kind: "interest" },
  { id: "tag:bridal",            name: "כלות",             category: "יופי ואופנה", kind: "interest" },
  { id: "tag:jewelry",           name: "תכשיטים",          category: "יופי ואופנה", kind: "interest" },
  { id: "tag:perfume",           name: "בשמים",            category: "יופי ואופנה", kind: "interest" },

  /* — Health & Wellness — */
  { id: "6003277229443", name: "בריאות ואיכות חיים",       category: "בריאות ורווחה", kind: "interest" },
  { id: "tag:nutrition",         name: "תזונה",            category: "בריאות ורווחה", kind: "interest" },
  { id: "tag:weight_loss",       name: "ירידה במשקל",      category: "בריאות ורווחה", kind: "interest" },
  { id: "tag:meditation",        name: "מדיטציה",          category: "בריאות ורווחה", kind: "interest" },
  { id: "tag:alternative_med",   name: "רפואה משלימה",     category: "בריאות ורווחה", kind: "interest" },
  { id: "tag:dental",            name: "טיפולי שיניים",    category: "בריאות ורווחה", kind: "interest" },
  { id: "tag:fertility",         name: "פוריות",           category: "בריאות ורווחה", kind: "interest" },
  { id: "tag:cosmetic_surgery",  name: "ניתוחים אסתטיים",  category: "בריאות ורווחה", kind: "interest" },

  /* — Real Estate & Home — */
  { id: "tag:real_estate",       name: "נדל\"ן",            category: "נדל\"ן ובית", kind: "interest" },
  { id: "tag:home_improvement",  name: "שיפוצים",          category: "נדל\"ן ובית", kind: "interest" },
  { id: "tag:interior_design",   name: "עיצוב פנים",       category: "נדל\"ן ובית", kind: "interest" },
  { id: "tag:gardening",         name: "גינון",            category: "נדל\"ן ובית", kind: "interest" },
  { id: "tag:furniture",         name: "ריהוט",            category: "נדל\"ן ובית", kind: "interest" },
  { id: "tag:home_buyers",       name: "רוכשי דירות (התנהגות)", category: "נדל\"ן ובית", kind: "behavior" },
  { id: "tag:recently_moved",    name: "עברו דירה לאחרונה", category: "נדל\"ן ובית", kind: "behavior" },

  /* — Business & Finance — */
  { id: "tag:small_business",    name: "בעלי עסקים קטנים", category: "עסקים וכספים", kind: "demographic" },
  { id: "tag:entrepreneurs",     name: "יזמים",            category: "עסקים וכספים", kind: "demographic" },
  { id: "tag:freelancers",       name: "פרילנסרים",        category: "עסקים וכספים", kind: "demographic" },
  { id: "tag:investors",         name: "משקיעים",          category: "עסקים וכספים", kind: "interest" },
  { id: "tag:cryptocurrency",    name: "מטבעות דיגיטליים", category: "עסקים וכספים", kind: "interest" },
  { id: "tag:stock_market",      name: "שוק ההון",         category: "עסקים וכספים", kind: "interest" },
  { id: "tag:online_shoppers",   name: "קונים אונליין (התנהגות)", category: "עסקים וכספים", kind: "behavior" },
  { id: "tag:high_net_worth",    name: "בעלי הון גבוה",    category: "עסקים וכספים", kind: "demographic" },

  /* — Tech & Devices — */
  { id: "tag:tech_early_adopters", name: "אוהבי טכנולוגיה (אימוץ מוקדם)", category: "טכנולוגיה ומכשירים", kind: "behavior" },
  { id: "tag:apple_users",       name: "משתמשי Apple",     category: "טכנולוגיה ומכשירים", kind: "behavior" },
  { id: "tag:android_users",     name: "משתמשי Android",   category: "טכנולוגיה ומכשירים", kind: "behavior" },
  { id: "tag:gamers",            name: "גיימרים",          category: "טכנולוגיה ומכשירים", kind: "interest" },
  { id: "tag:smart_home",        name: "בית חכם",          category: "טכנולוגיה ומכשירים", kind: "interest" },

  /* — Travel — */
  { id: "tag:frequent_travellers", name: "נוסעים תכופים (התנהגות)", category: "תיירות ונסיעות", kind: "behavior" },
  { id: "tag:business_travelers",  name: "נוסעי עסקים",    category: "תיירות ונסיעות", kind: "behavior" },
  { id: "tag:cruises",           name: "שייט",             category: "תיירות ונסיעות", kind: "interest" },
  { id: "tag:beach_vacations",   name: "חופשות חוף",       category: "תיירות ונסיעות", kind: "interest" },
  { id: "tag:europe_travel",     name: "טיולים באירופה",   category: "תיירות ונסיעות", kind: "interest" },
  { id: "tag:adventure_travel",  name: "טיולי הרפתקאות",   category: "תיירות ונסיעות", kind: "interest" },

  /* — Education — */
  { id: "tag:students_uni",      name: "סטודנטים באוניברסיטה", category: "השכלה", kind: "demographic" },
  { id: "tag:students_college",  name: "סטודנטים במכללה",  category: "השכלה", kind: "demographic" },
  { id: "tag:online_learning",   name: "לומדים אונליין",   category: "השכלה", kind: "interest" },
  { id: "tag:masters_degree",    name: "תואר שני",         category: "השכלה", kind: "demographic" },
  { id: "tag:professional_dev",  name: "פיתוח מקצועי",     category: "השכלה", kind: "interest" },

  /* — Cars — */
  { id: "tag:car_enthusiasts",   name: "חובבי רכבים",      category: "רכבים", kind: "interest" },
  { id: "tag:luxury_cars",       name: "רכבי יוקרה",       category: "רכבים", kind: "interest" },
  { id: "tag:electric_vehicles", name: "רכבים חשמליים",    category: "רכבים", kind: "interest" },
  { id: "tag:car_buyers_intent", name: "קונים פוטנציאליים של רכב (התנהגות)", category: "רכבים", kind: "behavior" },

  /* — Entertainment — */
  { id: "tag:movies",            name: "סרטים",            category: "בידור", kind: "interest" },
  { id: "tag:music",             name: "מוזיקה",           category: "בידור", kind: "interest" },
  { id: "tag:concerts",          name: "הופעות",           category: "בידור", kind: "interest" },
  { id: "tag:theater",           name: "תיאטרון",          category: "בידור", kind: "interest" },
  { id: "tag:reading",           name: "קריאה וספרים",     category: "בידור", kind: "interest" },
  { id: "tag:streaming",         name: "פלטפורמות סטרימינג", category: "בידור", kind: "interest" },

  /* — Religion / Lifestyle — */
  { id: "tag:religious_jewish",  name: "יהדות / מסורת",    category: "אורח חיים ודת", kind: "interest" },
  { id: "tag:secular",           name: "חילוני",           category: "אורח חיים ודת", kind: "demographic" },
  { id: "tag:religious_muslim",  name: "אסלאם",            category: "אורח חיים ודת", kind: "interest" },
  { id: "tag:lgbtq",             name: "LGBTQ+",           category: "אורח חיים ודת", kind: "demographic" },

  /* — B2B / Job Roles — */
  { id: "tag:job_executive",     name: "מנהלים בכירים",    category: "מקצוע ועיסוק", kind: "demographic" },
  { id: "tag:job_marketing",     name: "אנשי שיווק",       category: "מקצוע ועיסוק", kind: "demographic" },
  { id: "tag:job_sales",         name: "אנשי מכירות",      category: "מקצוע ועיסוק", kind: "demographic" },
  { id: "tag:job_engineer",      name: "מהנדסים / היי-טק", category: "מקצוע ועיסוק", kind: "demographic" },
  { id: "tag:job_healthcare",    name: "צוות רפואי",       category: "מקצוע ועיסוק", kind: "demographic" },
  { id: "tag:job_education",     name: "מורים ומחנכים",    category: "מקצוע ועיסוק", kind: "demographic" },
  { id: "tag:job_legal",         name: "תחום המשפט",       category: "מקצוע ועיסוק", kind: "demographic" },
];

/** Convenience: distinct categories in display order. */
export const FB_TARGETING_CATEGORIES: string[] = (() => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const o of FB_TARGETING_OPTIONS) {
    if (!seen.has(o.category)) { seen.add(o.category); out.push(o.category); }
  }
  return out;
})();

/** Map a curated option to the FbInterest persisted on the service. */
export function toFbInterest(o: FbTargetingOption): FbInterest {
  return { id: o.id, name: o.name, category: o.category, kind: o.kind };
}
