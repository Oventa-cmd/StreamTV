/* =====================================================================
   StreamTV – Sport: kommende Live-Events + Vormerken
   Fußball: OpenLigaDB (1.–3. Liga, DFB-Pokal, Champions League)
   Turniere: TheSportsDB (WM, EM)   ·   F1: Jolpica-F1
   MotoGP: offizielle MotoGP-API   ·   DTM: TheSportsDB
   ===================================================================== */
const SP = {
  STORE: 'streamtv.sport', REM: 'streamtv.remind',
  TTL: 3 * 3600 * 1000, DAYS: 14,
  OLDB: 'https://api.openligadb.de', JOLPICA: 'https://api.jolpi.ca/ergast/f1',
  TSDB: 'https://www.thesportsdb.com/api/v1/json/123', MOTOGP: 'https://api.motogp.pulselive.com/motogp/v1',
  /** Wettbewerbe: Kürzel, Name, Sportart, Farben, Sender-Stichworte (Vorschläge, keine Rechte-Datenbank). */
  COMP: {
    bl1: { name: 'Bundesliga', short: 'BL', sport: 'fb', c: ['#d20515', '#3d0006'], kw: ['sky sport bundesliga', 'sky sport top event', 'dazn', 'sat.1', 'sat 1', 'sky sport'] },
    bl2: { name: '2. Bundesliga', short: '2. BL', sport: 'fb', c: ['#b4111f', '#2c0207'], kw: ['sky sport bundesliga', 'sky sport', 'sport1', 'dazn'] },
    bl3: { name: '3. Liga', short: '3. Liga', sport: 'fb', c: ['#00857a', '#00211e'], kw: ['magenta', 'sportdigital', 'ard', 'das erste', 'wdr', 'ndr', 'br ', 'swr', 'mdr', 'hr '] },
    dfb: { name: 'DFB-Pokal', short: 'Pokal', sport: 'fb', c: ['#127a3e', '#03200f'], kw: ['sky sport', 'ard', 'das erste', 'zdf'] },
    ucl: { name: 'Champions League', short: 'CL', sport: 'fb', c: ['#1d3fa8', '#050d2e'], kw: ['dazn', 'prime', 'amazon', 'zdf', 'sky sport'] },
    wm: { name: 'Weltmeisterschaft', short: 'WM', sport: 'fb', c: ['#8a1538', '#1e0410'], kw: ['ard', 'das erste', 'zdf', 'magenta'] },
    em: { name: 'Europameisterschaft', short: 'EM', sport: 'fb', c: ['#0b4ea2', '#020f26'], kw: ['ard', 'das erste', 'zdf', 'magenta'] },
    f1: { name: 'Formel 1', short: 'F1', sport: 'ms', c: ['#e10600', '#15151e'], kw: ['sky sport f1', 'f1', 'formel 1', 'rtl', 'servus', 'orf', 'sky sport'] },
    motogp: { name: 'MotoGP', short: 'MotoGP', sport: 'ms', c: ['#c80a1e', '#111'], kw: ['servus', 'motogp', 'sky sport', 'dazn', 'eurosport'] },
    dtm: { name: 'DTM', short: 'DTM', sport: 'ms', c: ['#0a3a7a', '#020a18'], kw: ['prosieben', 'pro7', 'ran', 'joyn', 'dtm'] }
  },
  events: [], errors: [], at: 0, loading: false, listeners: [], rem: null,

  load() {
    try {
      const c = JSON.parse(localStorage.getItem(this.STORE) || 'null');
      if (c && Array.isArray(c.events)) { this.events = c.events.filter(e => e.end > Date.now()); this.at = c.at || 0; }
    } catch (e) {}
  },
  save() {
    const lim = Date.now() + this.DAYS * 864e5;
    try { localStorage.setItem(this.STORE, JSON.stringify({ at: this.at, events: this.events.filter(e => e.start < lim).slice(0, 400) })); } catch (e) {}
  },
  onUpdate(fn) { this.listeners.push(fn); },
  emit() { this.listeners.forEach(fn => { try { fn(); } catch (e) {} }); },

  async json(url, ms = 20000) {
    const r = await request('GET', url, { timeout: ms });
    if (r.status < 200 || r.status > 299) throw new Error('HTTP ' + r.status);
    return JSON.parse(r.text);
  },
  season() { const d = new Date(); return d.getMonth() >= 6 ? d.getFullYear() : d.getFullYear() - 1; },
  utc(s) { if (!s) return 0; s = String(s); if (!/[zZ]|[+-]\d\d:?\d\d$/.test(s)) s += 'Z'; const t = Date.parse(s); return isNaN(t) ? 0 : t; },

  /* ---------- Quellen ---------- */
  async openliga(code) {
    const list = await this.json(`${this.OLDB}/getmatchdata/${code}/${this.season()}`);
    if (!Array.isArray(list)) return [];
    return list.map(m => {
      const start = this.utc(m.matchDateTimeUTC) || this.utc(m.matchDateTime);
      const goals = Array.isArray(m.goals) && m.goals.length ? m.goals[m.goals.length - 1] : null;
      return {
        id: `${code}:${m.matchID}`, comp: code, start, end: start + 115 * 60000, done: !!m.matchIsFinished,
        home: (m.team1 && (m.team1.shortName || m.team1.teamName)) || '', away: (m.team2 && (m.team2.shortName || m.team2.teamName)) || '',
        homeFull: (m.team1 && m.team1.teamName) || '', awayFull: (m.team2 && m.team2.teamName) || '',
        homeIcon: (m.team1 && m.team1.teamIconUrl) || '', awayIcon: (m.team2 && m.team2.teamIconUrl) || '',
        round: (m.group && m.group.groupName) || '', score: goals ? `${goals.scoreTeam1}:${goals.scoreTeam2}` : ''
      };
    });
  },
  async f1() {
    const j = await this.json(`${this.JOLPICA}/current.json`);
    const races = (((j || {}).MRData || {}).RaceTable || {}).Races || [];
    const out = [];
    const S = [['SprintQualifying', 'Sprint-Qualifying', 60], ['Sprint', 'Sprint', 60], ['Qualifying', 'Qualifying', 60]];
    for (const r of races) {
      const gp = String(r.raceName || '').replace(/Grand Prix/i, 'GP');
      const place = (r.Circuit && r.Circuit.Location && (r.Circuit.Location.locality || r.Circuit.Location.country)) || '';
      for (const [k, label, min] of S) {
        if (!r[k] || !r[k].date) continue;
        const start = this.utc(r[k].date + 'T' + (r[k].time || '00:00:00Z'));
        out.push({ id: `f1:${r.season}:${r.round}:${k}`, comp: 'f1', start, end: start + min * 60000, title: label, gp, place });
      }
      const start = this.utc(r.date + 'T' + (r.time || '00:00:00Z'));
      out.push({ id: `f1:${r.season}:${r.round}:race`, comp: 'f1', start, end: start + 120 * 60000, title: 'Rennen', gp, place, main: true });
    }
    return out;
  },
  async motogp() {
    const y = new Date().getFullYear();
    const list = await this.json(`${this.MOTOGP}/events?seasonYear=${y}`, 25000);
    const out = [];
    for (const e of Array.isArray(list) ? list : []) {
      if (String(e.kind || '').toUpperCase() !== 'GP') continue;
      const place = (e.circuit && (e.circuit.place || e.circuit.name)) || (e.country && e.country.name) || e.shortname || '';
      const gp = 'GP ' + place;
      const sess = (Array.isArray(e.broadcasts) ? e.broadcasts : []).filter(b => {
        const cat = b.category || {};
        return (/motogp/i.test(cat.name || '') || cat.acronym === 'MGP') && /^(RACE|SPRINT|RAC|SPR|Q2)$/i.test(b.kind || b.shortname || '');
      });
      if (sess.length) {
        for (const b of sess) {
          const k = String(b.kind || b.shortname).toUpperCase();
          const start = this.utc(b.date_start);
          out.push({ id: `motogp:${e.id}:${b.id || k}`, comp: 'motogp', start, end: this.utc(b.date_end) || start + 60 * 60000,
            title: /SPR/.test(k) ? 'Sprint' : /Q/.test(k) ? 'Qualifying' : 'Rennen', gp, place, main: /RAC/.test(k) });
        }
      } else {
        const start = this.utc(e.date_start);
        out.push({ id: `motogp:${e.id}`, comp: 'motogp', start, end: this.utc(e.date_end) || start + 3 * 864e5, title: 'Rennwochenende', gp, place, main: true, weekend: true });
      }
    }
    return out;
  },
  async tsdb(league, comp) {
    const j = await this.json(`${this.TSDB}/eventsnextleague.php?id=${league}`);
    return ((j && j.events) || []).map(e => {
      const start = this.utc(e.strTimestamp || (e.dateEvent + 'T' + (e.strTime || '00:00:00')));
      const fb = this.COMP[comp].sport === 'fb';
      return fb ? {
        id: `${comp}:${e.idEvent}`, comp, start, end: start + 115 * 60000, home: e.strHomeTeam || '', away: e.strAwayTeam || '',
        homeIcon: e.strHomeTeamBadge || '', awayIcon: e.strAwayTeamBadge || '', round: e.intRound ? `${e.intRound}. Spieltag` : (e.strGroup || '')
      } : {
        id: `${comp}:${e.idEvent}`, comp, start, end: start + 75 * 60000, title: (e.strEvent || '').replace(/^.*?\b(Race \d|Qualifying \d?)$/i, '$1').replace(/^Race/, 'Rennen'),
        gp: e.strVenue || e.strEvent || '', place: e.strCity || e.strCountry || '', main: /race/i.test(e.strEvent || '')
      };
    });
  },

  /** Alle Quellen laden (parallel, Fehler einzeln). */
  async refresh(force) {
    if (this.loading) return;
    if (!force && this.at && Date.now() - this.at < this.TTL && this.events.length) return;
    this.loading = true; this.emit();
    const jobs = [
      ['Bundesliga', () => this.openliga('bl1')], ['2. Bundesliga', () => this.openliga('bl2')], ['3. Liga', () => this.openliga('bl3')],
      ['DFB-Pokal', () => this.openliga('dfb')], ['Champions League', () => this.openliga('ucl')],
      ['Formel 1', () => this.f1()], ['MotoGP', () => this.motogp()], ['DTM', () => this.tsdb(4438, 'dtm')],
      ['WM', () => this.tsdb(4429, 'wm')], ['EM', () => this.tsdb(4502, 'em')]
    ];
    const res = await Promise.allSettled(jobs.map(([, fn]) => fn()));
    const now = Date.now(), lim = now + this.DAYS * 864e5, all = [], errors = [];
    res.forEach((r, i) => {
      if (r.status === 'fulfilled') all.push(...r.value.filter(e => e.start && e.end > now && e.start < lim && !e.done));
      else errors.push(jobs[i][0]);
    });
    // bei Teilausfall die alten Events dieser Wettbewerbe behalten
    if (errors.length && this.events.length) {
      const failed = new Set(jobs.filter((j, i) => res[i].status !== 'fulfilled').map(j => j[0]));
      const keep = this.events.filter(e => failed.has(this.COMP[e.comp] && this.COMP[e.comp].name) && e.end > now);
      all.push(...keep);
    }
    const seen = new Set();
    this.events = all.filter(e => !seen.has(e.id) && seen.add(e.id)).sort((a, b) => a.start - b.start);
    this.errors = errors;
    this.at = Date.now();
    this.loading = false;
    this.save();
    this.emit();
  },
  byId(id) { return this.events.find(e => e.id === id) || (this.rems()[id] && this.rems()[id].ev) || null; },
  isLive(e, now = Date.now()) { return e.start <= now && now < e.end && !e.weekend; },
  title(e) { return e.home ? `${e.home} – ${e.away}` : `${this.COMP[e.comp].short} · ${e.title}`; },

  /* ---------- Passende Sender ---------- */
  norm(s) { return ' ' + String(s || '').toLowerCase().replace(/^\s*((\||\[)[^|\]]{1,12}(\||\])\s*|[a-z]{2,4}\s*[-:|]\s+)+/, '').replace(/[^a-z0-9äöüß.]+/g, ' ') + ' '; },
  channelsFor(e, max = 8) {
    const c = this.COMP[e.comp], kws = c.kw;
    const words = [e.home, e.away, e.homeFull, e.awayFull, c.name, c.short, e.title === 'Rennen' ? '' : e.title]
      .filter(w => w && w.length > 2).map(w => w.toLowerCase());
    const out = [];
    for (const ch of visibleChannels()) {
      const n = this.norm(ch.name);
      let score = 0;
      kws.forEach((k, i) => { if (n.includes(' ' + k) || n.includes(k)) score = Math.max(score, 60 - i * 5); });
      const ep = EPG.now(ch.id), t = ep && ep.cur ? ep.cur.t.toLowerCase() : '';
      const epg = !!t && words.some(w => t.includes(w));
      if (epg) score += 100;
      if (score > 0) out.push({ ch, score, epg, prog: ep && ep.cur ? ep.cur.t : '' });
    }
    return out.sort((a, b) => b.score - a.score || a.ch.name.length - b.ch.name.length).slice(0, max);
  },

  /* ---------- Vormerken ---------- */
  rems() { if (!this.rem) { try { this.rem = JSON.parse(localStorage.getItem(this.REM) || '{}'); } catch (e) { this.rem = {}; } } return this.rem; },
  saveRem() { try { localStorage.setItem(this.REM, JSON.stringify(this.rem)); } catch (e) {} },
  isRem(id) { return !!this.rems()[id]; },
  toggleRem(e) {
    const r = this.rems();
    if (r[e.id]) delete r[e.id]; else r[e.id] = { ev: e, at: Date.now(), done: false };
    this.saveRem();
    return !!r[e.id];
  },
  /** Fällige Erinnerungen (5 Min. vorher bis 30 Min. nach Beginn), räumt Altes auf. */
  due(now = Date.now()) {
    const r = this.rems(), out = [];
    let dirty = false;
    for (const id in r) {
      const x = r[id], e = x.ev;
      if (e.end < now - 3600000) { delete r[id]; dirty = true; continue; }
      if (!x.done && now >= e.start - 5 * 60000 && now < Math.min(e.end, e.start + 30 * 60000)) { x.done = true; dirty = true; out.push(e); }
    }
    if (dirty) this.saveRem();
    return out;
  }
};
