/* =====================================================================
   StreamTV – Serien-Empfehlungen (TMDB) & Serien-Watchlist
   Gleiches Konto und gleiche Logik wie im TV-Launcher.
   ===================================================================== */

// XHR statt fetch: läuft in der App ohne CORS-Beschränkung
function request(method, url, { headers = {}, body = null, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open(method, url, true);
    x.timeout = timeout;
    for (const k in headers) x.setRequestHeader(k, headers[k]);
    x.onload = () => resolve({ status: x.status, text: x.responseText });
    x.onerror = () => reject(new Error('Server nicht erreichbar'));
    x.ontimeout = () => reject(new Error('Zeitüberschreitung'));
    x.send(body);
  });
}

/* ---------------- Serien-Watchlist (Supabase) ---------------- */
const WL = {
  URL: 'https://rdaivvzpgnsfecwkrgyg.supabase.co',
  KEY: 'sb_publishable_yYxzES9mAW8Y2ZB_92rKgg_a0mycrXo',
  STORE: 'streamtv.wl',
  s: {},

  load() { try { this.s = JSON.parse(localStorage.getItem(this.STORE) || '{}'); } catch (e) { this.s = {}; } },
  save() { try { localStorage.setItem(this.STORE, JSON.stringify(this.s)); } catch (e) {} },
  get connected() { return !!this.s.refresh; },

  async http(method, path, body, auth = true) {
    const h = { apikey: this.KEY, 'Content-Type': 'application/json' };
    if (auth && this.s.access) h.Authorization = 'Bearer ' + this.s.access;
    if (method === 'UPSERT') h.Prefer = 'resolution=merge-duplicates,return=minimal';
    return request(method === 'UPSERT' ? 'POST' : method, this.URL + path,
      { headers: h, body: body ? JSON.stringify(body) : null, timeout: 12000 });
  },
  storeSession(j) {
    this.s.access = j.access_token;
    this.s.until = Date.now() + ((j.expires_in || 3600) - 60) * 1000;
    this.s.uid = (j.user && j.user.id) || this.s.uid;
    this.s.refresh = j.refresh_token;
    this.save();
  },
  async login(mail, pass) {
    const r = await this.http('POST', '/auth/v1/token?grant_type=password', { email: mail.trim(), password: pass }, false);
    if (r.status === 400) throw new Error('E-Mail oder Passwort falsch');
    if (r.status < 200 || r.status > 299) throw new Error('Anmeldung fehlgeschlagen (' + r.status + ')');
    this.s = { email: mail.trim() };
    this.storeSession(JSON.parse(r.text));
    await this.refreshItems(true);
    await this.tmdbKey();
  },
  logout() { this.s = {}; this.save(); },
  async ensureToken() {
    if (this.s.access && Date.now() < this.s.until) return true;
    if (!this.s.refresh) return false;
    const r = await this.http('POST', '/auth/v1/token?grant_type=refresh_token', { refresh_token: this.s.refresh }, false);
    if (r.status >= 200 && r.status < 300) { this.storeSession(JSON.parse(r.text)); return true; }
    if (r.status === 400 || r.status === 401) { this.s.refresh = null; this.save(); }
    return false;
  },
  async refreshItems(force) {
    if (!this.connected) return;
    if (!force && Date.now() - (this.s.loadedAt || 0) < 60000) return;
    if (!await this.ensureToken()) return;
    const r = await this.http('GET', '/rest/v1/items?select=media_type,tmdb_id,title,status,rating,position,updated_at,poster_path,backdrop_path,meta');
    if (r.status < 200 || r.status > 299) return;
    this.s.items = JSON.parse(r.text);
    this.s.loadedAt = Date.now();
    this.save();
  },
  async tmdbKey() {
    if (this.s.tmdb) return this.s.tmdb;
    if (!this.connected || !await this.ensureToken()) return null;
    const r = await this.http('GET', '/rest/v1/settings?select=tmdb_key');
    if (r.status < 200 || r.status > 299) return null;
    try {
      const k = (JSON.parse(r.text)[0] || {}).tmdb_key;
      if (k) { this.s.tmdb = k; this.save(); return k; }
    } catch (e) {}
    return null;
  },
  keys() { return new Set((this.s.items || []).map(o => o.media_type + ':' + o.tmdb_id)); },
  /** Gewichtung wie im TV-Launcher (Bewertung schlägt Status). */
  seeds() {
    const base = { done: 0.8, watching: 1.0, planned: 0.5, dropped: -0.7 };
    const sd = [];
    for (const o of this.s.items || []) {
      const r = o.rating == null ? 0 : (Number(o.rating) || 0);
      const w = r > 0 ? (r - 5) / 2.5 : (o.status in base ? base[o.status] : 0.4);
      if (w !== 0) sd.push({ type: o.media_type, id: o.tmdb_id, title: o.title, weight: w, updated: o.updated_at || '' });
    }
    return sd.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight) || (b.updated > a.updated ? 1 : -1)).slice(0, 16);
  },
  maxPlanned() {
    return (this.s.items || []).filter(o => o.status === 'planned').reduce((m, o) => Math.max(m, Number(o.position) || 0), 0);
  },
  async addPlanned(type, d) {
    if (!await this.ensureToken()) throw new Error('Bitte neu anmelden');
    const now = new Date().toISOString();
    const row = {
      user_id: this.s.uid, media_type: type, tmdb_id: d.id, title: TM.nameOf(d),
      poster_path: d.poster_path || null, backdrop_path: d.backdrop_path || null, logo_path: TM.pickLogo(d),
      status: 'planned', position: this.maxPlanned() + 1, rating: null, note: null,
      progress: {}, meta: TM.metaOf(type, d), added_at: now, updated_at: now
    };
    const r = await this.http('UPSERT', '/rest/v1/items?on_conflict=user_id,media_type,tmdb_id', [row]);
    if (r.status < 200 || r.status > 299) throw new Error('Speichern fehlgeschlagen (' + r.status + ')');
    await this.refreshItems(true);
  },

  /** Reihenfolge der geplanten Titel speichern (gleiches Feld wie in der Watchlist-App). list: [{ type, id, position }] */
  async setPositions(list) {
    if (!list.length || !this.connected || !await this.ensureToken()) return;
    for (const x of list) {
      const r = await this.http('PATCH', `/rest/v1/items?media_type=eq.${encodeURIComponent(x.type)}&tmdb_id=eq.${Number(x.id)}`, { position: x.position });
      if (r.status < 200 || r.status > 299) throw new Error('Reihenfolge nicht gespeichert (' + r.status + ')');
      const o = (this.s.items || []).find(i => i.media_type === x.type && Number(i.tmdb_id) === Number(x.id));
      if (o) o.position = x.position;
    }
    this.save();
  },

  /* ---------- Gesehen-Status aus dem Player übernehmen ---------- */
  /** Ist (Staffel, Folge) die letzte bekannte Folge laut meta (aired bzw. seasons)? */
  isLast(meta, season, num) {
    const a = meta && Array.isArray(meta.aired) && meta.aired[0] ? meta.aired : null;
    const s = meta && Array.isArray(meta.seasons) && meta.seasons.length ? meta.seasons[meta.seasons.length - 1] : null;
    const last = a || s;
    return !!last && (season > last[0] || (season === last[0] && num >= last[1]));
  },
  /** Folge (bzw. Film) als gesehen eintragen. Fehlt der Titel, wird er wie bei addPlanned angelegt. */
  async markWatched(type, id, season, num) {
    if (!this.connected) return null;
    if (!await this.ensureToken()) throw new Error('Watchlist: bitte neu anmelden');
    const q = `/rest/v1/items?media_type=eq.${encodeURIComponent(type)}&tmdb_id=eq.${Number(id)}`;
    const g = await this.http('GET', q + '&select=status,progress,meta');
    if (g.status < 200 || g.status > 299) throw new Error('Watchlist nicht erreichbar (' + g.status + ')');
    const row = JSON.parse(g.text)[0] || null;
    const now = new Date().toISOString();
    const add = (prog) => {
      if (type !== 'tv') return prog;
      const p = Object.assign({}, prog), k = String(season);
      p[k] = [...new Set([...(Array.isArray(p[k]) ? p[k] : []), num])].sort((a, b) => a - b);
      return p;
    };
    let status;
    if (row) {
      const last = type !== 'tv' || this.isLast(row.meta, season, num);
      status = row.status === 'done' || last ? 'done' : 'watching';
      const r = await this.http('PATCH', q, { progress: add(row.progress || {}), status, updated_at: now });
      if (r.status < 200 || r.status > 299) throw new Error('Watchlist-Speichern fehlgeschlagen (' + r.status + ')');
    } else {
      const d = await TM.details(type, id);
      const meta = TM.metaOf(type, d);
      status = type !== 'tv' || this.isLast(meta, season, num) ? 'done' : 'watching';
      const pos = (this.s.items || []).filter(o => o.status === status).reduce((m, o) => Math.max(m, Number(o.position) || 0), 0) + 1;
      const r = await this.http('UPSERT', '/rest/v1/items?on_conflict=user_id,media_type,tmdb_id', [{
        user_id: this.s.uid, media_type: type, tmdb_id: d.id, title: TM.nameOf(d),
        poster_path: d.poster_path || null, backdrop_path: d.backdrop_path || null, logo_path: TM.pickLogo(d),
        status, position: pos, rating: null, note: null,
        progress: add({}), meta, added_at: now, updated_at: now
      }]);
      if (r.status < 200 || r.status > 299) throw new Error('Watchlist-Speichern fehlgeschlagen (' + r.status + ')');
    }
    await this.refreshItems(true).catch(() => {});
    return status;
  },
  /** Nicht übertragene Einträge (z. B. offline) – werden beim nächsten Start nachgeholt. */
  queue(job) {
    const p = this.s.pending || [];
    if (!p.some(j => j.type === job.type && j.id === job.id && j.season === job.season && j.num === job.num)) p.push(job);
    this.s.pending = p.slice(-50);
    this.save();
  },
  async flush() {
    const p = (this.s.pending || []).slice();
    if (!p.length || !this.connected) return 0;
    let n = 0;
    for (const j of p) {
      try {
        await this.markWatched(j.type, j.id, j.season, j.num);
        this.s.pending = (this.s.pending || []).filter(x => x !== j && !(x.type === j.type && x.id === j.id && x.season === j.season && x.num === j.num));
        this.save(); n++;
      } catch (e) { break; }
    }
    return n;
  }
};

