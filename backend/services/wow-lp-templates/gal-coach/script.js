/* GAL COACH — interactions */
const WA_NUMBER = '972528330884'; // Gal · international format, no +

/* ===========================================================
   WA LEAD CAPTURE GATE
   Intercepts every click on a[href*="wa.me"], shows the modal,
   captures name+phone, sends a rich lead via WATrack, then opens
   WhatsApp. Runs (end-of-body, non-defer) BEFORE the deferred
   wa-tracker.js, so its capture-phase listener registers first.
   =========================================================== */
(function () {
  const KEY = 'wa_gate_filled';
  let pendingHref = null, pendingButton = null;
  const gate = document.getElementById('waGate');
  if (!gate) return;
  const form = document.getElementById('waGateForm');
  const closeBtn = document.getElementById('waGateClose');
  const skipBtn = document.getElementById('waGateSkip');

  const filled = () => { try { return sessionStorage.getItem(KEY) === '1'; } catch (e) { return false; } };
  const markFilled = () => { try { sessionStorage.setItem(KEY, '1'); } catch (e) {} };

  function openGate(href, button) {
    pendingHref = href; pendingButton = button;
    gate.classList.add('open'); gate.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    setTimeout(() => { try { form.elements.name.focus(); } catch (e) {} }, 120);
  }
  function closeGate() {
    gate.classList.remove('open'); gate.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    form.querySelectorAll('input').forEach(i => i.classList.remove('invalid'));
  }
  const openWA = (href) => window.open(href, '_blank', 'noopener');

  // Intercept WA clicks — capture phase, before WATrack
  document.addEventListener('click', function (ev) {
    const a = ev.target && ev.target.closest && ev.target.closest('a[href*="wa.me"]');
    if (!a) return;
    if (filled()) return; // already engaged this session → let WATrack log normally
    ev.preventDefault();
    ev.stopImmediatePropagation();
    openGate(a.href, a.dataset.waButton || 'link');
  }, true);

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    const name = form.elements.name.value.trim();
    const phone = form.elements.phone.value.trim();
    const nameOk = name.length >= 2;
    const phoneOk = /^[+\d][\d\-\s]{8,14}$/.test(phone.replace(/\s/g, ''));
    form.elements.name.classList.toggle('invalid', !nameOk);
    form.elements.phone.classList.toggle('invalid', !phoneOk);
    if (!nameOk || !phoneOk) return;

    if (window.WATrack) {
      window.WATrack.send({
        button: 'lead-gate · ' + (pendingButton || 'link'),
        trigger: 'gate-submit',
        wa_number: WA_NUMBER,
        form: { name: name, phone: phone, source_button: pendingButton }
      });
    }
    markFilled();
    const href = pendingHref;
    closeGate();
    openWA(href);
  });

  skipBtn.addEventListener('click', function () {
    if (window.WATrack) {
      window.WATrack.send({ button: pendingButton || 'link', trigger: 'gate-skip', wa_number: WA_NUMBER });
    }
    markFilled();
    const href = pendingHref;
    closeGate();
    openWA(href);
  });

  closeBtn.addEventListener('click', closeGate);
  gate.addEventListener('click', (ev) => { if (ev.target === gate) closeGate(); });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && gate.classList.contains('open')) closeGate(); });
})();

/* ===========================================================
   Page interactions
   =========================================================== */
(function () {
  'use strict';
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  const yr = $('#year'); if (yr) yr.textContent = new Date().getFullYear();

  const header = $('#header');
  const onScroll = () => header.classList.toggle('scrolled', window.scrollY > 20);
  onScroll(); window.addEventListener('scroll', onScroll, { passive: true });

  const burger = $('#burger');
  if (burger) {
    burger.addEventListener('click', () => header.classList.toggle('open'));
    $$('#navLinks a').forEach(a => a.addEventListener('click', () => header.classList.remove('open')));
  }

  const reveals = $$('.reveal');
  if ('IntersectionObserver' in window && !reduce) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
    reveals.forEach(el => io.observe(el));
  } else { reveals.forEach(el => el.classList.add('in')); }

  const counters = $$('[data-count]');
  if (counters.length && 'IntersectionObserver' in window && !reduce) {
    const cio = new IntersectionObserver((entries) => {
      entries.forEach(e => {
        if (!e.isIntersecting) return;
        const el = e.target, target = +el.dataset.count, suffix = el.dataset.suffix || '';
        const t0 = performance.now(), dur = 1400;
        (function tick(now) {
          const p = Math.min(1, (now - t0) / dur);
          el.textContent = Math.round((1 - Math.pow(1 - p, 3)) * target) + suffix;
          if (p < 1) requestAnimationFrame(tick);
        })(t0);
        cio.unobserve(el);
      });
    }, { threshold: 0.5 });
    counters.forEach(c => cio.observe(c));
  }

  /* contact form -> WhatsApp (prefilled) + rich lead */
  const form = $('#leadForm'), note = $('#formNote');
  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = form.name.value.trim(), phone = form.phone.value.trim();
      const msg = form.msg.value.trim();
      if (name.length < 2 || phone.replace(/\D/g, '').length < 9) {
        if (note) { note.textContent = 'רגע — נשמח לשם מלא וטלפון תקין 🙏'; note.classList.remove('ok'); }
        return;
      }
      if (window.WATrack) {
        window.WATrack.send({
          button: 'contact-form',
          trigger: 'contact-form',
          wa_number: WA_NUMBER,
          form: { name: name, phone: phone, message: msg, source_button: 'contact-form' }
        });
      }
      const text = 'שלום גל 🙏 שמי ' + name + '.' + (msg ? ' ' + msg : ' אשמח לשמוע על תהליך אימון.') + ' הטלפון שלי: ' + phone;
      const url = 'https://wa.me/' + WA_NUMBER + '?text=' + encodeURIComponent(text);
      if (note) { note.textContent = 'פותח וואטסאפ… 🌱 תודה ' + name + '!'; note.classList.add('ok'); }
      window.open(url, '_blank', 'noopener');
    });
  }
})();
