/**
 * Gemini Pipeline — פייפליין מקביל לייצור HTML מלא עם Gemini
 * שלב 0: Gemini ולידטור PRE — בודק שהבריף מספיק עשיר לסגנון העיצובי
 * שלב 1: OpenAI מייצר תוכן עשיר (טקסטים, שירותים, המלצות)
 * שלב 2: Gemini מקבל את כל המידע + הבריף + הנחיות ולידטור → מייצר HTML מלא
 * שלב 3: Gemini ולידטור POST — בודק שה-HTML עומד בסטנדרט הסגנון, מזריק CSS fixes
 * שלב 4: מחליף תמונות placeholder בתמונות שנוצרות על ידי Gemini Image
 */
const sharp = require("sharp");
const backblazeService = require("../backblaze.service");
const { generateFullHtml } = require("./gemini-html.service");
const { generateImage, enhanceClientPhoto, generateImageWithFace } = require("./gemini-image.service");
const { generateHeroVideo } = require("./gemini-video.service");
const sessionService = require("./session.service");

/**
 * Extract picsum.photos placeholder URLs from HTML and return their context
 * Returns array of { placeholder: 'https://picsum.photos/...', context: '...surrounding html...' }
 */
function extractPlaceholders(html) {
  const results = [];
  const seen = new Set();

  // Match src="https://picsum.photos/..." and url(https://picsum.photos/...)
  const regex = /(?:src=["']|url\(["']?)(https:\/\/picsum\.photos\/[^"'\s)]+)/g;
  let match;

  while ((match = regex.exec(html)) !== null) {
    const placeholder = match[1];
    if (seen.has(placeholder)) continue;
    seen.add(placeholder);

    // Extract surrounding context (300 chars) to determine the role
    const start = Math.max(0, match.index - 200);
    const end = Math.min(html.length, match.index + 200);
    const context = html.slice(start, end);

    results.push({ placeholder, context });
  }

  return results;
}

/**
 * Determine image role/key from context HTML
 */
function inferImageKey(context, index) {
  const ctx = context.toLowerCase();

  if (ctx.includes('hero') || ctx.includes('banner') || ctx.includes('jumbotron')) {
    return index === 0 ? 'hero-bg' : 'hero-img';
  }
  if (ctx.includes('about') || ctx.includes('story') || ctx.includes('founder') || ctx.includes('team')) {
    return 'about-img';
  }
  if (ctx.includes('gallery') || ctx.includes('lookbook') || ctx.includes('g-tall') || ctx.includes('g-wide') || ctx.includes('g-small') || ctx.includes('g-med')) {
    return `g${index + 1}-img`;
  }
  if (ctx.includes('blog') || ctx.includes('article') || ctx.includes('post')) {
    return `bl${index + 1}-img`;
  }
  if (ctx.includes('testimonial') || ctx.includes('review') || ctx.includes('client')) {
    return `t${index + 1}-img`;
  }
  if (ctx.includes('service') || ctx.includes('treatment') || ctx.includes('product') || ctx.includes('service-visual') || ctx.includes('service-block')) {
    return `p${index + 1}-img`;
  }
  if (ctx.includes('split') || ctx.includes('cta') || ctx.includes('split-img')) {
    return 'p1-img';
  }

  return `img-${index + 1}`;
}

/**
 * Extract width/height from picsum URL and return aspect ratio hint
 * e.g. https://picsum.photos/1920/1080 → 'landscape 16:9'
 */
function picsumAspect(url) {
  const m = url.match(/picsum\.photos\/(\d+)\/(\d+)/);
  if (!m) return 'landscape 16:9';
  const w = parseInt(m[1]), h = parseInt(m[2]);
  const ratio = w / h;
  if (ratio >= 2.5) return 'ultra-wide panoramic';
  if (ratio >= 1.6) return 'landscape 16:9';
  if (ratio >= 1.2) return 'landscape 4:3';
  if (ratio >= 0.9) return 'square 1:1';
  if (ratio >= 0.65) return 'portrait 3:4';
  return 'portrait 2:3';
}

/**
 * Post-process Gemini HTML to fix common issues:
 * 1. Hide mobile-nav overlays that have no CSS (render as white blocks)
 * 2. Hide standalone hamburger divs that have no CSS
 * 3. Ensure </html> closes the document properly
 */
