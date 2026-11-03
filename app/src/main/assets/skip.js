/* =====================================================================
   StreamTV – Intro, Rückblick und Abspann erkennen
   1. TheIntroDB (Community-Datenbank, per TMDB-ID, Staffel, Folge, Laufzeit)
   2. Selbst gelernt pro Serie (wo der Nutzer vorspult / zur nächsten Folge springt)
   3. Faustregel als Rückfall
   ===================================================================== */
const SK = {
  STORE: 'streamtv.skip',
  API: 'https://api.theintrodb.org/v3/media',
  TTL: 7 * 864e5,          // Treffer 7 Tage merken
  NEG: 864e5,              // „nichts gefunden“ 1 Tag merken
  SETTLE: 20000,           // so lange nach dem Spulen weiterschauen, damit es als „Intro übersprungen“ zählt
  MIN_INTRO_OBS: 2,        // gelerntes Intro erst ab 2 übereinstimmenden Beobachtungen
  d: null,

  all() {
    if (!this.d) {
      try { this.d = JSON.parse(localStorage.getItem(this.STORE) || '{}'); } catch (e) { this.d = {}; }
      this.d.db = this.d.db || {};
      this.d.learn = this.d.learn || {};
    }
    return this.d;
  },
  save() {
    const d = this.all(), ks = Object.keys(d.db);
    if (ks.length > 600) ks.sort((a, b) => d.db[a].at - d.db[b].at).slice(0, ks.length - 600).forEach(k => delete d.db[k]);
    try { localStorage.setItem(this.STORE, JSON.stringify(d)); } catch (e) {}
  },

  /* ---------- 1. TheIntroDB ---------- */
  seg(list) {
    const x = Array.isArray(list) && list[0];
    if (!x) return null;
    const s = x.start_ms == null ? 0 : Number(x.start_ms) / 1000;
    const e = x.end_ms == null ? null : Number(x.end_ms) / 1000;
    if (!isFinite(s) || (e != null && e <= s)) return null;
    return { s, e };
  },
  async fromDb(type, id, season, num, dur) {
    if (!(id > 0)) return null;
    const key = type === 'movie' ? `movie:${id}` : `tv:${id}:${season}:${num}`;
    const c = this.all().db[key];
    if (c && Date.now() - c.at < (c.r ? this.TTL : this.NEG)) return c.r;
    let q = `${this.API}?tmdb_id=${id}`;
    if (type !== 'movie') q += `&season=${season}&episode=${num}`;
    if (dur > 0) q += `&duration_ms=${Math.round(dur * 1000)}`;
    let r = null;
    try {
      const x = await request('GET', q, { timeout: 6000 });
      if (x.status === 200) {
        const j = JSON.parse(x.text);
        r = { intro: this.seg(j.intro), recap: this.seg(j.recap), credits: this.seg(j.credits) };
        if (!r.intro && !r.recap && !r.credits) r = null;
      } else if (x.status !== 404) return null;   // vorübergehender Fehler → nicht merken
    } catch (e) { return null; }
    this.all().db[key] = { at: Date.now(), r };
    this.save();
    return r;
  },

  /* ---------- 2. Gelernt ---------- */
  med(a) { const b = a.slice().sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; },
  learned(key) {
    const L = key && this.all().learn[key];
    if (!L) return { intro: null, outro: null };
    let intro = null;
    const ii = L.intro || [];
    if (ii.length >= this.MIN_INTRO_OBS) {
      const e = this.med(ii.map(x => x.e)), s = this.med(ii.map(x => x.s));
      const agree = ii.filter(x => Math.abs(x.e - e) <= 25).length;
      if (agree >= this.MIN_INTRO_OBS) intro = { s, e };
    }
    const oo = L.outro || [];
    return { intro, outro: oo.length ? this.med(oo) : null };
  },
  note(key, kind, val) {
    if (!key) return;
    const d = this.all(), L = d.learn[key] = d.learn[key] || {};
    L[kind] = (L[kind] || []).concat([val]).slice(-6);
    L.at = Date.now();
    const ks = Object.keys(d.learn);
    if (ks.length > 300) ks.sort((a, b) => (d.learn[a].at || 0) - (d.learn[b].at || 0)).slice(0, ks.length - 300).forEach(k => delete d.learn[k]);
    this.save();
  },
  learnIntro(key, s, e) { this.note(key, 'intro', { s: Math.round(s), e: Math.round(e) }); },
  learnOutro(key, offset) { this.note(key, 'outro', Math.round(offset)); }
};
