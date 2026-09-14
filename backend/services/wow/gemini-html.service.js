/**
 * HTML Service — generates the landing-page HTML via Gemini.
 */
const fs = require("fs/promises");
const path = require("path");
const { GoogleGenAI } = require("@google/genai");
const { planSections, renderBlueprint } = require("./section-blueprint");
const { formatBrandPalette } = require("../../utils/brand-palette");

const STYLE_META = {
  'editorial': { styleBlock: 'Design style: Editorial Studio. Asymmetrical magazine-style layout, editorial photography, oversized pull quotes, bold contrasting type weights, and generous white space like a high-end gallery.', visualTraits: 'פריסה א-סימטרית בסגנון מגזין יוקרה, צילום אדיטוריאלי, ציטוטים ענקיים, משקלי טיפוגרפיה מנוגדים, חלל לבן בסגנון גלריה', suitableFor: 'סוכנויות קריאייטיב, מגזינים דיגיטליים, מותגי fashion, סטודיו למיתוג' },
  'neo-brutalism': { styleBlock: 'Design style: Neo-Brutalism. Use raw, bold, unapologetic elements — thick black borders, hard drop shadows (no blur), neon primary accent colors, and oversized screaming typography.', visualTraits: 'גבולות שחורים ועבים, צלליות קשות ללא טשטוש, צבעי יסוד עזים, טיפוגרפיה ענקית וצועקת', suitableFor: 'סטארטאפים, אפליקציות לצעירים, מותגי streetwear' },
  'glassmorphism': { styleBlock: 'Design style: Glassmorphism & High-Tech. Dark mode with glowing colorful orbs, frosted glass card surfaces, thin light borders, and clean futuristic sans-serif fonts.', visualTraits: 'רקעים כהים, זכוכית חלבית שקופה, הילות צבעוניות, פונטים נקיים ודקים', suitableFor: 'SaaS, AI, קריפטו, טכנולוגיה' },
  'organic': { styleBlock: 'Design style: Organic & Earthy. Earthy palette (sage, ochre, terracotta, linen), amorphous blob shapes, rounded soft typography, and natural textures.', visualTraits: 'צבעי אדמה, פינות מעוגלות, צורות אמורפיות, פונטים רכים', suitableFor: 'קוסמטיקה טבעית, יוגה, פרחים, ריזורטים' },
  'swiss': { styleBlock: 'Design style: Swiss Minimalist. Strict mathematical grid, extreme white space, single accent color, Helvetica-family fonts, zero decorations.', visualTraits: 'גריד מתמטי, חלל לבן, צבע accent אחד, פונטים Helvetica', suitableFor: 'אדריכלים, עורכי דין, גלריות' },
  'classic': { styleBlock: 'Design style: Luxury / High-End. Deep dark backgrounds, gold accents, premium dramatic typography, moody photography, absolute exclusivity.', visualTraits: 'רקע כהה, זהב, טיפוגרפיה פרמיום, תמונות דרמטיות', suitableFor: 'יוקרה, High-End, מותגים יוקרתיים' },
  'noir': { styleBlock: 'Design style: Noir. Strictly black and white, dramatic high-contrast, extreme negative space, sharp elegant typography.', visualTraits: 'שחור-לבן, קונטרסט דרמטי, מינימליזם קיצוני', suitableFor: 'שעוני יוקרה, רכב, אופנה עילית' },
  'retro-70s': { styleBlock: 'Design style: Retro 70s. Warm earthy tones (orange, mustard, chocolate), chunky bubble typography, psychedelic wavy patterns, vintage film grain.', visualTraits: 'כתום, חרדל, פונטים שמנים, קווים גליים, וינטג\'', suitableFor: 'קפה, מוזיקה, וינטג\', מזון' },
  'cyberpunk': { styleBlock: 'Design style: Cyberpunk. Extreme dark mode, neon colors (pink, cyber-green, electric blue), glitch effects, metallic elements, technical typography.', visualTraits: 'ניאון, גליץ\', מתכת, פונטים טכניים', suitableFor: 'משחקים, Web3, מוזיקה אלקטרונית' },
  'mindful-gradient': { styleBlock: 'Design style: Mindful Gradient. Fluid lavender-to-sunset gradient mesh, glassmorphism cards, organic blob shapes, whisper-weight typography.', visualTraits: 'גרדיאנטים רכים, זכוכית אורגנית, פונטים אלגנטיים, שקט', suitableFor: 'NLP, מאמנים, מדיטציה, Wellness' },
  'solarpunk': { styleBlock: 'Design style: Solarpunk / Eco-Futurism. High-tech glass merged with botanical elements, golden-hour sunlight, green-gold palette, organic flowing curves.', visualTraits: 'שמש, צמחייה, זכוכית, ירוק-זהב, אורגני', suitableFor: 'אקלים, טבעונות, בנייה ירוקה' },
  'modern': { styleBlock: 'Design style: Modern & Clean. Sharp contemporary lines, balanced whitespace, confident minimalist aesthetic, current typography.', visualTraits: 'קווים חדים, מינימליזם, מקצועי', suitableFor: 'כל עסק מודרני' },
  'minimalist': { styleBlock: 'Design style: Pure Minimalist. Extreme simplicity, one accent color, content-first, generous white space, zero noise.', visualTraits: 'פשטות קיצונית, ניקיון מוחלט', suitableFor: 'כל עסק שרוצה ניקיון' },
  'elegant': { styleBlock: 'Design style: Elegant & Feminine. Soft curves, delicate pastel tones, refined serif typography, warm graceful atmosphere.', visualTraits: 'עקמומיות רכות, פסטל, סריף מעודן, חיננית', suitableFor: 'חתונות, קוסמטיקה, מתנות' },
};

