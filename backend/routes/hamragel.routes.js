const router = require("express").Router();
const { run } = require("../controllers/hamragel.controller");

/**
 * POST /api/ai/hamragel
 * המרגל — ניתוח מודעות מתחרים ויצירת מודעות חדשות
 *
 * Body params:
 *   status          "new" | "ok"
 *   image           base64 string של תמונת המתחרה
 *   phone           מספר טלפון (לנתיב B2)
 *   count           כמה תמונות לייצר (ברירת מחדל: 1)
 *   notes           הערות אופציונליות
 *   website         URL של אתר המתחרה (אופציונלי)
 *   success_reason  תוצאת שלב 1 (נדרש ב-status="ok")
 *   eye_grabbers    תוצאת שלב 1 (נדרש ב-status="ok")
 *   winning_changes תוצאת שלב 1 (נדרש ב-status="ok")
 */
router.post("/", run);

module.exports = router;
