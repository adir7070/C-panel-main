/* ═══════════════════════════════════════════════════════
   LUGASSY 1770 · SCRIPT
   ═══════════════════════════════════════════════════════ */

// ─── WA LEAD CAPTURE GATE ───────────────────────────────
(function () {
    const KEY = 'wa_gate_filled';
    const WA_NUMBER = '972542758352';
    let pendingHref = null, pendingButton = null;

    const gate = document.getElementById('waGate');
    const form = document.getElementById('waGateForm');
    const closeBtn = document.getElementById('waGateClose');
    const skipBtn = document.getElementById('waGateSkip');

    const filled = () => { try { return sessionStorage.getItem(KEY) === '1'; } catch { return false; } };
    const markFilled = () => { try { sessionStorage.setItem(KEY, '1'); } catch {} };

    function openGate(href, button) {
        pendingHref = href; pendingButton = button;
        gate.classList.add('open'); gate.setAttribute('aria-hidden', 'false');
        document.body.style.overflow = 'hidden';
        setTimeout(() => form.elements.phone.focus(), 120);
    }
    function closeGate() {
        gate.classList.remove('open'); gate.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = '';
        form.querySelectorAll('input').forEach(i => i.classList.remove('invalid'));
    }
    function openWA(href) { window.open(href, '_blank', 'noopener'); }

    document.addEventListener('click', function (ev) {
        const a = ev.target && ev.target.closest && ev.target.closest('a[href*="wa.me"]');
        if (!a) return;
        if (filled()) return;
        ev.preventDefault();
        ev.stopImmediatePropagation();
        openGate(a.href, a.dataset.waButton || 'link');
    }, true);

    form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        const phone = form.elements.phone.value.trim();
        const phoneOk = /^[+\d][\d\-\s]{8,14}$/.test(phone.replace(/\s/g, ''));
        form.elements.phone.classList.toggle('invalid', !phoneOk);
        if (!phoneOk) return;
        if (window.WATrack) {
            window.WATrack.send({
                button: 'lead-gate · ' + (pendingButton || 'link'),
                trigger: 'gate-submit',
                wa_number: WA_NUMBER,
                form: { phone: phone, source_button: pendingButton }
            });
        }
        markFilled();
        const href = pendingHref;
        closeGate();
        openWA(href);
    });

    skipBtn.addEventListener('click', function () {
        if (window.WATrack) {
            window.WATrack.send({
                button: pendingButton || 'link',
                trigger: 'gate-skip',
                wa_number: WA_NUMBER
            });
        }
        markFilled();
        const href = pendingHref;
        closeGate();
        openWA(href);
    });

    closeBtn.addEventListener('click', closeGate);
    gate.addEventListener('click', function (ev) { if (ev.target === gate) closeGate(); });
    document.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape' && gate.classList.contains('open')) closeGate();
    });
})();

// ─── HEADER SCROLL ──────────────────────────────────────
const header = document.getElementById('header');
window.addEventListener('scroll', () => {
    header.classList.toggle('scrolled', window.scrollY > 60);
});

// ─── MOBILE NAV (HAMBURGER) ─────────────────────────────
document.getElementById('hamburger').addEventListener('click', () => {
    document.getElementById('navMid').classList.toggle('open');
});
document.querySelectorAll('#navMid a').forEach(a => {
    a.addEventListener('click', () => document.getElementById('navMid').classList.remove('open'));
});

// ─── REVEAL ON SCROLL ───────────────────────────────────
const io = new IntersectionObserver(entries => {
    entries.forEach(e => {
        if (e.isIntersecting) {
            e.target.classList.add('in');
            io.unobserve(e.target);
        }
    });
}, { threshold: 0.1, rootMargin: '0px 0px -50px 0px' });
document.querySelectorAll('[data-reveal]').forEach(el => io.observe(el));

// ─── FAQ ACCORDION ──────────────────────────────────────
document.querySelectorAll('.faq-q').forEach(q => {
    q.addEventListener('click', () => {
        const item = q.closest('.faq-item');
        const was = item.classList.contains('open');
        document.querySelectorAll('.faq-item').forEach(i => i.classList.remove('open'));
        if (!was) item.classList.add('open');
    });
});

// ─── ANIMATED COUNTERS ──────────────────────────────────
const counters = document.querySelectorAll('[data-count]');
const co = new IntersectionObserver(entries => {
    entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        const el = entry.target;
        const target = parseInt(el.dataset.count, 10);
        const suffix = el.dataset.suffix || '';
        const duration = 1800;
        const start = performance.now();
        const animate = now => {
            const elapsed = now - start;
            const p = Math.min(elapsed / duration, 1);
            const eased = 1 - Math.pow(1 - p, 3);
            el.textContent = Math.floor(eased * target).toLocaleString('he-IL') + suffix;
            if (p < 1) requestAnimationFrame(animate);
            else el.textContent = target.toLocaleString('he-IL') + suffix;
        };
        requestAnimationFrame(animate);
        co.unobserve(el);
    });
}, { threshold: 0.4 });
counters.forEach(c => co.observe(c));

// ─── CONTACT FORM → WHATSAPP + TRACKER ──────────────────
window.sendToWA = function (ev) {
    ev.preventDefault();
    const f = ev.target;
    const get = n => (f.elements[n] && f.elements[n].value || '').trim();
    const data = {
        name:     get('name'),
        phone:    get('phone'),
        occasion: get('occasion'),
        fabric:   get('fabric'),
        when:     get('when'),
        area:     get('area'),
        message:  get('message')
    };
    if (window.WATrack) {
        window.WATrack.send({
            button: 'contact-form',
            trigger: 'form-submit',
            wa_number: '972542758352',
            form: data
        });
    }
    const lines = [
        'שלום יהודה, מעוניין/ת לתאם פגישה', '',
        '👤 שם: ' + data.name,
        '📞 טלפון: ' + data.phone,
        data.occasion ? '🎩 אירוע: ' + data.occasion : '',
        data.fabric   ? '✂ בד מועדף: ' + data.fabric : '',
        data.when     ? '📅 מתי: ' + data.when : '',
        data.area     ? '📍 אזור: ' + data.area : '',
        data.message  ? '\n📝 פרטים:\n' + data.message : ''
    ].filter(Boolean);
    window.open('https://wa.me/972542758352?text=' + encodeURIComponent(lines.join('\n')), '_blank');
    return false;
};
