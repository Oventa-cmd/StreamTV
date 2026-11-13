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
  const PROXY = '/functions/v1/xtream-proxy';

  const direct = request;   // aus tmdb.js
  async function viaProxy(url, opts) {
    if (!WL.connected) throw new Error('Für die Web-Version zuerst unter Einstellungen mit dem Watchlist-Konto anmelden.');
    if (!await WL.ensureToken()) throw new Error('Watchlist-Anmeldung abgelaufen – bitte neu anmelden.');
    // Zieladresse (mit Benutzer/Passwort) nur im verschlüsselten Inhalt, nie in der URL
    const r = await direct('POST', WL.URL + PROXY, {
      headers: { apikey: WL.KEY, Authorization: 'Bearer ' + WL.s.access, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
      timeout: opts.timeout || 90000
    });
    if (r.status === 401 && /Watchlist/.test(r.text)) throw new Error('Watchlist-Anmeldung abgelaufen – bitte neu anmelden.');
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
    return String(url).replace(/(\/live\/[^/]+\/[^/]+\/\d+)\.ts(\?|$)/i, '$1.m3u8$2');
  }
  /** Reihenfolge der Abspiel-Wege im Browser. */
  function engines(u) {
    if (u.endsWith('.m3u8')) return nativeHls ? ['native', 'hls'] : ['hls', 'native'];
    if (/\.(mp4|m4v|mov|mkv|webm|avi)$/.test(u)) return ['native'];
    return null;
  }
  function failHint(url) {
    const u = String(url).split('?')[0].toLowerCase();
    if (/\.(mkv|avi)$/.test(u)) return iOS
      ? 'Dieses Format (MKV/AVI) kann Safari nicht abspielen – auf dem TV oder in VLC ansehen'
      : 'Dieses Format kann der Browser evtl. nicht abspielen – auf dem TV oder in VLC ansehen';
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
        `<div class="web-note" id="webNote"><b>Browser-Version</b><span>Melde dich unten bei „Serien-Empfehlungen“ mit deinem Watchlist-Konto an und füge danach deinen Xtream-Zugang hinzu. Fortschritt und Favoriten kommen automatisch vom Fernseher.</span></div>`);
    }
    const note = () => { const n = $('#webNote'); if (n) n.classList.toggle('hidden', WL.connected && (state.sources || []).length > 0); };
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

  return { iOS, touch, nativeHls, streamUrl, engines, failHint, fullscreen };
})();
window.WEBX = WEBX;
