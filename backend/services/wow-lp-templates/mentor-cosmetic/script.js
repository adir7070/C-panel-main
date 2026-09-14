/* Mentor Cosmetics – interactions */

(() => {
  'use strict';

  /* Year */
  const y = document.getElementById('year');
  if (y) y.textContent = new Date().getFullYear();

  /* Header scroll state + back-to-top */
  const header = document.getElementById('header');
  const top    = document.querySelector('.float-top');
  const onScroll = () => {
    header.classList.toggle('scrolled', window.scrollY > 30);
    top.classList.toggle('visible', window.scrollY > 500);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
  top.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));

  /* Mobile nav */
  const toggle = document.querySelector('.nav-toggle');
  const nav    = document.getElementById('nav');
  if (toggle && nav) {
    toggle.addEventListener('click', () => {
      const open = nav.classList.toggle('open');
      toggle.classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    nav.querySelectorAll('a').forEach(a => a.addEventListener('click', () => {
      nav.classList.remove('open');
      toggle.classList.remove('open');
    }));
  }

  /* Countdown – ends 7 days from first visit (stored in localStorage) */
  const cd = document.getElementById('countdown');
  if (cd) {
    const KEY = 'mentor_promo_end';
    let end = +localStorage.getItem(KEY);
    if (!end || end < Date.now()) {
      end = Date.now() + 7 * 24 * 60 * 60 * 1000;
      localStorage.setItem(KEY, end);
    }
    const pad = (n) => String(n).padStart(2, '0');
    const tick = () => {
      const diff = Math.max(0, end - Date.now());
      const d = Math.floor(diff / 86400000);
      const h = Math.floor((diff / 3600000) % 24);
      const m = Math.floor((diff / 60000) % 60);
      const s = Math.floor((diff / 1000) % 60);
      document.getElementById('cd-days').textContent  = pad(d);
      document.getElementById('cd-hours').textContent = pad(h);
      document.getElementById('cd-mins').textContent  = pad(m);
      document.getElementById('cd-secs').textContent  = pad(s);
    };
    tick();
    setInterval(tick, 1000);
  }

  /* Forms → WhatsApp */
  const WA_NUMBER = '972539855922'; // country code + number without leading 0
  const validatePhone = (v) => /^0\d{8,9}$/.test(String(v || '').trim());

  const wireForm = (form) => {
    if (!form) return;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(form).entries());
      const status = form.querySelector('.form-status');
      const setMsg = (msg, ok) => {
        if (status) {
          status.textContent = msg;
          status.className = 'form-status ' + (ok ? 'success' : 'error');
        } else if (!ok) {
          alert(msg);
        }
      };
      if (!data.name  || data.name.trim().length < 2) return setMsg('יש להזין שם מלא.', false);
      if (!validatePhone(data.phone))                  return setMsg('מספר טלפון לא תקין.', false);

      // Build WhatsApp message in Hebrew
      const lines = [
        'שלום, אני מעוניינת לקבוע פגישת ייעוץ 💕',
        '',
        `שם: ${data.name.trim()}`,
        `טלפון: ${data.phone.trim()}`,
      ];
      if (data.email   && data.email.trim())   lines.push(`מייל: ${data.email.trim()}`);
      if (data.service && data.service.trim()) lines.push(`טיפול מבוקש: ${data.service.trim()}`);
      if (data.message && data.message.trim()) lines.push(`הודעה: ${data.message.trim()}`);

      const url = `https://wa.me/${WA_NUMBER}?text=${encodeURIComponent(lines.join('\n'))}`;
      setMsg('פותח וואטסאפ... 💬', true);
      window.open(url, '_blank', 'noopener');
      form.reset();
    });
  };

  wireForm(document.getElementById('leadForm'));
  wireForm(document.getElementById('contactForm'));

  /* Active nav link on scroll */
  const navLinks = document.querySelectorAll('.nav a[href^="#"]');
  if ('IntersectionObserver' in window && navLinks.length) {
    const sections = [...navLinks].map(a => document.querySelector(a.getAttribute('href'))).filter(Boolean);
    const io = new IntersectionObserver((entries) => {
      entries.forEach(en => {
        if (en.isIntersecting) {
          const id = '#' + en.target.id;
          navLinks.forEach(a => a.classList.toggle('active', a.getAttribute('href') === id));
        }
      });
    }, { rootMargin: '-40% 0px -55% 0px' });
    sections.forEach(s => io.observe(s));
  }

  /* Marquee – duplicate children once so translateX(-50%) loops seamlessly */
  document.querySelectorAll('.marquee').forEach(m => {
    const track = m.querySelector('.marquee-track');
    if (!track) return;
    const items = [...track.children];
    items.forEach(node => track.appendChild(node.cloneNode(true)));
  });

  /* YouTube click-to-load embeds */
  document.querySelectorAll('.yt-embed').forEach(box => {
    const id    = box.dataset.yt;
    const start = box.dataset.start || 0;
    if (!id) return;
    const trigger = box.querySelector('.play-btn');
    const load = () => {
      const iframe = document.createElement('iframe');
      iframe.src = `https://www.youtube.com/embed/${id}?autoplay=1&rel=0&start=${start}`;
      iframe.title = 'YouTube video player';
      iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
      iframe.allowFullscreen = true;
      iframe.loading = 'lazy';
      box.innerHTML = '';
      box.appendChild(iframe);
      box.classList.add('yt-loaded');
    };
    trigger.addEventListener('click', (e) => { e.preventDefault(); load(); });
    box.addEventListener('click', (e) => {
      if (e.target.tagName === 'IMG') load();
    });
  });

  /* Other play buttons stub */
  document.querySelectorAll('.play-btn').forEach(btn => {
    if (btn.closest('.yt-embed')) return;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      // TODO: embed a real video URL per card (data-video="...")
      console.log('[play] clicked');
    });
  });

})();
