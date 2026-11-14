/* =====================================================================
   StreamTV – Statistik (was, wie lange, wann geschaut)
   Gespeichert pro Gerät und Tag; über das StreamTV-Konto synchronisiert (sync.js),
   jedes Gerät schreibt nur seinen eigenen Teil, angezeigt wird die Summe.
   ===================================================================== */
const ST = {
  STORE: 'streamtv.stats',
  DEV: 'streamtv.devid',
  DAYS_MAX: 800,
  d: null,
  pend: { t: {}, e: {}, h: {} },   // noch nicht gespeicherte Sekunden: key -> s, Folgen: key -> n, Stunde: "Tag|h" -> s
  meta: {},
  lastTick: 0,
  lastPos: -1,
  savedAt: 0,

  dev() {
    let id = null;
    try { id = localStorage.getItem(this.DEV); } catch (e) {}
    if (!id) { id = 'd' + Math.random().toString(36).slice(2, 10); try { localStorage.setItem(this.DEV, id); } catch (e) {} }
    return id;
  },
  load() {
    if (!this.d) {
      try { this.d = JSON.parse(localStorage.getItem(this.STORE) || '{}'); } catch (e) { this.d = {}; }
      this.d.dev = this.d.dev || {};
      this.d.meta = this.d.meta || {};
    }
    return this.d;
  },
  day(ts) { const t = new Date(ts || Date.now()); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`; },

  /** Was läuft gerade? → { key, k: 's'|'m'|'l', n, tm, img } */
  current() {
    try {
      if (vod) {
        const c = vod.ctx || {}, movie = !!vod.ep.movie, name = c.name || vod.show || '';
        const tm = c.tmdb ? String(c.tmdb) : '';
        const key = tm || (movie ? 'f:' : 's:') + String(name).toLowerCase().replace(/\s+/g, ' ').trim();
        const d = tm && TM.details_[tm];
        return { key, k: movie ? 'm' : 's', n: name, tm, p: (d && d.poster_path) || null, bd: (d && d.backdrop_path) || null, img: c.img || '' };
      }
      if (currentId) {
        const ch = byId(currentId);
        if (ch) return { key: 'l:' + ch.name, k: 'l', n: ch.name, img: ch.logo || '' };
      }
    } catch (e) {}
    return null;
  },
  tick() {
    const now = Date.now(), dt = Math.min(15000, now - (this.lastTick || now));
    this.lastTick = now;
    if (!playerOpen || video.paused || document.hidden || (typeof SLEEP !== 'undefined' && SLEEP.on)) { this.lastPos = -1; return; }
    const pos = video.currentTime || 0;
    const moved = this.lastPos < 0 || Math.abs(pos - this.lastPos) > 0.5;   // hängt der Stream, zählt es nicht
    this.lastPos = pos;
    if (!moved || dt < 1000) return;
    const c = this.current();
    if (!c) return;
    const s = dt / 1000, hk = this.day(now) + '|' + new Date(now).getHours();
    this.pend.t[c.key] = (this.pend.t[c.key] || 0) + s;
    this.pend.h[hk] = (this.pend.h[hk] || 0) + s;
    this.note(c);
    if (now - this.savedAt > 60000) this.flush();
  },
  note(c) {
    const m = this.meta[c.key] || {};
    this.meta[c.key] = { n: c.n || m.n, k: c.k, tm: c.tm || m.tm || '', p: c.p || m.p || null, bd: c.bd || m.bd || null, img: c.img || m.img || '' };
  },
  /** Folge/Film zu Ende geschaut (ab 90 %). */
  done(v) {
    if (!v) return;
    const c = this.current();
    if (!c || c.k === 'l') return;
    this.pend.e[c.key] = (this.pend.e[c.key] || 0) + 1;
    this.note(c);
    this.flush();
  },
  /** Ausstehendes in den Speicher schreiben (frisch gelesen – der Sync kann zwischendurch zusammengeführt haben). */
  flush() {
    const P = this.pend;
    if (!Object.keys(P.t).length && !Object.keys(P.e).length && !Object.keys(P.h).length && !Object.keys(this.meta).length) return;
    this.d = null;
    const d = this.load(), me = this.dev(), B = d.dev[me] = d.dev[me] || { days: {} }, today = this.day();
    const D = k => (B.days[k] = B.days[k] || { t: {}, e: {}, h: [] });
    for (const k in P.t) { const x = D(today); x.t[k] = Math.round((x.t[k] || 0) + P.t[k]); }
    for (const k in P.e) { const x = D(today); x.e[k] = (x.e[k] || 0) + P.e[k]; }
    for (const hk in P.h) {
      const [day, h] = hk.split('|'), x = D(day);
      while (x.h.length < 24) x.h.push(0);
      x.h[Number(h)] = Math.round(x.h[Number(h)] + P.h[hk]);
    }
    for (const k in this.meta) d.meta[k] = Object.assign({}, d.meta[k] || {}, Object.fromEntries(Object.entries(this.meta[k]).filter(([, v]) => v)));
    const ks = Object.keys(B.days).sort();
    if (ks.length > this.DAYS_MAX) ks.slice(0, ks.length - this.DAYS_MAX).forEach(k => delete B.days[k]);
    B.at = Date.now();
    this.pend = { t: {}, e: {}, h: {} }; this.meta = {};
    this.savedAt = Date.now();
    try { localStorage.setItem(this.STORE, JSON.stringify(d)); } catch (e) {}
  },

  /** Summe aller Geräte für Tage in [from, to] (Tagesschlüssel "JJJJ-MM-TT"). */
  sum(from, to) {
    this.flush();
    const d = this.load(), out = { t: {}, e: {}, h: new Array(24).fill(0), byDay: {} };
    for (const id in d.dev) {
      const days = (d.dev[id] || {}).days || {};
      for (const day in days) {
        if (day < from || day > to) continue;
        const x = days[day];
        let tot = 0;
        for (const k in x.t || {}) { out.t[k] = (out.t[k] || 0) + x.t[k]; tot += x.t[k]; }
        for (const k in x.e || {}) out.e[k] = (out.e[k] || 0) + x.e[k];
        (x.h || []).forEach((v, i) => { out.h[i] += v || 0; });
        out.byDay[day] = (out.byDay[day] || 0) + tot;
      }
    }
    return out;
  },
  firstDay() {
    const d = this.load();
    let f = this.day();
    for (const id in d.dev) for (const day in (d.dev[id] || {}).days || {}) if (day < f) f = day;
    return f;
  }
};
setInterval(() => ST.tick(), 10000);
document.addEventListener('visibilitychange', () => { if (document.hidden) ST.flush(); });
window.addEventListener('pagehide', () => ST.flush());
