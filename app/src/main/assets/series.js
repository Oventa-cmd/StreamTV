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

  /** Katalog eines Zugangs – kind: 'series' (Serien) oder 'vod' (Filme). Nur im Speicher (kann sehr groß sein). */
  async catalog(acc, force, kind = 'series') {
    const ck = kind + '|' + acc.key, c = this.cat_[ck];
    if (!force && c && Date.now() - c.at < this.TTL) return c;
    const vod = kind === 'vod';
    const [list, cats] = await Promise.all([
      getJSON(this.api(acc, vod ? 'get_vod_streams' : 'get_series')),
      getJSON(this.api(acc, vod ? 'get_vod_categories' : 'get_series_categories')).catch(() => [])
    ]);
    if (!Array.isArray(list)) throw new Error(vod ? 'Anbieter bietet keine Filme (VOD) an' : 'Anbieter liefert keinen Serienkatalog');
    const names = new Map((Array.isArray(cats) ? cats : []).map(x => [String(x.category_id), x.category_name]));
    const items = list.map(o => {
      const n = this.norm(o.name);
      return {
        sid: vod ? o.stream_id : o.series_id, name: o.name || 'Unbenannt', n, t: this.tokens(n), year: this.yearOf(o),
        tmdb: Number(o.tmdb || o.tmdb_id) || 0, cover: (vod ? o.stream_icon : o.cover) || '', cat: names.get(String(o.category_id)) || '',
        ext: vod ? (o.container_extension || 'mp4') : ''
      };
    });
    const order = (Array.isArray(cats) ? cats : []).map(x => x.category_name).filter(Boolean);
    return (this.cat_[ck] = { at: Date.now(), list: items, cats: order });
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

  /** Treffer für eine TMDB-Serie (bzw. einen Film) in allen Xtream-Quellen. */
  async find(p, d) {
    const kind = p.type === 'movie' ? 'vod' : 'series';
    const accs = this.accounts();
    if (!accs.length) throw new Error('Keine Xtream-Quelle eingerichtet – unter „Einstellungen“ hinzufügen.');
    const titles = [...new Set([p.title, d && (d.name || d.title), d && (d.original_name || d.original_title)].filter(Boolean))];
    const qs = titles.map(t => { const n = this.norm(t); return { n, t: this.tokens(n) }; }).filter(q => q.t.length);
    const year = p.year || (d && String(d.first_air_date || d.release_date || '').slice(0, 4)) || '';
    const errors = [], hits = [];
    let total = 0;
    await Promise.all(accs.map(async acc => {
      let cat;
      try { cat = await this.catalog(acc, false, kind); } catch (e) { errors.push(`${acc.name}: ${e.message}`); return; }
      total += cat.list.length;
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
    if (!total) throw new Error(kind === 'vod' ? 'Dein Anbieter bietet keine Filme (VOD) an.' : 'Dein Anbieter bietet keine Serien an.');
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
  /** Ein Film als „Folgenliste“ mit einem Eintrag – gleicher Player, gleiches Fortsetzen. */
  async movie(acc, it) {
    const k = acc.key + ':m' + it.sid;
    if (this.info_[k]) return this.info_[k];
    let inf = {}, ext = it.ext;
    try {
      const j = await getJSON(this.api(acc, 'get_vod_info', '&vod_id=' + encodeURIComponent(it.sid)));
      inf = (j && j.info) || {};
      if (j && j.movie_data && j.movie_data.container_extension) ext = j.movie_data.container_extension;
    } catch (e) {}   // Infos sind optional – abspielen geht auch ohne
    const ep = {
      id: 'm' + it.sid, num: 1, season: 0, movie: true, title: it.name,
      plot: inf.plot || inf.description || '',
      dur: Number(inf.duration_secs) || this.secs(inf.duration) || 0,
      url: `${acc.base}/movie/${acc.u}/${acc.p}/${it.sid}.${ext || 'mp4'}`
    };
    return (this.info_[k] = { movie: true, seasons: [{ num: 0, eps: [ep] }] });
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
  /** m = Metadaten für „Weiterschauen“: { show, season, num, title, url, img, acc, sid, src } */
  set(id, pos, dur, m) {
    const s = this.all();
    const old = s[id];
    s[id] = { pos: Math.floor(pos), dur: Math.floor(dur || 0), at: Date.now() };
    if (m || (old && old.m)) s[id].m = m || Object.assign({}, old.m, { hidden: false });
    const keys = Object.keys(s);
    if (keys.length > 400) keys.sort((a, b) => s[a].at - s[b].at).slice(0, keys.length - 400).forEach(k => delete s[k]);
    this.save();
    this.share();
  },
  /** Weiterschauen-Liste an die App übergeben (für den TV-Launcher). */
  share() {
    clearTimeout(this.shareT);
    this.shareT = setTimeout(() => {
      try {
        const b = window.StreamTVApp;
        if (!b || typeof b.setContinue !== 'function') return;
        b.setContinue(JSON.stringify(this.continueList(20).map(v => ({
          id: v.id, show: v.m.show, season: v.m.season || 0, episode: v.m.num || 0, title: v.m.title || '', image: v.m.img || '',
          pos: v.pos, dur: v.dur, updated: v.at, tmdb: v.m.tmdb || '', movie: !!v.m.movie, uri: 'streamtv://resume/' + encodeURIComponent(v.id)
        }))));
      } catch (e) {}
    }, 800);
  },
  save() { try { localStorage.setItem(this.STORE, JSON.stringify(this.all())); } catch (e) {} },
  /** Gesehen = im Abspann angekommen (mind. 90 s, bei langen Titeln bis 150 s = 4 % vor Schluss). */
  done(id) { const v = this.get(id); return !!(v && v.dur && v.pos >= v.dur - Math.max(90, Math.min(150, v.dur * 0.04))); },
  /** Angefangene Folgen – pro Serie nur die zuletzt gesehene, neueste zuerst. */
  continueList(max = 15) {
    const s = this.all(), seen = new Set(), out = [];
    Object.keys(s).filter(id => s[id].m).sort((a, b) => s[b].at - s[a].at).forEach(id => {
      const v = s[id], k = v.m.acc + '|' + v.m.sid;
      if (seen.has(k)) return;
      seen.add(k);
      if (!v.m.hidden && v.pos > 30 && !this.done(id)) out.push(Object.assign({ id }, v));
    });
    return out.slice(0, max);
  },
  hide(id) { const v = this.get(id); if (v && v.m) { v.m.hidden = true; this.save(); this.share(); } }
};
const fmtTime = s => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};
