/* ============================================================
   YASSU — Landing interactions (rich edition)
   ============================================================ */
(function () {
  'use strict';
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  /* ---------- Year ---------- */
  const y = $('#year'); if (y) y.textContent = new Date().getFullYear();

  /* ---------- Sticky nav + scroll progress + to-top ---------- */
  const nav = $('#nav'), bar = $('#scrollbar'), toTop = $('#totop');
  function onScroll() {
    const sc = window.scrollY;
    nav.classList.toggle('is-stuck', sc > 24);
    if (toTop) toTop.classList.toggle('is-on', sc > 700);
    if (bar) {
      const h = document.documentElement.scrollHeight - window.innerHeight;
      bar.style.width = (h > 0 ? (sc / h) * 100 : 0) + '%';
    }
  }
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });
  if (toTop) toTop.addEventListener('click', () => window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' }));

  /* ---------- Mobile menu ---------- */
  const burger = $('#burger'), navLinks = $('#navLinks');
  if (burger) {
    burger.addEventListener('click', () => nav.classList.toggle('is-open'));
    $$('a', navLinks).forEach(a => a.addEventListener('click', () => nav.classList.remove('is-open')));
  }

  /* ---------- Reveal on scroll ---------- */
  const reveals = $$('.reveal');
  if ('IntersectionObserver' in window && !reduce) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); } });
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
    reveals.forEach(el => io.observe(el));
  } else { reveals.forEach(el => el.classList.add('is-in')); }

  /* ---------- Animated counters ---------- */
  const counters = $$('[data-count]');
  if (counters.length && 'IntersectionObserver' in window && !reduce) {
    const cio = new IntersectionObserver((entries) => {
      entries.forEach(e => {
        if (!e.isIntersecting) return;
        const el = e.target, target = +el.dataset.count, suffix = el.dataset.suffix || '';
        const dur = 1500, t0 = performance.now();
        const fmt = n => n >= 1000 ? n.toLocaleString('en-US') : n;
        function tick(now) {
          const p = Math.min(1, (now - t0) / dur);
          const val = Math.round((1 - Math.pow(1 - p, 3)) * target);
          el.textContent = fmt(val) + suffix;
          if (p < 1) requestAnimationFrame(tick);
        }
        requestAnimationFrame(tick);
        cio.unobserve(el);
      });
    }, { threshold: 0.5 });
    counters.forEach(c => cio.observe(c));
  } else { counters.forEach(c => { c.textContent = (+c.dataset.count).toLocaleString('en-US') + (c.dataset.suffix || ''); }); }

  /* ---------- JS marquees (seamless, perf-friendly) ---------- */
  if (!reduce) {
    $$('[data-marquee]').forEach((track, idx) => {
      const rev = track.classList.contains('marquee__track--rev');
      let x = 0;
      const speed = (rev ? 0.4 : -0.4);
      const width = track.scrollWidth / 2; // duplicated content
      function step() {
        x += speed;
        if (!rev && x <= -width) x += width;
        if (rev && x >= 0) x -= width;
        track.style.transform = 'translateX(' + x + 'px)';
        requestAnimationFrame(step);
      }
      if (rev) x = -width;
      requestAnimationFrame(step);
    });
  }

  /* ---------- Hero parallax (mouse) ---------- */
  const phoneWrap = $('.hero__phone');
  if (phoneWrap && !reduce && window.matchMedia('(pointer:fine)').matches) {
    const phone = $('#phone'), stickers = $$('.float-sticker');
    const hero = $('.hero');
    hero.addEventListener('mousemove', (e) => {
      const r = hero.getBoundingClientRect();
      const cx = (e.clientX - r.left) / r.width - 0.5;
      const cy = (e.clientY - r.top) / r.height - 0.5;
      if (phone) phone.style.transform =
        `rotateY(${-12 + cx * 10}deg) rotateX(${4 - cy * 8}deg) rotate(2deg)`;
      stickers.forEach(s => {
        const d = +s.dataset.depth || 16;
        s.style.transform = `translate(${cx * d}px, ${cy * d}px)`;
      });
    });
    hero.addEventListener('mouseleave', () => {
      if (phone) phone.style.transform = '';
      stickers.forEach(s => s.style.transform = '');
    });
  }

  /* ---------- Gallery drag-to-scroll ---------- */
  const gal = $('#gal');
  if (gal) {
    let down = false, sx = 0, sl = 0;
    gal.addEventListener('pointerdown', (e) => { down = true; gal.classList.add('is-drag'); sx = e.pageX; sl = gal.scrollLeft; });
    window.addEventListener('pointerup', () => { down = false; gal.classList.remove('is-drag'); });
    gal.addEventListener('pointermove', (e) => { if (!down) return; gal.scrollLeft = sl - (e.pageX - sx); });
    // gentle auto-advance until user interacts
    let autop = true;
    gal.addEventListener('pointerdown', () => autop = false);
    if (!reduce) {
      (function drift() {
        if (autop && gal.scrollWidth > gal.clientWidth) {
          gal.scrollLeft -= 0.5; // RTL drift
          if (gal.scrollLeft <= 0) gal.scrollLeft = gal.scrollWidth;
        }
        requestAnimationFrame(drift);
      })();
    }
  }

  /* ---------- Confetti ---------- */
  const palette = ['#7A1FB8', '#9A24C9', '#C71FA8', '#FF1E8E', '#FF7AC0', '#FFD23F', '#3FA9FF'];
  function makeConfetti(c, n, soft) {
    if (!c || reduce) return;
    const f = document.createDocumentFragment();
    for (let i = 0; i < n; i++) {
      const p = document.createElement('i');
      const size = 6 + Math.random() * 7;
      p.style.left = Math.random() * 100 + '%';
      p.style.background = palette[(Math.random() * palette.length) | 0];
      p.style.width = size + 'px';
      p.style.height = size * 1.5 + 'px';
      p.style.animationDuration = (6 + Math.random() * 7) + 's';
      p.style.animationDelay = (-Math.random() * 12) + 's';
      if (Math.random() > 0.6) p.style.borderRadius = '50%';
      if (soft) p.style.opacity = '0.55';
      f.appendChild(p);
    }
    c.appendChild(f);
  }
  makeConfetti($('#confetti'), 34);
  makeConfetti($('#confetti2'), 20, true);
  makeConfetti($('#confetti3'), 28);

  /* ---------- Forms ---------- */
  function handle(formId, noteId, ok) {
    const form = $('#' + formId), note = noteId ? $('#' + noteId) : null;
    if (!form) return;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('input', form), email = (input.value || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { input.focus(); if (note) note.textContent = 'רגע, נראה שהמייל לא תקין 🤔'; return; }
      try {
        const list = JSON.parse(localStorage.getItem('yassu_waitlist') || '[]');
        if (!list.includes(email)) list.push(email);
        localStorage.setItem('yassu_waitlist', JSON.stringify(list));
      } catch (_) {}
      form.reset(); input.placeholder = email;
      if (note) { note.textContent = ok; note.classList.add('is-ok'); }
      burst();
    });
  }
  handle('heroForm', 'heroFormNote', 'יש! אתם ברשימה 🎉 נעדכן ברגע שעולים לאוויר.');
  handle('joinForm', 'joinNote', 'אלופים! נתראה ב‑YASSU 🥳');
  handle('footerForm', 'footerNote', 'נרשמתם! 🎉');

  function burst() {
    if (reduce) return;
    const layer = document.createElement('div');
    layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:9999;overflow:hidden';
    document.body.appendChild(layer);
    for (let i = 0; i < 80; i++) {
      const p = document.createElement('i');
      const size = 7 + Math.random() * 9, x = 50 + (Math.random() - .5) * 60;
      const tx = (Math.random() - .5) * 640, ty = -(160 + Math.random() * 420), rot = (Math.random() - .5) * 720;
      p.style.cssText = 'position:absolute;top:62%;left:' + x + '%;width:' + size + 'px;height:' + size * 1.4 + 'px;background:' + palette[(Math.random() * palette.length) | 0] + ';border-radius:' + (Math.random() > .5 ? '50%' : '2px');
      p.animate([
        { transform: 'translate(0,0) rotate(0)', opacity: 1 },
        { transform: `translate(${tx}px,${ty}px) rotate(${rot}deg)`, opacity: 1, offset: .7 },
        { transform: `translate(${tx * 1.2}px,${ty + 720}px) rotate(${rot * 1.4}deg)`, opacity: 0 }
      ], { duration: 1000 + Math.random() * 900, easing: 'cubic-bezier(.2,.7,.3,1)' });
      layer.appendChild(p);
    }
    setTimeout(() => layer.remove(), 2300);
  }
})();

