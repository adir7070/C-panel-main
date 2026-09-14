# WOW Ads — מדריך אינטגרציה ל־Make.com

מסמך עזר מלא להעברת פייפליין יצירת המודעות הממומנות (WOW Ads) ל־Make.com.
כל פרומפט, פרמטר, ו־input/output מועתק 1:1 מהקוד הפרודקשן (`services/wow-ads.service.js` + `services/wow-ads-direction.service.js`).

> **תאריך עדכון**: 2026-06-10
> **גרסת Director**: v1.2
> **גרסת Reviewer**: v1.1
> **שפת המודעות**: עברית RTL

---

## 1. מבנה כללי של הפייפליין

הפייפליין מקבל **brief** של עסק ומפיק 10 מודעות (כברירת מחדל). כל מודעה עוברת 5 שלבים:

```
INPUT  ─────────────────────────────────────────────────────────────────►  OUTPUT
brief  →  Stage 1   →  Stage 2  →  Stage 3   →  Stage 4   →  Stage 5    →  10 PNGs
           (texts)    (analysis  (direction   (nano       (image          + 10 promo
                      + per-ad)   per ad)      prompt)     1024×1024)      copy texts
```

| שלב | שם | מודל | סוג | פלט |
|-----|----|------|-----|------|
| 1 | Ad Texts Generation | `gpt-4o` | Chat + JSON mode | JSON של 10 מודעות (headline/description/cta) |
| 2a | Business Visual Analysis | `gpt-4o` (vision) | Chat + JSON mode | טיפים לכל מודעה בהמשך |
| 2b | Creative Direction | `gpt-4o` | Chat + JSON mode (פעם אחת לכל מודעה) | תוכנית עיצוב מפורטת |
| 3 | Nano Prompt Builder | `gpt-4o` | Chat (פלט שורה אחת) | פרומפט תמונה באנגלית |
| 4 | Image Generation | `gpt-image-2` (primary) → `gpt-image-1` (fallback) | `images.edit` או `images.generate` | תמונת PNG 1024×1024 |
| 5a | Vision Review (איכות) | `gpt-4o` (vision) | Chat + JSON mode | ציון + Retry במידת הצורך |
| 5b | Promotion Copy | `gpt-4o` | Chat | טקסט להעתקה למודעה ב־Meta Ads |

---

## 2. מבנה ה־brief (INPUT)

זה ה־payload שצריך להחזיק ב־Data Store / Variables של Make לאורך כל הריצה:

```json
{
  "businessName":    "פסגת הצל",
  "businessField":   "פרגולות אלומיניום",
  "businessNiche":   "שערי הצללה ופתרונות הצללה לבתים פרטיים",
  "about":           "מתמחים בתכנון, ייצור והתקנה של פרגולות בהתאמה אישית...",
  "services":        "פרגולות אלומיניום + שערי הצללה + תכנון מדויק...",
  "promotion":       "ייעוץ ותכנון ללא התחייבות",
  "targetAudience":  ["בעלי בתים פרטיים", "מתכננים שיפוץ חצר"],
  "designStyle":     "מודרני, איכותי, ישראלי תוסס",
  "preferredColors": {
    "primary":   "#1A2E40",
    "secondary": "#0B5F4A",
    "accent":    "#B5D334"
  },
  "logoUrl":         "https://....png  (אופציונלי)",
  "referenceImages": ["https://...", "https://..."],
  "packageId":       "premium-ads-10"
}
```

> `preferredColors` חייב להיות במבנה הזה — `primary` / `secondary` / `accent` כ־hex codes.
> כשמורידים את הלוגו / תמונות הרפרנס, מבקשים אותן כ־base64 בהמשך הפייפליין.

---

## 3. שלב 1 — Ad Texts Generation (10 כותרות+תיאורים+CTA)

### 3.1 הגדרת ה־API call

| Field | Value |
|-------|-------|
| Provider | OpenAI |
| Endpoint | `POST https://api.openai.com/v1/chat/completions` |
| Model | `gpt-4o` |
| Response format | `{ "type": "json_object" }` |
| Headers | `Authorization: Bearer {OPENAI_API_KEY}` |

### 3.2 System Prompt

```
You are an Israeli copywriter. Always respond with valid JSON containing an 'ads' array of 10 items.
```

### 3.3 User Prompt (template)

הזרם הזה דורש 4 משתנים שמחושבים מ־brief:
- `businessProfileShort` = מחרוזת רב־שורתית של שם/תחום/נישה/על העסק/קהל יעד
- `servicesAndDeals` = "שירותים: ... \n מבצע נוכחי: ..." (או "ללא מבצע פעיל")
- `count` = 10 (כמות המודעות)
- `hasPromotion` = true אם יש מבצע

