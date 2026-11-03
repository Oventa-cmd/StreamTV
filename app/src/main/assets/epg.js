/* =====================================================================
   StreamTV – Programmdaten (EPG) der Xtream-Quellen
   get_short_epg pro Sender, nur für sichtbare Sender, mit Cache.
   ===================================================================== */
const EPG = {
  STORE: 'streamtv.epg',
  TTL: 30 * 60 * 1000,       // spätestens nach 30 Min. neu laden
  MAX: 400,                  // Sender im Cache
  PAR: 3,                    // gleichzeitige Anfragen
  d: null,                   // chId -> { at, list: [{ t, s, e }] }
  queue: [], busy: 0, pending: new Set(), listeners: [],

  load() {
    try { this.d = JSON.parse(localStorage.getItem(this.STORE) || '{}'); } catch (e) { this.d = {}; }
    const now = Date.now() / 1000;
    for (const k in this.d) {
      const c = this.d[k];
      c.list = (c.list || []).filter(p => p.e > now);
      if (!c.list.length && Date.now() - c.at > this.TTL) delete this.d[k];
    }
  },
  save() {
    const keys = Object.keys(this.d);
    if (keys.length > this.MAX) keys.sort((a, b) => this.d[a].at - this.d[b].at).slice(0, keys.length - this.MAX).forEach(k => delete this.d[k]);
    try { localStorage.setItem(this.STORE, JSON.stringify(this.d)); } catch (e) {}
  },
  saveSoon() { clearTimeout(this.st); this.st = setTimeout(() => this.save(), 2000); },
  onUpdate(fn) { this.listeners.push(fn); },

  /** Xtream-Zugang und stream_id eines Senders – auch für M3U-Links im Xtream-Format. */
  ref(ch) {
    if (!ch || !ch.url) return null;
    const m = ch.url.match(/^(https?:\/\/[^/?#]+)\/(?:live\/)?([^/?#]+)\/([^/?#]+)\/(\d+)(?:\.\w+)?(?:[?#].*)?$/i);
    if (!m) return null;
    let user;
    try { user = decodeURIComponent(m[2]); } catch (e) { user = m[2]; }
    const acc = XS.accounts().find(a => a.key === normServer(m[1]) + '|' + user);
    return acc ? { acc, sid: m[4] } : null;
  },
  b64(s) {
    if (!s) return '';
    try {
      const bin = atob(String(s));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder('utf-8').decode(bytes).trim();
    } catch (e) { return String(s); }   // manche Panels liefern Klartext
  },
  ts(v, str) {
    const n = Number(v);
    if (n > 1e9) return n;
    const t = Date.parse(String(str || '').replace(' ', 'T'));
    return isNaN(t) ? 0 : Math.floor(t / 1000);
  },

  /** Aktuelle und nächste Sendung (aus dem Cache, ohne Netz). */
  now(chId) {
    const c = this.d && this.d[chId];
    if (!c) return null;
    const t = Date.now() / 1000;
    const i = c.list.findIndex(p => p.e > t);
    if (i < 0) return null;
    const cur = c.list[i].s <= t ? c.list[i] : null;
    return { cur, next: cur ? c.list[i + 1] || null : c.list[i] };
  },
  fresh(chId) {
    const c = this.d[chId];
    if (!c) return false;
    const n = this.now(chId);
    return Date.now() - c.at < this.TTL && (!c.list.length || (n && n.cur));
  },

  /** Programmdaten anfordern (wenn nicht frisch im Cache). */
  want(ch, prio) {
    if (!ch || this.pending.has(ch.id) || this.fresh(ch.id)) return;
    const r = this.ref(ch);
    if (!r) return;
    this.pending.add(ch.id);
    const job = { ch, r };
    prio ? this.queue.unshift(job) : this.queue.push(job);
    this.pump();
  },
  pump() {
    while (this.busy < this.PAR && this.queue.length) {
      const { ch, r } = this.queue.shift();
      this.busy++;
      this.fetch(r).then(list => {
        this.d[ch.id] = { at: Date.now(), list };
      }).catch(() => {
        this.d[ch.id] = { at: Date.now(), list: [] };   // keine EPG-Daten → nicht ständig neu fragen
      }).then(() => {
        this.busy--; this.pending.delete(ch.id);
        this.saveSoon();
        this.listeners.forEach(fn => { try { fn(ch.id); } catch (e) {} });
        this.pump();
      });
    }
  },
  async fetch({ acc, sid }) {
    const r = await request('GET', XS.api(acc, 'get_short_epg', `&stream_id=${encodeURIComponent(sid)}&limit=4`), { timeout: 15000 });
    if (r.status < 200 || r.status > 299) throw new Error('HTTP ' + r.status);
    const j = JSON.parse(r.text);
    const raw = (j && (j.epg_listings || j.listings)) || [];
    const now = Date.now() / 1000;
    return raw.map(p => ({
      t: this.b64(p.title) || 'Sendung',
      s: this.ts(p.start_timestamp, p.start),
      e: this.ts(p.stop_timestamp || p.end_timestamp, p.end || p.stop)
    })).filter(p => p.s && p.e > now).sort((a, b) => a.s - b.s).slice(0, 4);
  },

  /** Sichtbare Senderkacheln vormerken. */
  scan() {
    clearTimeout(this.scanT);
    this.scanT = setTimeout(() => {
      const H = window.innerHeight, W = window.innerWidth, seen = new Set();
      for (const el of document.querySelectorAll('[data-card]')) {
        const id = el.dataset.card;
        if (seen.has(id)) continue;
        const b = el.getBoundingClientRect();
        if (!b.width || b.bottom < -100 || b.top > H * 2 || b.right < -100 || b.left > W + 600) continue;
        seen.add(id);
        this.want(byId(id));
      }
    }, 250);
  }
};
const hhmm = s => new Date(s * 1000).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
