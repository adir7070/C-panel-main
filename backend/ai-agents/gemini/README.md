# Gemini AI Agents

סוכני AI פשוטים וקלים לשימוש עם Google Gemini.

## המבנה

```
ai-agents/
  gemini/
    ├── imageAgent.js    # סוכן ליצירת תמונות
    ├── textAgent.js     # סוכן ליצירת טקסט
    ├── index.js         # ייצוא מרכזי
    └── README.md        # התיעוד
```

---

## שימוש בסוכן התמונות (Image Agent)

### דוגמה בסיסית:
```javascript
const { imageAgent } = require('./ai-agents/gemini');

// יצירת תמונה
const result = await imageAgent.generate(
  "Create a picture of a sunset over the ocean"
);

console.log('תמונה נוצרה:', {
  size: result.size,
  description: result.description
});

// שמירת התמונה
const fs = require('fs');
fs.writeFileSync('sunset.png', result.buffer);
```

### מה מוחזר?
```javascript
{
  buffer: Buffer,           // התמונה כ-Buffer
  base64: "iVBORw0KG...",   // התמונה כ-base64 string
  size: 125000,             // גודל בבייטים
  mimeType: "image/png",    // סוג הקובץ
  description: "..."        // תיאור התמונה מ-Gemini
}
```

---

## שימוש בסוכן הטקסט (Text Agent)

### דוגמה 1: יצירת תוכן
```javascript
const { textAgent } = require('./ai-agents/gemini');

// יצירת תוכן
const result = await textAgent.generate(
  "כתוב מתכון לעוגת שוקולד"
);

console.log('תוכן:', result.text);
console.log('טוקנים:', result.tokensUsed);
```

### דוגמה 2: שיחה (Chat)
```javascript
const { textAgent } = require('./ai-agents/gemini');

// שיחה ראשונה
const response1 = await textAgent.chat("מה השם שלך?");
console.log('תשובה:', response1.text);

// המשך שיחה עם היסטוריה
const history = [
  { role: 'user', text: 'מה השם שלך?' },
  { role: 'assistant', text: response1.text }
];

const response2 = await textAgent.chat("מה אתה יכול לעשות?", history);
console.log('תשובה:', response2.text);
```

### אופציות נוספות:
```javascript
const result = await textAgent.generate(
  "כתוב סיפור קצר",
  {
    temperature: 0.9,      // יצירתיות (0-1)
    maxTokens: 2048        // אורך מקסימלי
  }
);
```

---

## דוגמאות שימוש ב-Controller

### Controller עם סוכן תמונות:
```javascript
const { imageAgent } = require('../ai-agents/gemini');

exports.createImage = async (req, res) => {
  try {
    const { prompt } = req.body;

    const result = await imageAgent.generate(prompt);

    res.set('Content-Type', 'image/png');
    res.send(result.buffer);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
```

### Controller עם סוכן טקסט:
```javascript
const { textAgent } = require('../ai-agents/gemini');

exports.generateContent = async (req, res) => {
  try {
    const { prompt } = req.body;

    const result = await textAgent.generate(prompt);

    res.json({
      content: result.text,
      tokens: result.tokensUsed
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
```

---

## יתרונות המבנה

✅ **פשוט וקל להבנה** - קוד נקי בלי סיבוכים
✅ **ניתן לשימוש חוזר** - אותם סוכנים בכל מקום
✅ **מרוכז** - כל הלוגיקה של AI במקום אחד
✅ **ניתן להרחבה** - קל להוסיף סוכנים חדשים

---

## הוספת סוכן חדש

1. צור קובץ חדש (למשל `audioAgent.js`)
2. ייצא אותו ב-`index.js`
3. השתמש בו בכל מקום בקוד

זהו! 🎯