```
תפקידך:
אתה קופירייטר לקמפיינים ממומנים בפייסבוק ובאינסטגרם.
אתה לא משרד פרסום.
אתה נשמע כמו בן אדם אמיתי — שייקי, חד, ישיר.

המטרה שלך היא אחת:
לעצור גלילה עם מסר חד שצמוד לשירות האמיתי של העסק.

📥 נתונים להזנה:
איפיון עסק:
{{businessProfileShort}}

שירותים ומבצעים:
{{servicesAndDeals}}

🎯 חוקי כתיבה (חובה):
- הכותרת חייבת לנקוב בשירות ספציפי מהרשימה — לא ניסוח כללי
- השתמש בשמות השירותים, במחירים, ובמאפיינים הייחודיים שמופיעים בנתונים
- כתוב כמו בעל העסק עצמו מדבר עם הלקוח: ישיר, אמיתי, בלי שטויות
- כותרות שייקיות: קצרות, חדות, מעוררות תגובה רגשית מיידית
- אסור כלישאות: "פתרון מקצועי / שירות איכותי / ניסיון רב שנים" — הם נשמעים גנריים
- אם יש מבצע — הוא חייב להיות ספציפי: מחיר, הטבה, תנאי

🚫 חוק קריטי — אסור להמציא מוצרים, שירותים או תיאורים שלא מופיעים בנתונים:
- אסור לחבר שני מושגים לתיאור מומצא (למשל: "ריסים חצי צפוף", "צבע עין מתוח", "פנים חצי שעה").
- אסור להוסיף תיאור (צפוף/מלא/מוארך/חדש/מתקדם) למוצר אם המילה לא מופיעה מילולית ברשימה.
- אם המושג שאתה רוצה לכתוב אינו קיים מילולית ב-"שירותים ומבצעים" → השתמש בשם השירות המקורי בלי שינוי.
- כל מילה בכותרת חייבת להיות מילה אמיתית בעברית. אסור צירופים שלא משמשים בשפת היומיום.
- במקרה של ספק: השתמש בשם השירות בדיוק כפי שכתוב, גם אם זה פחות "יצירתי".

🇮🇱 איכות עברית:
- בדוק שכל משפט הגיוני בקריאה רמה. אם נשמע מוזר → תכתוב מחדש.
- אסור תרגום מילולי מאנגלית ("צד עין" / "side eye" — לא קיים בעברית).
- שמות שירותים שמכילים מספר (X70₪) → המספר חייב להיצמד למחיר אמיתי שמופיע בנתונים.
- אסור צירופים תרגומיים שמרגישים "תרגום מ-Google" ולא משהו שישראלי אמיתי יגיד:
  • "לזוגות מתחילים" / "ללקוחות מתחילים" / "למשפחות מתחילות" — אין דבר כזה בעברית.
  • "ברמה אחרת" כסיומת — מוזר ושחוק. כתוב חוויה ספציפית: "ברומא / בליל ירח / על המים".
  • "פתרון מקצועי" / "ניסיון רב שנים" / "צוות מקצועי" — כלישאות ריקות שאסור להן להופיע.
- 🚨 אסור צורות פועל מומצאות / שגויות:
  • "נשכחי" / "תזכרי-תזכרו" שלא בהקשר פנייה ישירה / "יישכחי" / "תיהנו לכם" — צורות שלא קיימות.
  • לפני שאתה כותב פועל, ודא שהוא קיים מילולית בעברית מודרנית.
  • דוגמת תרגום שכשל: "nightlife you won't forget" — נכון: "חיי לילה בלתי נשכחים".
  • העדף שמות תואר על פני זמן עתיד פסיבי: "בלתי נשכח" > "לא יישכח" > NEVER "לא נשכחי".
- מבחן השפיים: קרא בקול. אם זה לא נשמע כמו משהו שחבר היה אומר לחבר — שכתב.

⚠️ כלל מבצע (רק אם hasPromotion=true):
יש מבצע ספציפי בקלט. הוא חייב להופיע **בדיוק ב-2 מתוך 10 מודעות** — לא יותר, לא פחות.
שאר 8 המודעות לא יזכירו מחיר/מבצע/הנחה — רק תועלת או רגש ספציפיים לשירות.

🧱 מבנה קבוע לכל מודעה (חובה):
החזר מערך JSON בלבד של 10 אובייקטים:

{
  "ads": [
    {
      "id": 1,
      "type": "regular",
      "headline": "כותרת חדה וספציפית לשירות (עד 6 מילים)",
      "description": "טקסט קצר שמדגיש תועלת ספציפית + מידע על העסק (1-2 משפטים)",
      "cta": "טקסט כפתור (2-3 מילים)"
    }
  ]
}

חוקים:
- בעברית בלבד
- type יכול להיות: regular, crazy, או carousel
- וריאציה: 7 רגילים, 2 מטורפים, 1 קרוסלה
- אסור Markdown או הסברים — JSON תקני בלבד
```

### 3.4 Output Schema

```json
{
  "ads": [
    {
      "id": 1,
      "type": "regular",
      "headline": "פתרונות צל בהתאמה אישית",
      "description": "פרגולות אלומיניום מותאמות לחלל שלכם — תכנון מדויק, ייצור והתקנה.",
      "cta": "קבעו פגישה"
    }
    // ... 10 פריטים
  ]
}
```

> **חשוב**: שמור את הפלט כ־array — הוא נדרש בכל השלבים הבאים.

---

## 4. שלב 2a — Business Visual Analysis (טיפים ויזואליים)

מפעיל את `gpt-4o` עם vision על הלוגו + תמונות הרפרנס. הפלט מזין את שלב 3.

### 4.1 הגדרת ה־API call

| Field | Value |
|-------|-------|
| Model | `gpt-4o` |
| Response format | `{ "type": "json_object" }` |

### 4.2 System Prompt (BUSINESS_ANALYST_SYSTEM)

```
You are a precision visual marketing analyst. Your output feeds directly into AI image generation — every wrong detail produces a wrong image that fails the client.

You receive: a business profile (services, vehicles, capacity, style) + optional logo + optional reference photos.

YOUR PRIMARY JOB: Read every service detail with surgical precision and translate it into exact visual instructions. Generic tips destroy the ad. Wrong visuals (wrong vehicle, wrong room, wrong scale) make the client look unprofessional.

Return ONLY valid JSON:
{
  "nanoPromptTips": ["...", "...", "..."],
  "geminiTips": ["...", "...", "..."]
}

━━━ SERVICE PRECISION — THE MOST IMPORTANT RULE ━━━
Before writing any tip, extract the EXACT physical details of every service:
- Transport business: What is the EXACT vehicle type? Minibus (8 seats) ≠ bus (50 seats) ≠ sedan ≠ van. If the profile says "minibus for 8 passengers" — tips must say "minibus, approximately 8 seats" and EXPLICITLY PROHIBIT a full-size bus, coach, or minivan unless that is what is described.
- Beauty/wellness: Is it one operator or a full salon? 1 chair or 20? Nail bar or full spa? Be exact.
- Food: Specific dishes? Hummus spot ≠ restaurant ≠ bakery. Name the exact food.
- Retail: What exact products? Small boutique ≠ large store.
- Always ask: what would the image AI default to if given no guidance? THAT is what you must correct with explicit "do NOT show X, show Y instead."

━━━ nanoPromptTips (for the GPT that writes the Gemini prompt) ━━━
Tips that guide SCENE CHOICE and COMPOSITION:
1. The EXACT physical setting: where does this service happen? Describe it precisely.
2. The EXACT subject: what vehicle / space / product / person appears? Be hyper-specific.
3. The EXACT wrong visual to avoid: what would the AI default to that is wrong for this business?
4. The target customer: who is in the scene, what are they doing, what emotion do they show?
5. The unique visual angle: one specific composition or moment that belongs only to this business.

━━━ geminiTips (passed verbatim into the Gemini image generation prompt) ━━━
Tips that control RENDERING QUALITY and ACCURACY:
1. Exact vehicle/product/space specification with size, color, model if known from profile or photos.
2. The scene setting: time of day, location, weather/light that suits this business.
3. The people: who, how many, what they wear, what they are doing — be cinematic and specific.
4. Any unique visual from the reference photos (specific decor color, logo on vehicle, uniform color).
5. What must be EXCLUDED: name the wrong visual explicitly.
6. The emotional quality: what should the viewer FEEL looking at this image?

Rules:
- Minimum 4 tips per list, maximum 6
- Every tip is 100% specific to THIS business — zero generic marketing language
- If reference photos provided: base visual tips on exactly what you see in them
- English only
- The wrong-visual prohibition tip is MANDATORY whenever the AI could default to the wrong scale/type
```

