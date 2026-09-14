const SCREENS = {
  Home: "בית",
  ServicesScreen: "שירותים",
  Leads: "לידים",
  IconiqPage: "דף איקוניק",
  Profile: "פרופיל",
  Studio: "סטודיו",
  NewCampaignEditScreen: "עריכת קמפיין חדש",
  CreatePost: "יצירת פוסט",
  LeadDetails: "פרטי ליד",
  DesignsStatusScreen: "סטטוס עיצובים",
  Login: "התחברות",
  Register: "הרשמה",
  Settings: "הגדרות",
  Gallery: "גלריה",
  Chat: "צ'אט",
  Stats: "סטטיסטיקות",
  Appointments: "פגישות",
  Calendar: "יומן",
  Brief: "תדריך",
  Onboarding: "הכרת המערכת",
  SupportChat: "צ'אט תמיכה",
  WebsiteStatusScreen: "סטטוס אתר",
  NewAdEditScreen: "עריכת מודעה חדשה",
  CampaignEdit: "עריכת קמפיין",
  AdsManager: "מנהל מודעות",
  Notifications: "התראות",
  Search: "חיפוש",
};

const ACTIONS = {
  "services.tap_edit": "עריכת שירות",
  "services.tap_add": "הוספת שירות",
  "services.tap_delete": "מחיקת שירות",
  "login": "התחברות",
  "logout": "התנתקות",
  "lead_details.save_changes": "שמירת שינויים בליד",
  "leads.tap_card": "לחיצה על ליד",
  "leads.tap_filter": "סינון לידים",
  "create_post.tap_next_step": "המשך ביצירת פוסט",
  "create_post.select_post_type": "בחירת סוג פוסט",
  "create_post.tap_publish": "פרסום פוסט",
  "stats.tap_help": "עזרה בסטטיסטיקות",
  "chat.send_message": "שליחת הודעה בצ'אט",
  "chat.tap_attachment": "צירוף קובץ בצ'אט",
  "gallery.select_filter": "בחירת פילטר בגלריה",
  "gallery.tap_image": "לחיצה על תמונה",
  "profile.tap_edit": "עריכת פרופיל",
  "profile.tap_logo": "החלפת לוגו",
  "appointments.tap_create": "יצירת פגישה",
  "appointments.tap_cancel": "ביטול פגישה",
  "campaign_edit.toggle_campaign": "הפעלה/השהיית קמפיין",
  "campaign_edit.tap_save": "שמירת קמפיין",
  "campaign_edit.tap_publish": "פרסום קמפיין",
  "lead_details.select_status": "בחירת סטטוס ליד",
  "lead_details.open_status_modal": "פתיחת חלון סטטוס",
  "lead_details.tap_whatsapp": "פתיחת וואטסאפ מליד",
  "lead_details.tap_send_formatted": "שליחת הודעה מעוצבת",
  "lead_details.tap_call": "חיוג לליד",
  "lead_details.tap_email": "שליחת אימייל לליד",
  "lead_details.tap_note": "הוספת הערה לליד",
  "ads.tap_new": "מודעה חדשה",
  "ads.tap_edit": "עריכת מודעה",
  "ads.tap_delete": "מחיקת מודעה",
  "notifications.tap_item": "פתיחת התראה",
};

export function localizeScreen(name) {
  if (!name) return name;
  return SCREENS[name] || name;
}

export function localizeAction(name) {
  if (!name) return name;
  return ACTIONS[name] || name;
}

export function localizePath(path, sep = " → ") {
  if (!path) return path;
  return path.split(sep).map(localizeScreen).join(sep);
}

export function localizeEvent(type, name) {
  if (type === "action") return localizeAction(name);
  if (type === "screen_view" || type === "screen_leave") return localizeScreen(name);
  return name;
}
