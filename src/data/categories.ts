export interface SubCat { key: string; label: string }
export interface Cat { key: string; label: string; subCategories: SubCat[] }

const OTHER: SubCat = { key: "other_input", label: "אחר" };

export const CATEGORIES: Cat[] = [
  { key: "beauty", label: "יופי וטיפוח", subCategories: [
    { key: "barber", label: "ספרות" }, { key: "womens_salon", label: "מספרה לנשים" },
    { key: "nails", label: "מניקור/פדיקור" }, { key: "cosmetics", label: "קוסמטיקה" },
    { key: "eyebrows", label: "עיצוב גבות" }, { key: "hair_removal", label: "הסרת שיער" },
    { key: "massage", label: "עיסוי" }, { key: "makeup", label: "איפור" },
    { key: "lashes", label: "הארכת ריסים" }, { key: "tanning", label: "שיזוף" },
    { key: "spa", label: "ספא" }, OTHER ]},
  { key: "health", label: "בריאות ורפואה", subCategories: [
    { key: "physio", label: "פיזיותרפיה" }, { key: "private_medicine", label: "רפואה פרטית" },
    { key: "nutrition", label: "תזונה ודיאטה" }, { key: "nursing", label: "שירותי סיעוד" },
    { key: "chiro", label: "כירופרקטיקה" }, { key: "osteo", label: "אוסטאופתיה" },
    { key: "sleep", label: "שינה ואורח חיים" }, { key: "addiction", label: "גמילה והרגלים" }, OTHER ]},
  { key: "dental", label: "רפואת שיניים", subCategories: [
    { key: "general_dental", label: "רופא שיניים כללי" }, { key: "orthodontics", label: "יישור שיניים" },
    { key: "whitening", label: "הלבנת שיניים" }, { key: "implants", label: "שתלים" },
    { key: "gums", label: "חניכיים" }, { key: "kids_dental", label: "שיניים לילדים" },
    { key: "dental_emergency", label: "חירום שיניים" }, { key: "oral_surgery", label: "ניתוחי פה" }, OTHER ]},
  { key: "optics", label: "אופטיקה וראייה", subCategories: [
    { key: "eye_exam", label: "בדיקות עיניים" }, { key: "glasses", label: "משקפיים" },
    { key: "contact_lenses", label: "עדשות מגע" }, { key: "laser_eye", label: "ניתוח עיניים" },
    { key: "kids_vision", label: "ראייה לילדים" }, { key: "sunglasses", label: "משקפי שמש" }, OTHER ]},
  { key: "alternative_medicine", label: "רפואה משלימה", subCategories: [
    { key: "homeopathy", label: "הומיאופתיה" }, { key: "acupuncture", label: "דיקור סיני" },
    { key: "reflexology", label: "רפלקסולוגיה" }, { key: "naturopathy", label: "נטורופתיה" },
    { key: "occupational_therapy", label: "ריפוי בעיסוק" }, { key: "energy_healing", label: "ריפוי אנרגטי" },
    { key: "hypnosis", label: "היפנוזה" }, { key: "nlp", label: "NLP" }, OTHER ]},
  { key: "mental_health", label: "בריאות הנפש", subCategories: [
    { key: "psychology", label: "פסיכולוגיה" }, { key: "couples_therapy", label: "ייעוץ זוגי" },
    { key: "coaching", label: "קוצ'ינג" }, { key: "meditation", label: "מדיטציה" },
    { key: "biofeedback", label: "ביופידבק" }, { key: "youth_counseling", label: "ייעוץ לנוער" },
    { key: "grief_therapy", label: "טיפול בשכול" }, OTHER ]},
  { key: "sports", label: "ספורט וכושר", subCategories: [
    { key: "personal_trainer", label: "מאמן אישי" }, { key: "pilates", label: "פילאטיס" },
    { key: "yoga", label: "יוגה" }, { key: "crossfit", label: "קרוספיט" },
    { key: "gym", label: "חדרי כושר" }, { key: "martial_arts", label: "אמנויות לחימה" },
    { key: "swimming", label: "שחייה" }, { key: "running", label: "ריצה" },
    { key: "cycling", label: "רכיבה" }, { key: "dance", label: "ריקוד" },
    { key: "boxing", label: "אגרוף" }, OTHER ]},
  { key: "food", label: "מסעדות ואוכל", subCategories: [
    { key: "restaurant", label: "מסעדה" }, { key: "fast_food", label: "מזון מהיר" },
    { key: "catering", label: "קייטרינג" }, { key: "bakery_cakes", label: "קונדיטוריה ואפייה" },
    { key: "cafe", label: "בתי קפה" }, { key: "culinary_exp", label: "חוויות קולינריות" },
    { key: "delivery", label: "משלוחי אוכל" }, { key: "butcher", label: "קצביות" },
    { key: "health_food", label: "מזון בריאות" }, { key: "ready_meals", label: "ארוחות מוכנות" },
    { key: "bar_alcohol", label: "ברים ואלכוהול" }, { key: "private_chef", label: "בשלן פרטי" }, OTHER ]},
  { key: "education", label: "חינוך ולמידה", subCategories: [
    { key: "tutoring", label: "שיעורים פרטיים" }, { key: "music_lessons", label: "לימודי מוזיקה" },
    { key: "languages", label: "לימודי שפות" }, { key: "bagrut", label: "הכנה לבגרויות" },
    { key: "professional_training", label: "הדרכה מקצועית" }, { key: "digital_courses", label: "קורסים דיגיטליים" },
    { key: "science", label: "לימודי מדעים" }, { key: "driving_school", label: "מורה לנהיגה" },
    { key: "institutions", label: "מוסדות לימוד" }, OTHER ]},
  { key: "kids_activities", label: "חוגים לילדים", subCategories: [
    { key: "art_workshop", label: "סדנאות יצירה" }, { key: "sports_group", label: "חוגי ספורט" },
    { key: "music_group", label: "חוגי מוזיקה" }, { key: "cooking_group", label: "חוגי בישול" },
    { key: "dance_group", label: "חוגי ריקוד" }, { key: "summer_camp", label: "מחנות קיץ" },
    { key: "baby_care", label: "טיפולי תינוקות" }, { key: "theater", label: "תיאטרון" },
    { key: "kids_products", label: "מוצרי ילדים" }, OTHER ]},
  { key: "design", label: "עיצוב ואמנות", subCategories: [
    { key: "graphic", label: "גרפיקה" }, { key: "interior", label: "עיצוב אינטריאר" },
    { key: "photography", label: "צילום" }, { key: "web_design", label: "עיצוב אתרים" },
    { key: "branding", label: "מיתוג" }, { key: "animation", label: "אנימציה" },
    { key: "illustration", label: "איור" }, { key: "product_design", label: "עיצוב מוצר" },
    { key: "fashion_design", label: "עיצוב אופנה" }, OTHER ]},
  { key: "video_content", label: "וידאו ותוכן", subCategories: [
    { key: "video_production", label: "הפקת וידאו" }, { key: "video_editing", label: "עריכת וידאו" },
    { key: "wedding_video", label: "וידאו לחתונות" }, { key: "corporate_video", label: "סרטי תדמית" },
    { key: "clips", label: "קליפים ורילס" }, { key: "youtube", label: "יוטיוב / יוצרים" },
    { key: "podcast", label: "פודקאסטים" }, { key: "documentary", label: "סרטים תיעודיים" }, OTHER ]},
  { key: "tech", label: "טכנולוגיה", subCategories: [
    { key: "software", label: "פיתוח תוכנה" }, { key: "mobile_apps", label: "פיתוח אפליקציות" },
    { key: "web_dev", label: "בניית אתרים" }, { key: "ai_ml", label: "בינה מלאכותית" },
    { key: "cyber", label: "אבטחת מידע" }, { key: "tech_support", label: "תמיכה טכנית" },
    { key: "cloud", label: "שירותי ענן" }, { key: "data_science", label: "אנליטיקה ודאטה" },
    { key: "freelance_dev", label: "פרילנסרים דיגיטליים" }, { key: "customer_tech", label: "שירות לקוחות טכנולוגי" }, OTHER ]},
  { key: "digital_marketing", label: "שיווק דיגיטלי", subCategories: [
    { key: "seo", label: "קידום אורגני (SEO)" }, { key: "social_media", label: "ניהול סושיאל" },
    { key: "copywriting", label: "קופירייטינג" }, { key: "pr", label: "יחסי ציבור" },
    { key: "content_marketing", label: "שיווק תוכן" }, { key: "email_marketing", label: "שיווק במייל" },
    { key: "ads", label: "פרסום ממומן" }, { key: "influencer", label: "אינפלואנסרים" }, OTHER ]},
  { key: "ecommerce", label: "מסחר ואיקומרס", subCategories: [
    { key: "online_store", label: "חנויות אונליין" }, { key: "dropshipping", label: "דרופשיפינג" },
    { key: "amazon_ebay", label: "Amazon / eBay" }, { key: "b2b", label: "מכירות B2B" },
    { key: "import_export", label: "ייבוא/ייצוא" }, { key: "inventory", label: "ניהול מלאי" },
    { key: "fulfillment", label: "פולפילמנט" }, OTHER ]},
  { key: "construction", label: "בנייה ושיפוצים", subCategories: [
    { key: "contractor", label: "קבלן בניין" }, { key: "renovation", label: "שיפוצים" },
    { key: "concrete", label: "עבודות בטון" }, { key: "carpentry", label: "נגרות" },
    { key: "flooring", label: "ריצוף" }, { key: "plaster", label: "גבס" },
    { key: "painting", label: "צביעה" }, { key: "elevators", label: "מעליות ותחזוקה" },
    { key: "fire_safety", label: "בטיחות וכיבוי אש" }, { key: "building_mgmt", label: "ניהול מבנים" }, OTHER ]},
  { key: "solar", label: "אנרגיה סולארית", subCategories: [
    { key: "solar_install", label: "התקנת פאנלים" }, { key: "solar_maintain", label: "תחזוקת מערכות" },
    { key: "energy_consulting", label: "ייעוץ אנרגיה" }, { key: "storage_systems", label: "מערכות אחסון" },
    { key: "commercial_solar", label: "סולארי לעסקים" }, OTHER ]},
  { key: "security", label: "אבטחה ומיגון", subCategories: [
    { key: "cameras", label: "מצלמות אבטחה" }, { key: "locks", label: "מנעולים וכספות" },
    { key: "alarm", label: "מערכות אזעקה" }, { key: "guards", label: "שמירה ואבטחה" },
    { key: "cyber_security", label: "סייבר ביטחוני" }, { key: "building_security", label: "מיגון מבנים" }, OTHER ]},
  { key: "automotive", label: "רכב ותחבורה", subCategories: [
    { key: "garage", label: "מוסך" }, { key: "body_shop", label: "פחחות וצבע" },
    { key: "car_wash", label: "שטיפת רכב" }, { key: "auto_electric", label: "חשמלאי רכב" },
    { key: "electric_vehicles", label: "רכבים חשמליים" }, { key: "delivery_courier", label: "שליחויות והפצה" },
    { key: "car_rental", label: "השכרת רכבים" }, { key: "driving_lessons", label: "לימודי נהיגה" },
    { key: "smart_transport", label: "תחבורה חכמה" }, { key: "heavy_equipment", label: "ציוד כבד" },
    { key: "parking", label: "חניה ושירותי דרך" }, OTHER ]},
  { key: "realestate", label: 'נדל"ן', subCategories: [
    { key: "broker", label: 'מתווך נדל"ן' }, { key: "property_mgmt", label: "ניהול נכסים" },
    { key: "appraisal", label: "שמאות" }, { key: "rental", label: "השכרת דירות" },
    { key: "construction_dev", label: "קבלנות ופיתוח" }, { key: "airbnb", label: "נופש / Airbnb" },
    { key: "commercial_real_estate", label: 'נדל"ן מסחרי' }, OTHER ]},
  { key: "furniture", label: "ריהוט ועיצוב הבית", subCategories: [
    { key: "custom_furniture", label: "ריהוט בהזמנה" }, { key: "luxury_furniture", label: "ריהוט יוקרה" },
    { key: "office_furniture", label: "ריהוט משרד" }, { key: "kitchens", label: "מטבחים" },
    { key: "sofas", label: "ספות" }, { key: "kids_furniture", label: "חדרי ילדים" },
    { key: "bedrooms", label: "חדרי שינה" }, OTHER ]},
  { key: "legal", label: "משפטים", subCategories: [
    { key: "lawyer_general", label: "עורך דין כללי" }, { key: "notary", label: "נוטריון" },
    { key: "mediation", label: "גישור" }, { key: "labor_law", label: "דיני עבודה" },
    { key: "real_estate_law", label: 'נדל"ן משפטי' }, { key: "criminal_law", label: "פלילי" },
    { key: "family_law", label: "משפחה" }, { key: "tort", label: "נזיקין" }, OTHER ]},
  { key: "finance", label: "פיננסים", subCategories: [
    { key: "accountant", label: "רואה חשבון" }, { key: "tax_advisor", label: "יועץ מס" },
    { key: "loans", label: "הלוואות ומימון" }, { key: "insurance", label: "ביטוחים" },
    { key: "mortgage", label: "משכנתאות" }, { key: "credit", label: "אשראי וסליקה" },
    { key: "budget", label: "הנהלת תקציב" }, { key: "payment_solutions", label: "פתרונות תשלום" },
    { key: "tax_returns", label: "החזרי מס" }, { key: "business_finance", label: "שירותים לעסקים" }, OTHER ]},
  { key: "events", label: "אירועים", subCategories: [
    { key: "dj", label: "דיג׳יי" }, { key: "wedding_photo", label: "צלם חתונות" },
    { key: "mc", label: "מנחה אירועים" }, { key: "live_music", label: "מוזיקה חיה" },
    { key: "event_planning", label: "ארגון אירועים" }, { key: "flowers", label: "פרחים ועיצוב" },
    { key: "event_catering", label: "קייטרינג לאירועים" }, { key: "venue", label: "אולמות שמחות" },
    { key: "photobooth", label: "פוטובוס" }, { key: "kids_entertainment", label: "בידור לילדים" }, OTHER ]},
  { key: "pets", label: "בעלי חיים", subCategories: [
    { key: "vet", label: "וטרינר" }, { key: "dog_grooming", label: "מספרת כלבים" },
    { key: "dog_training", label: "אילוף מתקדם" }, { key: "pet_hotel", label: "פנסיון לחיות" },
    { key: "dog_walking", label: "הליכת כלבים" }, { key: "pet_shop", label: "ציוד לבעלי חיים" }, OTHER ]},
  { key: "cleaning", label: "ניקיון ותחזוקה", subCategories: [
    { key: "home_cleaning", label: "ניקיון דירות" }, { key: "commercial_cleaning", label: "ניקיון מסחרי" },
    { key: "carpet_cleaning", label: "ניקוי שטיחים" }, { key: "ac_cleaning", label: "ניקוי מזגנים" },
    { key: "gardening", label: "גינון" }, { key: "pest_control", label: "הדברה" },
    { key: "pool", label: "טיפול בריכות" }, { key: "post_reno", label: "ניקיון לאחר שיפוץ" }, OTHER ]},
  { key: "tourism", label: "תיירות", subCategories: [
    { key: "travel_agency", label: "סוכנות נסיעות" }, { key: "tour_guide", label: "מדריך טיולים" },
    { key: "hotel", label: "מלון / B&B" }, { key: "rural_tourism", label: "נופש כפרי" },
    { key: "escape_room", label: "חדרי בריחה" }, { key: "extreme_sports_tour", label: "ספורט אתגרי" },
    { key: "corporate_trips", label: "טיולים ארגוניים" }, { key: "cruise", label: "שיט וקרוזים" }, OTHER ]},
  { key: "business_services", label: "שירותים עסקיים", subCategories: [
    { key: "consulting", label: "ייעוץ עסקי" }, { key: "project_mgmt", label: "ניהול פרויקטים" },
    { key: "hr", label: "משאבי אנוש" }, { key: "logistics", label: "לוגיסטיקה" },
    { key: "printing", label: "הדפסה ודפוס" }, { key: "office_mgmt", label: "ניהול משרד" },
    { key: "customer_service_center", label: "שירות לקוחות ומוקדים" }, OTHER ]},
  { key: "coaching", label: "ייעוץ וקוצ'ינג", subCategories: [
    { key: "personal_coaching", label: "קוצ'ינג אישי" }, { key: "career_coaching", label: "ייעוץ קריירה" },
    { key: "couples_coaching", label: "ייעוץ זוגי" }, { key: "org_consulting", label: "ייעוץ ארגוני" },
    { key: "life_coaching", label: "לייף קוצ'ינג" }, { key: "business_coaching", label: "קוצ'ינג עסקי" }, OTHER ]},
  { key: "gifts", label: "מתנות", subCategories: [
    { key: "gift_baskets", label: "מארזי מתנות" }, { key: "corporate_gifts", label: "מתנות לעסקים" },
    { key: "gift_shop", label: "חנות מתנות" }, { key: "print_on_product", label: "הדפסה על מוצרים" },
    { key: "personal_gifts", label: "מתנות אישיות" }, OTHER ]},
  { key: "agriculture", label: "חקלאות", subCategories: [
    { key: "vegetables", label: "גידול ירקות" }, { key: "flowers_farm", label: "גידול פרחים" },
    { key: "olive_oil", label: "שמן זית" }, { key: "fruit_trees", label: "עצי פרי" },
    { key: "farm", label: "חווה" }, { key: "honey", label: "דבש" },
    { key: "organic", label: "מוצרים אורגניים" }, { key: "agricultural_equipment", label: "ציוד חקלאי" }, OTHER ]},
  /* — Added categories the manager asked for. Kept ordered before
       the catch-all 'other' so they show in their natural position
       in the inline picker dropdown. — */
  { key: "plumbing_hvac", label: "אינסטלציה ומיזוג", subCategories: [
    { key: "plumber", label: "אינסטלטור" }, { key: "drain_clearing", label: "פתיחת סתימות" },
    { key: "boilers", label: "דודים ושמש" }, { key: "leaks", label: "איתור נזילות" },
    { key: "hvac_install", label: "התקנת מזגנים" }, { key: "hvac_maintain", label: "תחזוקת מזגנים" },
    { key: "underfloor_heating", label: "חימום תת-רצפתי" }, { key: "water_treatment", label: "טיהור מים" }, OTHER ]},
  { key: "electrical", label: "חשמל ותאורה", subCategories: [
    { key: "electrician", label: "חשמלאי מוסמך" }, { key: "lighting_design", label: "עיצוב תאורה" },
    { key: "smart_home", label: "בית חכם" }, { key: "ev_chargers", label: "עמדות טעינה לרכב" },
    { key: "generators", label: "גנרטורים וגיבוי" }, { key: "industrial_electric", label: "חשמל תעשייתי" }, OTHER ]},
  { key: "aesthetic_medicine", label: "רפואה אסתטית", subCategories: [
    { key: "botox_fillers", label: "בוטוקס וחומצה הילרונית" }, { key: "lipo", label: "שאיבות שומן" },
    { key: "cosmetic_surgery", label: "ניתוחים אסתטיים" }, { key: "laser_skin", label: "טיפולי לייזר" },
    { key: "skin_tightening", label: "מתיחות עור" }, { key: "hair_restoration", label: "השתלות שיער" },
    { key: "anti_aging", label: "אנטי-אייג'ינג" }, OTHER ]},
  { key: "device_repair", label: "תיקון מכשירים", subCategories: [
    { key: "phone_repair", label: "תיקון סלולר" }, { key: "computer_repair", label: "תיקון מחשבים" },
    { key: "tv_repair", label: "תיקון טלוויזיות" }, { key: "appliance_repair", label: "תיקון מוצרי חשמל" },
    { key: "data_recovery", label: "שחזור נתונים" }, OTHER ]},
  { key: "music_arts", label: "מוזיקה ובמה", subCategories: [
    { key: "music_studio", label: "אולפן הקלטות" }, { key: "live_band", label: "להקות חיות" },
    { key: "music_production", label: "הפקה מוזיקלית" }, { key: "vocal_coaching", label: "הוראת שירה" },
    { key: "dj_school", label: "בית ספר ל-DJ" }, { key: "stage_design", label: "תפאורה לאירועים" }, OTHER ]},
  { key: "body_art", label: "קעקועים ופירסינג", subCategories: [
    { key: "tattoo", label: "קעקועים" }, { key: "tattoo_removal", label: "הסרת קעקועים" },
    { key: "piercing", label: "פירסינג" }, { key: "permanent_makeup", label: "איפור קבוע" }, OTHER ]},
  { key: "logistics_shipping", label: "לוגיסטיקה ושילוח", subCategories: [
    { key: "moving", label: "הובלות דירה" }, { key: "courier", label: "שליחויות" },
    { key: "warehousing", label: "אחסון וניהול מחסנים" }, { key: "freight", label: "שילוח מטענים" },
    { key: "customs", label: "עמילות מכס" }, { key: "last_mile", label: "מייל אחרון" }, OTHER ]},
  { key: "fashion_retail", label: "אופנה ולבוש", subCategories: [
    { key: "womens_fashion", label: "אופנת נשים" }, { key: "mens_fashion", label: "אופנת גברים" },
    { key: "kids_fashion", label: "אופנת ילדים" }, { key: "wedding_dress", label: "שמלות כלה" },
    { key: "evening_wear", label: "ערב וטקסים" }, { key: "shoes", label: "נעליים" },
    { key: "bags_accessories", label: "תיקים ואקססוריז" }, { key: "swimwear", label: "בגדי ים" },
    { key: "lingerie", label: "הלבשה תחתונה" }, OTHER ]},
  { key: "wellness_retreat", label: "ספא ונופש", subCategories: [
    { key: "day_spa", label: "ספא יומי" }, { key: "retreat_center", label: "מרכזי ריטריט" },
    { key: "hot_springs", label: "מעיינות וג'קוזי" }, { key: "wellness_resort", label: "מלון רווחה" }, OTHER ]},
  { key: "other", label: "אחר", subCategories: [{ key: "misc", label: "שונות" }, OTHER ]},
];

export function categoryByKey(key: string | undefined): Cat | undefined {
  return key ? CATEGORIES.find(c => c.key === key) : undefined;
}
