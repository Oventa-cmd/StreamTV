/* =====================================================================
   StreamTV – Browser-Version (iPad, Laptop)
   Läuft nur, wenn die Seite NICHT in der TV-App steckt (dort gibt es window.StreamTVApp).
   - Xtream-API, EPG und M3U-Listen über die Supabase-Funktion „xtream-proxy“
     (Safari blockiert sie sonst: CORS, IPTV-Kennung). Nur mit Watchlist-Anmeldung.
   - Videos laufen direkt zum Anbieter; auf iPad/Safari mit dem eingebauten HLS-Player.
   - Fortschritt, Favoriten usw. kommen wie auf dem TV über den Cloud-Sync (sync.js).
   ===================================================================== */
const WEBX = window.StreamTVApp ? null : (() => {
  document.documentElement.classList.add('web');
  const ua = navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const touch = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
  if (iOS) document.documentElement.classList.add('ios');
  if (touch) document.documentElement.classList.add('touch');
  const probe = document.createElement('video');
  const nativeHls = !!probe.canPlayType('application/vnd.apple.mpegurl');

  // Diese Dienste erlauben Browser-Zugriffe selbst – alles andere (IPTV-Anbieter) über den Proxy
  const DIRECT = /(^|\.)(supabase\.co|themoviedb\.org|tmdb\.org|theintrodb\.org|github\.com|githubusercontent\.com|openligadb\.de|thesportsdb\.com|jolpi\.ca|pulselive\.com|mux\.dev)$/i;
  const PROXY = '/functions/v1/relay';

  const direct = request;   // aus tmdb.js
  async function viaProxy(url, opts) {
    if (!ACC.connected) throw new Error('Bitte zuerst anmelden.');
    if (!await ACC.ensureToken()) throw new Error('Anmeldung abgelaufen – bitte neu anmelden.');
    // Zieladresse (mit Benutzer/Passwort) nur im verschlüsselten Inhalt, nie in der URL
    const r = await direct('POST', WL.URL + PROXY, {
      headers: { apikey: ACC.KEY, Authorization: 'Bearer ' + ACC.s.access, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
      timeout: opts.timeout || 90000
    });
    if (r.status === 401 && /Anmeldung/.test(r.text)) throw new Error('Anmeldung abgelaufen – bitte neu anmelden.');
    return r;
  }
  // request() aus tmdb.js ersetzen: gleiche Schnittstelle, Anbieter-Adressen über den Proxy
  request = function (method, url, opts = {}) {
    let host = '';
    try { host = new URL(url, location.href).hostname; } catch (e) {}
    if (method !== 'GET' || !host || DIRECT.test(host) || host === location.hostname) return direct(method, url, opts);
    return viaProxy(url, opts);
  };

  /** Live-Sender des Anbieters: im Browser immer als HLS (.m3u8) abrufen. */
  function streamUrl(url) {
    clearBar();
    return String(url).replace(/(\/live\/[^/]+\/[^/]+\/\d+)\.ts(\?|$)/i, '$1.m3u8$2');
  }
  // Safari (iPad/iPhone/Mac) kann kein MKV/AVI – Chrome & Co. meist schon (MKV)
  const webkitOnly = iOS || (nativeHls && /Safari/.test(ua) && !/Chrome|Chromium|Edg|OPR|Firefox/.test(ua));
  /** Reihenfolge der Abspiel-Wege im Browser. alt-xyz = dieselbe Folge als .xyz beim Anbieter anfragen. */
  function engines(u) {
    if (u.endsWith('.m3u8')) return nativeHls ? ['native', 'hls'] : ['hls', 'native'];
    if (/\.(mkv|avi)$/.test(u)) return webkitOnly ? ['alt-m3u8', 'alt-mp4'] : ['native', 'alt-m3u8', 'hls', 'alt-mp4'];
    if (/\.(mp4|m4v|mov|webm)$/.test(u)) return ['native'];
    return null;
  }
  const alt = (url, ext) => String(url).replace(/\.(mkv|avi)(\?|$)/i, '.' + ext + '$2');

  /* ---------- Fallback: externer Player (VLC / Infuse) ---------- */
  function clearBar() { const b = document.getElementById('extBar'); if (b) b.remove(); }
  function showBar(url) {
    clearBar();
    const p = document.getElementById('player');
    if (!p) return;
    const u = encodeURIComponent(url);
    const btns = iOS
      ? `<a class="btn" href="vlc-x-callback://x-callback-url/stream?url=${u}">In VLC öffnen</a>
         <a class="btn" href="infuse://x-callback-url/play?url=${u}">In Infuse öffnen</a>`
      : `<button class="btn" type="button" data-copy>Link für VLC kopieren</button>`;
    p.insertAdjacentHTML('beforeend', `<div id="extBar">${btns}<button class="btn" type="button" data-retry>Erneut versuchen</button></div>`);
    const bar = document.getElementById('extBar');
    bar.addEventListener('click', e => {
      e.stopPropagation();
      if (e.target.closest('[data-retry]')) { clearBar(); try { retryNow(); } catch (x) {} }
      if (e.target.closest('[data-copy]')) {
        try { navigator.clipboard.writeText(url).then(() => toast('Link kopiert – in VLC: Medien → Netzwerkstream öffnen')); } catch (x) {}
      }
    });
  }
  function failHint(url) {
    const u = String(url).split('?')[0].toLowerCase();
    if (/\.(mkv|avi)$/.test(u)) {
      showBar(url);
      return webkitOnly
        ? 'MKV kann Safari nicht abspielen, und der Anbieter bietet keine andere Variante an'
        : 'Dieses Format kann der Browser nicht abspielen';
    }
    if (location.protocol === 'https:' && /^http:/i.test(url)) return 'Unverschlüsselter Stream (http) wird vom Browser blockiert';
    return '';
  }
  function fullscreen() {
    const v = $('#video'), p = $('#player');
    try {
      if (document.fullscreenElement || document.webkitFullscreenElement) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      else if (p.requestFullscreen) p.requestFullscreen();
      else if (p.webkitRequestFullscreen) p.webkitRequestFullscreen();
      else if (v.webkitEnterFullscreen) v.webkitEnterFullscreen();   // iPhone
    } catch (e) {}
  }

  /* ---------- Bedienelemente für Maus & Touch ---------- */
  function setupUi() {
    // Serien-/Film-Player: Schließen + Vollbild oben rechts
    const top = $('#vosd .v-top');
    if (top && !$('#vClose')) {
      top.insertAdjacentHTML('beforeend',
        `<button class="vb web-fs" data-vb="fs" type="button" tabindex="-1" aria-label="Vollbild"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M4 4h6v2H6v4H4zm10 0h6v6h-2V6h-4zM4 14h2v4h4v2H4zm14 0h2v6h-6v-2h4z"/></svg></button>
         <button class="vb" data-vb="close" type="button" tabindex="-1" id="vClose" aria-label="Schließen"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12 19 17.6 17.6 19 12 13.4 6.4 19 5 17.6 10.6 12 5 6.4z"/></svg></button>`);
    }
    // Hinweis in den Einstellungen, solange die Watchlist fehlt
    const set = $('#view-settings .settings');
    if (set && !$('#webNote')) {
      set.querySelector('.large-title').insertAdjacentHTML('afterend',
        `<div class="web-note" id="webNote"><b>Browser-Version</b><span>Füge unter „Meine Quellen“ deinen Xtream-Zugang hinzu – er wird verschlüsselt in deinem Konto gespeichert und steht danach auf allen Geräten bereit.</span></div>`);
    }
    const note = () => { const n = $('#webNote'); if (n) n.classList.toggle('hidden', (state.sources || []).length > 0); };
    note(); setInterval(note, 3000);
    // iPad/Safari: Ton-Wiedergabe braucht manchmal ein Antippen – dann nicht als Fehler werten
    if (typeof safePlay === 'function') {
      safePlay = function (p) {
        try {
          const r = p.play();
          if (r && r.catch) r.catch(e => {
            if (e && e.name === 'NotAllowedError') { clearTimeout(startTimer); setStatus('▶ Zum Abspielen tippen'); }
          });
        } catch (e) {}
      };
    }
    // App wieder im Vordergrund (iPad): sofort abgleichen
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') { try { SYNC.run(true); } catch (e) {} }
      else { try { SYNC.run(false); } catch (e) {} }
    });
    // Beim Schließen des Tabs eigenen Fortschritt noch hochladen
    addEventListener('pagehide', () => { try { SYNC.run(false); } catch (e) {} });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(setupUi, 0));
  else setTimeout(setupUi, 0);

  return { iOS, touch, nativeHls, webkitOnly, streamUrl, engines, alt, failHint, fullscreen };
})();
window.WEBX = WEBX;
