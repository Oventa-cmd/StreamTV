/* =====================================================================
   StreamTV – Profile (mehrere Personen in einem Konto, wie bei Netflix)
   - Pro Profil getrennt: Weiterschauen/Fortschritt, Zuletzt gesehen, Favoriten,
     Statistik, Einstellungen (inkl. Wiedergabe/Tonspur) und Empfehlungs-Cache.
   - Gemeinsam: Konto, IPTV-Zugänge, Kanallisten, Intro-Marken, Sport-Erinnerungen.
   - Hauptprofil („main“) nutzt die bisherigen Speicher-Schlüssel – nichts muss umziehen.
     Weitere Profile speichern unter „<schlüssel>@<profil-id>“ (lokal und in der Cloud).
   - Zusatzprofile haben statt der Serien-Watchlist eine eigene Merkliste nur in StreamTV
     (gleiche Oberfläche, Empfehlungen über TMDB), siehe patchWL().
   - Optionale PIN pro Profil (nur Zugangssperre in der Oberfläche, keine Verschlüsselung).
   Muss direkt nach vault.js laden: legt sich als Schicht über localStorage.
   ===================================================================== */
const PROF = (() => {
  const SCOPED = ['streamtv.vodpos', 'streamtv.favs', 'streamtv.recent', 'streamtv.settings', 'streamtv.stats',
    'streamtv.tracks', 'streamtv.playback', 'streamtv.syncmeta', 'streamtv.tmdb', 'streamtv.mylist'];
  const ACTIVE = 'streamtv.profile', LIST = 'streamtv.profiles', OKS = 'streamtv.profile.ok';
  const COLORS = ['#0a84ff', '#ff9f0a', '#30d158', '#bf5af2', '#ff375f', '#64d2ff', '#ffd60a', '#ac8e68'];
  const base = window.localStorage;

  const readList = () => {
    try { const l = JSON.parse(base.getItem(LIST) || '[]'); if (Array.isArray(l) && l.some(p => p && p.id === 'main')) return l; } catch (e) {}
    return [{ id: 'main', name: '', color: COLORS[0] }];
  };
  let active = 'main';
  try { active = base.getItem(ACTIVE) || 'main'; } catch (e) {}
  if (!readList().some(p => p.id === active)) active = 'main';

  const phys = k => active !== 'main' && SCOPED.includes(k) ? k + '@' + active : k;
  const shim = {
    __shim: true,
    __vault: !!base.__vault,
    get length() { return base.length; },
    key(i) { return base.key(i); },
    getItem(k) { return base.getItem(phys(k)); },
    setItem(k, v) { base.setItem(phys(k), v); },
    removeItem(k) { base.removeItem(phys(k)); },
    clear() { base.clear(); }
  };
  let works = false;
  try { Object.defineProperty(window, 'localStorage', { configurable: true, get: () => shim }); works = window.localStorage === shim; } catch (e) {}
  if (!works) active = 'main';

  // Neues Profil auf diesem Gerät: Einstellungen des Hauptprofils als Ausgangspunkt (Player, VPN, Darstellung)
  if (active !== 'main') {
    for (const k of ['streamtv.settings', 'streamtv.playback']) {
      try { if (base.getItem(phys(k)) == null && base.getItem(k) != null) base.setItem(phys(k), base.getItem(k)); } catch (e) {}
    }
  }

  /* ---------- Hilfen ---------- */
  const side = () => active !== 'main';
  const list = () => readList();
  const byId = id => list().find(p => p.id === id) || null;
  const current = () => byId(active) || list()[0];
  const nameOf = p => (p && p.name) || (p && p.id === 'main' ? ((typeof ACC !== 'undefined' && ACC.s.user) || 'Ich') : 'Profil');
  const initial = p => (nameOf(p).trim()[0] || '?').toUpperCase();
  const h = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  /** PIN-Prüfwert (gleich auf allen Geräten; reine Oberflächensperre). */
  function pinHash(id, pin) {
    let x = 'stv:' + id + ':' + pin, hv = 0x811c9dc5;
    for (let r = 0; r < 5000; r++) {
      for (let i = 0; i < x.length; i++) { hv ^= x.charCodeAt(i); hv = Math.imul(hv, 0x01000193) >>> 0; }
      x = hv.toString(36) + x.length;
    }
    return hv.toString(36);
  }
  const okSet = () => { try { return new Set(JSON.parse(sessionStorage.getItem(OKS) || '[]')); } catch (e) { return new Set(); } };
  const markOk = id => { const s = okSet(); s.add(id); try { sessionStorage.setItem(OKS, JSON.stringify([...s])); } catch (e) {} };
  const saveList = l => { try { localStorage.setItem(LIST, JSON.stringify(l)); } catch (e) {} };
  /** Cloud-Schlüssel (sync.js): Profil-Daten mit Endung, Rest gemeinsam. */
  const cloudKey = k => phys(k);

  function switchTo(id) {
    if (id === active) return;
    try { base.setItem(ACTIVE, id); } catch (e) {}
    try { if (typeof SYNC !== 'undefined') SYNC.run(false); } catch (e) {}
    setTimeout(() => location.reload(), 250);
  }
  /** Profil wählen – mit PIN-Abfrage, falls gesetzt. */
  function choose(id) {
    const p = byId(id);
    if (!p || id === active) { close(); return; }
    if (p.pin && !okSet().has(id)) return askPin(p, () => { markOk(id); switchTo(id); });
    switchTo(id);
  }

  /* ---------- Zusatzprofil: eigene Merkliste statt Serien-Watchlist ---------- */
  function patchWL(WL) {
    if (!side()) return;
    const MY = 'streamtv.mylist', SESSION = ['access', 'until', 'uid', 'refresh', 'tmdb'];
    const readMy = () => { try { return JSON.parse(localStorage.getItem(MY) || '{}'); } catch (e) { return {}; } };
    const readMain = () => { try { return JSON.parse(base.getItem(WL.STORE) || '{}'); } catch (e) { return {}; } };
    WL.load = function () {
      const m = readMain(), my = readMy();
      this.s = { items: Array.isArray(my.items) ? my.items : [], loadedAt: Date.now(), mine: true };
      SESSION.forEach(k => { if (m[k] !== undefined) this.s[k] = m[k]; });   // Sitzung des Hauptprofils für TMDB-Schlüssel & Claude-Suche
    };
    WL.save = function () {
      try {
        const m = readMain(); let ch = false;
        SESSION.forEach(k => { if (k in this.s && m[k] !== this.s[k]) { m[k] = this.s[k]; ch = true; } });
        if (ch) base.setItem(WL.STORE, JSON.stringify(m));
      } catch (e) {}
      try { localStorage.setItem(MY, JSON.stringify({ items: this.s.items || [] })); } catch (e) {}
    };
    Object.defineProperty(WL, 'connected', { configurable: true, get() { return true; } });
    WL.login = async () => { throw new Error('Im Zusatzprofil nicht verfügbar'); };
    WL.logout = () => {};
    WL.refreshItems = async function () { const my = readMy(); this.s.items = Array.isArray(my.items) ? my.items : []; this.s.loadedAt = Date.now(); };
    const row = (type, d, status, extra) => {
      const now = new Date().toISOString();
      return Object.assign({
        media_type: type, tmdb_id: Number(d.id), title: TM.nameOf(d), poster_path: d.poster_path || null, backdrop_path: d.backdrop_path || null,
        status, rating: null, position: 0, progress: {}, meta: TM.metaOf(type, d), added_at: now, updated_at: now
      }, extra || {});
    };
    const maxPos = (items, st) => items.filter(o => o.status === st).reduce((m, o) => Math.max(m, Number(o.position) || 0), 0);
    WL.addPlanned = async function (type, d) {
      const items = this.s.items = (this.s.items || []).filter(o => !(o.media_type === type && Number(o.tmdb_id) === Number(d.id)));
      items.push(row(type, d, 'planned', { position: maxPos(items, 'planned') + 1 }));
      this.save();
    };
    WL.remove = async function (type, id) {
      this.s.items = (this.s.items || []).filter(o => !(o.media_type === type && Number(o.tmdb_id) === Number(id)));
      this.save();
    };
    WL.setPositions = async function (l) {
      for (const x of l) {
        const o = (this.s.items || []).find(i => i.media_type === x.type && Number(i.tmdb_id) === Number(x.id));
        if (o) o.position = x.position;
      }
      this.save();
    };
    WL.markWatched = async function (type, id, season, num) {
      const items = this.s.items = this.s.items || [];
      const add = prog => {
        if (type !== 'tv') return prog;
        const p = Object.assign({}, prog), k = String(season);
        p[k] = [...new Set([...(Array.isArray(p[k]) ? p[k] : []), num])].sort((a, b) => a - b);
        return p;
      };
      let o = items.find(i => i.media_type === type && Number(i.tmdb_id) === Number(id)), status;
      if (o) {
        status = o.status === 'done' || type !== 'tv' || this.isLast(o.meta, season, num) ? 'done' : 'watching';
        Object.assign(o, { progress: add(o.progress || {}), status, updated_at: new Date().toISOString() });
      } else {
        const d = await TM.details(type, id);
        const meta = TM.metaOf(type, d);
        status = type !== 'tv' || this.isLast(meta, season, num) ? 'done' : 'watching';
        items.push(row(type, d, status, { meta, progress: add({}), position: maxPos(items, status) + 1 }));
      }
      this.save();
      return status;
    };
    WL.queue = () => {};
    WL.flush = async () => 0;
  }

  /* ---------- Oberfläche ---------- */
  let ov = null, onClose = null;
  function css() {
    if (document.getElementById('profCss')) return;
    document.head.insertAdjacentHTML('beforeend', `<style id="profCss">
.prof-btn{gap:.45rem;padding:.2rem .7rem .2rem .2rem;cursor:pointer;color:inherit;font:inherit}
.prof-av{display:inline-grid;place-items:center;width:1.55rem;height:1.55rem;border-radius:.45rem;color:#fff;font-weight:800;font-size:.8rem;flex:none}
#profOv{position:fixed;inset:0;z-index:9980;background:rgba(0,0,0,.72);-webkit-backdrop-filter:blur(24px);backdrop-filter:blur(24px);display:grid;place-items:center;color:#fff;font-family:inherit}
#profOv .pbox{width:min(46rem,92vw);display:flex;flex-direction:column;align-items:center;gap:1.4rem;text-align:center}
#profOv h2{font-size:1.9rem;font-weight:700;margin:0}
#profOv .psub{color:rgba(255,255,255,.6);font-size:.95rem;margin-top:-.8rem}
#profOv .pgrid{display:flex;flex-wrap:wrap;justify-content:center;gap:1.4rem}
#profOv .pcard{background:none;border:0;color:#fff;display:flex;flex-direction:column;align-items:center;gap:.6rem;cursor:pointer;font:inherit;padding:.4rem;border-radius:1rem;outline:none}
#profOv .pcard .pbig{width:6.5rem;height:6.5rem;border-radius:1.1rem;display:grid;place-items:center;font-size:2.6rem;font-weight:800;transition:transform .15s,box-shadow .15s}
#profOv .pcard span{color:rgba(255,255,255,.75);font-weight:600}
#profOv .pcard:focus .pbig,#profOv .pcard:hover .pbig{transform:scale(1.08);box-shadow:0 0 0 3px #fff}
#profOv .pcard:focus span{color:#fff}
#profOv .pcard.add .pbig{background:rgba(255,255,255,.12);font-weight:400}
#profOv .plock{font-size:.75rem;opacity:.7}
#profOv input{width:min(18rem,80vw);padding:.85rem 1rem;border-radius:.8rem;border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.1);color:#fff;font-size:max(16px,1.1rem);text-align:center;outline:none}
#profOv input:focus{border-color:#fff}
#profOv input.pin{letter-spacing:.6rem;font-size:1.6rem}
#profOv .pacts{display:flex;gap:.7rem;flex-wrap:wrap;justify-content:center}
#profOv .pbtn{padding:.75rem 1.4rem;border-radius:999px;border:0;background:rgba(255,255,255,.14);color:#fff;font:inherit;font-weight:700;cursor:pointer;outline:none}
#profOv .pbtn.pri{background:#fff;color:#000}
#profOv .pbtn:focus{box-shadow:0 0 0 3px #fff}
#profOv .pbtn.pri:focus{box-shadow:0 0 0 3px rgba(255,255,255,.5)}
#profOv .perr{color:#ff6b6b;min-height:1.2em;font-size:.9rem}
#profOv .pcolors{display:flex;gap:.6rem}
#profOv .pcol{width:2rem;height:2rem;border-radius:.5rem;border:0;cursor:pointer;outline:none}
#profOv .pcol.sel{box-shadow:0 0 0 3px rgba(255,255,255,.55)}
#profOv .pcol:focus{box-shadow:0 0 0 3px #fff}
.prof-row .prof-av{width:2.1rem;height:2.1rem;font-size:1rem;margin-right:.8rem;border-radius:.55rem}
.prof-row .meta{display:flex;align-items:center}
.prof-row .meta>div{display:flex;flex-direction:column}
</style>`);
  }
  function open(html, opts) {
    css(); close(true);
    document.body.insertAdjacentHTML('beforeend', `<div id="profOv"><div class="pbox">${html}</div></div>`);
    ov = document.getElementById('profOv');
    onClose = opts && opts.onClose || null;
    ov.dataset.locked = opts && opts.locked ? '1' : '';
    ov.addEventListener('click', e => { if (e.target === ov && !ov.dataset.locked) close(); });
    setTimeout(() => { const f = ov && (ov.querySelector('[autofocus]') || ov.querySelector('input,button')); if (f) f.focus(); }, 60);
    return ov;
  }
  function close(silent) {
    if (!ov) return;
    ov.remove(); ov = null;
    const cb = onClose; onClose = null;
    if (!silent && cb) cb();
    const b = document.getElementById('profBtn');
    if (!silent && b) b.focus({ preventScroll: true });
  }
  // Fernbedienung/Tastatur im Overlay: Pfeile wandern durch die Elemente, Zurück schließt
  window.addEventListener('keydown', e => {
    if (!ov) return;
    const k = e.key, a = document.activeElement, typing = a && a.tagName === 'INPUT';
    if (k === 'Escape' || k === 'Backspace' || k === 'GoBack' || k === 'BrowserBack') {
      if (typing && k === 'Backspace') { e.stopImmediatePropagation(); return; }
      e.preventDefault(); e.stopImmediatePropagation();
      if (!ov.dataset.locked) close();
      return;
    }
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(k)) {
      if (typing && (k === 'ArrowLeft' || k === 'ArrowRight')) { e.stopImmediatePropagation(); return; }
      e.preventDefault(); e.stopImmediatePropagation();
      const items = [...ov.querySelectorAll('input,button')];
      const i = items.indexOf(a), fwd = k === 'ArrowDown' || k === 'ArrowRight';
      const n = items[i < 0 ? 0 : Math.max(0, Math.min(items.length - 1, i + (fwd ? 1 : -1)))];
      if (n) n.focus();
      return;
    }
    if (k === 'Enter') {
      e.preventDefault(); e.stopImmediatePropagation();
      if (a && a.tagName === 'BUTTON') a.click();
      else { const pri = ov.querySelector('.pbtn.pri'); if (pri) pri.click(); }
      return;
    }
    e.stopImmediatePropagation();
  }, true);

  const card = (p, extra) => `<button class="pcard" type="button" data-pid="${h(p.id)}">
      <i class="pbig" style="background:${h(p.color || COLORS[0])}">${h(initial(p))}</i><span>${h(nameOf(p))}${extra || ''}</span>${p.pin ? '<small class="plock">🔒 PIN</small>' : ''}</button>`;

  /** „Wer schaut?“ – Profil wechseln. */
  function picker() {
    const l = list();
    open(`<h2>Wer schaut?</h2>
      <div class="pgrid">${l.map(p => card(p, p.id === active ? ' ✓' : '')).join('')}
        <button class="pcard add" type="button" data-padd><i class="pbig">+</i><span>Profil hinzufügen</span></button></div>
      <div class="pacts"><button class="pbtn" type="button" data-pmanage>Profile verwalten</button></div>`);
    const cur = ov.querySelector(`[data-pid="${active}"]`); if (cur) setTimeout(() => cur.focus(), 70);
    ov.addEventListener('click', e => {
      const c = e.target.closest('[data-pid]');
      if (c) return choose(c.dataset.pid);
      if (e.target.closest('[data-padd]')) return edit(null);
      if (e.target.closest('[data-pmanage]')) { close(true); try { show('settings'); } catch (x) {} setTimeout(() => { const g = document.getElementById('profGroup'); if (g) { g.scrollIntoView({ block: 'center' }); const f = g.querySelector('.focusable'); if (f) f.focus({ preventScroll: true }); } }, 200); }
    });
  }
  /** Name und Farbe (neu oder bearbeiten). */
  function edit(id) {
    const p = id ? byId(id) : null;
    let color = (p && p.color) || COLORS[list().length % COLORS.length];
    open(`<h2>${p ? 'Profil bearbeiten' : 'Neues Profil'}</h2>
      <input id="profName" data-nolock maxlength="20" placeholder="Name" value="${h(p ? nameOf(p) : '')}" autocomplete="off" autofocus />
      <div class="pcolors">${COLORS.map(c => `<button class="pcol ${c === color ? 'sel' : ''}" type="button" data-col="${c}" style="background:${c}" aria-label="Farbe"></button>`).join('')}</div>
      <div class="perr" id="profErr"></div>
      <div class="pacts"><button class="pbtn pri" type="button" data-psave>Speichern</button><button class="pbtn" type="button" data-pcancel>Abbrechen</button></div>`);
    ov.addEventListener('click', e => {
      const c = e.target.closest('[data-col]');
      if (c) { color = c.dataset.col; ov.querySelectorAll('.pcol').forEach(b => b.classList.toggle('sel', b === c)); return; }
      if (e.target.closest('[data-pcancel]')) return close();
      if (e.target.closest('[data-psave]')) {
        const name = document.getElementById('profName').value.trim();
        if (!name) { document.getElementById('profErr').textContent = 'Bitte einen Namen eingeben'; return; }
        const l = list();
        if (p) Object.assign(l.find(x => x.id === p.id), { name, color });
        else l.push({ id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name, color });
        saveList(l); close(true); render();
        toast(p ? 'Profil gespeichert' : `Profil „${name}“ angelegt – oben rechts wechseln`);
      }
    });
  }
  /** PIN abfragen (ok = Rückruf nach richtiger Eingabe). */
  function askPin(p, ok, locked) {
    open(`<h2>${h(nameOf(p))}</h2><div class="psub">PIN eingeben</div>
      <input id="profPin" data-nolock class="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="off" autofocus />
      <div class="perr" id="profErr"></div>
      <div class="pacts"><button class="pbtn pri" type="button" data-pok>OK</button>${locked ? '<button class="pbtn" type="button" data-pother>Anderes Profil</button>' : '<button class="pbtn" type="button" data-pcancel>Abbrechen</button>'}</div>`, { locked });
    const inp = document.getElementById('profPin');
    const go = () => {
      if (pinHash(p.id, inp.value) === p.pin) { close(true); ok(); }
      else { document.getElementById('profErr').textContent = 'Falsche PIN'; inp.value = ''; inp.focus(); }
    };
    inp.addEventListener('input', () => { if (inp.value.length >= 4 && pinHash(p.id, inp.value) === p.pin) go(); });
    ov.addEventListener('click', e => {
      if (e.target.closest('[data-pok]')) return go();
      if (e.target.closest('[data-pcancel]')) return close();
      if (e.target.closest('[data-pother]')) { ov.dataset.locked = ''; lockedPicker(); }
    });
  }
  /** Gesperrtes Profil beim Start: nur andere Profile wählbar. */
  function lockedPicker() {
    const l = list();
    open(`<h2>Wer schaut?</h2><div class="pgrid">${l.map(p => card(p)).join('')}</div>`, { locked: true });
    ov.addEventListener('click', e => {
      const c = e.target.closest('[data-pid]');
      if (!c) return;
      const p = byId(c.dataset.pid);
      if (p.id === active) return askPin(p, () => markOk(p.id), true);
      if (p.pin) return askPin(p, () => { markOk(p.id); switchTo(p.id); }, true);
      switchTo(p.id);
    });
  }
  /** PIN festlegen bzw. entfernen. */
  function setPin(id) {
    const p = byId(id);
    const run = () => {
      open(`<h2>PIN für ${h(nameOf(p))}</h2><div class="psub">4–8 Ziffern${p.pin ? ' · leer lassen = PIN entfernen' : ''}</div>
        <input id="profPin" data-nolock class="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="off" autofocus />
        <input id="profPin2" data-nolock class="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="off" placeholder="wiederholen" />
        <div class="perr" id="profErr"></div>
        <div class="pacts"><button class="pbtn pri" type="button" data-psave>Speichern</button><button class="pbtn" type="button" data-pcancel>Abbrechen</button></div>`);
      ov.addEventListener('click', e => {
        if (e.target.closest('[data-pcancel]')) return close();
        if (!e.target.closest('[data-psave]')) return;
        const a = document.getElementById('profPin').value, b = document.getElementById('profPin2').value, err = t => { document.getElementById('profErr').textContent = t; };
        const l = list(), x = l.find(q => q.id === id);
        if (!a && !b && x.pin) { delete x.pin; saveList(l); close(true); render(); return toast('PIN entfernt'); }
        if (!/^\d{4,8}$/.test(a)) return err('Bitte 4–8 Ziffern');
        if (a !== b) return err('PINs stimmen nicht überein');
        x.pin = pinHash(id, a); saveList(l); markOk(id); close(true); render(); toast('PIN gespeichert');
      });
    };
    if (p.pin && !okSet().has(id)) askPin(p, () => { markOk(id); run(); }); else run();
  }
  async function remove(id) {
    const p = byId(id);
    if (!p || id === 'main' || id === active) return;
    const go = async () => {
      if (!confirm(`Profil „${nameOf(p)}“ mit Verlauf, Favoriten und Merkliste löschen?`)) return;
      saveList(list().filter(x => x.id !== id));
      for (const k of SCOPED) { try { base.removeItem(k + '@' + id); } catch (e) {} }
      try { if (typeof ACC !== 'undefined' && ACC.connected && await ACC.ensureToken()) await ACC.http('DELETE', '/rest/v1/store?key=like.*%40' + encodeURIComponent(id)); } catch (e) {}
      render(); toast('Profil gelöscht');
    };
    if (p.pin && !okSet().has(id)) askPin(p, () => { markOk(id); go(); }); else go();
  }

  /** Kopfzeile + Einstellungen aktualisieren. */
  function render() {
    css();
    const cur = current();
    const st = document.querySelector('header .status');
    if (st) {
      let b = document.getElementById('profBtn');
      if (!b) {
        st.insertAdjacentHTML('afterbegin', '<button class="pill focusable prof-btn" id="profBtn" type="button" aria-label="Profil wechseln"></button>');
        b = document.getElementById('profBtn');
        b.addEventListener('click', e => { e.stopPropagation(); picker(); });
      }
      b.innerHTML = `<span class="prof-av" style="background:${h(cur.color || COLORS[0])}">${h(initial(cur))}</span><span>${h(nameOf(cur))}</span>`;
    }
    const set = document.querySelector('#view-settings .settings');
    if (!set) return;
    let g = document.getElementById('profGroup');
    if (!g) {
      const anchor = document.getElementById('accGroup') || set.querySelector('.large-title');
      anchor.insertAdjacentHTML('afterend', '<div class="group-title">Profile</div><div class="group" id="profGroup"></div><p class="group-foot">Jedes Profil hat eigenen Verlauf, Weiterschauen, Favoriten, Statistik und Einstellungen. IPTV-Zugang und Konto sind gemeinsam. Zusatzprofile haben statt der Serien-Watchlist eine eigene Merkliste in StreamTV.</p>');
      g = document.getElementById('profGroup');
      g.addEventListener('click', e => {
        e.stopPropagation();
        const t = e.target.closest('[data-pa]');
        if (!t) return;
        const id = t.dataset.id;
        ({ go: () => choose(id), edit: () => edit(id), pin: () => setPin(id), del: () => remove(id), add: () => edit(null) })[t.dataset.pa]();
      });
    }
    const had = document.activeElement && g.contains(document.activeElement) ? [document.activeElement.dataset.pa, document.activeElement.dataset.id] : null;
    g.innerHTML = list().map(p => `<div class="row-item prof-row"><div class="meta"><span class="prof-av" style="background:${h(p.color || COLORS[0])}">${h(initial(p))}</span>
        <div><b>${h(nameOf(p))}${p.id === active ? ' · aktiv' : ''}</b><small>${p.id === 'main' ? 'Hauptprofil · Serien-Watchlist' : 'Eigene Merkliste'}${p.pin ? ' · 🔒 PIN' : ''}</small></div></div>
      <div class="actions">${p.id !== active ? `<button class="mini primary focusable" data-pa="go" data-id="${h(p.id)}" type="button">Wechseln</button>` : ''}
        <button class="mini focusable" data-pa="edit" data-id="${h(p.id)}" type="button">Bearbeiten</button>
        <button class="mini focusable" data-pa="pin" data-id="${h(p.id)}" type="button">${p.pin ? 'PIN ändern' : 'PIN'}</button>
        ${p.id !== 'main' && p.id !== active ? `<button class="mini focusable" data-pa="del" data-id="${h(p.id)}" type="button">Löschen</button>` : ''}</div></div>`).join('')
      + `<div class="row-item"><div class="meta"><b>Profil hinzufügen</b><small>z. B. für Familie – gleicher Zugang, eigener Verlauf</small></div><div class="actions"><button class="mini focusable" data-pa="add" type="button">+ Neu</button></div></div>`;
    if (had) { const f = g.querySelector(`[data-pa="${had[0]}"]${had[1] ? `[data-id="${had[1]}"]` : ''}`); if (f) f.focus({ preventScroll: true }); }
  }
  /** Profil-Liste aus der Cloud geändert (sync.js). */
  function changed() {
    if (!byId(active)) { try { base.setItem(ACTIVE, 'main'); } catch (e) {} location.reload(); return; }
    render();
  }
  function init() {
    render();
    setTimeout(render, 1500);   // Name des Hauptprofils kommt aus dem Konto
    const p = current();
    if (p.pin && !okSet().has(p.id)) askPin(p, () => markOk(p.id), true);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(init, 0));
  else setTimeout(init, 0);

  return { side, id: () => active, list, current, cloudKey, patchWL, render, changed, picker, LIST, works: () => works };
})();
