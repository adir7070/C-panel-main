/* ============================================
   ליאור יצחקוב | Beauty & Art – scripts
   - Sticky header shadow
   - Mobile nav toggle
   - Reveal-on-scroll animations
   - WA Lead Gate (intercepts wa.me clicks once)
============================================ */

(() => {
  'use strict';

  /* -----  Sticky header shadow  ----- */
  const header = document.getElementById('header');
  const onScroll = () => {
    if (!header) return;
    header.classList.toggle('scrolled', window.scrollY > 8);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* -----  Mobile nav toggle  ----- */
  const navToggle = document.querySelector('.nav-toggle');
  const nav = document.querySelector('.nav');
  if (navToggle && nav) {
    navToggle.addEventListener('click', () => {
      const open = nav.classList.toggle('open');
      navToggle.classList.toggle('open', open);
      navToggle.setAttribute('aria-expanded', String(open));
    });
    nav.addEventListener('click', e => {
      if (e.target.tagName === 'A') {
        nav.classList.remove('open');
        navToggle.classList.remove('open');
        navToggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  /* -----  Reveal on scroll  ----- */
  const revealTargets = document.querySelectorAll('.section, .pm-card, .srv-card, .duo-card, .value-card, .promo-card, .tst, .removal-card, .process-step, .gallery-grid figure, .contact-card');
  revealTargets.forEach(el => el.classList.add('reveal'));
  const io = ('IntersectionObserver' in window) ? new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (e.isIntersecting) {
        e.target.classList.add('in');
        io.unobserve(e.target);
      }
    });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 }) : null;
  if (io) revealTargets.forEach(el => io.observe(el));
  else revealTargets.forEach(el => el.classList.add('in'));

  /* ============================================
     WA LEAD GATE
     Intercepts any <a> with href starting with
     "https://wa.me/" and shows a phone-capture modal
     once per session (sessionStorage flag).
  ============================================ */
  const GATE_FLAG = 'lior_wa_gate_seen';
  const gate     = document.getElementById('wa-gate');
  const gateForm = document.getElementById('wa-gate-form');
  const phoneIn  = document.getElementById('wa-gate-phone');
  const closeBtn = gate ? gate.querySelector('.wa-gate-close') : null;
  const skipBtn  = gate ? gate.querySelector('.wa-gate-skip')  : null;
  const backdrop = gate ? gate.querySelector('.wa-gate-backdrop') : null;
  let pendingTarget = null;

  const openGate = () => {
    if (!gate) return;
    gate.classList.add('open');
    gate.setAttribute('aria-hidden', 'false');
    setTimeout(() => phoneIn && phoneIn.focus(), 200);
  };
  const closeGate = () => {
    if (!gate) return;
    gate.classList.remove('open');
    gate.setAttribute('aria-hidden', 'true');
  };

  const proceedToWA = () => {
    sessionStorage.setItem(GATE_FLAG, '1');
    closeGate();
    if (pendingTarget) {
      const url = pendingTarget.href;
      window.open(url, '_blank', 'noopener');
      pendingTarget = null;
    }
  };

  // Intercept WA clicks at capture phase so we can show modal before nav
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="https://wa.me/"], a[href^="http://wa.me/"]');
    if (!a) return;
    if (sessionStorage.getItem(GATE_FLAG) === '1') return; // shown once per session
    e.preventDefault();
    e.stopImmediatePropagation();
    pendingTarget = a;
    openGate();
  }, true);

  if (gateForm) {
    gateForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const phone = (phoneIn.value || '').trim();
      const phoneRe = /^0[2-9][0-9]{7,8}$/;
      if (!phoneRe.test(phone)) {
        phoneIn.style.borderColor = '#d94d4d';
        phoneIn.setAttribute('aria-invalid', 'true');
        return;
      }
      phoneIn.style.borderColor = '';
      phoneIn.removeAttribute('aria-invalid');

      // Send the lead via beacon (CPANEL tracker endpoint) — silent, non-blocking.
      try {
        const payload = JSON.stringify({
          phone: phone,
          source: 'lior-beauty',
          page:   location.href,
          target: pendingTarget ? pendingTarget.getAttribute('data-wa') || 'unknown' : 'unknown',
          ts:     new Date().toISOString()
        });
        if ('sendBeacon' in navigator) {
          const blob = new Blob([payload], { type: 'application/json' });
          navigator.sendBeacon('https://api.iconiqmedia.co.il/api/leads/wa-click', blob);
        } else {
          fetch('https://api.iconiqmedia.co.il/api/leads/wa-click', {
            method: 'POST',
            mode: 'no-cors',
            headers: { 'Content-Type': 'application/json' },
            body: payload,
            keepalive: true
          }).catch(() => {});
        }
      } catch (err) { /* silent */ }

      proceedToWA();
    });
  }

  if (closeBtn) closeBtn.addEventListener('click', () => { pendingTarget = null; closeGate(); });
  if (skipBtn)  skipBtn .addEventListener('click', () => { proceedToWA(); });
  if (backdrop) backdrop.addEventListener('click', () => { pendingTarget = null; closeGate(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { pendingTarget = null; closeGate(); } });

  /* -----  Smooth-scroll polyfill for older Safari + offset for sticky header  ----- */
  document.querySelectorAll('a[href^="#"]').forEach(a => {
    a.addEventListener('click', (e) => {
      const id = a.getAttribute('href');
      if (id.length <= 1) return;
      const target = document.querySelector(id);
      if (!target) return;
      e.preventDefault();
      const headerH = (header ? header.offsetHeight : 0) + 12;
      const top = target.getBoundingClientRect().top + window.scrollY - headerH;
      window.scrollTo({ top, behavior: 'smooth' });
    });
  });

  /* -----  Contact form submission  ----- */
  const liorForm = document.getElementById('lior-form');
  if (liorForm) {
    const status = liorForm.querySelector('.form-status');
    const phoneRe = /^0[2-9][0-9]{7,8}$/;

    const setError = (input, isErr) => {
      if (isErr) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    };

    liorForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      status.className = 'form-status';
      status.textContent = '';

      const data = new FormData(liorForm);
      const name = (data.get('name') || '').trim();
      const phone = (data.get('phone') || '').trim();
      const service = (data.get('service') || '').trim();
      const clinic = (data.get('clinic') || '').trim();
      const time = (data.get('time') || '').trim();
      const message = (data.get('message') || '').trim();
      const consent = liorForm.querySelector('[name="consent"]').checked;

      const nameInput = liorForm.querySelector('[name="name"]');
      const phoneInput = liorForm.querySelector('[name="phone"]');
      const consentInput = liorForm.querySelector('[name="consent"]');

      let ok = true;
      setError(nameInput, !name || name.length < 2); if (!name || name.length < 2) ok = false;
      setError(phoneInput, !phoneRe.test(phone)); if (!phoneRe.test(phone)) ok = false;
      if (!consent) {
        status.className = 'form-status err';
        status.textContent = 'יש לאשר את קבלת ההודעות לפני שליחה';
        ok = false;
      }
      if (!ok) {
        if (!status.textContent) {
          status.className = 'form-status err';
          status.textContent = 'נא לבדוק שהשם והטלפון מולאו נכון';
        }
        return;
      }

      // Build WA message
      const lines = [
        `היי ליאור, אשמח לקבוע תור.`,
        `שם: ${name}`,
        `טלפון: ${phone}`
      ];
      if (service) lines.push(`שירות: ${service}`);
      if (clinic)  lines.push(`קליניקה: ${clinic}`);
      if (time)    lines.push(`זמן מועדף: ${time}`);
      if (message) lines.push(`הערה: ${message}`);
      const waText = encodeURIComponent(lines.join('\n'));
      const waUrl  = `https://wa.me/972509553030?text=${waText}`;

      // Send lead to CPANEL backend (silent, non-blocking)
      try {
        const payload = JSON.stringify({
          name, phone, service, clinic, time, message,
          source: 'lior-beauty-form',
          page:   location.href,
          target: 'contact-form',
          ts:     new Date().toISOString()
        });
        if ('sendBeacon' in navigator) {
          const blob = new Blob([payload], { type: 'application/json' });
          navigator.sendBeacon('https://api.iconiqmedia.co.il/api/leads/wa-click', blob);
        } else {
          fetch('https://api.iconiqmedia.co.il/api/leads/wa-click', {
            method: 'POST',
            mode: 'no-cors',
            headers: { 'Content-Type': 'application/json' },
            body: payload,
            keepalive: true
          }).catch(() => {});
        }
      } catch (err) { /* silent */ }

      // Mark gate as already fired so the WA modal doesn't double-up
      try { sessionStorage.setItem('lior_wa_gate_seen', '1'); } catch (e) {}

      status.className = 'form-status ok';
      status.textContent = 'מעביר אותך לוואטסאפ של ליאור...';

      // Open WhatsApp
      setTimeout(() => {
        window.open(waUrl, '_blank', 'noopener');
        liorForm.reset();
      }, 600);
    });
  }

  /* -----  Testimonials carousel arrows  ----- */
  const tTrack = document.querySelector('.t-track');
  const tPrev  = document.querySelector('.t-prev');
  const tNext  = document.querySelector('.t-next');
  if (tTrack && tPrev && tNext) {
    const scrollBy = () => Math.max(280, tTrack.clientWidth * 0.7);
    const isRTL = () => getComputedStyle(tTrack).direction === 'rtl' ||
                        document.documentElement.dir === 'rtl';
    tPrev.addEventListener('click', () => {
      const d = scrollBy();
      tTrack.scrollBy({ left: isRTL() ? d : -d, behavior: 'smooth' });
    });
    tNext.addEventListener('click', () => {
      const d = scrollBy();
      tTrack.scrollBy({ left: isRTL() ? -d : d, behavior: 'smooth' });
    });
  }

  /* -----  Subtle parallax for hero badge  ----- */
  const heroBadge = document.querySelector('.hero-badge');
  if (heroBadge) {
    window.addEventListener('scroll', () => {
      const y = window.scrollY;
      if (y < 600) heroBadge.style.transform = `translateY(${-y * 0.05}px)`;
    }, { passive: true });
  }

})();