### 4.3 User Message Structure (multimodal)

```json
{
  "role": "user",
  "content": [
    {
      "type": "text",
      "text": "Business profile:\n{{JSON.stringify(brief, null, 2)}}"
    },
    {
      "type": "image_url",
      "image_url": { "url": "data:image/png;base64,{{logoBase64}}" }
    },
    {
      "type": "image_url",
      "image_url": { "url": "data:image/jpeg;base64,{{photo1Base64}}" }
    }
  ]
}
```

### 4.4 Output Schema

```json
{
  "nanoPromptTips": [
    "The setting is a sleek modern home backyard with a pergola attached over a wooden deck...",
    "Subject is a custom aluminum slat pergola — black/dark navy frame...",
    "Do NOT show generic wooden pergolas or cheap tent canopies..."
  ],
  "geminiTips": [
    "Aluminum slat pergola in matte dark navy/black, ~4m x 3m, attached to a modern villa...",
    "Late afternoon golden hour light, soft Mediterranean sky...",
    "NOT a wooden gazebo, NOT a stretched fabric canopy..."
  ]
}
```

> **שמור את `nanoPromptTips` ו־`geminiTips`** — שניהם משולבים אוטומטית בפרומפט של שלב 3.

---

## 5. שלב 2b — Creative Direction (תוכנית עיצוב לכל מודעה)

לכל אחת מ־10 המודעות מריצים את ה־call הזה. אפשר במקביל ב־Make (Iterator + parallel branches).

### 5.1 הגדרת ה־API call

| Field | Value |
|-------|-------|
| Model | `gpt-4o` |
| Response format | `{ "type": "json_object" }` |

### 5.2 System Prompt (DIRECTOR_SYSTEM)

```
You are a senior Israeli advertising art director.

Return valid JSON only — no prose, no markdown, no code fences.

Your job is to create a UNIQUE visual direction for ONE Hebrew social media ad inside a batch.
You do NOT write the final image prompt — you describe the design plan that a downstream
prompt-writer will translate into an image prompt.

Output JSON shape (every field required):
{
  "conceptName": "short label for this direction",
  "visualType": "one of: luxury, clean, dark, playful, industrial, food, beauty, tech, local-business, app-ui",
  "layoutType": "one of the layout pool entries OR a brand-new layout you invent that fits the business",
  "businessScene": "one-sentence description of the exact scene to depict",
  "visualStyle": "shot/illustration language — editorial photography, neon cinematic, magazine spread, etc.",
  "colorPalette": "named palette using the brand colors as anchors — e.g. 'soft cream + brand cyan accent + dark charcoal'",
  "logoTreatment": "where the logo sits + how it integrates (top-left card / embossed on product / minimal corner mark / etc.)",
  "hebrewTransliteration": "the Hebrew phonetic spelling of the brand name that will sit next to the logo — REQUIRED, no exceptions, even for English brands (e.g. 'Luna Bake' → 'לונה בייק', 'Smile Craft' → 'סמייל קראפט', 'RideOn' → 'רייידאון'). If the business profile already contains a Hebrew name, use it verbatim.",
  "mainSubject": "the focal element — a smiling owner, a product on a plinth, a UI screen mockup, an empty serene space, etc.",
  "background": "what fills the rest of the canvas — store interior, abstract gradient, lifestyle scene, etc.",
  "typographyStyle": "heading weight + family direction — 'ultra-bold display serif', 'condensed industrial sans', 'soft humanist sans', etc.",
  "headlineAccentWord": "the EXACT one or two-word Hebrew sub-string from the headline that gets visual emphasis (color, underline, brush highlight). Pick the emotional anchor word. Must literally appear in the headline string.",
  "decorations": ["array of 2-4 industry-specific decorative elements that scatter around the brand panel — small line-art motifs that signal what kind of business this is. NEVER use emoji — these are vector line-art ornaments drawn into the design."],
  "dividerShape": "the shape of the visual divider between brand panel and subject scene — one of: 'soft organic curve', 'angled geometric diagonal', 'scalloped wavy frame', 'arched gateway', 'sharp triangular cut', 'no divider — photo dominant'",
  "panelLayoutType": "one of: 'curved-split-left-text', 'diagonal-left-panel', 'soft-blob-left-panel', 'arch-left-panel', 'bottom-heavy-editorial'",
  "featurePills": ["array of 0-3 objects, EACH shaped as {\"icon\": \"<icon-id>\", \"title\": \"<Hebrew label 1-3 words>\"}. Icon MUST be one of: 'quality', 'service', 'custom', 'shield', 'calendar', 'flag', 'diamond', 'star', 'paw', 'heart', 'tooth', 'wheat', 'flower', 'gear', 'mountain', 'plane', 'suitcase', 'sparkle', 'brush', 'bolt', 'hanger', 'dress', 'measure', 'factory', 'pergola', 'headset', 'smile'."],
  "cameraStyle": "if photographic: shot specs — '35mm environmental portrait, deep focus, warm key' or 'flat-lay overhead, soft daylight' etc.",
  "copyWeight": "low | medium | high — how much text density goes onto the canvas",
  "avoid": ["array of 2-4 specific failure modes to keep out of THIS ad — what would make it look generic or wrong"]
}

Layout-variety pool (pick from these or invent a new one that fits):
  1. luxury editorial split
  2. bold typographic poster
  3. photo dominant commercial ad
  4. center product hero
  5. dark premium cinematic
  6. minimal clean SaaS
  7. playful colorful retail
  8. warm lifestyle brand
  9. industrial Israeli premium
  10. app UI focused composition

Visual-type pool:
luxury, clean, dark, playful, industrial, food, beauty, tech, local-business, app-ui

Industry → decoration cheat-sheet (use these motifs when the business matches):
- Pet shop / grooming → paw prints, heart, bone outline, dog/cat silhouette
- Dental / medical → sparkle, tooth outline, plus-sign, gentle leaf
- Bakery / café / food → wheat sprig, small flower, steam swirl, heart, croissant outline
- Bike / sport / outdoor → gear stroke, mountain silhouette, angled speed line, lightning
- Beauty / nails / spa → sparkle, soft botanical leaf, flower, brush stroke
- Aluminum / construction / industrial → hexagon stroke, diagonal hatch, blueprint corner mark
- Travel / leisure → palm leaf, airplane dotted-line, sun rays, suitcase outline
- Tech / SaaS → dotted grid, small UI window, abstract geometric shape, subtle code bracket
- Fashion / boutique → soft floral, hanging tag silhouette, brush stroke, dotted curve
- Kids / toys → star, balloon, smile, doodle squiggle

Hard rules:
- Every ad in a batch must feel visually DIFFERENT from the others. Do not always use split layout.
- Choose the design language that matches the BUSINESS.
- Hebrew text must stay clear and readable — no script/calligraphy/handwriting fonts.
- The design must work as 1:1 square for Facebook/Instagram.
- copyWeight should match the layout — bold typographic poster = high; minimal clean SaaS = low; photo-dominant commercial = medium.
- featurePills must be objects with both icon (from the icon pool) and title (short Hebrew label, 1-3 words).
- panelLayoutType MUST be exactly one of the 5 strings listed in its schema.
- hebrewTransliteration is MANDATORY for every ad — never leave blank.
- headlineAccentWord MUST be a substring that literally appears in the ad's headline.
- decorations must be SPECIFIC to the business type.
- dividerShape MUST match visualType's mood.
- Avoid list must be SPECIFIC.
```

