/**
 * Analyze support chats from the last month to find common app issues.
 * Run: node scripts/analyze-support-chats.js
 */

const { MongoClient } = require("mongodb");
require("dotenv").config();

const MONGO_URI = process.env.MONGO_URI;
const AWS_URI   = process.env.AWS_MONGO_URI;

async function run() {
  const uri = AWS_URI || MONGO_URI;
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000, connectTimeoutMS: 8000 });

  try {
    await client.connect();
    const db = client.db("iconiq");
    const col = db.collection("support_chats");

    const since = new Date();
    since.setDate(since.getDate() - 30);

    console.log(`\n📅 סורק שיחות מאז: ${since.toLocaleDateString("he-IL")}\n`);

    const chats = await col
      .find(
        { updated_at: { $gte: since }, status: { $ne: "merged" } },
        { projection: { messages: 1, name: 1, fireberyName: 1, phone: 1, updated_at: 1 } }
      )
      .sort({ updated_at: -1 })
      .toArray();

    console.log(`✅ נמצאו ${chats.length} שיחות בחודש האחרון\n`);

    // collect all user messages
    const userMessages = [];
    for (const chat of chats) {
      const msgs = (chat.messages || []).filter(
        (m) => m.fromRole === "user" || m.role === "user"
      );
      const name = chat.fireberyName || chat.name || chat.phone || "לא ידוע";
      for (const m of msgs) {
        const text = (m.text || m.content || "").trim();
        if (text.length > 5) {
          userMessages.push({ text, name, date: new Date(m.createdAt || 0) });
        }
      }
    }

    console.log(`📨 סה"כ הודעות משתמשים: ${userMessages.length}\n`);
    console.log("─".repeat(60));

    // keyword categories to identify app issues
    const categories = [
      {
        label: "🚀 קמפיין — הפעלה / עצירה",
        keywords: ["קמפיין", "הדלק", "להדליק", "להפעיל", "לעצור", "עצור", "פעיל", "לא פעיל", "מופסק", "campaign"],
      },
      {
        label: "🎯 טרגוט / קהל יעד",
        keywords: ["טרגוט", "קהל", "targeting", "גיל", "אזור", "מיקום", "מין", "interest", "אינטרס"],
      },
      {
        label: "💰 תקציב / עלות",
        keywords: ["תקציב", "עלות", "כסף", "מחיר", "תשלום", "חיוב", "budget", "כמה", "עולה"],
      },
      {
        label: "📸 תמונה / וידאו / קריאייטיב",
        keywords: ["תמונה", "סרטון", "וידאו", "תוכן", "קריאייטיב", "עלה", "להעלות", "image", "video", "media"],
      },
      {
        label: "📊 סטטיסטיקות / תוצאות",
        keywords: ["סטטיסטיקה", "תוצאות", "ביצועים", "נתונים", "stats", "לידים", "חשיפות", "הגעות", "קליקים"],
      },
      {
        label: "🔐 כניסה / חיבור / חשבון",
        keywords: ["כניסה", "login", "סיסמה", "חיבור", "Facebook", "פייסבוק", "חשבון", "account", "התחבר"],
      },
      {
        label: "📱 אפליקציה — תקלה / לא עובד",
        keywords: ["לא עובד", "שגיאה", "תקלה", "קרסה", "error", "בעיה", "תקוע", "נתקע", "אין תגובה"],
      },
      {
        label: "✏️ עריכת פוסט / תוכן",
        keywords: ["טקסט", "כיתוב", "לערוך", "לשנות", "עריכה", "שינוי", "caption", "הכותרת", "הטקסט"],
      },
      {
        label: "📅 תיזמון / פרסום",
        keywords: ["תיזמון", "מתי", "תאריך", "שעה", "לפרסם", "schedule", "אוטומטי", "לקבוע"],
      },
      {
        label: "🏪 עמוד / דף עסקי",
        keywords: ["עמוד", "דף", "page", "עסק", "פרופיל", "ביו", "אינסטגרם", "instagram"],
      },
      {
        label: "💬 AI / בוט / עוזר",
        keywords: ["AI", "בינה", "בוט", "bot", "עוזר", "אוטומציה", "צ'אט", "chat"],
      },
      {
        label: "📦 חבילה / מנוי / שדרוג",
        keywords: ["חבילה", "מנוי", "שדרוג", "plan", "subscription", "לשדרג", "בסיסי", "פרמיום"],
      },
    ];

    const results = categories.map((cat) => {
      const matches = userMessages.filter((m) =>
        cat.keywords.some((kw) => m.text.toLowerCase().includes(kw.toLowerCase()))
      );
      return { ...cat, count: matches.length, messages: matches.slice(0, 5) };
    });

    results.sort((a, b) => b.count - a.count);

    console.log("\n📊 הבעיות השכיחות ביותר (לפי מספר הודעות):\n");

    for (const cat of results) {
      if (cat.count === 0) continue;
      console.log(`${cat.label}`);
      console.log(`   כמות הודעות: ${cat.count}`);
      console.log("   דוגמאות:");
      for (const m of cat.messages) {
        const shortText = m.text.length > 120 ? m.text.slice(0, 120) + "..." : m.text;
        console.log(`     • [${m.name}] ${shortText}`);
      }
      console.log();
    }

    // uncategorized messages
    const categorized = new Set();
    for (const cat of results) {
      cat.messages.forEach((m) => categorized.add(m.text));
    }
    const uncategorized = userMessages.filter(
      (m) =>
        !results.some((cat) =>
          cat.keywords.some((kw) => m.text.toLowerCase().includes(kw.toLowerCase()))
        )
    );

    console.log("─".repeat(60));
    console.log(`\n❓ הודעות שלא סווגו (${uncategorized.length} הודעות) — דוגמאות:`);
    for (const m of uncategorized.slice(0, 20)) {
      const shortText = m.text.length > 100 ? m.text.slice(0, 100) + "..." : m.text;
      console.log(`  • [${m.name}] ${shortText}`);
    }

    console.log("\n✅ הניתוח הסתיים.");
  } catch (err) {
    console.error("❌ שגיאה:", err.message);
  } finally {
    await client.close();
  }
}

run();
