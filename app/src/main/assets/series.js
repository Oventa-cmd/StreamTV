/* =====================================================================
   StreamTV – Serienkatalog des IPTV-Anbieters (Xtream Codes)
   Sucht eine TMDB-Serie im Serienangebot der eigenen Xtream-Quellen.
   ===================================================================== */
const XS = {
  TTL: 6 * 3600 * 1000,
  cat_: {},        // accKey -> { at, list, cats }
  info_: {},       // accKey:sid -> Serien-Infos
  STOP: new Set(['der', 'die', 'das', 'the', 'a', 'an', 'and', 'und', 'of', 'von', 'le', 'la', 'el']),

  /** Alle Xtream-Zugänge (auch M3U-Links im get.php-Format). */
  accounts() {
    const out = [], seen = new Set();
    for (const s of state.sources) {
      let server, user, pass;
      if (s.type === 'xtream') ({ server, user, pass } = s);
      else if (s.type === 'm3u') { const l = parseXtreamLink(s.url || ''); if (!l) continue; ({ server, user, pass } = l); }
      else continue;
      const base = normServer(server);
      const key = base + '|' + user;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, name: s.name, base, u: encodeURIComponent(user), p: encodeURIComponent(pass) });
    }
    return out;
  },
  api(acc, action, extra = '') {
    return `${acc.base}/player_api.php?username=${acc.u}&password=${acc.p}&action=${action}${extra}`;
  },

  norm(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss')
      // Anbieter-Präfixe wie „DE - “, „|DE| “, „[NF] “
      .replace(/^\s*((\||\[)[^|\]]{1,12}(\||\])\s*|(de|ger|en|eng|us|uk|tr|fr|it|es|nl|pl|at|ch|ar|multi|vod|nf|netflix|amz|amazon|prime|dsnp|disney|apple|4k|hd)\s*[-:|]\s+)+/, '')
      .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
      .replace(/\b(4k|uhd|fhd|hd|sd|hevc|multi|multisub|ger|german|deutsch|dubbed|subbed|(staffel|season|s)\s*\d{1,2})\b/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ').trim();
  },
  tokens(n) { return n.split(' ').filter(t => t && !this.STOP.has(t)); },
  yearOf(o) {
    const m = String(o.releaseDate || o.release_date || o.year || '').match(/(19|20)\d{2}/) || String(o.name || '').match(/\b(19|20)\d{2}\b/);
    return m ? m[0] : '';
  },

  async catalog(acc, force) {
    const c = this.cat_[acc.key];
    if (!force && c && Date.now() - c.at < this.TTL) return c;
    const [list, cats] = await Promise.all([
      getJSON(this.api(acc, 'get_series')),
      getJSON(this.api(acc, 'get_series_categories')).catch(() => [])
    ]);
    if (!Array.isArray(list)) throw new Error('Anbieter liefert keinen Serienkatalog');
    const names = new Map((Array.isArray(cats) ? cats : []).map(x => [String(x.category_id), x.category_name]));
    const items = list.map(o => {
      const n = this.norm(o.name);
      return {
        sid: o.series_id, name: o.name || 'Unbenannt', n, t: this.tokens(n), year: this.yearOf(o),
        tmdb: Number(o.tmdb || o.tmdb_id) || 0, cover: o.cover || '', cat: names.get(String(o.category_id)) || ''
      };
    });
    return (this.cat_[acc.key] = { at: Date.now(), list: items });
  },

  score(q, it) {
    if (!it.n) return 0;
    if (it.n === q.n) return 100;
    const nt = new Set(it.t);
    const inter = q.t.filter(t => nt.has(t)).length;
    if (!inter) return 0;
    const dice = 2 * inter / (q.t.length + nt.size);
    let s = 90 * dice;
    if (inter === q.t.length) s = Math.max(s, 68 + 22 * (inter / nt.size));
    return s;
  },

  /** Treffer für eine TMDB-Serie in allen Xtream-Quellen. */
  async find(p, d) {
    const accs = this.accounts();
    if (!accs.length) throw new Error('Keine Xtream-Quelle eingerichtet – unter „Einstellungen“ hinzufügen.');
    const titles = [...new Set([p.title, d && d.name, d && d.original_name].filter(Boolean))];
    const qs = titles.map(t => { const n = this.norm(t); return { n, t: this.tokens(n) }; }).filter(q => q.t.length);
    const year = p.year || (d && String(d.first_air_date || '').slice(0, 4)) || '';
    const errors = [], hits = [];
    await Promise.all(accs.map(async acc => {
      let cat;
      try { cat = await this.catalog(acc); } catch (e) { errors.push(`${acc.name}: ${e.message}`); return; }
      for (const it of cat.list) {
        let s = it.tmdb && it.tmdb === p.id ? 120 : 0;
        for (const q of qs) s = Math.max(s, this.score(q, it));
        if (s < 55) continue;
        if (year && it.year) s += Math.abs(Number(year) - Number(it.year)) <= 1 ? 8 : -12;
        if (s >= 55) hits.push({ acc, it, s });
      }
    }));
    hits.sort((a, b) => b.s - a.s || a.it.name.length - b.it.name.length);
    if (!hits.length && errors.length) throw new Error(errors.join(' · '));
    return hits.slice(0, 20);
  },

  /** Staffeln & Folgen einer Katalog-Serie. */
  async info(acc, sid) {
    const k = acc.key + ':' + sid;
    if (this.info_[k]) return this.info_[k];
    const j = await getJSON(this.api(acc, 'get_series_info', '&series_id=' + encodeURIComponent(sid)));
    let eps = j && j.episodes;
    if (Array.isArray(eps)) {   // manche Panels liefern eine flache Liste
      const m = {};
      for (const e of eps) (m[e.season || 1] = m[e.season || 1] || []).push(e);
      eps = m;
    }
    const seasons = Object.keys(eps || {}).map(Number).filter(n => !isNaN(n)).sort((a, b) => (a || 99) - (b || 99))
      .map(num => ({
        num,
        eps: (eps[num] || []).map((e, i) => ({
          id: String(e.id), num: Number(e.episode_num) || i + 1, season: num,
          title: this.epTitle(e.title, Number(e.episode_num) || i + 1),
          plot: (e.info && e.info.plot) || '',
          dur: (e.info && (Number(e.info.duration_secs) || this.secs(e.info.duration))) || 0,
          url: `${acc.base}/series/${acc.u}/${acc.p}/${e.id}.${e.container_extension || 'mp4'}`
        })).sort((a, b) => a.num - b.num)
      })).filter(s => s.eps.length);
    if (!seasons.length) throw new Error('Keine Folgen beim Anbieter gefunden');
    return (this.info_[k] = { seasons });
  },
  epTitle(t, n) {
    const s = String(t || '').replace(/^.*?S\d{1,2}\s*E\d{1,3}\s*[-–:|]?\s*/i, '').trim();
    return s && !/^(episode|folge|ep\.?)\s*\d+$/i.test(s) ? s : `Folge ${n}`;
  },
  secs(hms) {
    const m = String(hms || '').match(/^(\d+):(\d{2}):(\d{2})$/);
    return m ? m[1] * 3600 + m[2] * 60 + Number(m[3]) : 0;
  }
};

/* ---------------- Wiedergabe-Fortschritt (Folgen) ---------------- */
const VP = {
  STORE: 'streamtv.vodpos',
  s: null,
  all() { if (!this.s) { try { this.s = JSON.parse(localStorage.getItem(this.STORE) || '{}'); } catch (e) { this.s = {}; } } return this.s; },
  get(id) { return this.all()[id] || null; },
  set(id, pos, dur) {
    const s = this.all();
    s[id] = { pos: Math.floor(pos), dur: Math.floor(dur || 0), at: Date.now() };
    const keys = Object.keys(s);
    if (keys.length > 400) keys.sort((a, b) => s[a].at - s[b].at).slice(0, keys.length - 400).forEach(k => delete s[k]);
    try { localStorage.setItem(this.STORE, JSON.stringify(s)); } catch (e) {}
  },
  done(id) { const v = this.get(id); return !!(v && v.dur && v.pos >= v.dur - 90); }
};
const fmtTime = s => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};