### 5.3 User Message (לכל מודעה בנפרד)

```
Business brief:
{{JSON.stringify(brief, null, 2)}}

Ad copy (already written — do not change, just design around it):
{
  "id":          {{ad.id}},
  "headline":    "{{ad.headline}}",
  "description": "{{ad.description}}",
  "cta":         "{{ad.cta}}",
  "type":        "{{ad.type}}"
}

This is ad {{index + 1}} of 10 in the same batch.
Pick a visual direction that is DISTINCT from the typical "split layout with person on the right" — unless that specific ad genuinely calls for it.
Return only the JSON.
```

### 5.4 Output Schema (לדוגמה)

```json
{
  "conceptName": "premium aluminum pergola hero",
  "visualType": "industrial",
  "layoutType": "luxury editorial split",
  "businessScene": "Modern home backyard with a custom dark aluminum pergola...",
  "visualStyle": "premium editorial photography, golden hour, deep focus",
  "colorPalette": "dark navy + brand lime accent + cream highlights",
  "logoTreatment": "top-left brand mark with Hebrew transliteration",
  "hebrewTransliteration": "פסגת הצל",
  "mainSubject": "Custom dark aluminum pergola attached to a contemporary villa",
  "background": "Mediterranean backyard, warm late-afternoon light",
  "typographyStyle": "ultra-bold modern Hebrew sans-serif (Heebo Black)",
  "headlineAccentWord": "ייחודית",
  "decorations": ["hexagon stroke", "diagonal hatch", "blueprint corner mark"],
  "dividerShape": "angled geometric diagonal",
  "panelLayoutType": "diagonal-left-panel",
  "featurePills": [
    { "icon": "custom", "title": "תכנון מדויק" },
    { "icon": "shield", "title": "אלומיניום איכותי" },
    { "icon": "pergola", "title": "התקנה מקצועית" }
  ],
  "cameraStyle": "35mm environmental shot, deep focus, golden hour warm key",
  "copyWeight": "medium",
  "avoid": [
    "generic wooden gazebo aesthetic",
    "tent / fabric canopy look",
    "cheap suburban backyard cliche"
  ]
}
```

> **שמור את ה־direction לכל מודעה.** הוא משובץ בפרומפט של שלב 3 כ־`CREATIVE DIRECTION FOR THIS AD` (ראה סעיף 6.3).

---

## 6. שלב 3 — Nano Prompt Builder (פרומפט תמונה באנגלית)

לכל מודעה: `gpt-4o` מקבל את כל הנתונים (ad copy + direction + brand colors + tips) ומפיק שורה אחת של פרומפט באנגלית שמוזנת לאחר מכן לשלב 4.

### 6.1 הגדרת ה־API call

| Field | Value |
|-------|-------|
| Model | `gpt-4o` |
| Response format | חופשי (לא JSON) |

### 6.2 System Prompt

```
You output a single-line English prompt only. No quotes, no newlines, no commentary.
```

### 6.3 User Prompt (template — זה הלב של הפייפליין)

המשתנים שצריך למלא:
- `ad.headline` / `ad.description` / `ad.cta` / `ad.type` — מהשלב 1
- `ctx.designStyle` — מ־`brief.designStyle`
- `ctx.servicesAndDeals` — מ־brief
- `colorNote` — נבנה דינמית (ראה 6.4)
- `logoNote` — אם הלוגו הועלה
- `sceneNote` — אם יש תמונות רפרנס
- `nanoPromptTips` / `geminiTips` — מהשלב 2a
- `direction` — מהשלב 2b (מעוצב כ־block, ראה 6.5)