// Deterministic mapping: designStyle → reference template file.
// Each family groups styles sharing visual DNA (palette temperature, mood, layout feel).
const TEMPLATE_BY_STYLE = {
  // botanical-couture — light, warm, organic, soft, feminine, wellness
  elegant: 'botanical-couture.html', organic: 'botanical-couture.html', atelier: 'botanical-couture.html',
  ethereal: 'botanical-couture.html', japandi: 'botanical-couture.html', 'soft-zen': 'botanical-couture.html',
  'eco-minimal': 'botanical-couture.html', 'mindful-gradient': 'botanical-couture.html', solarpunk: 'botanical-couture.html',
  scrapbook: 'botanical-couture.html', 'human-journal': 'botanical-couture.html', 'makers-journal': 'botanical-couture.html',
  claymorphism: 'botanical-couture.html',

  // editorial-fashion — light, cool, editorial, architectural, monochrome, minimalist
  editorial: 'editorial-fashion.html', kinetic: 'editorial-fashion.html', monolithic: 'editorial-fashion.html',
  noir: 'editorial-fashion.html', swiss: 'editorial-fashion.html', 'clinical-grid': 'editorial-fashion.html',
  broadsheet: 'editorial-fashion.html', minimalist: 'editorial-fashion.html', modern: 'editorial-fashion.html',
  'editorial-performance': 'editorial-fashion.html', 'op-art': 'editorial-fashion.html', 'anti-design': 'editorial-fashion.html',
  'color-block': 'editorial-fashion.html', bauhaus: 'editorial-fashion.html', risograph: 'editorial-fashion.html',

  // family-travel — light, vibrant, playful, bright, warm-forward
  'vibrant-pop': 'family-travel.html', 'frutiger-aero': 'family-travel.html', fintech: 'family-travel.html',
  bento: 'family-travel.html', neumorphism: 'family-travel.html', memphis: 'family-travel.html',
  'comic-book': 'family-travel.html', 'space-age': 'family-travel.html', 'retro-juice': 'family-travel.html',

  // luxury-resort — dark, warm, gold/black, moody luxury
  classic: 'luxury-resort.html', 'dark-academia': 'luxury-resort.html', 'art-deco': 'luxury-resort.html',
  baroque: 'luxury-resort.html', heritage: 'luxury-resort.html', 'raw-workshop': 'luxury-resort.html',
  'tropical-luxury': 'luxury-resort.html', 'retro-70s': 'luxury-resort.html',

  // luxury-travel — dark, cool, dramatic, tech-noir, high-energy
  'neo-brutalism': 'luxury-travel.html', glassmorphism: 'luxury-travel.html', cyberpunk: 'luxury-travel.html',
  iridescent: 'luxury-travel.html', vaporwave: 'luxury-travel.html', acid: 'luxury-travel.html',
  'pixel-art': 'luxury-travel.html', 'hyper-skeuomorphism': 'luxury-travel.html', blueprint: 'luxury-travel.html',
  'neural-tech': 'luxury-travel.html', 'liquid-chrome': 'luxury-travel.html', 'flash-noir': 'luxury-travel.html',
  'urban-bold': 'luxury-travel.html', maximalism: 'luxury-travel.html', grunge: 'luxury-travel.html',
};

