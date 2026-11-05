/* =====================================================================
   StreamTV – Cloud-Sync über das Watchlist-Konto (Supabase, Tabelle streamtv_sync)
   Synchronisiert: Weiterschauen-Fortschritt, Favoriten, Zuletzt gesehen, Einstellungen,
   gelernte Intro-Marken, Tonspur-Wahl, Sport-Erinnerungen.
   NICHT synchronisiert: IPTV-Zugänge (Server, Benutzer, Passwort) und Kanallisten.
   Server-/Benutzer-/Passwort-Angaben in Stream-Adressen werden vor dem Hochladen
   durch Platzhalter ersetzt und auf dem anderen Gerät mit dessen eigenen Zugängen
   wieder eingesetzt.
   ===================================================================== */
const SYNC = {
  KEYS: ['streamtv.vodpos', 'streamtv.favs', 'streamtv.recent', 'streamtv.settings', 'streamtv.skip', 'streamtv.tracks', 'streamtv.remind'],
  META: 'streamtv.syncmeta',          // { mtime: {key: ms}, seen: {key: ms}, pulledAt }
  LOCAL_SETTINGS: ['lite', 'vpnAuto', 'vpnReq', 'nativeVod'],   // bleiben pro Gerät (VPN-App, Player)
  applying: false,
  busy: false,
  timer: null,
  m: null,
  keep: {},                           // Cloud-Einträge, deren Zugang es hier (noch) nicht gibt – beim Hochladen behalten

  meta() {
    if (!this.m) { try { this.m = JSON.parse(localStorage.getItem(this.META) || '{}'); } catch (e) { this.m = {}; } }
    this.m.mtime = this.m.mtime || {}; this.m.seen = this.m.seen || {};
    return this.m;
  },
  saveMeta() { try { Storage.prototype._stvSet.call(localStorage, this.META, JSON.stringify(this.meta())); } catch (e) {} },

  /** Änderungen an synchronisierten Schlüsseln mitschreiben (nur echte Änderungen). */
  install() {
    if (Storage.prototype._stvSet) return;
    const orig = Storage.prototype.setItem;
    Storage.prototype._stvSet = orig;
    const self = this;
    Storage.prototype.setItem = function (k, v) {
      const tracked = this === localStorage && !self.applying && self.KEYS.includes(k);
      const changed = tracked && this.getItem(k) !== String(v);
      orig.call(this, k, v);
      if (changed) { self.meta().mtime[k] = Date.now(); self.saveMeta(); self.schedule(); }
    };
  },

  /* ---------- Zugangsdaten durch Platzhalter ersetzen ---------- */
  hash(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(36); },
  rx(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); },
  /** Lokale Zugänge mit Platzhalter-Kennung. */
  subs() {
    const out = [];
    try {
      for (const a of XS.accounts()) {
        const h = this.hash(a.key);
        out.push({ h, key: a.key, base: a.base, u: a.u, p: a.p });
      }
    } catch (e) {}
    return out;
  },
  srcs() {
    return (state.sources || []).map(s => {
      const id = s.type === 'xtream' ? normServer(s.server || '') + '|' + (s.user || '') : (s.url || '');
      return { id: s.id, h: this.hash(id) };
    });
  },
  sanitize(str) {
    let out = String(str);
    for (const a of this.subs()) {
      // Stream-Adressen: <server>/[series|movie|live/]<user>/<pass>/…  ->  {X:h}/[series/]…
      out = out.replace(new RegExp(this.rx(a.base) + '/((?:[a-z]+/)?)' + this.rx(a.u) + '/' + this.rx(a.p) + '/', 'g'), `{X:${a.h}}/$1`);
      out = out.split(a.key).join(`{K:${a.h}}`);
    }
    for (const s of this.srcs()) out = out.split(`"${s.id}_`).join(`"{S:${s.h}}_`);
    return out;
  },
  restore(str) {
    let out = String(str);
    for (const a of this.subs()) {
      out = out.split(`{X:${a.h}}/`).join(`${a.base}/@@XS@@`)
        .replace(/@@XS@@((?:[a-z]+\/)?)/g, (_, seg) => `${seg}${a.u}/${a.p}/`);
      out = out.split(`{K:${a.h}}`).join(a.key);
    }
    for (const s of this.srcs()) out = out.split(`"{S:${s.h}}_`).join(`"${s.id}_`);
    return out;
  },
  unresolved(str) { return /\{[XKS]:[0-9a-z]+\}/.test(str); },

  /* ---------- Ablauf ---------- */
  schedule(delay = 20000) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.run(false), delay);
  },
  async api(method, path, body) {
    return WL.http(method, '/rest/v1/streamtv_sync' + path, body);
  },
  /** Abgleich: holen, zusammenführen, eigene Änderungen hochladen. */
  async run(forcePull = true) {
    if (this.busy || !WL.connected) return false;
    this.busy = true;
    try {
      if (!await WL.ensureToken()) return false;
      const M = this.meta();
      const pullDue = forcePull || Date.now() - (M.pulledAt || 0) > 120000;
      const changed = new Set(), push = new Set();
      let remote = {};
      if (pullDue) {
        const r = await this.api('GET', '?select=key,value,updated_at');
        if (r.status < 200 || r.status > 299) return false;
        for (const row of JSON.parse(r.text)) remote[row.key] = row;
        const first = !M.pulledAt;   // erster Abgleich auf diesem Gerät: Cloud-Stand hat Vorrang
        M.pulledAt = Date.now();
        for (const k of this.KEYS) {
          const row = remote[k];
          if (!row) { if (localStorage.getItem(k) != null) push.add(k); continue; }
          if (k === VP.STORE || k === SK.STORE) {
            const r2 = this.merge(k, row);
            if (r2.local) changed.add(k);
            if (r2.push) push.add(k);
            continue;
          }
          const ts = Number(row.updated_at) || 0;
          if (ts > (M.seen[k] || 0) && (first || ts > (M.mtime[k] || 0))) {
            this.partial = false;
            if (this.apply(k, row.value)) changed.add(k);
            if (this.partial) { M.mtime[k] = 0; continue; }   // Quelle fehlt noch: später erneut übernehmen
            M.mtime[k] = ts;
          }
          M.seen[k] = Math.max(M.seen[k] || 0, ts);
        }
      }
      // Hochladen: alles, was hier neuer ist als der zuletzt gesehene Cloud-Stand
      const up = [];
      for (const k of this.KEYS) {
        const local = localStorage.getItem(k);
        if (local == null) continue;
        const mt = M.mtime[k] || 0;
        if (!push.has(k) && mt <= (M.seen[k] || 0)) continue;
        const ts = Math.max(mt, Date.now());
        up.push({ key: k, value: this.withKept(k, this.sanitize(this.outbound(k, local))), updated_at: ts, device: this.device() });
        M.seen[k] = ts; M.mtime[k] = ts;
      }
      if (up.length) {
        const r = await this.api('UPSERT', '?on_conflict=user_id,key', up);
        if (r.status < 200 || r.status > 299) { up.forEach(u => { M.seen[u.key] = 0; }); return false; }
      }
      this.saveMeta();
      if (changed.size) this.refreshUi(changed);
      return true;
    } catch (e) {
      console.warn('Sync', e && e.message);
      return false;
    } finally { this.busy = false; }
  },
  device() { try { return (bridge && bridge.deviceName && bridge.deviceName()) || 'TV'; } catch (e) { return 'TV'; } },
  /** Was hochgeladen wird (z. B. nur die gelernten Intro-Marken, nicht den TheIntroDB-Cache). */
  outbound(k, v) {
    if (k === 'streamtv.settings') {
      try { const s = JSON.parse(v); this.LOCAL_SETTINGS.forEach(x => delete s[x]); return JSON.stringify(s); } catch (e) { return v; }
    }
    if (k === SK.STORE) { try { return JSON.stringify({ learn: JSON.parse(v).learn || {} }); } catch (e) { return '{}'; } }
    return v;
  },
  withKept(k, v) {
    const keep = this.keep[k];
    if (!keep || !Object.keys(keep).length) return v;
    try {
      const o = JSON.parse(v);
      const tgt = k === SK.STORE ? (o.learn = o.learn || {}) : o;
      for (const id in keep) if (!(id in tgt)) tgt[id] = keep[id];
      return JSON.stringify(o);
    } catch (e) { return v; }
  },
  set(k, v) { this.applying = true; try { localStorage.setItem(k, v); } finally { this.applying = false; } },
  /** Cloud-Stand übernehmen (ganzer Wert). */
  apply(k, value) {
    let v = this.restore(value);
    if (k === 'streamtv.settings') {
      try {
        const cur = JSON.parse(localStorage.getItem(k) || '{}'), s = JSON.parse(v);
        this.LOCAL_SETTINGS.forEach(x => { if (x in cur) s[x] = cur[x]; else delete s[x]; });
        v = JSON.stringify(s);
      } catch (e) { return false; }
    }
    if ((k === 'streamtv.favs' || k === 'streamtv.recent')) {
      // Kanäle anderer Quellen, die es hier nicht gibt, weglassen
      try {
        const all = JSON.parse(v), ok = all.filter(id => typeof id !== 'string' || !this.unresolved(id));
        if (ok.length < all.length) this.partial = true;
        v = JSON.stringify(ok);
      } catch (e) { return false; }
    }
    if (localStorage.getItem(k) === v) return false;
    this.set(k, v);
    return true;
  },
  /** Fortschritt bzw. Intro-Marken zusammenführen: pro Eintrag gewinnt der neuere. */
  merge(k, row) {
    let inc = {}, cur = {};
    try { inc = JSON.parse(this.restore(row.value)); cur = JSON.parse(localStorage.getItem(k) || '{}'); } catch (e) { return { local: false, push: false }; }
    let changed = false, push = false;
    const keep = {};
    this.keep[k] = keep;
    if (k === VP.STORE) {
      for (const id in inc) {
        const e = inc[id];
        if (!e) continue;
        if (e.m && this.unresolved(JSON.stringify(e.m))) { keep[id] = e; continue; }   // Zugang fehlt hier
        if (!cur[id] || (e.at || 0) > (cur[id].at || 0)) { cur[id] = e; changed = true; }
      }
      for (const id in cur) if (!inc[id] || (cur[id].at || 0) > (inc[id].at || 0)) push = true;   // hier Neueres
      if (changed) { this.set(k, JSON.stringify(cur)); VP.s = null; }
    } else {
      cur.learn = cur.learn || {};
      for (const id in (inc.learn || {})) {
        if (this.unresolved(id)) { keep[id] = inc.learn[id]; continue; }
        if (JSON.stringify(cur.learn[id]) !== JSON.stringify(inc.learn[id])) { cur.learn[id] = inc.learn[id]; changed = true; }
      }
      for (const id in cur.learn) if (!(inc.learn || {})[id]) push = true;
      if (changed) { this.set(k, JSON.stringify(cur)); SK.d = null; }
    }
    this.meta().seen[k] = Math.max(this.meta().seen[k] || 0, Number(row.updated_at) || 0);
    return { local: changed, push };
  },
  refreshUi(changed) {
    try {
      if (changed.has('streamtv.favs')) state.favs = JSON.parse(localStorage.getItem('streamtv.favs') || '[]');
      if (changed.has('streamtv.recent')) state.recent = JSON.parse(localStorage.getItem('streamtv.recent') || '[]');
      if (changed.has('streamtv.settings')) { state.settings = { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('streamtv.settings') || '{}') }; applyTheme(); }
      if (changed.has('streamtv.tracks')) TRK.p = null;
      if (changed.has('streamtv.remind')) SP.rem = null;
      if (changed.has(VP.STORE)) VP.share();
      if (!playerOpen && !sheetOpen) refresh();
    } catch (e) {}
  }
};
SYNC.install();