/* ---------------- TMDB ---------------- */
const TM = {
  STORE: 'streamtv.tmdb',
  IMG: 'https://image.tmdb.org/t/p/',
  TTL: 6 * 3600 * 1000,
  cache: {},            // tab -> { at, sig, items }
  loading: new Set(),
  details_: {},         // "tv:123" -> Details-JSON

  load() { try { this.cache = JSON.parse(localStorage.getItem(this.STORE) || '{}'); } catch (e) { this.cache = {}; } },
  save() { try { localStorage.setItem(this.STORE, JSON.stringify(this.cache)); } catch (e) {} },
  clear() { this.cache = {}; this.details_ = {}; this.save(); },

  key() {
    const own = typeof state !== 'undefined' ? (state.settings.tmdbKey || '').trim() : '';
    return own || WL.s.tmdb || null;
  },

  async get(path, params = {}) {
    const key = this.key();
    if (!key) throw new Error('Kein TMDB-Schlüssel');
    const p = new URLSearchParams(Object.assign({ language: 'de-DE' }, params));
    const bearer = key.startsWith('eyJ');
    if (!bearer) p.set('api_key', key);
    const r = await request('GET', 'https://api.themoviedb.org/3' + path + '?' + p.toString(),
      { headers: bearer ? { Authorization: 'Bearer ' + key } : {}, timeout: 15000 });
    if (r.status !== 200) throw new Error('TMDB ' + r.status);
    return JSON.parse(r.text);
  },

  nameOf(d) { return ['title', 'name', 'original_title', 'original_name'].map(k => d[k]).find(Boolean) || ''; },
  pick(o, type) {
    if (type !== 'tv' && type !== 'movie') return null;
    return {
      type, id: o.id, title: this.nameOf(o), orig: o.original_name || o.original_title || '',
      backdrop: o.backdrop_path || null, poster: o.poster_path || null,
      overview: o.overview || '',
      year: String(o.first_air_date || o.release_date || '').slice(0, 4),
      vote: Number(o.vote_average) || 0, reason: null
    };
  },
  picks(j, force) { return (j.results || []).map(o => this.pick(o, force || o.media_type)).filter(Boolean); },
  info(p) {
    return [p.type === 'tv' ? 'Serie' : 'Film', p.year || null, p.vote > 0 ? '★ ' + p.vote.toFixed(1).replace('.', ',') : null]
      .filter(Boolean).join(' · ');
  },

  /** Reiter wie im TV-Launcher – erst Serien, dann Filme. */
  tabs() {
    const seeds = WL.connected ? WL.seeds() : [];
    const because = seeds.filter(s => s.weight > 0 && s.type === 'tv').sort((a, b) => b.weight - a.weight)[0];
    const movieSeeds = seeds.some(s => s.weight > 0 && s.type === 'movie');
    return [
      seeds.length ? { id: 'forYou', label: 'Serien für dich' } : null,
      { id: 'top', label: 'Top 10 Serien diese Woche', rank: true },
      because ? { id: 'because', label: `Weil du „${because.title}“ magst`, seed: because } : null,
      { id: 'new', label: 'Neu bei Netflix & Prime' },
      { id: 'best', label: 'Bestbewertete Serien' },
      { id: 'hidden', label: 'Geheimtipps' },
      movieSeeds ? { id: 'mForYou', label: 'Filme für dich', type: 'movie' } : null,
      { id: 'mTop', label: 'Top 10 Filme diese Woche', rank: true, type: 'movie' },
      { id: 'mNew', label: 'Neue Filme bei Netflix & Prime', type: 'movie' },
      { id: 'mBest', label: 'Bestbewertete Filme', type: 'movie' }
    ].filter(Boolean).map(t => Object.assign({ type: 'tv' }, t));
  },
  seedSig() { return WL.seeds().map(s => `${s.type}:${s.id}:${s.weight}`).join('|'); },

  async loadTab(tab) {
    const today = new Date();
    const since = new Date(today.getTime() - 120 * 864e5).toISOString().slice(0, 10);
    let list = [];
    if (tab.id === 'top') {
      list = this.picks(await this.get('/trending/tv/week'), 'tv');
    } else if (tab.id === 'forYou') {
      list = await this.recs('tv');
    } else if (tab.id === 'because') {
      list = this.picks(await this.get(`/tv/${tab.seed.id}/recommendations`), 'tv');
    } else if (tab.id === 'new') {
      list = this.picks(await this.get('/discover/tv', {
        watch_region: 'DE', with_watch_providers: '8|9', sort_by: 'popularity.desc', 'vote_count.gte': '15', 'first_air_date.gte': since
      }), 'tv');
    } else if (tab.id === 'best') {
      const [a, b] = await Promise.all([1, 2].map(p => this.get('/tv/top_rated', { page: String(p) })));
      list = this.picks(a, 'tv').concat(this.picks(b, 'tv'));
    } else if (tab.id === 'hidden') {
      list = this.picks(await this.get('/discover/tv', {
        sort_by: 'vote_average.desc', 'vote_average.gte': '7.8', 'vote_count.gte': '150', 'vote_count.lte': '1500'
      }), 'tv');
    }
    else if (tab.id === 'mTop') {
      list = this.picks(await this.get('/trending/movie/week'), 'movie');
    } else if (tab.id === 'mForYou') {
      list = await this.recs('movie');
    } else if (tab.id === 'mNew') {
      list = this.picks(await this.get('/discover/movie', {
        watch_region: 'DE', with_watch_providers: '8|9', sort_by: 'popularity.desc', 'vote_count.gte': '20', 'primary_release_date.gte': since
      }), 'movie');
    } else if (tab.id === 'mBest') {
      const [a, b] = await Promise.all([1, 2].map(p => this.get('/movie/top_rated', { page: String(p) })));
      list = this.picks(a, 'movie').concat(this.picks(b, 'movie'));
    }
    const seen = new Set();
    return list.filter(p => (p.backdrop || p.poster) && !seen.has(p.type + ':' + p.id) && seen.add(p.type + ':' + p.id));
  },

  /** Empfehlungen aus der eigenen Watchlist (wie computeRecs() der Web-App). */
  async recs(want) {
    const seeds = WL.seeds();
    const scores = new Map();
    const results = await Promise.all(seeds.map(s =>
      this.get(`/${s.type}/${s.id}/recommendations`).then(j => [s, j.results || []]).catch(() => [s, null])));
    for (const [s, arr] of results) {
      if (!arr) continue;
      arr.slice(0, 20).forEach((o, i) => {
        const type = o.media_type || s.type;
        if (type !== want) return;
        const p = this.pick(o, type);
        if (!p) return;
        const sc = s.weight * (1 - i / 26) * ((o.vote_count || 0) > 50 ? 1 : 0.6);
        const k = p.type + ':' + p.id;
        const e = scores.get(k) || { p, score: 0, why: [] };
        e.score += sc;
        if (sc > 0) e.why.push([sc, s.title]);
        scores.set(k, e);
      });
    }
    return [...scores.values()].filter(e => e.score > 0.25).sort((a, b) => b.score - a.score).slice(0, 40).map(e => {
      const w = e.why.sort((a, b) => b[0] - a[0])[0];
      return Object.assign({}, e.p, { reason: w ? `Wegen „${w[1]}“` : null });
    });
  },

  async ensure(tab, force) {
    const sig = ['forYou', 'because', 'mForYou'].includes(tab.id) ? this.seedSig() : '';
    const c = this.cache[tab.id];
    if (!force && c && Date.now() - c.at < this.TTL && c.sig === sig) return;
    if (this.loading.has(tab.id)) return;
    this.loading.add(tab.id);
    try {
      const items = await this.loadTab(tab);
      this.cache[tab.id] = { at: Date.now(), sig, items };
      this.save();
    } finally { this.loading.delete(tab.id); }
  },
  /** Liste eines Reiters, ohne Titel, die schon auf der Watchlist stehen. */
  list(id) {
    const items = (this.cache[id] && this.cache[id].items) || [];
    if (!WL.connected || id === 'top') return items;
    const k = WL.keys();
    return items.filter(p => !k.has(p.type + ':' + p.id));
  },
  find(key) {
    for (const id in this.cache) {
      const p = (this.cache[id].items || []).find(x => x.type + ':' + x.id === key);
      if (p) return p;
    }
    return (this.searchRes || []).find(x => x.type + ':' + x.id === key) || (this.extra || []).find(x => x.type + ':' + x.id === key)
      || (typeof wlPicks === 'function' ? wlPicks().find(x => x.type + ':' + x.id === key) : null) || null;
  },
  async search(q) {
    const j = await this.get('/search/multi', { query: q, include_adult: 'false' });
    this.searchRes = this.picks(j).filter(p => p.backdrop || p.poster);
    return this.searchRes;
  },
  async details(type, id) {
    const k = type + ':' + id;
    if (this.details_[k]) return this.details_[k];
    const d = await this.get(`/${type}/${id}`, { append_to_response: 'images,watch/providers', include_image_language: 'de,en,null' });
    if (!d.overview) {
      try { d.overview = (await this.get(`/${type}/${id}`, { language: 'en-US' })).overview || ''; } catch (e) {}
    }
    this.details_[k] = d;
    return d;
  },
  /** Folgen einer Staffel: Nummer → { still, name, ov } */
  async season(id, n) {
    const k = `season:${id}:${n}`;
    if (this.details_[k]) return this.details_[k];
    const j = await this.get(`/tv/${id}/season/${n}`);
    const m = {};
    for (const e of j.episodes || []) m[e.episode_number] = { still: e.still_path || '', name: e.name || '', ov: e.overview || '' };
    return (this.details_[k] = m);
  },
  pickLogo(d) {
    const logos = (d.images && d.images.logos) || [];
    const rank = o => o.iso_639_1 == null ? 1 : o.iso_639_1 === 'de' ? 3 : o.iso_639_1 === 'en' ? 2 : 0;
    const best = logos.slice().sort((a, b) => rank(b) - rank(a) || (b.vote_average || 0) - (a.vote_average || 0))[0];
    return best && rank(best) > 0 ? best.file_path : null;
  },
  providersDE(d) {
    const fr = (((d['watch/providers'] || {}).results || {}).DE || {}).flatrate || [];
    return fr.map(p => p.provider_name);
  },
  genres(d) { return (d.genres || []).map(g => g.name); },
  metaOf(type, d) {
    const fr = (((d['watch/providers'] || {}).results || {}).DE || {}).flatrate || [];
    const meta = {
      year: String(d.release_date || d.first_air_date || '').slice(0, 4),
      genres: this.genres(d).slice(0, 3),
      prov: fr.slice(0, 3).map(p => ({ n: p.provider_name, l: p.logo_path }))
    };
    if (type === 'tv') {
      meta.seasons = (d.seasons || []).filter(s => s.season_number > 0 && s.episode_count > 0).map(s => [s.season_number, s.episode_count]);
      const last = d.last_episode_to_air;
      meta.aired = last ? [last.season_number, last.episode_number] : [0, 0];
      meta.tv_status = d.status || null;
    } else {
      meta.runtime = d.runtime > 0 ? d.runtime : null;
    }
    return meta;
  }
};