function extractVisualDNA(html) {
  if (!html) return null;
  const linkMatch = html.match(/<link[^>]*fonts\.googleapis\.com[^>]*>/i);
  const rootMatch = html.match(/:root\s*\{[\s\S]*?\}/);
  const familyMatches = [...html.matchAll(/font-family:\s*[^;]+;/g)]
    .map(m => m[0])
    .filter((v, i, a) => a.indexOf(v) === i)
    .slice(0, 4);
  if (!linkMatch && !rootMatch) return null;
  return {
    fontLinkTag: linkMatch?.[0] || '',
    rootBlock: rootMatch?.[0] || '',
    fontFamilyDecls: familyMatches,
  };
}

function pickReferenceTemplate(designStyle, available) {
  const normalized = (designStyle || '').toLowerCase();
  const exact = TEMPLATE_BY_STYLE[normalized];
  if (exact && available.has(exact)) return exact;
  const partial = Object.keys(TEMPLATE_BY_STYLE).find(k => normalized.includes(k));
  if (partial && available.has(TEMPLATE_BY_STYLE[partial])) return TEMPLATE_BY_STYLE[partial];
  // Neutral fallback: editorial-fashion is the most universally adaptable
  if (available.has('editorial-fashion.html')) return 'editorial-fashion.html';
  const first = [...available][0];
  return first || null;
}