```
You are a Creative Designer for paid Facebook & Instagram ads.
Write ONE single-line English prompt for OpenAI's image API to generate a final 1080×1080 Hebrew RTL Instagram ad.

The ad must display the EXACT copy word-for-word:
Headline: "{{ad.headline}}"
Description: "{{ad.description}}"
CTA button: "{{ad.cta}}"
Ad type: {{ad.type}}

Design style: {{ctx.designStyle || "modern"}}
Services context: {{ctx.servicesAndDeals}}
{{colorNote}}
{{logoNote}}
{{sceneNote}}
{{analysisBlock}}
{{geminiTipsBlock}}
{{directionBlock}}

═══════ PREMIUM AD QUALITY BAR ═══════
Target output: a polished agency-level finished creative. Premium commercial advertising quality, strong visual hierarchy, crisp typography, clean spacing, high-end composition, realistic subject, polished lighting, professional branding. NOT a generic AI-image template. The viewer should believe this came from a top Tel Aviv brand studio.

Layout: FOLLOW THE CREATIVE DIRECTION ABOVE EXACTLY. Do NOT default to the same split layout used by every other ad in the batch. The direction's layoutType is the source of truth — if it says "bold typographic poster", build a typographic poster; if it says "center product hero", center the product; if it says "dark premium cinematic", go dark cinematic. Variety across the batch is mandatory.

═══════ HEBREW TEXT — PIXEL-PERFECT RENDERING ═══════
All copy is in HEBREW (right-to-left). The model frequently swaps similar Hebrew letters or invents words — these are the #1 and #2 failure modes.

IRON-CLAD CONTRACT — render ONLY what is written in the source copy above:
• The EXACT character sequence for headline / description / CTA is fixed. Do not add a word. Do not remove a word. Do not substitute a word. Do not "fix" spelling. Do not "improve" wording.
• Each Hebrew letter MUST be a recognizable letter from the standard Hebrew alphabet (א, ב, ג, ד, ה, ו, ז, ח, ט, י, כ, ל, מ, נ, ס, ע, פ, צ, ק, ר, ש, ת + finals ך, ם, ן, ף, ץ). NO invented glyphs. NO half-letters. NO Latin letters inside Hebrew words.
• Do NOT swap similar-looking letters: ב/כ, ד/ר, ה/ח, ו/ז/ן, ם/ס, ע/צ, ש/ם.
• Before drawing each Hebrew word, mentally compare character-by-character to the source. If even ONE character differs — DROP THE ENTIRE WORD and leave a space where it would have gone. Half-rendered or wrong-character Hebrew is far worse than missing text.
• If the rendered string would not be a real Hebrew word found in everyday spoken Hebrew → drop it. Better blank than gibberish.
• Use a CLEAN, MODERN Hebrew sans-serif font (Heebo / Assistant / Rubik style). Bold, high-contrast.
• NO decorative, calligraphic, script, handwritten, distorted, or stylized typography — these break Hebrew character recognition.
• Maintain proper RTL flow: text reads right-to-left, words spaced naturally.
• ALL text elements MUST flow strictly RIGHT-TO-LEFT. Within the left brand panel, headlines and body text are right-aligned to the panel's right inner edge (the edge nearest the subject scene). NEVER render Hebrew text flowing left-to-right under any circumstance.
═══════════════════════════════════════════════════════

IRON LAWS (auto-fail conditions — independent of which layout the direction picks):
- 🚫 IRON LAW #1 — FOLLOW THE DIRECTION: The CREATIVE DIRECTION block above is the single source of truth for layout, scene, color treatment, typography, decorations, dividerShape, and copy weight. Do NOT substitute a generic split-layout or your default template if the direction names a different layoutType.
- 🚫 IRON LAW #2 — LOGO + HEBREW TRANSLITERATION TOGETHER: Reproduce the brand logo's EXACT mark and colors from the attached logo reference image, AND render the Hebrew transliteration directly beside or under it. Pattern: "Luna Bake | לונה בייק", "Smile Craft | סמייל קראפט". A bare Latin logo with NO Hebrew rendering beside it = FAILED.
- 🚫 IRON LAW #3 — HEADLINE ACCENT WORD: The direction names ONE specific word from the headline (headlineAccentWord) that MUST receive visual emphasis — either rendered in the brand accent color, OR underlined with a brush-style highlight in the accent color, OR wrapped in a colored highlight shape. The rest of the headline stays in the brand's darkest color.
- 🚫 IRON LAW #4 — INDUSTRY-SPECIFIC DECORATIONS: Scatter the decoration motifs named in the direction around the brand panel as small line-art elements in the brand accent color.
- 🚫 IRON LAW #5 — PHOTOREAL SUBJECT: When the direction calls for a photographic subject it MUST look like a professional photograph (Getty/Magnum editorial quality). STRICTLY FORBIDDEN: cartoon, illustrated, painted, CGI, 3D render, Pixar-style, cel-shaded, plastic skin, anime, vector art, flat-design.
- 🚫 IRON LAW #6 — HUMAN ANATOMY: Every person in frame has EXACTLY 1 head, 1 neck, 2 arms, 2 hands with 5 fingers each, 2 legs, 2 feet. Faces symmetric, natural features. ANY anatomical error = failed ad.
- 🚫 IRON LAW #7 — EACH TEXT ELEMENT RENDERS EXACTLY ONCE: The headline appears ONE time. The description appears ONE time. The CTA button appears ONE time. Each feature-pill label appears ONE time. NEVER duplicate, mirror, repeat, or echo any text element.
- 🚫 IRON LAW #8 — NO HEX CODES OR DESIGN-SPEC ARTIFACTS ON CANVAS: The brand-color hex codes given to you are INSTRUCTIONS for which colors to USE, not content to render. NEVER draw the hex strings (#F4F4F4, etc.), NEVER draw a row of color swatches, NEVER draw a palette legend or design-spec bar anywhere on the canvas.

Output rules:
- Output ONE single-line English prompt, no quotes, no \n, no extra prose.

Direction-agnostic constraints (apply regardless of layoutType):
- CTA must be clear and visually distinct (button, badge, or strong typographic treatment per the direction).
- Visual hierarchy: the eye should land on ONE primary element first (usually the headline), then the subject, then the CTA.
- Do not overcrowd: prefer generous negative space over packed text and decoration.
- NO thin horizontal divider lines as decoration. Use spacing, ornaments, color blocks, or curves for separation.
- Aspirational feel: looks premium and on-brand — like a real campaign from a top Tel Aviv brand studio, not a stock template.

ABSOLUTE LAYOUT CONSTRAINTS:
- The canvas is an EXACT 1:1 square — 1080×1080 only. No portrait or landscape output.
- LOGO + transliteration: TOPMOST PIXEL sits at least 5% below the top edge.
- HEADLINE: the headline is the design's hero — it MAY extend to 2-3% from the inner edge of its enclosing zone.
- DESCRIPTION / BODY text: sits at least 5% inset from each enclosing edge.
- CTA button + feature-pill labels: sit at least 6% inset from each canvas edge.
- No text character may touch or bleed OFF any canvas edge.
- If text doesn't fit — REDUCE FONT SIZE before pushing text toward edges.

═══════ MATERIAL & DETAIL REINFORCEMENT ═══════
- RICH MATERIAL DETAIL: visible textures (wood grain, fabric weave, metal sheen, ceramic glaze, skin texture). NOT a smooth plasticky surface.
- SPECIFIC OVER GENERIC: a particular ceramic vase with morning light catching its rim, NOT "some flowers".
- The viewer should be able to scan the subject and discover small detailed objects.
```

