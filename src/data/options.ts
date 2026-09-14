export const TARGET_AUDIENCE_OPTIONS = [
  "נשים", "גברים", "זוגות", "משפחות", "בני נוער", "קשישים",
  "בעלי עסקים", "מקצוענים", "סטודנטים", "הורים",
];

export const PAGE_GOAL_OPTIONS = [
  { label: "לידים",      value: "leads"       },
  { label: "מכירות",     value: "sales"       },
  { label: "הזמנת תור",  value: "appointment" },
  { label: "יצירת קשר",  value: "contact"     },
  { label: "מידע כללי",  value: "info"        },
];

export function pageGoalLabel(value: string | undefined): string {
  return PAGE_GOAL_OPTIONS.find(o => o.value === value)?.label ?? "—";
}