const generateFullHtml = async (brief) => {
  const ds = brief.designStyle || 'modern';
  const meta = STYLE_META[ds] || STYLE_META[Object.keys(STYLE_META).find(k => ds.includes(k)) || ''] || null;
  const waLink = `https://wa.me/${(brief.phone || '').replace(/[^0-9]/g, '')}`;
  console.log(`✦ [HTML] designStyle: "${ds}"`);

  // Load a full template as reference — pick deterministically by designStyle
  // TODO: templates directory not yet ported; when present, place under iconiq-server/data/wow-templates
  const TEMPLATES_DIR = path.resolve(__dirname, '../../data/wow-templates');
  let templateRef = '';
  let dna = null;
  try {
    const available = new Set((await fs.readdir(TEMPLATES_DIR)).filter(f => f.endsWith('.html')));
    const pick = pickReferenceTemplate(ds, available);
    if (pick) {
      templateRef = await fs.readFile(path.join(TEMPLATES_DIR, pick), 'utf-8');
      dna = extractVisualDNA(templateRef);
      console.log(`✦ [HTML] Template reference: ${pick} (${(templateRef.length/1024).toFixed(0)}KB) for designStyle=${ds}`);
    }
  } catch {
    console.warn('[HTML] No templates directory found — proceeding without visual DNA reference');
  }

  const dnaBlock = dna ? `
VISUAL DNA — NON-NEGOTIABLE. You MUST copy these EXACTLY from the reference. Do NOT substitute with other fonts or variable names.

1. Google Fonts link tag (include verbatim in <head>):
${dna.fontLinkTag}

2. :root CSS variable block — copy the variable NAMES exactly. You MAY adapt hex values to the brief's brand colors (keep the palette's warm/cool + dark/light direction), but variable names and count must match:
${dna.rootBlock}

3. font-family declarations — reuse these exact rules in your CSS:
${dna.fontFamilyDecls.join('\n')}

These three items define the brand identity. If you invent your own fonts or rename variables, you have failed the task.
` : '';

  // Plan sections — varies per run for structural variety within a style.
  const plan = planSections(
    { businessField: brief.businessField, services: brief.services, address: brief.address,
      promotion: brief.promotion, photos: brief.photos, faq: brief.faq, pageGoal: brief.pageGoal },
    `${brief.businessName}|${Date.now()}|${Math.random()}`,
  );
  const blueprintBlock = renderBlueprint(plan);
  console.log(`✦ [HTML] Blueprint: ${plan.map(p => `${p.archetype}:${p.variant}`).join(' → ')}`);

  const prompt = `Build a complete landing page HTML file for this business:

Business: ${brief.businessName} — ${brief.businessField}${brief.businessNiche ? ` (${brief.businessNiche})` : ''}
About: ${brief.about}
Services: ${brief.services}
Phone: ${brief.phone}${brief.address ? ` | Address: ${brief.address}` : ''}
${brief.promotion ? `Promotion: ${brief.promotion}` : ''}
${brief.preferredColors?.primary ? (() => { const p = formatBrandPalette(brief.preferredColors); return p ? `Colors: ${p}` : ""; })() : ''}
WhatsApp: ${waLink}
${brief.logo ? `Logo: ${brief.logo.startsWith('http') ? brief.logo : `http://localhost:3001${brief.logo}`}` : ''}

Design language: "${ds}"
${meta ? meta.styleBlock : ''}
${meta ? `Visual: ${meta.visualTraits}` : ''}
${dnaBlock}

${blueprintBlock}

TECHNICAL REQUIREMENTS:
- Single HTML file (CSS + JS inside)
- Hebrew RTL
- Responsive with mobile hamburger menu
- Use the VISUAL DNA fonts declared above — do not add new font families
- picsum.photos for images (https://picsum.photos/WIDTH/HEIGHT?random=N with N 1-99; hero 1920/1080, gallery 800/600, portrait 600/800, product 600/600)
- CSS variables in :root — use the VISUAL DNA variable names
- WhatsApp floating button
- data-inject attributes for live editing on every editable text node and data-inject-src on every <img>
- In the ABOUT section the image must have src="https://picsum.photos/600/800?random=42" and data-inject-src="about-img"
- Hero image should carry data-inject-src="hero-bg" or "hero-img"

${templateRef ? `STYLE REFERENCE (first 6KB — for CSS quality, animation patterns, and tone only. Do NOT copy its section structure — follow the SECTION BLUEPRINT above instead):

${templateRef.slice(0, 6000)}
` : ''}

Output ONLY the complete HTML file. No explanation, no markdown fences.`;

  let html = '';
  const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_AI_API_KEY });
  const GEMINI_MODEL = process.env.GEMINI_HTML_MODEL || 'gemini-2.5-pro';
  try {
    const r = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
      config: { temperature: 0.3, maxOutputTokens: 65536 },
    });
    html = r.text || '';
    console.log(`✦ [GeminiHTML] Success via ${GEMINI_MODEL}: ${(html.length / 1024).toFixed(0)}KB`);
  } catch (err) {
    console.error(`✦ [GeminiHTML] ${GEMINI_MODEL} failed: ${err.message}, trying flash`);
    const r = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: { temperature: 0.3, maxOutputTokens: 65536 },
    });
    html = r.text || '';
    console.log(`✦ [GeminiHTML] Success via flash: ${(html.length / 1024).toFixed(0)}KB`);
  }

  // Clean markdown fences
  html = html.replace(/^```html\n?/i, '').replace(/^```\n?/, '').replace(/\n?```$/m, '').trim();

  // Ensure starts with DOCTYPE
  if (!html.startsWith('<!')) {
    const doctype = html.indexOf('<!DOCTYPE');
    if (doctype > 0) html = html.slice(doctype);
  }

  // Ensure proper closing tags
  if (!html.includes('</body>')) html += '\n</body>';
  if (!html.includes('</html>')) html += '\n</html>';

  console.log(`✦ [HTML] Done: ${(html.length / 1024).toFixed(0)}KB`);
  return html;
};

module.exports = {
  generateFullHtml,
};
