/* =====================================================================
   Konto (Benutzername + Passwort) – einmal pro Gerät anmelden, danach bleibt man angemeldet.
   Im Konto liegen:
   - Weiterschauen, Favoriten, Einstellungen … (Cloud-Sync, sync.js, Tabelle „store“)
   - Quellen (Xtream/M3U samt Zugangsdaten) und Watchlist-Zugang – Ende-zu-Ende-verschlüsselt
     mit einem Schlüssel aus dem Konto-Passwort (AES-GCM 256, PBKDF2 600.000 Runden).
     Der Server sieht davon nur verschlüsselte Daten.
   ===================================================================== */
const ACC = {
  URL: WL.URL, KEY: WL.KEY,
  STORE: 'streamtv.acc', DOMAIN: 'konto.invalid', ITER: 600000,
  s: {},
  load() { try { this.s = JSON.parse(localStorage.getItem(this.STORE) || '{}'); } catch (e) { this.s = {}; } },
  save() { try { localStorage.setItem(this.STORE, JSON.stringify(this.s)); } catch (e) {} },
  get connected() { return !!(this.s.refresh && this.s.k); },
  norm: u => String(u || '').trim().toLowerCase(),

  async http(method, path, body, auth = true) {
    const h = { apikey: this.KEY, 'Content-Type': 'application/json' };
    if (auth && this.s.access) h.Authorization = 'Bearer ' + this.s.access;
    if (method === 'UPSERT') h.Prefer = 'resolution=merge-duplicates,return=minimal';
    return request(method === 'UPSERT' ? 'POST' : method, this.URL + path,
      { headers: h, body: body ? JSON.stringify(body) : null, timeout: 15000 });
  },
  session(j) {
    this.s.access = j.access_token;
    this.s.until = Date.now() + ((j.expires_in || 3600) - 60) * 1000;
    this.s.refresh = j.refresh_token;
  },
  async ensureToken() {
    if (this.s.access && Date.now() < this.s.until) return true;
    if (!this.s.refresh) return false;
    const r = await this.http('POST', '/auth/v1/token?grant_type=refresh_token', { refresh_token: this.s.refresh }, false);
    if (r.status >= 200 && r.status < 300) { this.session(JSON.parse(r.text)); this.save(); return true; }
    if (r.status === 400 || r.status === 401) { this.s.refresh = null; this.save(); location.reload(); }
    return false;
  },

  /* ---------- Ende-zu-Ende-Verschlüsselung ---------- */
  b64: u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); },
  unb64: s => { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; },
  async deriveKey(user, pass) {
    const te = new TextEncoder();
    const base = await crypto.subtle.importKey('raw', te.encode(pass), 'PBKDF2', false, ['deriveKey']);
    const k = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: te.encode('stv-e2e|' + user), iterations: this.ITER, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    return this.b64(new Uint8Array(await crypto.subtle.exportKey('raw', k)));
  },
  key() { return crypto.subtle.importKey('raw', this.unb64(this.s.k), 'AES-GCM', false, ['encrypt', 'decrypt']); },
  async encrypt(obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const c = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await this.key(), new TextEncoder().encode(JSON.stringify(obj))));
    return JSON.stringify({ v: 1, iv: this.b64(iv), d: this.b64(c) });
  },
  async decrypt(text) {
    const o = JSON.parse(text);
    const p = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: this.unb64(o.iv) }, await this.key(), this.unb64(o.d));
    return JSON.parse(new TextDecoder().decode(p));
  },

  /* ---------- Anmelden / Konto anlegen ---------- */
  async login(user, pass) {
    user = this.norm(user);
    const r = await this.http('POST', '/auth/v1/token?grant_type=password', { email: `${user}@${this.DOMAIN}`, password: pass }, false);
    if (r.status === 400) throw new Error('Benutzername oder Passwort falsch');
    if (r.status === 429) throw new Error('Zu viele Versuche – bitte kurz warten');
    if (r.status < 200 || r.status > 299) throw new Error('Anmeldung fehlgeschlagen (' + r.status + ')');
    const k = await this.deriveKey(user, pass);
    if (this.s.user && this.s.user !== user) { localStorage.removeItem('streamtv.syncmeta'); localStorage.removeItem('streamtv.accmeta'); }
    this.s = { user, k };
    this.session(JSON.parse(r.text));
    this.save();
  },
  async register(user, pass, code) {
    const r = await this.http('POST', '/functions/v1/gate', { action: 'register', user: this.norm(user), pass, code }, false);
    let j = {}; try { j = JSON.parse(r.text); } catch (e) {}
    if (r.status < 200 || r.status > 299) throw new Error(j.error || 'Konto konnte nicht angelegt werden (' + r.status + ')');
    await this.login(user, pass);
  },
  logout() {
    for (let i = localStorage.length - 1; i >= 0; i--) { const k = localStorage.key(i); if (k && k.startsWith('streamtv.')) localStorage.removeItem(k); }
    location.reload();
  },

  /* ---------- Quellen & Watchlist-Zugang im Konto (verschlüsselt) ---------- */
  meta() { try { return JSON.parse(localStorage.getItem('streamtv.accmeta') || '{}'); } catch (e) { return {}; } },
  setMeta(m) { try { localStorage.setItem('streamtv.accmeta', JSON.stringify(m)); } catch (e) {} },
  srcKey: s => s.type === 'xtream' ? 'x|' + normServer(s.server || '').toLowerCase() + '|' + (s.user || '') : 'm|' + (s.url || ''),
  payload() {
    const pick = s => ({ id: s.id, type: s.type, name: s.name, server: s.server, user: s.user, pass: s.pass, url: s.url, format: s.format });
    return { sources: (state.sources || []).map(pick), wl: this.s.wl || null };
  },
  hash(o) { return JSON.stringify(o); },
  busy: false,
  async syncSecret() {
    if (!this.connected || this.busy) return;
    this.busy = true;
    try {
      if (!await this.ensureToken()) return;
      const m = this.meta();
      const r = await this.http('GET', '/rest/v1/store?key=eq.secret&select=value,updated_at');
      if (r.status < 200 || r.status > 299) return;
      const row = JSON.parse(r.text)[0];
      const remoteAt = row ? Number(row.updated_at) || 0 : 0;
      if (row && remoteAt > (m.at || 0)) {
        let cloud;
        try { cloud = await this.decrypt(row.value); }
        catch (e) { toast('Konto-Daten konnten nicht entschlüsselt werden'); return; }
        await this.adopt(cloud, !m.at);
        m.at = remoteAt; m.h = this.hash(this.payload());
        this.setMeta(m);
        if (m.h === this.hash(cloud)) return;   // nichts Eigenes hinzugekommen
      }
      const p = this.payload(), h = this.hash(p);
      if (h === m.h && row) return;
      const at = Date.now();
      const w = await this.http('UPSERT', '/rest/v1/store?on_conflict=user_id,key', [{ key: 'secret', value: await this.encrypt(p), updated_at: at, device: SYNC.device() }]);
      if (w.status >= 200 && w.status < 300) { m.at = at; m.h = h; this.setMeta(m); }
    } catch (e) { console.warn('Konto', e && e.message); }
    finally { this.busy = false; }
  },
  /** Stand aus dem Konto übernehmen. first = erster Abgleich auf diesem Gerät → zusammenführen statt ersetzen. */
  async adopt(cloud, first) {
    const local = state.sources || [];
    const byKey = new Map(local.map(s => [this.srcKey(s), s]));
    const next = [], fresh = [];
    for (const c of cloud.sources || []) {
      const l = local.find(s => s.id === c.id) || byKey.get(this.srcKey(c));
      if (l && l.id === c.id) next.push(Object.assign(l, c));
      else { next.push(Object.assign({}, c)); fresh.push(c.id); }
    }
    if (first) for (const l of local) if (!next.some(s => s.id === l.id || this.srcKey(s) === this.srcKey(l))) next.push(l);
    const keep = new Set(next.map(s => s.id));
    const changed = fresh.length || local.some(s => !keep.has(s.id));
    if (changed) {
      state.sources = next;
      state.channels = state.channels.filter(c => !c.src || c.src === 'demo' || c.src === 'man' || keep.has(c.src));
      persist();
      for (const id of fresh) { const s = state.sources.find(x => x.id === id); if (s) await refreshSource(s, true); }
      refresh();
    }
    const wl = cloud.wl;
    this.s.wl = wl || this.s.wl || null; this.save();
    if (wl && wl.email && (!WL.connected || (WL.s.email || '').toLowerCase() !== wl.email.toLowerCase())) {
      try { await WL.login(wl.email, wl.pass); TM.clear(); renderSettings(); loadDiscover(true); } catch (e) {}
    }
  },

  /* ---------- Oberfläche ---------- */
  gate() {
    if (document.getElementById('gate')) return;
    document.head.insertAdjacentHTML('beforeend', `<style>
#gate{position:fixed;inset:0;z-index:9990;background:#111;color:#eee;display:grid;place-items:center;font:16px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
#gate form{width:min(20rem,88vw);display:flex;flex-direction:column;gap:.7rem}
#gate h1{font-size:1.4rem;font-weight:600;margin-bottom:.4rem}
#gate input{padding:.75rem .8rem;border-radius:.4rem;border:1px solid #444;background:#1c1c1c;color:#fff;font-size:max(16px,1rem)}
#gate input:focus,#gate button:focus{outline:2px solid #fff;outline-offset:1px}
#gate button{padding:.75rem;border-radius:.4rem;border:0;background:#eee;color:#111;font:inherit;font-weight:600;cursor:pointer}
#gate button.l{background:none;color:#999;font-weight:400;font-size:.9rem}
#gate .e{color:#ff6b6b;min-height:1.2em;font-size:.9rem}
#gate .hidden{display:none}</style>`);
    document.body.insertAdjacentHTML('beforeend', `<div id="gate"><form autocomplete="on" onsubmit="return false">
      <h1 id="gT">Anmelden</h1>
      <input id="gU" data-nolock name="username" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="Benutzername" />
      <input id="gP" data-nolock name="password" type="password" autocomplete="current-password" placeholder="Passwort" />
      <input id="gP2" data-nolock class="hidden" type="password" autocomplete="new-password" placeholder="Passwort wiederholen" />
      <input id="gC" data-nolock class="hidden" autocomplete="off" autocapitalize="characters" placeholder="Einladungscode" />
      <div class="e" id="gE"></div>
      <button id="gGo" type="submit">Anmelden</button>
      <button id="gMode" class="l" type="button">Neues Konto erstellen</button>
    </form></div>`);
    let reg = false, busy = false;
    const $g = id => document.getElementById(id), err = t => { $g('gE').textContent = t; };
    const mode = r => {
      reg = r; err('');
      $g('gT').textContent = r ? 'Konto erstellen' : 'Anmelden';
      $g('gGo').textContent = r ? 'Konto erstellen' : 'Anmelden';
      $g('gMode').textContent = r ? 'Ich habe schon ein Konto' : 'Neues Konto erstellen';
      $g('gP2').classList.toggle('hidden', !r); $g('gC').classList.toggle('hidden', !r);
      $g('gP').autocomplete = r ? 'new-password' : 'current-password';
    };
    $g('gMode').onclick = () => mode(!reg);
    $g('gGo').onclick = async () => {
      if (busy) return;
      const u = $g('gU').value, p = $g('gP').value;
      if (!u.trim() || !p) return err('Benutzername und Passwort eingeben');
      if (reg && p.length < 8) return err('Passwort: mindestens 8 Zeichen');
      if (reg && p !== $g('gP2').value) return err('Passwörter stimmen nicht überein');
      if (reg && !$g('gC').value.trim()) return err('Einladungscode eingeben');
      busy = true; err(''); $g('gGo').textContent = 'Einen Moment …';
      try {
        if (reg) await this.register(u, p, $g('gC').value); else await this.login(u, p);
        location.reload();
      } catch (e) { mode(reg); err(e.message); }
      finally { busy = false; }
    };
    // Fernbedienung/Tastatur: ▲▼ wechselt Felder, Eingaben nicht an die App durchreichen
    window.addEventListener('keydown', e => {
      if (!document.getElementById('gate') || document.getElementById('vault')) return;
      e.stopImmediatePropagation();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const items = [...document.querySelectorAll('#gate input:not(.hidden),#gate button')], i = items.indexOf(document.activeElement);
        const n = items[Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
        if (n) { e.preventDefault(); n.focus(); }
      }
    }, true);
    setTimeout(() => { if (!document.getElementById('vault')) $g('gU').focus(); }, 60);
  },
  settingsGroup() {
    const set = document.querySelector('#view-settings .settings');
    if (!set || document.getElementById('accGroup')) return;
    set.querySelector('.large-title').insertAdjacentHTML('afterend', `<div class="group-title">Konto</div>
      <div class="group" id="accGroup"><div class="row-item"><div class="meta"><b>Angemeldet als ${esc(this.s.user || '')}</b>
        <small>Quellen und Watchlist-Zugang liegen Ende-zu-Ende-verschlüsselt im Konto und stehen auf allen Geräten bereit</small></div>
        <div class="actions"><button class="mini focusable" id="accOut" type="button">Abmelden</button></div></div></div>`);
    document.getElementById('accOut').addEventListener('click', e => {
      e.stopPropagation();
      if (confirm('Abmelden? Alle StreamTV-Daten auf diesem Gerät werden entfernt (im Konto bleibt alles erhalten).')) this.logout();
    });
  },
  init() {
    this.load();
    // Watchlist-Zugang beim Anmelden im Konto hinterlegen (für die anderen Geräte)
    const wlIn = WL.login.bind(WL), wlOut = WL.logout.bind(WL);
    WL.login = async (mail, pass) => { await wlIn(mail, pass); this.s.wl = { email: String(mail).trim(), pass }; this.save(); };
    WL.logout = () => { wlOut(); this.s.wl = null; this.save(); };
    const ready = () => {
      if (!this.connected) return this.gate();
      this.settingsGroup();
      setTimeout(() => this.syncSecret(), 1500);
      setInterval(() => { if (this.hash(this.payload()) !== this.meta().h) this.syncSecret(); }, 8000);   // eigene Änderungen hochladen
      setInterval(() => this.syncSecret(), 5 * 60000);                                                   // fremde Änderungen holen
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') this.syncSecret(); });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(ready, 0));
    else setTimeout(ready, 0);
  }
};
ACC.init();