function postProcessGeminiHtml(html) {
  // 1. Safety CSS + Quality Foundation Layer
  // This CSS is injected AFTER Gemini's CSS, acting as a safety net
  // It fixes common Gemini quality failures without overriding intentional design choices
  const safetyCss = `
<style id="wow-safety">
/* ═══ Mobile nav safety ═══ */
[id*="mobile-nav"], [id*="mobile-menu"], [id*="nav-overlay"], [id*="hamburger"],
[class*="mobile-nav"], [class*="nav-overlay"], [class*="mobile-menu"],
.mobile-menu, .nav-overlay, #mobile-nav-overlay {
  display: none !important;
}
@media (max-width: 768px) {
  [id*="hamburger"], [class*="hamburger"] { display: flex !important; }
  [id*="mobile-nav"].active, [id*="mobile-menu"].active,
  [id*="nav-overlay"].active, .nav-overlay.active,
  #mobile-nav-overlay.active { display: flex !important; }
}
.cursor-dot, .cursor-outline, [class*="cursor-dot"], [class*="cursor-outline"] {
  position: fixed !important; pointer-events: none !important; z-index: 9999 !important;
}
</style>

<style id="wow-quality-foundation">
/* ═══ Quality Foundation — fixes common Gemini failures ═══ */

/* 0. Font safety — ensure Hebrew fonts are ALWAYS loaded and applied */
@import url('https://fonts.googleapis.com/css2?family=Heebo:wght@300;400;500;600;700;800;900&family=Rubik:wght@300;400;500;600;700&display=swap');
body { font-family: var(--body-font, 'Heebo', 'Rubik', sans-serif) !important; }
h1, h2, h3, h4, h5, h6 { font-family: var(--heading-font, 'Heebo', 'Rubik', sans-serif); }

/* 1. Typography safety — prevent browser defaults leaking */
body { -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; text-rendering: optimizeLegibility; }
h1, h2, h3, h4, h5, h6 { text-wrap: balance; }
p, li { text-wrap: pretty; }

/* 2. Image safety — prevent broken/stretched images */
img { max-width: 100%; height: auto; display: block; }
img[src*="picsum"], img[src=""], img:not([src]) {
  background: linear-gradient(135deg, rgba(0,0,0,0.03), rgba(0,0,0,0.06));
  min-height: 200px;
}

/* 3. Button safety — ensure all buttons feel clickable */
button, [class*="btn"], [class*="cta"] { cursor: pointer; }
button:not([style*="transform"]):hover, [class*="btn"]:not([style*="transform"]):hover {
  transform: translateY(-1px);
}
button:active, [class*="btn"]:active { transform: translateY(0) scale(0.98); }

/* 4. Link safety */
a { text-decoration: none; }

/* 5. Section minimum padding — prevent cramped sections */
section { min-padding: 0; }
section:not([style*="padding"]) { padding-block: clamp(40px, 8vh, 100px); }

/* 6. Form inputs — ensure they look styled */
input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([style*="border"]),
textarea:not([style*="border"]) {
  border: 1px solid rgba(0,0,0,0.12);
  border-radius: 8px;
  padding: 12px 16px;
  font-size: 15px;
  width: 100%;
  box-sizing: border-box;
  transition: border-color 0.2s, box-shadow 0.2s;
}
input:focus, textarea:focus {
  outline: none;
  border-color: var(--accent, var(--primary, #645DD7));
  box-shadow: 0 0 0 3px rgba(100, 93, 215, 0.1);
}

/* 7. Smooth scroll */
html { scroll-behavior: smooth; }
section[id] { scroll-margin-top: 80px; }

/* 8. Selection color */
::selection { background: rgba(100, 93, 215, 0.15); color: inherit; }

/* 9. Responsive images in containers */
[class*="gallery"] img, [class*="catalog"] img, [class*="portfolio"] img {
  object-fit: cover; width: 100%; height: 100%;
}

/* 10. Transition safety — everything interactive should transition */
a, button, input, [class*="card"], [class*="btn"] {
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

/* 11. Fix testimonials scroll for RTL */
[class*="testimonial"] [style*="translateX"], [class*="review"] [style*="translateX"],
[class*="testimonial"] [class*="track"], [class*="review"] [class*="track"],
[class*="carousel"] [class*="track"], [class*="slider"] [class*="track"] {
  direction: ltr !important;
}
@keyframes scrollRTL {
  0% { transform: translateX(-50%); }
  100% { transform: translateX(0%); }
}
[class*="testimonial"] [style*="animation"], [class*="review"] [style*="animation"] {
  animation-name: scrollRTL !important;
}

/* 12. Animation CSS — smooth transitions everywhere */
* { transition: opacity 0.3s ease, transform 0.3s ease; }
a, button, [class*="btn"], [class*="card"], img {
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}
button:hover, [class*="btn"]:hover { transform: translateY(-2px); }
button:active, [class*="btn"]:active { transform: translateY(0) scale(0.98); }
img:hover { transform: scale(1.02); }

/* 12. Smooth scroll */
html { scroll-behavior: smooth; }
section[id] { scroll-margin-top: 80px; }

/* 13. Contrast safety — prevent invisible text */
section, div, footer, header, nav {
  /* Ensure text is always readable by setting minimum contrast */
}
/* Light backgrounds must have dark text */
[style*="background: #fff"], [style*="background: white"],
[style*="background-color: #fff"], [style*="background-color: white"],
[style*="background:#fff"], [style*="background:white"] {
  color: #111 !important;
}
/* Dark backgrounds must have light text */
[style*="background: #000"], [style*="background: #111"],
[style*="background: #1a"], [style*="background: #0d"],
[style*="background-color: #000"], [style*="background-color: #111"],
[style*="background:#000"], [style*="background:#111"] {
  color: #f0f0f0 !important;
}

/* 14. Hero system rule — always full width × full viewport */
/* Restricted to section/header to avoid giving min-height:100vh to inner elements */
section:first-of-type,
section[class*="hero"], section[id*="hero"],
header[class*="hero"], header[id*="hero"],
.hero-section {
  width: 100% !important;
  max-width: 1920px !important;
  min-height: 100vh !important;
}

/* 15. About section — ensure image column is always visible */
[class*="about"] img[data-inject-src],
[id*="about"] img[data-inject-src],
[class*="story"] img[data-inject-src],
[class*="about"] .about-img,
[id*="about"] .about-img {
  display: block !important;
  width: 100% !important;
  height: 100% !important;
  min-height: 400px !important;
  object-fit: cover !important;
}
/* Ensure the about image column wrapper has visible height */
[class*="about"] > *:first-child,
[id*="about"] > *:first-child,
[class*="story"] > *:first-child {
  min-height: 400px !important;
}

/* 16. Hero video background — only when a <video> is actually present */
section[class*="hero"]:has(video) > *:not(video),
section[id*="hero"]:has(video) > *:not(video),
section:first-of-type:has(video) > *:not(video),
header[class*="hero"]:has(video) > *:not(video) {
  position: relative !important;
  z-index: 1 !important;
}
section[class*="hero"]:has(video),
section[id*="hero"]:has(video),
section:first-of-type:has(video),
header[class*="hero"]:has(video) {
  position: relative !important;
  overflow: hidden !important;
}
</style>`;

  // Ensure viewport meta tag exists
  if (!html.includes('name="viewport"') && !html.includes("name='viewport'")) {
    html = html.replace('<head>', '<head>\n<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0">');
  }

  // Mobile-responsive safety CSS
  const mobileCss = `
<style id="wow-mobile-safety">
/* ═══ Mobile Responsive Safety ═══ */
@media (max-width: 768px) {
  /* Force single column on mobile */
  [style*="display: grid"], [style*="display:grid"] {
    grid-template-columns: 1fr !important;
  }
  [style*="display: flex"][style*="row"],
  .flex-row, [class*="grid"], [class*="columns"] {
    flex-direction: column !important;
  }

  /* Prevent horizontal overflow */
  body { overflow-x: hidden !important; }
  * { max-width: 100vw; box-sizing: border-box; }
  img, video, iframe, table { max-width: 100% !important; }

  /* Scale down oversized text */
  h1 { font-size: clamp(1.8rem, 6vw, 3rem) !important; }
  h2 { font-size: clamp(1.4rem, 5vw, 2.2rem) !important; }
  h3 { font-size: clamp(1.2rem, 4vw, 1.8rem) !important; }
  p, li, td { font-size: clamp(0.9rem, 3.5vw, 1.1rem) !important; line-height: 1.6 !important; }

  /* Section padding on mobile */
  section, [class*="section"] { padding: 40px 16px !important; }
  header, nav { padding: 12px 16px !important; }

  /* Hero section mobile fix */
  section:first-of-type, [class*="hero"], [id*="hero"], header[class*="hero"] {
    min-height: 60vh !important;
    padding: 60px 20px !important;
  }

  /* Fix grids that won't wrap */
  [style*="grid-template-columns: repeat"] {
    grid-template-columns: 1fr !important;
    gap: 16px !important;
  }

  /* Cards full width on mobile */
  [class*="card"], [class*="item"], [class*="service"] {
    width: 100% !important;
    min-width: 0 !important;
  }

  /* Gallery / catalog columns */
  [class*="gallery"], [class*="catalog"], [class*="portfolio"] {
    grid-template-columns: repeat(2, 1fr) !important;
    gap: 8px !important;
  }

  /* Testimonial cards */
  [class*="testimonial"], [class*="review"] {
    width: 85vw !important;
    flex-shrink: 0;
  }

  /* Stats / numbers row */
  [class*="stats"], [class*="counter"], [class*="numbers"] {
    grid-template-columns: repeat(2, 1fr) !important;
  }

  /* Footer columns → stack */
  footer [style*="grid"], footer [style*="flex"] {
    grid-template-columns: 1fr !important;
    flex-direction: column !important;
  }

  /* Hide desktop-only elements */
  [class*="desktop-only"], [class*="hide-mobile"], br.desktop { display: none !important; }

  /* CTA buttons full width on mobile */
  [class*="cta"] a, [class*="cta"] button, [class*="btn-primary"], button[class*="cta"] {
    width: 100% !important;
    text-align: center !important;
    padding: 14px 20px !important;
  }

  /* Fix absolute positioned elements that break on mobile */
  [style*="position: absolute"][style*="left:"][style*="top:"] {
    position: relative !important;
    left: auto !important;
    top: auto !important;
  }
}

/* Small phones */
@media (max-width: 380px) {
  h1 { font-size: 1.6rem !important; }
  h2 { font-size: 1.3rem !important; }
  section, [class*="section"] { padding: 30px 12px !important; }
}
</style>`;

  // Inject before </head>
  if (html.includes('</head>')) {
    html = html.replace('</head>', `${safetyCss}\n${mobileCss}\n</head>`);
  }

  // Inject GSAP animations before </body>
  const animationScript = `
<script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/ScrollTrigger.min.js"></script>
<script>
(function(){
  if(typeof gsap==='undefined')return;
  gsap.registerPlugin(ScrollTrigger);

  // Scroll reveal — all sections and major elements
  document.querySelectorAll('section, [class*="card"], [class*="service"], [class*="testimonial"], h2, h3, .gallery img, footer').forEach(function(el,i){
    gsap.fromTo(el,
      {opacity:0, y:40},
      {opacity:1, y:0, duration:0.8, ease:'power2.out',
        scrollTrigger:{trigger:el, start:'top 88%', toggleActions:'play none none none'},
        delay: (i%4)*0.1
      }
    );
  });

  // Image scale on scroll
  document.querySelectorAll('img[class*="hero"], section[style*="background-image"], [class*="gallery"] img').forEach(function(el){
    gsap.fromTo(el, {scale:1.08}, {scale:1, ease:'none', scrollTrigger:{trigger:el, scrub:true}});
  });

  // Parallax on hero
  var hero = document.querySelector('section:first-of-type, [class*="hero"]');
  if(hero){
    gsap.to(hero, {backgroundPositionY:'30%', ease:'none', scrollTrigger:{trigger:hero, scrub:true}});
  }

  // Counter animation
  document.querySelectorAll('[class*="counter"], [class*="stat"] [class*="number"], [class*="count"]').forEach(function(el){
    var target = parseInt(el.textContent.replace(/[^0-9]/g,'')) || 0;
    if(target<1)return;
    var suffix = el.textContent.replace(/[0-9]/g,'').trim();
    gsap.from(el,{
      textContent:0, duration:2, ease:'power1.out', snap:{textContent:1},
      scrollTrigger:{trigger:el, start:'top 85%'},
      onUpdate:function(){el.textContent=Math.round(parseFloat(el.textContent))+suffix}
    });
  });

  // Hover lift on cards
  document.querySelectorAll('[class*="card"], [class*="service"], [class*="iconbox"]').forEach(function(el){
    el.style.transition='transform 0.3s cubic-bezier(0.4,0,0.2,1), box-shadow 0.3s ease';
    el.addEventListener('mouseenter',function(){el.style.transform='translateY(-6px)';el.style.boxShadow='0 12px 40px rgba(0,0,0,0.12)';});
    el.addEventListener('mouseleave',function(){el.style.transform='';el.style.boxShadow='';});
  });
})();
</script>

<script>
// Infinite testimonials scroll — universal fix
(function(){
  var track = document.querySelector('[class*="testimonial"] [class*="track"], [class*="review"] [class*="track"], [class*="testimonial"] [class*="scroll"], [class*="carousel"][class*="testimonial"], [class*="reviews"] [class*="track"]');
  if (!track) {
    // Try finding any horizontally scrolling container inside testimonials section
    document.querySelectorAll('[class*="testimonial"], [class*="review"], [id*="testimonial"]').forEach(function(sec) {
      var inner = sec.querySelector('[style*="animation"], [style*="translateX"], [class*="track"], [class*="wrapper"]');
      if (inner && !track) track = inner;
    });
  }
  if (track) {
    // Clone children for seamless loop
    var children = track.children;
    var origCount = children.length;
    if (origCount > 0 && origCount < 20) {
      for (var i = 0; i < origCount; i++) {
        track.appendChild(children[i].cloneNode(true));
      }
    }
    // Apply infinite scroll animation
    track.style.display = 'flex';
    track.style.gap = track.style.gap || '24px';
    track.style.animation = 'infiniteScroll 30s linear infinite';
    track.style.width = 'max-content';

    var style = document.createElement('style');
    style.textContent = '@keyframes infiniteScroll { 0%{transform:translateX(0)} 100%{transform:translateX(-50%)} }';
    document.head.appendChild(style);
  }
})();

// Mobile hamburger menu — universal fix
(function(){
  // Find hamburger button and menu
  var btn = document.querySelector('[class*="hamburger"], [class*="menu-btn"], [class*="mobile-toggle"], [class*="burger"], button[aria-label*="menu"], button[aria-label*="Menu"], .menu-toggle, #menu-toggle, .nav-toggle');
  var menu = document.querySelector('[class*="mobile-menu"], [class*="nav-menu"], [class*="mobile-nav"], .mobile-menu, #mobile-menu, nav ul, header nav > ul');

  if (!btn || !menu) {
    // Try harder — find any button in header with 3 spans (hamburger pattern)
    document.querySelectorAll('header button, nav button, [class*="header"] button').forEach(function(b) {
      if (!btn && (b.querySelectorAll('span').length >= 2 || b.innerHTML.includes('☰') || b.innerHTML.includes('&#9776;') || b.textContent.trim() === '')) {
        btn = b;
      }
    });
    if (!menu) {
      menu = document.querySelector('header ul, nav ul, [class*="nav-links"]');
    }
  }

  if (btn && menu) {
    // Set initial hidden state on mobile
    var style = document.createElement('style');
    style.textContent = '@media(max-width:768px){' +
      '[data-wow-menu]{display:none!important;position:fixed;top:0;right:0;width:75vw;height:100vh;z-index:9998;padding:80px 30px 30px;flex-direction:column;gap:20px;transition:transform 0.3s ease,opacity 0.3s ease;transform:translateX(100%);opacity:0;}' +
      '[data-wow-menu].open{display:flex!important;transform:translateX(0);opacity:1;}' +
      '[data-wow-menu-overlay]{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9997;}' +
      '[data-wow-menu-overlay].open{display:block;}' +
    '}';
    document.head.appendChild(style);

    menu.setAttribute('data-wow-menu', '');
    // Set background from nearest parent or default
    var headerBg = getComputedStyle(menu.closest('header') || menu.closest('nav') || document.body).backgroundColor;
    if (!headerBg || headerBg === 'rgba(0, 0, 0, 0)') headerBg = '#ffffff';
    menu.style.backgroundColor = headerBg;

    // Create overlay
    var overlay = document.createElement('div');
    overlay.setAttribute('data-wow-menu-overlay', '');
    document.body.appendChild(overlay);

    var isOpen = false;
    function toggle() {
      isOpen = !isOpen;
      menu.classList.toggle('open', isOpen);
      overlay.classList.toggle('open', isOpen);
      document.body.style.overflow = isOpen ? 'hidden' : '';
    }

    btn.addEventListener('click', function(e) { e.preventDefault(); e.stopPropagation(); toggle(); });
    overlay.addEventListener('click', toggle);
    menu.querySelectorAll('a').forEach(function(a) { a.addEventListener('click', function() { if(isOpen) toggle(); }); });
  }
})();
</script>`;

  if (html.includes('</body>')) {
    html = html.replace('</body>', `${animationScript}\n</body>`);
  }

  return html;
}