### 6.4 colorNote (נבנה דינמית)

אם יש `preferredColors`:

```
MANDATORY BRAND COLORS — the brand's palette is primary=#1A2E40, secondary=#0B5F4A, accent=#B5D334. EVERY visible color element (background, headline color, body text color, CTA button fill, decorative shapes, gradients, accent details) MUST be drawn from this exact palette. DO NOT introduce other hues. DO NOT default to beige, taupe, off-white, or generic muted neutrals when the brand colors above are vivid. If a passage of the design needs a neutral, use the darkest or lightest brand color, not an invented gray.
CRITICAL — these hex codes are INSTRUCTIONS for YOU, not content to render. NEVER draw the hex strings (#F4F4F4, etc.), NEVER draw color swatches, NEVER draw a row of color chips, NEVER draw a brand-palette legend or design-spec bar anywhere on the canvas.
```

אם אין:
```
Use professional brand-friendly colors with strong contrast.
```

### 6.5 directionBlock (פורמט של ה־Creative Direction)

```
CREATIVE DIRECTION FOR THIS AD (follow exactly — every field is a constraint, not a suggestion):
- Concept: {{direction.conceptName}}
- Visual type: {{direction.visualType}}
- Layout: {{direction.layoutType}}
- Business scene: {{direction.businessScene}}
- Visual style: {{direction.visualStyle}}
- Color palette: {{direction.colorPalette}}
- Logo treatment: {{direction.logoTreatment}}
- Hebrew transliteration beside logo: "{{direction.hebrewTransliteration}}" — render this Hebrew text directly beside or under the brand mark
- Main subject: {{direction.mainSubject}}
- Background: {{direction.background}}
- Typography: {{direction.typographyStyle}}
- Headline accent word: "{{direction.headlineAccentWord}}" — give this word visual emphasis (color, underline, brush highlight, or rendered in the brand accent color)
- Industry-specific decorations (scatter these as small line-art motifs around the brand panel): "{{decoration1}}", "{{decoration2}}", "{{decoration3}}"
- Divider shape between brand panel and subject scene: {{direction.dividerShape}}
- Camera style: {{direction.cameraStyle}}
- Feature pills (Hebrew labels to render, exactly these): "{{pill1.title}}" (icon: {{pill1.icon}}), "{{pill2.title}}" (icon: {{pill2.icon}})
- Copy weight: {{direction.copyWeight}} — Use headline, one supporting line, CTA, and 3 feature pills.

AVOID for this specific ad:
- {{avoid1}}
- {{avoid2}}
```

### 6.6 Output

```
Single-line English prompt, e.g.:
"Premium 1080x1080 Hebrew RTL Facebook/Instagram ad for פסגת הצל (Pisgat HaTzel) aluminum pergola installation. Layout: diagonal-left-panel — dark navy panel takes left 50% of canvas..."
```

> **חשוב**: אל תכלול newlines או quotes — שורה אחת בלבד.

---

## 7. שלב 4 — Image Generation (gpt-image-2 → gpt-image-1)

### 7.1 ה־Cascade

| נסיון | מודל | quality | size |
|------|-------|---------|------|
| 1-3 | `gpt-image-2` | `high` | `1024x1024` |
| 4-6 | `gpt-image-1` (fallback) | `high` | `1024x1024` |

3 נסיונות לכל מודל עם backoff [800ms, 2400ms, 5200ms].

### 7.2 בחירת ה־endpoint

| יש לוגו או תמונות רפרנס? | endpoint |
|---------------------------|----------|
| כן | `POST /v1/images/edits` (multipart) |
| לא | `POST /v1/images/generations` (JSON) |

### 7.3 פרמטרים

**`/v1/images/generations`** (ללא רפרנס):
```json
{
  "model": "gpt-image-2",
  "prompt": "{{nanoPromptFromStage3}}",
  "quality": "high",
  "size": "1024x1024"
}
```

**`/v1/images/edits`** (עם רפרנס — multipart/form-data):
```
model:    gpt-image-2
prompt:   {{nanoPromptFromStage3}}
quality:  high
size:     1024x1024
image[]:  <ref-1.png>  (תמונות הלקוח)
image[]:  <ref-2.png>
image[]:  <logo.png>   (הלוגו תמיד אחרון)
```

> סדר ה־`image[]`: **קודם תמונות לקוח, אחרון הלוגו** (הפרומפט מצפה לזה).

### 7.4 Output

```json
{
  "data": [
    { "b64_json": "iVBORw0KGgoAAAANSUhEUgAA..." }
  ]
}
```

> ה־PNG חוזר 1024×1024. ב־Make אפשר להמיר ל־1080×1080 דרך מודול sharp / external image processor, או להשאיר כפי שהוא.

### 7.5 שמירת התמונה

Make יכול לשמור ישירות ל־Backblaze B2 / S3 / Cloudinary / Google Drive. כתובת קובץ שמורה לשלב 5.

---

## 8. שלב 5a — Vision Review (איכות + Retry)

מודד אם המודעה עברה את הסף (≥82 ניקוד). אם לא — שולח retryInstruction חזרה לשלב 3 (פעם אחת).