/* ============================================================
   ★ NEXT-LEVEL : advanced motion engine
   ============================================================ */
(function () {
  'use strict';
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fine = window.matchMedia('(pointer:fine)').matches;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  /* ---------- 1 · Split-text heading reveal ---------- */
  (function splitHeadings() {
    const heads = $$('.section__head h2, .what__copy h2, .growth__copy h2, .feature__copy h3, .moment__quote, .join__title, .stickers h2, .quotes h2, .events h2');
    if (!heads.length) return;
    heads.forEach(h => {
      if (h.dataset.split) return;
      h.dataset.split = '1';
      const frag = document.createDocumentFragment();
      let i = 0;
      Array.from(h.childNodes).forEach(node => {
        if (node.nodeType === 3) {
          node.textContent.split(/(\s+)/).forEach(tok => {
            if (tok === '' ) return;
            if (/^\s+$/.test(tok)) { frag.appendChild(document.createTextNode(tok)); return; }
            const s = document.createElement('span');
            s.className = 'w'; s.style.setProperty('--i', i++); s.textContent = tok;
            frag.appendChild(s);
          });
        } else if (node.nodeType === 1) {
          if (node.tagName === 'BR') { frag.appendChild(node.cloneNode()); return; }
          node.classList.add('w'); node.style.setProperty('--i', i++);
          frag.appendChild(node);
        }
      });
      h.innerHTML = ''; h.appendChild(frag);
      h.classList.add('split');
    });
    if (reduce || !('IntersectionObserver' in window)) { heads.forEach(h => h.classList.add('shown')); return; }
    const io = new IntersectionObserver((ents) => {
      ents.forEach(e => { if (e.isIntersecting) { e.target.classList.add('shown'); io.unobserve(e.target); } });
    }, { threshold: 0.3 });
    heads.forEach(h => io.observe(h));
  })();

  if (reduce) return;

  /* ---------- 2 · Tilt + spotlight cards ---------- */
  if (fine) {
    const cards = $$('.card, .pain, .trust__item, .qcard, .persona__card, .ev');
    cards.forEach(el => {
      el.classList.add('spot');
      let raf = 0, nx = 0, ny = 0, rx = 0, ry = 0;
      const max = el.classList.contains('ev') ? 6 : 9;
      el.addEventListener('pointermove', (e) => {
        const r = el.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
        el.style.setProperty('--mx', (px * 100) + '%');
        el.style.setProperty('--my', (py * 100) + '%');
        rx = (0.5 - py) * max; ry = (px - 0.5) * max;
        if (!raf) raf = requestAnimationFrame(apply);
      });
      function apply() {
        raf = 0;
        el.style.transform = `perspective(820px) rotateX(${rx}deg) rotateY(${ry}deg) translateY(-6px) scale(1.012)`;
      }
      el.addEventListener('pointerleave', () => { el.style.transform = ''; });
    });
  }

  /* ---------- 3 · Magnetic buttons ---------- */
  if (fine) {
    $$('.btn').forEach(b => {
      b.addEventListener('pointermove', (e) => {
        const r = b.getBoundingClientRect();
        const x = e.clientX - r.left - r.width / 2, y = e.clientY - r.top - r.height / 2;
        b.style.transform = `translate(${x * 0.22}px, ${y * 0.34}px)`;
      });
      b.addEventListener('pointerleave', () => { b.style.transform = ''; });
    });
  }

  /* ---------- 4 · Cursor glow ---------- */
  if (fine) {
    const glow = $('#cursorGlow');
    if (glow) {
      let gx = innerWidth / 2, gy = innerHeight / 2, cx = gx, cy = gy, on = false;
      window.addEventListener('pointermove', (e) => {
        gx = e.clientX; gy = e.clientY;
        if (!on) { on = true; glow.classList.add('is-on'); }
      });
      (function loop() {
        cx += (gx - cx) * 0.12; cy += (gy - cy) * 0.12;
        glow.style.transform = `translate(${cx}px, ${cy}px) translate(-50%,-50%)`;
        requestAnimationFrame(loop);
      })();
    }
  }

  /* ---------- 5 · Scroll parallax (decorative) ---------- */
  const parItems = [
    { el: $('.moment__img'), speed: 0.12 },
    { el: $('.hero__bgimg'), speed: -0.06 }
  ].filter(o => o.el);
  if (parItems.length) {
    let ticking = false;
    function par() {
      ticking = false;
      const vh = innerHeight;
      parItems.forEach(({ el, speed }) => {
        const r = el.getBoundingClientRect();
        const center = r.top + r.height / 2 - vh / 2;
        el.style.transform = `translateY(${center * speed}px) scale(1.12)`;
      });
    }
    window.addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(par); } }, { passive: true });
    par();
  }
})();
