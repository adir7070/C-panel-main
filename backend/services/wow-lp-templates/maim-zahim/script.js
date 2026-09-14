/* RM – בונים לך עתיד | scripts */

(() => {
  'use strict';

  /* Sticky header shadow */
  const header = document.getElementById('header');
  const onScroll = () => header && header.classList.toggle('scrolled', window.scrollY > 8);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* Mobile nav toggle */
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
      }
    });
  }

  /* Ads marquee — duplicate track children for a seamless loop */
  document.querySelectorAll('.ad-mq-track').forEach(t => { t.innerHTML += t.innerHTML; });

  /* Reveal on scroll */
  const revealTargets = document.querySelectorAll(
    '.section, .srv-card, .why-card, .proc-step, .proj-card, .ex-stat, .phase-card, .tst, .value-card, .contact-card'
  );
  revealTargets.forEach(el => el.classList.add('reveal'));
  const io = ('IntersectionObserver' in window) ? new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    });
  }, { rootMargin: '0px 0px -6% 0px', threshold: 0.05 }) : null;
  if (io) revealTargets.forEach(el => io.observe(el));
  else revealTargets.forEach(el => el.classList.add('in'));

  /* WA Lead Gate */
  const GATE_FLAG = 'rm_wa_gate_seen';
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
      window.open(pendingTarget.href, '_blank', 'noopener');
      pendingTarget = null;
    }
  };

  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="https://wa.me/"], a[href^="http://wa.me/"]');
    if (!a) return;
    if (sessionStorage.getItem(GATE_FLAG) === '1') return;
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
        phoneIn.style.borderColor = '#c44848';
        phoneIn.setAttribute('aria-invalid', 'true');
        return;
      }
      phoneIn.style.borderColor = '';
      phoneIn.removeAttribute('aria-invalid');
      proceedToWA();
    });
  }

  if (closeBtn) closeBtn.addEventListener('click', () => { pendingTarget = null; closeGate(); });
  if (skipBtn)  skipBtn .addEventListener('click', () => proceedToWA());
  if (backdrop) backdrop.addEventListener('click', () => { pendingTarget = null; closeGate(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { pendingTarget = null; closeGate(); } });

  /* Contact form */
  const rmForm = document.getElementById('rm-form');
  if (rmForm) {
    const status = rmForm.querySelector('.form-status');
    const phoneRe = /^0[2-9][0-9]{7,8}$/;
    const setError = (input, isErr) => { isErr ? input.setAttribute('aria-invalid', 'true') : input.removeAttribute('aria-invalid'); };

    rmForm.addEventListener('submit', (e) => {
      e.preventDefault();
      status.className = 'form-status'; status.textContent = '';

      const data = new FormData(rmForm);
      const name = (data.get('name') || '').trim();
      const phone = (data.get('phone') || '').trim();
      const service = data.get('service') || '';
      const city = data.get('city') || '';
      const message = (data.get('message') || '').trim();
      const consent = rmForm.querySelector('[name="consent"]').checked;

      const nameInput = rmForm.querySelector('[name="name"]');
      const phoneInput = rmForm.querySelector('[name="phone"]');

      let ok = true;
      setError(nameInput, !name || name.length < 2); if (!name || name.length < 2) ok = false;
      setError(phoneInput, !phoneRe.test(phone)); if (!phoneRe.test(phone)) ok = false;
      if (!consent) {
        status.className = 'form-status err';
        status.textContent = 'יש לאשר את קבלת ההודעות לפני שליחה';
        ok = false;
      }
      if (!ok) {
        if (!status.textContent) { status.className = 'form-status err'; status.textContent = 'נא לבדוק שהשם והטלפון מולאו נכון'; }
        return;
      }

      const lines = [
        'היי מים צחים, פרטים מטופס האתר:',
        `שם: ${name}`,
        `טלפון: ${phone}`
      ];
      if (service) lines.push(`סוג שירות: ${service}`);
      if (city)    lines.push(`יישוב: ${city}`);
      if (message) lines.push(`פרטים: ${message}`);
      const waUrl = `https://wa.me/972509755483?text=${encodeURIComponent(lines.join('\n'))}`;

      try { sessionStorage.setItem(GATE_FLAG, '1'); } catch (e) {}

      status.className = 'form-status ok';
      status.textContent = 'הפנייה נשלחה. מעביר אותך לוואטסאפ של מים צחים...';

      setTimeout(() => {
        window.open(waUrl, '_blank', 'noopener');
        rmForm.reset();
      }, 600);
    });
  }

  /* Testimonials carousel arrows */
  const tTrack = document.querySelector('.t-track');
  const tPrev  = document.querySelector('.t-prev');
  const tNext  = document.querySelector('.t-next');
  if (tTrack && tPrev && tNext) {
    const scrollBy = () => Math.max(280, tTrack.clientWidth * 0.7);
    const isRTL = () => document.documentElement.dir === 'rtl';
    tPrev.addEventListener('click', () => tTrack.scrollBy({ left: isRTL() ? scrollBy() : -scrollBy(), behavior: 'smooth' }));
    tNext.addEventListener('click', () => tTrack.scrollBy({ left: isRTL() ? -scrollBy() : scrollBy(), behavior: 'smooth' }));
  }

  /* Smooth scroll with sticky-header offset */
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

})();