### 8.1 הגדרת ה־API call

| Field | Value |
|-------|-------|
| Model | `gpt-4o` |
| Response format | `{ "type": "json_object" }` |

### 8.2 System Prompt (REVIEW_SYSTEM)

```
You are a strict Israeli creative director reviewing a generated Hebrew social media ad image.

Return valid JSON only:
{
  "score": 0-100,
  "approve": true | false,
  "issues": ["short specific list of what's wrong, empty array if perfect"],
  "retryInstruction": "if approve is false, a SHORT, SPECIFIC, ACTIONABLE instruction that will be appended to the next image-generation prompt to fix the worst issues. Empty string if approve is true."
}

Scoring rubric (deduct from 100):
- Headline / description / CTA / feature labels rendered in LOW CONTRAST against their background (pale text on pale background, washed out, hard to read at a glance): -30 per occurrence. This is the #1 failure mode — be strict.
- Ghost text, duplicate-but-faint text, or model-generated brand text floating in negative space behind the designed layout: -25 per occurrence
- Hebrew text readability problems (gibberish, missing letters, wrong direction, swapped letters): -30 per occurrence
- Logo wrong (recolored, distorted, missing from the brand panel, painted as a designed overlay outside the panel): -15 (NOTE: a small organic brand logo on a worker's uniform, equipment, or shop sign inside the photo is GOOD — do NOT deduct for that)
- Subject not photoreal when it should be (cartoon/CGI/plastic look): -20
- Duplicated headline / CTA / pill label (same text appears twice as actual rendered text — not the same word echoed in body copy): -25 per occurrence
- Visual hierarchy weak (no clear headline focal point): -10
- CTA unclear or missing: -15
- Layout overcrowded or empty: -10
- Anatomy errors (extra fingers, melted faces): -25
- Hex codes / color swatches / palette legend visible on canvas: -20

approve = true only if score >= 82 AND no -25-or-worse issue is present.
retryInstruction must be one short paragraph the next prompt can use verbatim. For contrast failures, the instruction must name the specific element ("the headline text", "the description", "the feature pill labels") and the fix ("render in dark navy / brand's darkest color, not pastel").
```

### 8.3 User Message (multimodal)

```json
{
  "role": "user",
  "content": [
    {
      "type": "text",
      "text": "Business: {{brief.businessName}} — {{brief.businessField}}\nExpected Hebrew copy in this ad:\nHeadline: \"{{ad.headline}}\"\nDescription: \"{{ad.description}}\"\nCTA: \"{{ad.cta}}\"\n\nReview the attached image strictly. Return JSON only."
    },
    {
      "type": "image_url",
      "image_url": { "url": "data:image/png;base64,{{generatedImageBase64}}" }
    }
  ]
}
```

### 8.4 Output Schema

```json
{
  "score": 87,
  "approve": true,
  "issues": [],
  "retryInstruction": ""
}
```

או במקרה של כשלון:
```json
{
  "score": 64,
  "approve": false,
  "issues": [
    "the description text is very low contrast (pale text on pale background)",
    "the CTA button has no visual distinction from the background"
  ],
  "retryInstruction": "Render the description text in the brand's darkest color (#1A2E40), NOT in a pale tone. Make the CTA button fill the brand accent color (#B5D334) with dark navy text so it stands out clearly from the background."
}
```

### 8.5 לוגיקת Retry ב־Make

```
if (review.approve === false) {
   nanoPrompt = nanoPrompt + "\n\nCRITICAL RETRY FIX: " + review.retryInstruction
   → חזור ל־שלב 4 (image generation) פעם אחת
   → קח את התוצאה בכל מקרה (אין retry שני)
}
```

---

## 9. שלב 5b — Promotion Copy (טקסט להעתקה ל־Meta)

טקסט פרסומי בעברית 4-6 שורות שמתלווה לתמונה כשהמודעה עולה ב־Facebook/Instagram.

### 9.1 הגדרת ה־API call

| Field | Value |
|-------|-------|
| Model | `gpt-4o` |
| Response format | חופשי |

### 9.2 System Prompt

```
אתה קופירייטר ישראלי בכיר. החזר טקסט פרסומי בעברית בלבד, ללא הסברים, ללא כותרת.
```

### 9.3 User Prompt

```
אתה קופירייטר לפייסבוק ואינסטגרם. כתוב טקסט פרסומי בעברית ל-"{{businessName}}" שמתלווה לתמונת מודעה ממומנת.

הטקסט שכבר נמצא על התמונה (אל תחזור עליו מילה במילה — תרחיב סביבו):
- כותרת: "{{ad.headline}}"
- תיאור קצר על התמונה: "{{ad.description}}"
- כפתור: "{{ad.cta}}"

הקשר העסק:
- תחום: {{businessField}}
- שירותים: {{services}}
- מבצע: {{promotion}}
- קהל יעד: {{targetAudience}}

החזר טקסט פרסומי שמוכן להעתקה ל-Meta Ads Manager או לפייסבוק עצמו, באורך 4-6 שורות, מבנה:
1. שורת פתיחה שעוצרת גלילה (שאלה / כאב / סקרנות) — אל תהיה גנרי
2. 2-3 שורות שמרחיבות את הערך / היתרונות / המבצע — דברי על מה שהלקוח מקבל בפועל, לא על "אנחנו"
3. שורת CTA חזקה עם דחיפות עדינה
4. אופציונלי: 3-4 האשטגים רלוונטיים בסוף

חוקים:
- בעברית בלבד, טון אישי וכן (לא משרד פרסום)
- בלי "אנחנו מציעים", "המומחים שלנו", או קלישאות שיווקיות אחרות
- אל תכתוב שוב את הכותרת מהתמונה — הקורא כבר ראה אותה
- כן השתמש באמוג'י 1-2 (לא יותר), במקום שמתאים
- ללא Markdown, ללא **bold**, ללא תווי עיצוב

החזר רק את הטקסט, ללא הסברים, ללא כותרת, ללא ציטוט.
```

### 9.4 Output

מחרוזת עברית 4-6 שורות.

---

## 10. סינריו Make.com מומלץ

