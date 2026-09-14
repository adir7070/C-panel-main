/*
 * wa-tracker.js — drop-in WhatsApp click tracker for client landing pages.
 *
 * Usage on a landing page:
 *   <script src="https://api.iconiqmedia.co.il/wa-tracker.js"
 *           data-client="0547203948"
 *           data-source="ceramica-landing"
 *           defer></script>
 *
 * Posts every <a href*="wa.me/..."> click (and window.open WA URLs) to
 * /api/leads/wa-click. WhatsApp still opens immediately — the beacon is
 * sent in the background and tolerates network failure.
 */
(function () {
  'use strict';
  var SELF = document.currentScript;
  var CFG = {
    endpoint: (SELF && SELF.dataset.endpoint) ||
              (SELF && new URL('./api/leads/wa-click', SELF.src).href),
    client:   (SELF && SELF.dataset.client)   || '',
    source:   (SELF && SELF.dataset.source)   || location.hostname,
  };

  function utm() {
    var q = new URLSearchParams(location.search), o = {};
    ['source','medium','campaign','term','content'].forEach(function (k) {
      var v = q.get('utm_' + k); if (v) o[k] = v;
    });
    return o;
  }

  function payload(extra) {
    var base = {
      client_id: CFG.client,
      source:    CFG.source,
      page_url:  location.href,
      referrer:  document.referrer || null,
      utm:       utm(),
      user_agent: navigator.userAgent,
      ts:        new Date().toISOString(),
    };
    if (extra) for (var k in extra) base[k] = extra[k];
    return base;
  }

  function send(data) {
    try {
      var blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
      if (navigator.sendBeacon && navigator.sendBeacon(CFG.endpoint, blob)) return;
    } catch (e) {}
    fetch(CFG.endpoint, {
      method: 'POST', keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }).catch(function () {});
  }

  function parseWa(href) {
    var m = /wa\.me\/(\d+)/.exec(href || '');
    return m ? m[1] : null;
  }

  document.addEventListener('click', function (ev) {
    var a = ev.target && ev.target.closest && ev.target.closest('a[href*="wa.me"]');
    if (!a) return;
    var wa = parseWa(a.getAttribute('href'));
    if (!wa) return;
    send(payload({
      wa_number: wa,
      button: a.dataset.waButton || (a.textContent || '').trim().slice(0, 40) || 'link',
      trigger: 'click',
    }));
  }, true);

  // Optional public API for form integrations: WATrack.send({ form: {...} })
  window.WATrack = { send: function (extra) { send(payload(extra || {})); } };

  // Catch window.open(wa.me/...) calls too
  var _open = window.open;
  window.open = function (url) {
    var wa = parseWa(url);
    if (wa) send(payload({ wa_number: wa, button: 'window.open', trigger: 'open' }));
    return _open.apply(window, arguments);
  };
})();