// Helper — fetch a URL (http/https) or Backblaze-path to a Buffer
const fetchAssetBuffer = async (ref) => {
  if (!ref) return null;
  try {
    if (/^https?:\/\//i.test(ref)) {
      const resp = await fetch(ref);
      if (!resp.ok) return null;
      return Buffer.from(await resp.arrayBuffer());
    }
    const cleanPath = ref.replace(/^\/+/, '');
    const { buffer } = await backblazeService.downloadImageByPath(cleanPath);
    return buffer;
  } catch {
    return null;
  }
};

const runGeminiPipeline = async (sessionId, brief, onProgress) => {
  const log = (msg) => {
    console.log(`✦ [GeminiPipeline] ${msg}`);
    onProgress?.(msg);
  };

  try {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`✦ [GeminiPipeline] START session=${sessionId}`);
    console.log(`✦ [GeminiPipeline] עסק: ${brief.businessName} | תחום: ${brief.businessField}`);
    console.log(`✦ [GeminiPipeline] סגנון: ${brief.designStyle || 'modern'} | תמונות: ${(brief.photos || []).length} | פנים: ${brief.facePhoto ? 'כן' : 'לא'}`);
    console.log(`${'═'.repeat(60)}\n`);

    // ═══ Resume support: check if HTML was already generated ═══
    const existingSession = await sessionService.getSession(sessionId);
    let html;
    if (existingSession.edits && existingSession.edits.geminiHtml && existingSession.edits.geminiHtml.length > 500) {
      html = existingSession.edits.geminiHtml;
      log(`📄 HTML already exists ✓ (${(html.length / 1024).toFixed(0)}KB) — resuming from images`);
    } else {
      // ═══ Step 1: Generate full HTML ═══
      log('📄 שלב 1: מייצר HTML מלא...');
      const htmlStartTime = Date.now();
      html = await generateFullHtml(brief);
      const htmlElapsed = ((Date.now() - htmlStartTime) / 1000).toFixed(1);

      if (!html || html.length < 500) {
        throw new Error('Gemini returned empty or too-short HTML');
      }
      log(`📄 HTML נוצר ✓ (${(html.length / 1024).toFixed(0)}KB, ${htmlElapsed}s)`);
    }

    // Post-process: safety CSS (always re-run — cheap and idempotent)
    log('🎨 מזריק safety CSS + GSAP animations...');
    html = postProcessGeminiHtml(html);
    log(`🎨 Post-process ✓ (HTML: ${(html.length / 1024).toFixed(0)}KB)`);

    // Save HTML
    const s2 = await sessionService.getSession(sessionId);
    s2.edits.geminiHtml = html;
    await sessionService.updateSession(sessionId, { edits: s2.edits, status: 'generating-images' });
    log(`💾 HTML נשמר ✓`);

    // ═══ Step 2: Setup ═══
    const placeholders = extractPlaceholders(html);
    log(`🖼️  שלב 2: נמצאו ${placeholders.length} placeholders להחלפה`);
    placeholders.forEach((p, i) => {
      const key = inferImageKey(p.context, i);
      console.log(`   placeholder ${i + 1}: key="${key}" url="${p.placeholder.substring(0, 60)}..."`);
    });

    const briefContext = { services: brief.services, about: brief.about, imageStyle: '' };

    // Client photos: in ported codebase brief.photos are public URLs (Backblaze) or legacy paths.
    const rawClientPhotos = (brief.photos || []).filter(Boolean);
    log(`📷 תמונות לקוח גולמיות: ${rawClientPhotos.length}`);

    // ═══ Step 3: Enhance client photos via Gemini ═══
    let clientPhotos = rawClientPhotos;
    if (rawClientPhotos.length > 0) {
      log(`✨ שלב 3: משפר ${rawClientPhotos.length} תמונות לקוח עם Gemini...`);
      const enhanced = await Promise.all(
        rawClientPhotos.map(async (photoRef, pi) => {
          try {
            log(`   משפר תמונה ${pi + 1}/${rawClientPhotos.length}: ${photoRef}`);
            const enhancedUrl = await enhanceClientPhoto(
              photoRef,
              { businessName: brief.businessName, businessField: brief.businessField, services: brief.services || '' },
              sessionId,
            );
            if (enhancedUrl) {
              log(`   תמונה ${pi + 1} משופרת ✓ → ${enhancedUrl}`);
              return enhancedUrl;
            }
            log(`   תמונה ${pi + 1}: Gemini לא החזיר תמונה — משתמש במקור`);
          } catch (enhErr) {
            const msg = enhErr instanceof Error ? enhErr.message : String(enhErr);
            log(`   תמונה ${pi + 1} שיפור נכשל (fallback): ${msg}`);
          }
          return photoRef;
        })
      );
      clientPhotos = enhanced;
      log(`✨ שיפור תמונות הושלם: ${clientPhotos.filter((u, i) => u !== rawClientPhotos[i]).length}/${rawClientPhotos.length} שופרו`);
    } else {
      log('📷 אין תמונות לקוח — דילוג על שלב שיפור');
    }

    // Categorize placeholders
    const productPlaceholders = [];
    const heroBgPlaceholders = [];

    for (const ph of placeholders) {
      const key = inferImageKey(ph.context, 0);
      if (key.startsWith('p') || key.startsWith('g') || ph.context.toLowerCase().includes('catalog')) {
        productPlaceholders.push(ph);
      } else {
        heroBgPlaceholders.push(ph);
      }
    }
    log(`📋 קטגוריות: ${productPlaceholders.length} product/gallery | ${heroBgPlaceholders.length} hero/about/bg`);

    // ═══ Phase A: Replace product/catalog images with client photos ═══
    if (clientPhotos.length > 0) {
      log(`🔄 Phase A: מחליף תמונות לקוח ב-${Math.min(productPlaceholders.length, clientPhotos.length)} slots...`);
      productPlaceholders.forEach(({ placeholder }, i) => {
        if (clientPhotos[i]) {
          html = html.split(placeholder).join(clientPhotos[i]);
          log(`   ✓ product slot ${i + 1} → תמונת לקוח ${i + 1}`);
        }
      });
      const remainingPhotos = clientPhotos.slice(productPlaceholders.length);
      remainingPhotos.forEach((photo, i) => {
        const slot = heroBgPlaceholders[i];
        if (slot) {
          // Reserve about-img for face generation (Phase B) when a facePhoto is available
          const slotKey = inferImageKey(slot.context, i);
          if (slotKey === 'about-img' && brief.facePhoto) {
            log(`   ⏭️  hero/about slot ${i + 1} (about-img) — שמור ליצירת תמונת פנים`);
            return;
          }
          html = html.split(slot.placeholder).join(photo);
          log(`   ✓ hero/about slot ${i + 1} (${slotKey}) → תמונת לקוח (overflow)`);
        }
      });
    } else {
      log('🔄 Phase A: אין תמונות לקוח — כל ה-slots יוצרו AI');
    }

    // ═══ Phase B: Generate AI images for remaining placeholders ═══
    const stillHasPicsum = extractPlaceholders(html);
    const toGenerate = stillHasPicsum;

    if (toGenerate.length > 0) {
      log(`🤖 Phase B: מייצר ${toGenerate.length} תמונות AI...`);
      const faceRef = brief.facePhoto || null;
      if (faceRef) log(`   פנים בעל עסק: ${faceRef}`);

      const imageResults = [];
      for (let i = 0; i < toGenerate.length; i += 4) {
        const batch = toGenerate.slice(i, i + 4);
        log(`   batch ${Math.floor(i / 4) + 1}: מייצר ${batch.length} תמונות במקביל...`);
        const batchResults = await Promise.allSettled(
          batch.map(async ({ placeholder, context }, j) => {
            const imageKey = inferImageKey(context, i + j);
            const aspect = picsumAspect(placeholder);
            const useFace = faceRef && (imageKey.startsWith('p') || imageKey === 'about-img');
            log(`     [${imageKey}] aspect=${aspect} | face=${useFace ? 'כן' : 'לא'}`);
            const imageUrl = useFace
              ? await generateImageWithFace(
                  faceRef,
                  { businessName: brief.businessName, businessField: brief.businessField, imageKey },
                  sessionId,
                ).catch((faceErr) => {
                  const msg = faceErr instanceof Error ? faceErr.message : String(faceErr);
                  log(`     [${imageKey}] פנים נכשל (${msg}) — fallback ל-generateImage`);
                  return generateImage(
                    brief.businessField, brief.businessName, imageKey, sessionId,
                    { ...briefContext, aspectHint: aspect, designStyle: brief.designStyle },
                  );
                })
              : await generateImage(
                  brief.businessField,
                  brief.businessName,
                  imageKey,
                  sessionId,
                  { ...briefContext, aspectHint: aspect, designStyle: brief.designStyle },
                );
            log(`     [${imageKey}] ✓ → ${imageUrl.substring(0, 60)}`);
            return { placeholder, imageUrl };
          })
        );
        imageResults.push(...batchResults);
        if (i + 4 < toGenerate.length) {
          await new Promise(r => setTimeout(r, 500));
        }
      }

      let aiSuccess = 0, aiFail = 0;
      for (const result of imageResults) {
        if (result.status === 'fulfilled') {
          html = html.split(result.value.placeholder).join(result.value.imageUrl);
          aiSuccess++;
        } else {
          aiFail++;
          log(`   ⚠️  תמונת AI נכשלה: ${result.reason?.message}`);
        }
      }
      log(`🤖 Phase B הושלם: ${aiSuccess} הצליחו, ${aiFail} נכשלו`);
    } else {
      log('✅ Phase B: כל ה-slots מולאו על ידי תמונות לקוח — אין צורך ב-AI images');
    }

    // Save final HTML with real images
    log('💾 שומר HTML סופי עם תמונות אמיתיות...');
    const s3 = await sessionService.getSession(sessionId);
    s3.edits.geminiHtml = html;
    await sessionService.updateSession(sessionId, {
      edits: s3.edits,
      status: 'ready',
    });
    log(`💾 HTML סופי נשמר ✓ (${(html.length / 1024).toFixed(0)}KB)`);

    // ═══ Auto Hero Video — compose from client photos via Veo image-to-video ═══
    if (rawClientPhotos.length > 0) {
      log(`🎬 שלב 4: יוצר סרטון Hero אוטומטי מ-${Math.min(rawClientPhotos.length, 4)} תמונות לקוח...`);
      try {
        const photoRefs = rawClientPhotos.slice(0, 4);
        let refBuffer;

        if (photoRefs.length === 1) {
          log(`   תמונה אחת — משתמש ישירות כ-reference`);
          refBuffer = await fetchAssetBuffer(photoRefs[0]);
          if (!refBuffer) throw new Error('Could not fetch single reference image');
        } else {
          log(`   ${photoRefs.length} תמונות — מרכיב collage 1920×${Math.ceil(photoRefs.length / 2) * 540}...`);
          // Stitch up to 4 photos into a 2-column grid (1920×1080 total)
          const resized = await Promise.all(
            photoRefs.map(async (ref) => {
              const buf = await fetchAssetBuffer(ref);
              if (!buf) throw new Error(`Could not fetch ${ref}`);
              return sharp(buf)
                .resize(960, 540, { fit: 'cover' })
                .jpeg({ quality: 85 })
                .toBuffer();
            })
          );
          const cols = 2;
          const rows = Math.ceil(resized.length / cols);
          const composites = resized.map((buf, i) => ({
            input: buf,
            left: (i % cols) * 960,
            top: Math.floor(i / cols) * 540,
          }));
          refBuffer = await sharp({
            create: { width: 1920, height: rows * 540, channels: 3, background: { r: 0, g: 0, b: 0 } },
          })
            .composite(composites)
            .jpeg({ quality: 85 })
            .toBuffer();
        }

        log(`   🎬 מפעיל Veo image-to-video (reference buffer: ${(refBuffer.length / 1024).toFixed(0)}KB)...`);
        const videoStartTime = Date.now();
        const videoUrl = await generateHeroVideo(
          brief.businessField,
          brief.businessName,
          sessionId,
          {
            services: brief.services,
            about: brief.about,
            preferredColors: brief.preferredColors,
            designStyle: brief.designStyle,
            targetAudience: brief.targetAudience,
            pageGoal: brief.pageGoal,
            businessNiche: brief.businessNiche,
          },
          refBuffer,
        );
        const videoElapsed = ((Date.now() - videoStartTime) / 1000).toFixed(1);
        log(`   🎬 Veo הושלם ✓ (${videoElapsed}s) → ${videoUrl}`);

        // Inject <video> into hero section
        const heroVideoTag = `<video autoplay muted loop playsinline style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:0;pointer-events:none" src="${videoUrl}"></video>`;
        const heroNamedRegex = /(<(?:section|header)[^>]*(?:class|id)=["'][^"']*(?:hero|banner|jumbotron)[^"']*["'][^>]*>)/i;
        const firstSectionRegex = /(<(?:section|header)\b[^>]*>)/i;
        const useNamedHero = heroNamedRegex.test(html);
        const targetRegex = useNamedHero ? heroNamedRegex : firstSectionRegex;
        const injectionLabel = useNamedHero ? 'named hero/banner section' : 'first section (fallback)';

        if (targetRegex.test(html)) {
          html = html.replace(targetRegex, (match) => {
            // Handle existing style attribute safely
            if (/style=["']/.test(match)) {
              match = match.replace(/style=["']/, (s) => `${s}position:relative;overflow:hidden;`);
            } else if (!match.includes('position:relative')) {
              match = match.replace('>', ' style="position:relative;overflow:hidden">');
            }
            return match + heroVideoTag;
          });
          log(`   🎬 <video> הוזרק ל-${injectionLabel} ✓`);
        } else {
          log('   ⚠️  לא נמצא section/header כלל — סרטון נשמר ב-session אך לא הוזרק');
        }

        const s4 = await sessionService.getSession(sessionId);
        s4.edits.geminiHtml = html;
        s4.edits.videoUrl = videoUrl;
        s4.edits.videoStatus = 'ready';
        await sessionService.updateSession(sessionId, { edits: s4.edits });
        log(`🎬 סרטון Hero אוטומטי ✓ → ${videoUrl}`);
      } catch (videoErr) {
        const msg = videoErr instanceof Error ? videoErr.message : String(videoErr);
        log(`⚠️  סרטון Hero נכשל (non-fatal — ממשיך ללא סרטון): ${msg}`);
      }
    } else {
      log('🎬 אין תמונות לקוח — דילוג על יצירת סרטון Hero');
    }

    console.log(`\n${'═'.repeat(60)}`);
    log('✅ פייפליין Gemini הושלם בהצלחה!');
    console.log(`${'═'.repeat(60)}\n`);

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n${'═'.repeat(60)}`);
    console.error(`✦ [GeminiPipeline] ❌ FAILED: ${msg}`);
    console.error(`${'═'.repeat(60)}\n`);
    try {
      await sessionService.updateSession(sessionId, { status: 'error' });
    } catch { /* */ }
    throw err;
  }
};

module.exports = {
  runGeminiPipeline,
};