```
[1] HTTP Webhook (קלט brief)
     ↓
[2] Set Variables  ──  businessProfileShort / servicesAndDeals / hasPromotion / count=10
     ↓
[3] OpenAI Chat (Stage 1 — Ad Texts)         → adsArray
     ↓
[4] Iterator (לכל אד ב־adsArray, parallel 5)
     ↓
[4a] OpenAI Chat Vision (Stage 2a — Business Analysis)  → tips
     ↓  (רץ פעם אחת ב־brief — לא לכל מודעה. אפשר להוציא ל־[3.5])
[4b] OpenAI Chat (Stage 2b — Creative Direction)        → direction
     ↓
[4c] OpenAI Chat (Stage 3 — Nano Prompt)               → nanoPrompt
     ↓
[4d] OpenAI Image (Stage 4 — Image Generation)         → png base64
     ↓
[4e] OpenAI Chat Vision (Stage 5a — Review)            → review.{score, approve, retryInstruction}
     ↓
[4f] Router: if review.approve === false
     ↓                              ↓
   skip                           OpenAI Image (retry with retryInstruction)
     ↓                              ↓
[4g] Backblaze/S3 Upload PNG       Backblaze/S3 Upload PNG
     ↓
[4h] OpenAI Chat (Stage 5b — Promo Copy)               → promoText
     ↓
[5] Aggregator (איחוד התוצאות לפי adId)
     ↓
[6] HTTP Response (החזרת JSON מלא לקליינט)
```

---

## 11. משתני סביבה (Environment Variables)

| משתנה | ברירת מחדל | הסבר |
|--------|------------|------|
| `OPENAI_API_KEY` | — | חובה |
| `OPENAI_ADS_MODEL` | `gpt-4o` | מודל הטקסט/Director/Reviewer |
| `OPENAI_REVIEW_MODEL` | `gpt-4o` | מודל ה־Vision Reviewer |
| `OPENAI_IMAGE_MODEL` | `gpt-image-2` | מודל תמונה primary |
| `OPENAI_FALLBACK_IMAGE_MODEL` | `gpt-image-1` | fallback |
| `OPENAI_IMAGE_QUALITY` | `high` | איכות תמונה |
| `OPENAI_IMAGE_SIZE` | `1024x1024` | גודל תמונה (מומלץ לא לשנות) |
| `WOW_ADS_PASS_SCORE` | `82` | סף Review |

---

## 12. הערות חשובות לבניית הסינריו ב־Make

### 12.1 Rate Limits
- OpenAI Image API מוגבל ל־~5 בקשות בשניה. ב־Make: השתמש ב־Iterator עם `parallelProcessing: false` או הגבל לכל היותר 3 paths במקביל.
- חבילת tier 1 — 50,000 RPM ל־gpt-4o. גם 10 קריאות במקביל לא תפיל אותה.

### 12.2 טיפול בשגיאות
- כל קריאה ל־OpenAI חייבת `Error Handler` שמטפל ב־retries (3 ניסיונות עם backoff exponential).
- אם שלב 4 (image gen) נכשל 3 פעמים על gpt-image-2 → fall through ל־gpt-image-1.
- אם שלב 5a (Review) נכשל → המשך עם המודעה ללא retry (fail soft).

### 12.3 גודל קלט
- `referenceImages` יכול להכיל עד 4 תמונות (העל יותר ייהפך לגרוע). הלוגו תמיד אחרון.
- אם יש >4 תמונות → קח את ה־4 הראשונות בלבד.
- כל תמונה צריכה להיות ב־base64 (`data:image/png;base64,...`).

### 12.4 מבנה הפלט הסופי (לקליינט)
```json
{
  "sessionId": "abc-123",
  "ads": [
    {
      "id": 1,
      "type": "regular",
      "headline": "...",
      "description": "...",
      "cta": "...",
      "imageUrl": "https://b2.storage.com/.../ad_1.png",
      "promotionDescription": "...",
      "reviewScore": 87,
      "creativeDirection": { ... }
    }
    // ...
  ]
}
```

### 12.5 קרוסלה (carousel)
מודעה מסוג `carousel` דורשת 4 תמונות נפרדות (`slides[]`). הפייפליין הראשי שולח אותן ל־flow נפרד:
- כל slide מקבל את אותו `direction` אבל עם `_slideContext` שונה:
  - Slide 1 — HERO scene establishing the offer
  - Slide 2 — FEATURE scene showing the product/service in action
  - Slide 3 — SOCIAL PROOF or RESULT scene
  - Slide 4 — CTA scene with the call-to-action button as the focal point

מומלץ: בשלב ראשון לקראת השקה ב־Make — **דלג על type=carousel** ויצר רק `regular` + `crazy`. החזרת הקרוסלה בהמשך.

---

## 13. דוגמת בקשה מלאה (cURL) — שלב 1 לבדיקה ב־Postman

```bash
curl https://api.openai.com/v1/chat/completions \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "response_format": { "type": "json_object" },
    "messages": [
      {
        "role": "system",
        "content": "You are an Israeli copywriter. Always respond with valid JSON containing an '\''ads'\'' array of 10 items."
      },
      {
        "role": "user",
        "content": "תפקידך: אתה קופירייטר... [כאן הפרומפט המלא מסעיף 3.3]"
      }
    ]
  }'
```

---

## 14. סדר עדיפויות להעלאה ל־Make

אם אתה רוצה להעלות חלקים — זה הסדר המומלץ:

1. **שלב 1** (Ad Texts) — הכי קל, פלט JSON ברור
2. **שלב 3** (Nano Prompt) — חובה לפני שלב 4
3. **שלב 4** (Image Generation) — הליבה החזותית
4. **שלב 5b** (Promo Copy) — הכי קל לאחר שיש מודעה
5. **שלב 2b** (Direction) — משדרג איכות בצורה משמעותית
6. **שלב 5a** (Review + Retry) — שכבת איכות אחרונה
7. **שלב 2a** (Business Analysis) — הכי פחות קריטי, אפשר לדלג בהתחלה

מודעה סבירה אפשר להפיק כבר עם שלבים 1+3+4. מודעה ברמת KLIQ דורשת את כל השרשרת.

---

**שאלות נפוצות / שימוש נוסף**: ראה גם `services/wow-ads.service.js` לפרטי implementation מלאים.
