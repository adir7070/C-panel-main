/**
 * LIVE_UPDATE_SCRIPT v2 — מוזרק לתוך ה-iframe של העורך
 * מספק: עריכת טקסט ישירה, כפתורי עריכת תמונה על כל תמונה,
 * ניווט עובד, עדכונים מה-parent
 */
const LIVE_UPDATE_SCRIPT = `
<style>
/* ═══ Text editing ═══ */
[data-inject] {
  position: relative;
  cursor: text;
  transition: outline 0.15s;
  outline: 2px solid transparent;
  outline-offset: 3px;
  border-radius: 3px;
}
[data-inject]:hover { outline: 2px dashed rgba(0,0,0,0.3); }
[data-inject].wow-editing {
  outline: 2px solid rgba(0,0,0,0.7) !important;
  box-shadow: 0 0 0 4px rgba(0,0,0,0.06);
  min-height: 1em;
}

/* ═══ Image edit wrapper ═══ */
.wow-img-wrap {
  position: relative !important;
  display: block;
}
.wow-img-btns {
  position: absolute; inset: 0; z-index: 50;
  display: flex; align-items: center; justify-content: center; gap: 8px;
  background: rgba(0,0,0,0.45);
  opacity: 0; transition: opacity 0.2s;
  pointer-events: none;
  border-radius: inherit;
}
.wow-img-wrap:hover .wow-img-btns,
.wow-img-btns.wow-active {
  opacity: 1; pointer-events: auto;
}
.wow-img-btns button {
  display: flex; align-items: center; gap: 6px;
  padding: 10px 16px; border-radius: 10px;
  border: 1px solid rgba(255,255,255,0.2);
  background: rgba(10,10,15,0.85); backdrop-filter: blur(8px);
  color: #e8e8e8; font-size: 13px; font-family: system-ui, -apple-system, sans-serif;
  cursor: pointer; transition: all 0.15s;
  white-space: nowrap;
}
.wow-img-btns button:hover {
  background: rgba(0,0,0,0.5);
  border-color: rgba(0,0,0,0.7);
  color: #fff;
}
.wow-img-btns button:active { transform: scale(0.95); }
.wow-img-btns svg { width: 16px; height: 16px; flex-shrink: 0; }
@media (max-width: 768px) {
  .wow-img-btns { flex-direction: column; gap: 6px; }
  .wow-img-btns button { padding: 12px 16px; font-size: 14px; }
}

/* ═══ Overlays must not block our edit buttons ═══ */
.wow-img-btns ~ [class*="overlay"] { pointer-events: none !important; }

/* ═══ Images always cover their container ═══ */
img[data-inject-src] {
  object-fit: cover !important;
  display: block !important;
}

/* ═══ Navigation anchor scrolling — ensure nav links work ═══ */
nav a[href^="#"], .navbar a[href^="#"], [class*="nav"] a[href^="#"],
.mobile-menu a[href^="#"], header a[href^="#"] {
  pointer-events: auto !important; cursor: pointer !important;
}

/* ═══ Navigation works for anchor scrolling ═══ */
nav a[href^="#"], .navbar a[href^="#"], [class*="nav"] a[href^="#"],
.mobile-menu a[href^="#"], header a[href^="#"] {
  pointer-events: auto !important; cursor: pointer !important;
}

/* ═══ Loading indicator on image ═══ */
.wow-img-loading {
  position: absolute; inset: 0; z-index: 60;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,0.5);
}
.wow-img-loading::after {
  content: ''; width: 32px; height: 32px;
  border: 3px solid rgba(255,255,255,0.2);
  border-top-color: #333333;
  border-radius: 50%;
  animation: wowSpin 0.8s linear infinite;
}
@keyframes wowSpin { to { transform: rotate(360deg); } }
</style>

<script>
(function() {
  'use strict';

  // ═══════════════════════════════════════════════
  // AUTO-DETECT MODE — Gemini HTML has no data-inject
  // When no data-inject elements exist, we auto-assign them
  // ═══════════════════════════════════════════════
  var geminiMode = document.querySelectorAll('[data-inject]').length === 0;

  if (geminiMode) {
    // ── Step 1: Assign SEMANTIC names to key structural elements ──
    // This ensures the editor chat field names (hero-title, about-text, etc.) work
    function qs(sel) { try { return document.querySelector(sel); } catch(e) { return null; } }
    function assign(sel, key) { var el = qs(sel); if (el && !el.hasAttribute('data-inject')) el.setAttribute('data-inject', key); return el; }

    var heroSec = qs('#hero, section[class*="hero"], .hero-section, section:first-of-type');
    if (heroSec) {
      var h1 = heroSec.querySelector('h1');
      if (h1) h1.setAttribute('data-inject', 'hero-title');
      var heroParagraphs = heroSec.querySelectorAll('p');
      if (heroParagraphs[0]) heroParagraphs[0].setAttribute('data-inject', 'hero-subtitle');
      var heroBtns = heroSec.querySelectorAll('a.btn, .btn, button, [class*="cta"]');
      if (heroBtns[0] && !heroBtns[0].href?.includes('wa.me')) heroBtns[0].setAttribute('data-inject', 'hero-cta-1');
      if (heroBtns[1]) heroBtns[1].setAttribute('data-inject', 'hero-cta-2');
      // Hero background image
      var heroBg = heroSec.querySelector('img');
      if (heroBg && !heroBg.hasAttribute('data-inject-src')) heroBg.setAttribute('data-inject-src', 'hero-image');
      else {
        var bgEl = heroSec.matches('[style*="background-image"]') ? heroSec : heroSec.querySelector('[style*="background-image"]');
        if (bgEl && !bgEl.hasAttribute('data-inject-src')) bgEl.setAttribute('data-inject-src', 'hero-image');
      }
    }
    var aboutSec = qs('#about, section[class*="about"], .about-section');
    if (aboutSec) {
      var aH = aboutSec.querySelector('h2, h3');
      if (aH) aH.setAttribute('data-inject', 'about-title');
      var aPs = aboutSec.querySelectorAll('p');
      for (var ai = 0; ai < aPs.length; ai++) {
        if (aPs[ai].textContent.trim().length > 30) { aPs[ai].setAttribute('data-inject', 'about-text'); break; }
      }
      var aboutImg = aboutSec.querySelector('img');
      if (aboutImg && !aboutImg.hasAttribute('data-inject-src')) aboutImg.setAttribute('data-inject-src', 'about-image');
    }
    var svcSec = qs('#services, section[class*="service"], .services-section');
    if (svcSec) {
      var sH = svcSec.querySelector('h2, h3');
      if (sH) sH.setAttribute('data-inject', 'services-title');
      var sCards = svcSec.querySelectorAll('[class*="service-card"], [class*="service-block"], [class*="svc-"], [class*="service-item"]');
      if (!sCards.length) sCards = svcSec.querySelectorAll('li, .card, [class*="card"]');
      sCards.forEach(function(card, i) {
        if (i >= 6) return;
        var n = i + 1;
        var t = card.querySelector('h3, h4, [class*="title"]');
        var p = card.querySelector('p, [class*="text"]');
        if (t && !t.hasAttribute('data-inject')) t.setAttribute('data-inject', 'svc-'+n+'-title');
        if (p && !p.hasAttribute('data-inject')) p.setAttribute('data-inject', 'svc-'+n+'-text');
      });
    }
    var ctaSec = qs('#cta, #contact, section[class*="cta"], .cta-section');
    if (ctaSec) {
      var cH = ctaSec.querySelector('h2, h3');
      if (cH) cH.setAttribute('data-inject', 'cta-title');
      var cP = ctaSec.querySelector('p');
      if (cP) cP.setAttribute('data-inject', 'cta-text');
      var cBtn = ctaSec.querySelector('a.btn, .btn, button');
      if (cBtn) cBtn.setAttribute('data-inject', 'cta-btn');
    }
    var footerEl2 = qs('footer');
    if (footerEl2) {
      var fBrand = footerEl2.querySelector('[class*="brand"], [class*="logo"], h3, h4');
      if (fBrand) fBrand.setAttribute('data-inject', 'footer-brand');
      var fPs = footerEl2.querySelectorAll('p');
      for (var fi = 0; fi < fPs.length; fi++) {
        if (fPs[fi].textContent.trim().length > 10) { fPs[fi].setAttribute('data-inject', 'footer-about'); break; }
      }
    }

    // ── Step 2: Generic naming for remaining non-tagged elements ──
    var counter = {};
    var editableSelectors = [
      'h1', 'h2', 'h3', 'h4',
      'p', 'span', 'li',
      'button', 'a.btn', '[class*="btn"]',
      '[class*="title"]', '[class*="subtitle"]', '[class*="heading"]',
      '[class*="cta"]', '[class*="description"]', '[class*="text"]',
    ];

    document.querySelectorAll(editableSelectors.join(',')).forEach(function(el) {
      var text = el.textContent.trim();
      // skip empty, icons-only, or WhatsApp-linked elements
      if (text.length < 2) return;
      if (el.closest('a[href*="wa.me"]')) return;
      if (el.closest('[data-inject]')) return; // already tagged by parent
      if (el.querySelector('[data-inject]')) return; // parent of tagged child
      if (el.hasAttribute('data-inject')) return; // already assigned semantic name
      // skip nav and footer service link items (too noisy)
      if (el.closest('nav') && el.tagName === 'A') return;
      if (el.closest('footer') && el.tagName === 'A') return;

      var tag = el.tagName.toLowerCase();
      counter[tag] = (counter[tag] || 0) + 1;
      el.setAttribute('data-inject', 'g-' + tag + '-' + counter[tag]);
    });

    // Auto-tag all images (skip logos: small height, alt includes "לוגו")
    var imgCounter = 0;
    document.querySelectorAll('img').forEach(function(img) {
      var h = parseInt(img.style.height || img.getAttribute('height') || '0');
      var alt = img.getAttribute('alt') || '';
      if (h > 0 && h <= 60) return; // likely a logo
      if (alt.includes('לוגו') || alt.includes('logo')) return;
      imgCounter++;
      img.setAttribute('data-inject-src', 'g-img-' + imgCounter);
    });

    // Also tag background-image divs that look like hero/section images
    var bgCounter = 0;
    document.querySelectorAll('[style*="background-image"]').forEach(function(el) {
      if (el.querySelector('img, [data-inject-src]')) return; // has child img
      bgCounter++;
      el.setAttribute('data-inject-src', 'g-bg-' + bgCounter);
    });
  }

  // ═══════════════════════════════════════════════
  // TEXT EDITING — event delegation for reliability
  // Uses document-level listeners so even dynamically
  // assigned [data-inject] elements are editable
  // ═══════════════════════════════════════════════

  function closeAllEditing() {
    document.querySelectorAll('.wow-editing').forEach(function(prev) {
      prev.classList.remove('wow-editing');
      prev.contentEditable = 'false';
      saveText(prev);
    });
  }

  function isEditableTarget(el) {
    if (!el || !el.hasAttribute || !el.hasAttribute('data-inject')) return false;
    // skip nav/footer links
    var inNav = el.closest('nav,header,.navbar,.mobile-menu,footer');
    if (inNav && (el.tagName === 'A' || el.closest('a'))) return false;
    // skip nested data-inject
    if (el.parentElement && el.parentElement.closest('[data-inject]')) return false;
    return true;
  }

  // Find closest [data-inject] parent from click target
  function findInjectTarget(target) {
    var el = target;
    while (el && el !== document.body) {
      if (el.hasAttribute && el.hasAttribute('data-inject') && isEditableTarget(el)) return el;
      el = el.parentElement;
    }
    return null;
  }

  document.addEventListener('click', function(e) {
    var el = findInjectTarget(e.target);
    if (!el) {
      // clicked outside — close any active editing
      closeAllEditing();
      return;
    }

    // Don't prevent default if already editing (allows cursor placement)
    if (el.classList.contains('wow-editing')) return;

    // Only prevent default on links to stop navigation
    if (e.target.tagName === 'A' || e.target.closest('a')) {
      e.preventDefault();
    }
    e.stopPropagation();

    // close previous
    closeAllEditing();

    el.classList.add('wow-editing');
    el.contentEditable = 'true';
    el.focus();

    // cursor at click position
    try {
      var sel = window.getSelection();
      if (sel.rangeCount === 0) {
        var range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    } catch(err) {}
  }, true); // capture phase

  document.addEventListener('focusout', function(e) {
    var el = e.target;
    if (!el || !el.classList || !el.classList.contains('wow-editing')) return;
    setTimeout(function() {
      if (!el.contains(document.activeElement)) {
        el.classList.remove('wow-editing');
        el.contentEditable = 'false';
        saveText(el);
      }
    }, 200);
  });

  document.addEventListener('keydown', function(e) {
    var el = e.target;
    if (!el || !el.classList || !el.classList.contains('wow-editing')) return;
    if (e.key === 'Escape') el.blur();
    if (e.key === 'Enter' && !e.shiftKey) {
      var tag = el.tagName.toLowerCase();
      if (['h1','h2','h3','h4','h5','h6','span','a','strong','em','button'].includes(tag)) {
        e.preventDefault();
        el.blur();
      }
    }
  });

  function saveText(el) {
    var key = el.getAttribute('data-inject');
    if (!key) return;
    window.parent.postMessage({
      action: 'wow-inline-edit', field: key, value: el.innerHTML, type: 'text'
    }, '*');
  }

  // ═══════════════════════════════════════════════
  // IMAGE EDITING — wrap each image with edit buttons
  // ═══════════════════════════════════════════════
  var uploadSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>';
  var regenSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>';
  var faceSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/><path d="M18 3l2 2-2 2"/></svg>';
  var videoSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>';

  document.querySelectorAll('[data-inject-src]').forEach(function(imgEl) {
    var key = imgEl.getAttribute('data-inject-src');
    var isSection = ['SECTION','HEADER','DIV','ARTICLE'].includes(imgEl.tagName);
    var isHero = key && (key.includes('hero') || key.includes('bg-') || key === 'g-bg-1');

    var btns = document.createElement('div');
    btns.className = 'wow-img-btns';
    btns.innerHTML = '<button data-action="upload">' + uploadSvg + ' העלאת תמונה</button>' +
                     '<button data-action="regen">' + regenSvg + ' יצירת תמונה AI</button>' +
                     '<button data-action="face">' + faceSvg + ' פנים AI</button>' +
                     (isHero ? '<button data-action="video">' + videoSvg + ' סרטון AI</button>' : '');

    if (isSection) {
      // Background-image container — don't wrap, just inject buttons overlay as child
      var cur = imgEl.style.position;
      if (!cur || cur === 'static') imgEl.style.position = 'relative';
      imgEl.appendChild(btns);
      imgEl.addEventListener('mouseenter', function() { btns.style.opacity='1'; btns.style.pointerEvents='auto'; });
      imgEl.addEventListener('mouseleave', function() { btns.style.opacity='0'; btns.style.pointerEvents='none'; });
    } else {
      // Regular img — wrap in div
      var wrapper = document.createElement('div');
      wrapper.className = 'wow-img-wrap';
      imgEl.parentNode.insertBefore(wrapper, imgEl);
      wrapper.appendChild(imgEl);
      wrapper.appendChild(btns);
    }

    // Upload click
    btns.querySelector('[data-action="upload"]').addEventListener('click', function(e) {
      e.preventDefault(); e.stopPropagation();
      window.parent.postMessage({ action: 'wow-inline-image-upload', field: key }, '*');
    });

    // Regen click
    btns.querySelector('[data-action="regen"]').addEventListener('click', function(e) {
      e.preventDefault(); e.stopPropagation();
      var container = isSection ? imgEl : imgEl.closest('.wow-img-wrap');
      if (container) {
        var loader = document.createElement('div');
        loader.className = 'wow-img-loading';
        container.appendChild(loader);
        setTimeout(function() { if (loader.parentNode) loader.remove(); }, 60000);
      }
      window.parent.postMessage({ action: 'wow-inline-image-regen', field: key }, '*');
    });

    // Face click — הכנסת פנים בעל עסק
    var faceBtn = btns.querySelector('[data-action="face"]');
    if (faceBtn) {
      faceBtn.addEventListener('click', function(e) {
        e.preventDefault(); e.stopPropagation();
        var container = isSection ? imgEl : imgEl.closest('.wow-img-wrap');
        if (container) {
          var loader = document.createElement('div');
          loader.className = 'wow-img-loading';
          container.appendChild(loader);
          setTimeout(function() { if (loader.parentNode) loader.remove(); }, 90000);
        }
        window.parent.postMessage({ action: 'wow-inline-image-face', field: key }, '*');
      });
    }

    // Video click — יצירת סרטון AI לhero
    var videoBtn = btns.querySelector('[data-action="video"]');
    if (videoBtn) {
      videoBtn.addEventListener('click', function(e) {
        e.preventDefault(); e.stopPropagation();
        var container = isSection ? imgEl : imgEl.closest('.wow-img-wrap');
        if (container) {
          var loader = document.createElement('div');
          loader.className = 'wow-img-loading';
          loader.setAttribute('data-video-loader', key);
          container.appendChild(loader);
        }
        window.parent.postMessage({ action: 'wow-inline-video-request', field: key }, '*');
      });
    }
  });

  // ═══════════════════════════════════════════════
  // SEMANTIC FIELD → CSS SELECTOR FALLBACK MAP
  // Used when data-inject exact match isn't found (e.g. Gemini HTML without explicit attributes)
  // ═══════════════════════════════════════════════
  var FIELD_SELECTORS = {
    'hero-title':     ['[data-inject="hero-title"]','#hero h1','.hero h1','section:first-of-type h1','header h1','.hero-title','[class*="hero"] h1'],
    'hero-subtitle':  ['[data-inject="hero-subtitle"]','#hero p:first-of-type','.hero p','.hero-subtitle','section:first-of-type p','[class*="hero"] p'],
    'hero-cta-1':     ['[data-inject="hero-cta-1"]','#hero a.btn','#hero .btn:first-child','.hero a[href*="wa.me"]','.hero-cta'],
    'hero-cta-2':     ['[data-inject="hero-cta-2"]','#hero .btn:nth-child(2)','.hero a:nth-child(2)'],
    'about-title':    ['[data-inject="about-title"]','#about h2','#about h3','.about h2','.about-title','section[id*="about"] h2'],
    'about-text':     ['[data-inject="about-text"]','#about p','.about-text','.about p','section[id*="about"] p'],
    'services-title': ['[data-inject="services-title"]','#services h2','.services-title','section[id*="service"] h2'],
    'svc-1-title':    ['[data-inject="svc-1-title"]','.services-grid .service-card:nth-child(1) h3','[class*="service-block"]:nth-child(1) h3','[class*="svc"]:nth-child(1) h3'],
    'svc-1-text':     ['[data-inject="svc-1-text"]','.services-grid .service-card:nth-child(1) p','[class*="service-block"]:nth-child(1) p'],
    'svc-2-title':    ['[data-inject="svc-2-title"]','.services-grid .service-card:nth-child(2) h3','[class*="service-block"]:nth-child(2) h3'],
    'svc-2-text':     ['[data-inject="svc-2-text"]','.services-grid .service-card:nth-child(2) p','[class*="service-block"]:nth-child(2) p'],
    'svc-3-title':    ['[data-inject="svc-3-title"]','.services-grid .service-card:nth-child(3) h3','[class*="service-block"]:nth-child(3) h3'],
    'svc-3-text':     ['[data-inject="svc-3-text"]','.services-grid .service-card:nth-child(3) p','[class*="service-block"]:nth-child(3) p'],
    'svc-4-title':    ['[data-inject="svc-4-title"]','.services-grid .service-card:nth-child(4) h3'],
    'svc-5-title':    ['[data-inject="svc-5-title"]','.services-grid .service-card:nth-child(5) h3'],
    'svc-6-title':    ['[data-inject="svc-6-title"]','.services-grid .service-card:nth-child(6) h3'],
    'cta-title':      ['[data-inject="cta-title"]','#cta h2','#contact h2','.cta-title','section[id*="cta"] h2','[class*="cta"] h2'],
    'cta-text':       ['[data-inject="cta-text"]','#cta p','.cta-text','section[id*="cta"] p','[class*="cta"] p'],
    'cta-btn':        ['[data-inject="cta-btn"]','#cta .btn','#cta a.btn','[class*="cta"] .btn'],
    'footer-brand':   ['[data-inject="footer-brand"]','footer [class*="brand"]','footer h3','footer h4','footer .logo-text'],
    'footer-about':   ['[data-inject="footer-about"]','footer p:first-of-type','footer .about-text','footer [class*="about"]'],
  };

  function findByField(field) {
    var selectors = FIELD_SELECTORS[field];
    if (!selectors) return null;
    for (var i = 0; i < selectors.length; i++) {
      try {
        var el = document.querySelector(selectors[i]);
        if (el) return el;
      } catch(e) {}
    }
    return null;
  }

  // ═══════════════════════════════════════════════
  // MESSAGES FROM PARENT — live updates
  // ═══════════════════════════════════════════════
  window.addEventListener('message', function(event) {
    var d = event.data || {};
    if (d.action !== 'wow-update') return;
    var field = d.field, value = d.value, type = d.type;

    if (type === 'text') {
      var html = value.replace(/\\\\n/g,'<br>').replace(/\\n/g,'<br>');
      var targets = document.querySelectorAll('[data-inject="'+field+'"]');
      if (targets.length > 0) {
        targets.forEach(function(el) { if (!el.classList.contains('wow-editing')) el.innerHTML = html; });
      } else {
        // Semantic fallback — find element by CSS selector pattern
        var el = findByField(field);
        if (el && !el.classList.contains('wow-editing')) el.innerHTML = html;
      }
    }
    if (type === 'image') {
      document.querySelectorAll('[data-inject-src="'+field+'"]').forEach(function(el) {
        // Remove loading indicator
        var wrap = el.closest('.wow-img-wrap');
        if (wrap) { var ld = wrap.querySelector('.wow-img-loading'); if(ld) ld.remove(); }
        var sec = el.closest('[style*="position"]');
        if (sec) { var ld2 = sec.querySelector('.wow-img-loading'); if(ld2) ld2.remove(); }
        if (value && el.tagName === 'IMG') el.src = value;
        else if (value) el.style.backgroundImage = 'url('+value+')';
      });
    }
    if (type === 'image-error') {
      // Remove loading indicators on failure
      document.querySelectorAll('[data-inject-src="'+field+'"]').forEach(function(el) {
        var wrap = el.closest('.wow-img-wrap');
        if (wrap) { var ld = wrap.querySelector('.wow-img-loading'); if(ld) ld.remove(); }
        var sec = el.closest('[style*="position"]');
        if (sec) { var ld2 = sec.querySelector('.wow-img-loading'); if(ld2) ld2.remove(); }
      });
      // Also remove by data-video-loader attribute
      var vl = document.querySelector('[data-video-loader="'+field+'"]');
      if (vl) vl.remove();
    }
    if (type === 'image-loading') {
      // Show loading on a specific image (used for face generation)
      document.querySelectorAll('[data-inject-src="'+field+'"]').forEach(function(el) {
        var container = el.closest('.wow-img-wrap') || el.closest('[style*="position"]');
        if (container) {
          if (!container.querySelector('.wow-img-loading')) {
            var ld = document.createElement('div');
            ld.className = 'wow-img-loading';
            container.appendChild(ld);
            setTimeout(function() { if (ld.parentNode) ld.remove(); }, 90000);
          }
        }
      });
    }
    if (type === 'video') {
      // Remove video loader
      var vl2 = document.querySelector('[data-video-loader]');
      if (vl2) vl2.remove();
      // Find hero section and inject video
      var heroEl = document.querySelector('#hero, section:first-of-type, [class*="hero"]');
      if (!heroEl) heroEl = document.querySelector('[data-inject-src="'+field+'"]');
      if (heroEl) {
        // Create video element
        var vid = document.createElement('video');
        vid.src = value;
        vid.autoplay = true;
        vid.muted = true;
        vid.loop = true;
        vid.setAttribute('playsinline', '');
        vid.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:0;';
        // Hide existing background image
        var existingBg = heroEl.querySelector('img[data-inject-src], [data-inject-src]');
        if (existingBg) existingBg.style.opacity = '0';
        heroEl.style.position = 'relative';
        heroEl.style.overflow = 'hidden';
        heroEl.insertBefore(vid, heroEl.firstChild);
      }
    }
    if (type === 'color' || type === 'border-radius') {
      // 1. Set CSS variable
      var cssVarStyle = document.getElementById('wow-var-overrides');
      if (!cssVarStyle) {
        cssVarStyle = document.createElement('style');
        cssVarStyle.id = 'wow-var-overrides';
        document.head.appendChild(cssVarStyle);
      }
      cssVarStyle.textContent += ':root { ' + field + ': ' + value + ' !important; }\n';

      // 2. If color: also apply to elements using var() for this field
      if (type === 'color' && field.startsWith('--')) {
        // Force CSS recalc by toggling a class
        document.documentElement.style.setProperty(field, value);

        // For Gemini HTML that doesn't use CSS variables:
        // Add override rules that target common elements based on which variable changed
        var overrideStyle = document.getElementById('wow-color-overrides');
        if (!overrideStyle) {
          overrideStyle = document.createElement('style');
          overrideStyle.id = 'wow-color-overrides';
          document.head.appendChild(overrideStyle);
        }
        if (field.includes('primary')) {
          overrideStyle.textContent += 'h1, h2, h3, [class*="title"], [class*="heading"], nav [class*="logo"], [class*="brand"] { color: ' + value + ' !important; }\n';
          overrideStyle.textContent += '[class*="btn-primary"], [class*="cta"]:not(section), nav [class*="btn"] { background: ' + value + ' !important; }\n';
        }
        if (field.includes('accent')) {
          overrideStyle.textContent += 'a:not([class]), [class*="accent"], [class*="highlight"] { color: ' + value + ' !important; }\n';
          overrideStyle.textContent += 'button:not([class*="secondary"]), [class*="btn"]:not([class*="secondary"]):not([class*="outline"]) { background: ' + value + ' !important; }\n';
        }
        if (field.includes('bg') || field.includes('background')) {
          overrideStyle.textContent += 'body, main { background-color: ' + value + ' !important; }\n';
        }
        if (field.includes('text')) {
          overrideStyle.textContent += 'body, p, li, span:not([class*="btn"]) { color: ' + value + ' !important; }\n';
        }
      }
    }
    if (type === 'link') {
      document.querySelectorAll('[data-inject-href="'+field+'"]').forEach(function(el) { el.href = value; });
    }
    if (type === 'font') {
      try {
        var fonts = JSON.parse(value);
        var cssVarStyleF = document.getElementById('wow-var-overrides');
        if (!cssVarStyleF) {
          cssVarStyleF = document.createElement('style');
          cssVarStyleF.id = 'wow-var-overrides';
          document.head.appendChild(cssVarStyleF);
        }
        if (fonts.heading) {
          cssVarStyleF.textContent += ':root { --heading-font: ' + fonts.heading + ' !important; }\n';
          var fn = fonts.heading.split("'")[1] || fonts.heading.split(',')[0].trim();
          if (fn && !document.querySelector('link[href*="'+fn.replace(/ /g,'+')+'"]')) {
            var lnk = document.createElement('link'); lnk.rel='stylesheet';
            lnk.href='https://fonts.googleapis.com/css2?family='+fn.replace(/ /g,'+')+':wght@300;400;500;600;700&subset=hebrew&display=swap';
            document.head.appendChild(lnk);
          }
        }
        if (fonts.body) {
          cssVarStyleF.textContent += ':root { --body-font: ' + fonts.body + ' !important; }\n';
          var bn = fonts.body.split("'")[1] || fonts.body.split(',')[0].trim();
          if (bn && !document.querySelector('link[href*="'+bn.replace(/ /g,'+')+'"]')) {
            var lnk2 = document.createElement('link'); lnk2.rel='stylesheet';
            lnk2.href='https://fonts.googleapis.com/css2?family='+bn.replace(/ /g,'+')+':wght@300;400;500;600;700&subset=hebrew&display=swap';
            document.head.appendChild(lnk2);
          }
        }
      } catch(e) {}
    }
    if (type === 'overlay') {
      document.querySelectorAll('[class*="hero"][class*="overlay"]').forEach(function(el) { el.style.opacity = value; });
    }
    if (type === 'section-hide') {
      var s=document.getElementById(field); if(s) s.style.display='none';
      document.querySelectorAll('a[href="#'+field+'"]').forEach(function(a) { a.style.display='none'; });
    }
    if (type === 'section-show') {
      var s2=document.getElementById(field); if(s2) s2.style.display='';
      document.querySelectorAll('a[href="#'+field+'"]').forEach(function(a) { a.style.display=''; });
    }
    if (type === 'icon') {
      document.querySelectorAll('[data-inject="'+field+'"]').forEach(function(el) {
        el.className = value;
      });
    }
    if (type === 'whatsapp') {
      var waBtn = document.getElementById('wow-whatsapp-btn');
      if (waBtn) waBtn.style.display = value === 'show' ? 'flex' : 'none';
    }
  });

})();
</script>
`;

module.exports = { LIVE_UPDATE_SCRIPT };
