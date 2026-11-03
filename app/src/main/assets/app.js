/* =====================================================================
   StreamTV – App-Logik
   ===================================================================== */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initials = n => String(n).split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
const uid = () => Math.random().toString(36).slice(2, 10);
const hash = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
const bridge = window.StreamTVApp || null;   // nur in der Fire-TV-App vorhanden

const KEY = { ch: 'streamtv.channels', fav: 'streamtv.favs', src: 'streamtv.sources', set: 'streamtv.settings', recent: 'streamtv.recent' };
const NAV_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
const RAIL_MAX = 30, ROWS_MAX = 15, GRID_MAX = 300, LIST_MAX = 200;
const DEMO_URL = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';
const DEMO = ['Nachrichten', 'Nachrichten', 'Sport', 'Sport', 'Filme', 'Filme']
  .map((g, i) => ({ id: 'demo_' + i, src: 'demo', name: `Demo ${g} ${i % 2 + 1}`, group: g, logo: '', url: DEMO_URL }));
const DEFAULT_SETTINGS = { autoRefresh: true, vpnAuto: true, vpnReq: false, tmdbKey: '' };

let state = { channels: [], favs: [], recent: [], sources: [], settings: { ...DEFAULT_SETTINGS }, cat: 'Alle', view: 'home' };
let playerOpen = false, sheetOpen = false, currentId = null, osdTimer = null, lastFocus = null, playerFocus = null, vod = null, editId = null, xtFmt = 'm3u8';

/* ================= Daten ================= */
function load() {
  try {
    const raw = localStorage.getItem(KEY.ch);
    state.channels = raw === null ? DEMO.map(c => ({ ...c })) : JSON.parse(raw);
    state.favs = JSON.parse(localStorage.getItem(KEY.fav) || '[]');
    state.recent = JSON.parse(localStorage.getItem(KEY.recent) || '[]');
    state.sources = JSON.parse(localStorage.getItem(KEY.src) || '[]');
    state.settings = { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(KEY.set) || '{}') };
  } catch (e) { state.channels = DEMO.map(c => ({ ...c })); }
  for (const c of state.channels) if (!c.src) c.src = c.url === DEMO_URL ? 'demo' : 'manual';
  for (const s of state.sources) s.loading = false;
}
function persist() {
  try {
    localStorage.setItem(KEY.ch, JSON.stringify(state.channels));
    localStorage.setItem(KEY.fav, JSON.stringify(state.favs));
    localStorage.setItem(KEY.recent, JSON.stringify(state.recent));
    localStorage.setItem(KEY.src, JSON.stringify(state.sources));
    localStorage.setItem(KEY.set, JSON.stringify(state.settings));
  } catch (e) { toast('Speicher voll – nicht alle Daten gespeichert'); }
}
function parseM3U(text, srcId) {
  const out = [], seen = new Set();
  let meta = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const attr = k => (line.match(new RegExp(k + '="([^"]*)"')) || [])[1] || '';
      meta = { name: line.slice(line.lastIndexOf(',') + 1).trim() || attr('tvg-name') || 'Unbenannt', group: attr('group-title') || 'Sonstige', logo: attr('tvg-logo') };
    } else if (line.startsWith('#EXTGRP:') && meta) {
      meta.group = line.slice(8).trim() || meta.group;
    } else if (!line.startsWith('#') && meta) {
      const base = srcId + '_' + hash(line + meta.name);
      let id = base, n = 1;
      while (seen.has(id)) id = base + '_' + n++;
      seen.add(id);
      out.push({ id, src: srcId, ...meta, url: line });
      meta = null;
    }
  }
  return out;
}
const byId = id => state.channels.find(c => c.id === id);
const isFav = id => state.favs.includes(id);
const favList = () => state.favs.map(byId).filter(Boolean);
const recentList = () => state.recent.map(byId).filter(Boolean);
function groups(list = state.channels) {
  const m = new Map();
  for (const c of list) { if (!m.has(c.group)) m.set(c.group, []); m.get(c.group).push(c); }
  return m;
}
function pruneRefs() {
  const ids = new Set(state.channels.map(c => c.id));
  state.favs = state.favs.filter(id => ids.has(id));
  state.recent = state.recent.filter(id => ids.has(id));
}
function toggleFav(id) {
  if (!id) return;
  state.favs = isFav(id) ? state.favs.filter(x => x !== id) : [...state.favs, id];
  refresh();
  if (playerOpen) $('#pFav').textContent = isFav(currentId) ? '★' : '☆';
  toast(isFav(id) ? '★ Zu Favoriten hinzugefügt' : 'Aus Favoriten entfernt');
}

/* ================= Quellen (M3U & Xtream) ================= */
function vpnHint() {
  const v = vpn();
  return v && v.active ? ' Tipp: Viele IPTV-Anbieter sperren VPN-Server – testweise ProtonVPN trennen.' : '';
}
async function getText(url, ms = 90000) {
  let r;
  try { r = await request('GET', url, { timeout: ms }); }
  catch (e) {
    throw new Error(e.message === 'Zeitüberschreitung'
      ? 'Zeitüberschreitung – Server antwortet nicht.' + vpnHint()
      : 'Server nicht erreichbar – Adresse und Port prüfen (z. B. http://server.tv:8080).' + vpnHint());
  }
  if ((r.status >= 200 && r.status < 300) || (r.status === 0 && r.text)) return r.text.replace(/^﻿/, '');
  if (r.status === 401 || r.status === 403) throw new Error(`Zugriff verweigert (HTTP ${r.status}).` + (vpnHint() || ' Zugangsdaten oder Anbieter-Sperre prüfen.'));
  if (r.status === 404) throw new Error('Adresse nicht gefunden (HTTP 404) – Server-URL prüfen.');
  if (r.status === 0) throw new Error('Keine Antwort vom Server.' + vpnHint());
  throw new Error('Serverfehler (HTTP ' + r.status + ').');
}
async function getJSON(url) {
  const t = (await getText(url)).trim();
  try { return JSON.parse(t); }
  catch (e) { throw new Error('Ungültige Antwort vom Server: „' + t.slice(0, 60).replace(/\s+/g, ' ') + '“'); }
}
function normServer(s) {
  s = s.trim().replace(/\/+$/, '').replace(/\/(player_api|get|xmltv)\.php.*$/i, '').replace(/\/c$/i, '');
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  return s;
}
/** Erkennt eingefügte Komplett-Links wie http://host:port/get.php?username=…&password=… */
function parseXtreamLink(text) {
  try {
    const u = new URL(/^https?:\/\//i.test(text.trim()) ? text.trim() : 'http://' + text.trim());
    const user = u.searchParams.get('username'), pass = u.searchParams.get('password');
    if (!user || !pass) return null;
    return { server: u.protocol + '//' + u.host, user, pass };
  } catch (e) { return null; }
}
async function xtreamViaM3U(base, u, p, src) {
  const out = src.format === 'ts' ? 'ts' : 'm3u8';
  const list = parseM3U(await getText(`${base}/get.php?username=${u}&password=${p}&type=m3u_plus&output=${out}`), src.id);
  if (!list.length) throw new Error('Keine Kanäle gefunden');
  src.info = 'Geladen über die M3U-Schnittstelle des Anbieters';
  return list;
}
async function fetchSource(src) {
  if (src.type === 'm3u') {
    const list = parseM3U(await getText(src.url, 60000), src.id);
    if (!list.length) throw new Error('Keine Kanäle in der Playlist gefunden');
    src.info = '';
    return list;
  }
  const base = normServer(src.server);
  const u = encodeURIComponent(src.user), p = encodeURIComponent(src.pass);
  const api = `${base}/player_api.php?username=${u}&password=${p}`;
  let info;
  try { info = await getJSON(api); }
  catch (e) {
    // Manche Anbieter sperren die API, liefern aber die M3U-Liste aus
    try { return await xtreamViaM3U(base, u, p, src); } catch (e2) { throw e; }
  }
  const ui = info && info.user_info;
  if (!ui || Number(ui.auth) === 0) throw new Error('Anmeldung fehlgeschlagen – Benutzername oder Passwort falsch.');
  if (ui.status && !/^active$/i.test(ui.status)) throw new Error(`Zugang ist „${ui.status}“ – beim Anbieter prüfen.`);
  const exp = ui.exp_date ? new Date(Number(ui.exp_date) * 1000).toLocaleDateString('de-DE') : 'unbegrenzt';
  src.info = `${ui.status || 'Aktiv'} · gültig bis ${exp}` + (ui.max_connections ? ` · max. ${ui.max_connections} Verbindung(en)` : '');
  const cats = await getJSON(api + '&action=get_live_categories');
  const order = new Map(), names = new Map();
  (Array.isArray(cats) ? cats : []).forEach((c, i) => { order.set(String(c.category_id), i); names.set(String(c.category_id), c.category_name); });
  const streams = await getJSON(api + '&action=get_live_streams');
  if (!Array.isArray(streams) || !streams.length) throw new Error('Keine Live-Kanäle gefunden');
  const ext = src.format === 'ts' ? 'ts' : 'm3u8';
  return streams
    .map((s, i) => ({ s, i, o: order.has(String(s.category_id)) ? order.get(String(s.category_id)) : 1e9 }))
    .sort((a, b) => a.o - b.o || a.i - b.i)
    .map(({ s }) => ({
      id: `${src.id}_${s.stream_id}`, src: src.id, name: s.name || 'Unbenannt',
      group: names.get(String(s.category_id)) || 'Sonstige', logo: s.stream_icon || '',
      url: `${base}/live/${u}/${p}/${s.stream_id}.${ext}`
    }));
}
async function refreshSource(src, quiet) {
  src.loading = true; renderSettings();
  try {
    const list = await fetchSource(src);
    state.channels = state.channels.filter(c => c.src !== src.id && c.src !== 'demo').concat(list);
    pruneRefs();
    Object.assign(src, { count: list.length, updated: Date.now(), error: '' });
    if (!quiet) toast(`${src.name}: ${list.length} Kanäle geladen`);
    return true;
  } catch (e) {
    src.error = e.message;
    if (!quiet) toast(`${src.name}: ${e.message}`);
    return false;
  } finally { src.loading = false; refresh(); }
}
async function addSource(src) {
  state.sources.push(src);
  const ok = await refreshSource(src);
  if (!ok) { state.sources = state.sources.filter(s => s !== src); refresh(); }
  return ok;
}
function removeSource(id) {
  const s = state.sources.find(x => x.id === id);
  if (!s || !confirm(`Quelle „${s.name}“ mit allen Kanälen entfernen?`)) return;
  state.sources = state.sources.filter(x => x.id !== id);
  state.channels = state.channels.filter(c => c.src !== id);
  pruneRefs(); refresh();
}

/* ================= Rendering: Kacheln ================= */
function tileHTML(c) {
  const n = EPG.now(c.id), prog = n && n.cur ? n.cur.t : '';
  return `<div class="tile focusable" tabindex="0" data-card="${esc(c.id)}">
    <div class="art"><span class="ini">${esc(initials(c.name))}</span>
      ${c.logo ? `<img class="logo" src="${esc(c.logo)}" alt="" loading="lazy" onerror="this.remove()">` : ''}
      <button class="star ${isFav(c.id) ? 'on' : ''}" tabindex="-1" data-fav="${esc(c.id)}" aria-label="Favorit">★</button>
    </div>
    <div class="caption">${esc(c.name)}</div>${prog ? `<div class="sub">${esc(prog)}</div>` : ''}
  </div>`;
}
/* ---------- EPG auf Kacheln und im Player ---------- */
function epgPatch(id) {
  const n = EPG.now(id), t = n && n.cur ? n.cur.t : '';
  for (const el of document.querySelectorAll(`.tile[data-card="${CSS.escape(id)}"]`)) {
    let sub = el.querySelector('.sub');
    if (!t) { if (sub) sub.remove(); continue; }
    if (!sub) { sub = document.createElement('div'); sub.className = 'sub'; el.appendChild(sub); }
    if (sub.textContent !== t) sub.textContent = t;
  }
  if (playerOpen && id === currentId) renderOsdEpg();
}
function renderOsdEpg() {
  const box = $('#pEpg'), n = !vod && currentId ? EPG.now(currentId) : null;
  box.classList.toggle('hidden', !n);
  if (!n) return;
  const now = Date.now() / 1000, c = n.cur, x = n.next;
  $('#eNowRow').classList.toggle('hidden', !c);
  $('#eProg').classList.toggle('hidden', !c);
  $('#eNextRow').classList.toggle('hidden', !x);
  if (c) {
    $('#eNowT').textContent = `${hhmm(c.s)}–${hhmm(c.e)}`;
    $('#eNow').textContent = c.t;
    $('#eBar').style.width = Math.min(100, Math.max(0, (now - c.s) / (c.e - c.s) * 100)).toFixed(1) + '%';
    $('#eLeft').textContent = `noch ${Math.max(1, Math.round((c.e - now) / 60))} Min.`;
  }
  if (x) { $('#eNextT').textContent = hhmm(x.s); $('#eNext').textContent = x.t; }
}
function showTileHTML(p, rank) {
  const img = p.backdrop ? `${TM.IMG}w780${p.backdrop}` : p.poster ? `${TM.IMG}w500${p.poster}` : '';
  return `<div class="tile show focusable" tabindex="0" data-show="${p.type}:${p.id}">
    <div class="art">${img ? `<img class="bd" src="${img}" alt="" loading="lazy">` : ''}<div class="shade"></div>
      ${rank ? `<span class="rank">${rank}</span>` : ''}<div class="t">${esc(p.title)}</div></div>
    <div class="caption">${esc(p.reason || TM.info(p))}</div>
  </div>`;
}
function resumeTileHTML(v) {
  const m = v.m, pct = v.dur ? Math.min(100, v.pos / v.dur * 100) : 0;
  const left = v.dur ? Math.max(1, Math.round((v.dur - v.pos) / 60)) : 0;
  return `<div class="tile show cont focusable" tabindex="0" data-resume="${esc(v.id)}">
    <div class="art">${m.img ? `<img class="bd" src="${esc(m.img)}" alt="" loading="lazy" onerror="this.remove()">` : `<span class="ini">${esc(initials(m.show))}</span>`}
      <div class="shade"></div><span class="ep-badge">${m.movie ? 'Film' : `S${esc(m.season)} E${esc(m.num)}`}</span>
      <div class="t">${esc(m.show)}</div><span class="pbar"><i style="width:${pct.toFixed(1)}%"></i></span></div>
    <div class="caption">${esc([m.movie ? '' : m.title, left ? `noch ${left} Min.` : ''].filter(Boolean).join(' · ')) || '&nbsp;'}</div>
  </div>`;
}
function continueRail() {
  const list = VP.continueList();
  return list.length ? railHTML('Weiterschauen', list.map(resumeTileHTML).join('')) : '';
}
const skeletons = n => Array.from({ length: n }, () => `<div class="tile show skeleton"><div class="art"></div><div class="caption">&nbsp;</div></div>`).join('');
function railHTML(title, inner, count) {
  return `<section><div class="section-label">${esc(title)}${count != null ? ` <small>${count}</small>` : ''}</div><div class="rail">${inner}</div></section>`;
}
function channelRail(title, list, catKey) {
  if (!list.length) return '';
  const more = catKey && list.length > RAIL_MAX
    ? `<div class="tile more focusable" tabindex="0" data-cat="${esc(catKey)}"><div class="art"><span>Alle ${list.length} →</span></div><div class="caption">&nbsp;</div></div>` : '';
  return railHTML(title, list.slice(0, RAIL_MAX).map(tileHTML).join('') + more, list.length);
}

/* ================= Rendering: Ansichten ================= */
function renderChips() {
  const names = ['Alle', ...groups().keys()];
  $('#chips').innerHTML = names.map(n => `<button class="chip focusable ${state.cat === n ? 'active' : ''}" data-cat="${esc(n)}">${esc(n)}</button>`).join('');
}
function renderHome() {
  const g = groups();
  if (state.cat !== 'Alle' && !g.has(state.cat)) state.cat = 'Alle';
  renderChips();
  $('#liveCount').textContent = state.channels.length ? state.channels.length + ' Sender' : '';
  $('#homeTop').innerHTML = continueRail() + channelRail('Meine Favoriten', favList()) + channelRail('Zuletzt gesehen', recentList());

  let rows = '';
  if (state.cat === 'Alle') {
    let n = 0;
    for (const [name, list] of g) { if (n++ >= ROWS_MAX) break; rows += channelRail(name, list, name); }
    if (g.size > ROWS_MAX) rows += `<p class="empty">Weitere ${g.size - ROWS_MAX} Kategorien oben in der Leiste.</p>`;
  } else {
    const list = g.get(state.cat) || [];
    rows = `<div class="grid">${list.slice(0, GRID_MAX).map(tileHTML).join('')}</div>` +
      (list.length > GRID_MAX ? `<p class="empty">Weitere ${list.length - GRID_MAX} Sender über die Suche.</p>` : '');
  }
  $('#homeRows').innerHTML = rows || `<p class="empty">Noch keine Sender. Unter „Einstellungen“ eine M3U-Playlist oder einen Xtream-Zugang hinzufügen.</p>`;
  EPG.scan();
  if (!heroItems.length) renderHero();
}
function discoverRowsHTML(ids) {
  const tabs = TM.tabs().filter(t => !ids || ids.includes(t.id));
  return tabs.map(t => {
    let items = TM.list(t.id);
    if (t.rank) items = items.slice(0, 10);
    if (!items.length) return TM.loading.has(t.id) || !TM.cache[t.id] ? railHTML(t.label, skeletons(5)) : '';
    return railHTML(t.label, items.map((p, i) => showTileHTML(p, t.rank ? i + 1 : 0)).join(''));
  }).join('');
}
function renderDiscover() {
  keepFocus(() => {
    if (!TM.key()) {
      $('#homeDiscover').innerHTML = '';
      $('#discoverRows').innerHTML = `<div class="pad"><div class="group"><div class="row-item"><div class="meta"><b>Serien-Empfehlungen einrichten</b>
        <small>Melde dich mit deinem Serien-Watchlist-Konto an oder hinterlege einen TMDB-Schlüssel.</small></div>
        <div class="actions"><button class="btn primary small focusable" data-view="settings">Zu den Einstellungen</button></div></div></div></div>`;
      return;
    }
    $('#homeDiscover').innerHTML = discoverRowsHTML(['forYou', 'top']);
    $('#discoverRows').innerHTML = discoverRowsHTML(null);
  });
}
function renderSearch() {
  const q = $('#q').value.trim().toLowerCase();
  const res = q ? state.channels.filter(c => (c.name + ' ' + c.group).toLowerCase().includes(q)) : [];
  $('#searchInfo').textContent = q ? `${res.length} Sender` + (res.length > GRID_MAX ? ` – die ersten ${GRID_MAX} werden angezeigt` : '') : '';
  $('#searchGrid').innerHTML = !q ? `<p class="empty">Sender, Kategorie, Serie oder Film eingeben.</p>`
    : res.length ? res.slice(0, GRID_MAX).map(tileHTML).join('') : '';
  EPG.scan();
}
let searchTimer = null;
function searchShows() {
  clearTimeout(searchTimer);
  const q = $('#q').value.trim();
  if (q.length < 2 || !TM.key()) { $('#searchShows').innerHTML = ''; return; }
  searchTimer = setTimeout(async () => {
    try {
      const res = await TM.search(q);
      if ($('#q').value.trim() !== q) return;
      keepFocus(() => { $('#searchShows').innerHTML = res.length ? railHTML('Serien & Filme', res.slice(0, 20).map(p => showTileHTML(p)).join(''), res.length) : ''; });
    } catch (e) { $('#searchShows').innerHTML = ''; }
  }, 450);
}
function renderFavs() {
  const f = favList();
  $('#favGrid').innerHTML = f.length ? f.map(tileHTML).join('')
    : `<p class="empty">Noch keine Favoriten. Auf einem Sender die Menü-Taste (≡) drücken oder im Player ☆ wählen.</p>`;
  EPG.scan();
}
function srcName(id) {
  if (id === 'manual') return 'Manuell';
  if (id === 'demo') return 'Demo';
  return (state.sources.find(s => s.id === id) || {}).name || 'Quelle';
}
function renderManage() {
  const q = $('#mq').value.trim().toLowerCase();
  const list = q ? state.channels.filter(c => (c.name + ' ' + c.group).toLowerCase().includes(q)) : state.channels;
  $('#count').textContent = state.channels.length;
  $('#manageList').innerHTML = list.length ? list.slice(0, LIST_MAX).map(c => `
    <div class="row-item">
      <div class="meta"><b>${esc(c.name)}</b><small>${esc(c.group)} · ${esc(srcName(c.src))}</small></div>
      <div class="actions">
        <button class="mini focusable" data-act="fav" data-id="${esc(c.id)}">${isFav(c.id) ? '★' : '☆'}</button>
        ${c.src === 'manual' ? `<button class="mini focusable" data-act="edit" data-id="${esc(c.id)}">Bearbeiten</button>` : ''}
        <button class="mini focusable" data-act="del" data-id="${esc(c.id)}">Löschen</button>
      </div>
    </div>`).join('') + (list.length > LIST_MAX ? `<div class="row-item"><small class="hint">${list.length - LIST_MAX} weitere – Filter nutzen.</small></div>` : '')
    : `<div class="row-item"><span class="hint">Keine Kanäle.</span></div>`;
}
function renderSettings() {
  const s = state.settings;
  $('#swAuto').classList.toggle('on', !!s.autoRefresh);
  $('#swVpnAuto').classList.toggle('on', !!s.vpnAuto);
  $('#swVpnReq').classList.toggle('on', !!s.vpnReq);
  $('#sourceList').innerHTML = state.sources.length ? state.sources.map(x => `
    <div class="row-item">
      <div class="meta">
        <b>${esc(x.name)}</b>
        <small>${x.type === 'm3u' ? 'M3U-Link' : 'Xtream Codes · ' + (x.format === 'ts' ? 'MPEG-TS' : 'HLS')} · ${x.count || 0} Kanäle${x.updated ? ' · ' + new Date(x.updated).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : ''}</small>
        ${x.info ? `<small>${esc(x.info)}</small>` : ''}
        ${x.loading ? `<small>Lädt …</small>` : x.error ? `<small class="err">Fehler: ${esc(x.error)}</small>` : ''}
      </div>
      <div class="actions">
        <button class="mini focusable" data-src-act="refresh" data-id="${esc(x.id)}">Aktualisieren</button>
        <button class="mini focusable" data-src-act="del" data-id="${esc(x.id)}">Entfernen</button>
      </div>
    </div>`).join('') : `<div class="row-item"><span class="hint">Noch keine Quelle – oben einen M3U-Link oder Xtream-Zugang hinzufügen.</span></div>`;
  renderWlGroup();
  renderVpn();
}
function renderWlGroup() {
  const own = (state.settings.tmdbKey || '').trim();
  let html = '';
  if (WL.connected) {
    const n = (WL.s.items || []).length;
    html += `<div class="row-item"><div class="meta"><b>Serien-Watchlist: ${esc(WL.s.email || 'angemeldet')}</b>
      <small>${n} Titel auf der Watchlist · TMDB-Schlüssel ${WL.s.tmdb ? '✓' : 'fehlt im Konto'}</small></div>
      <div class="actions"><button class="mini focusable" id="wlReload">Empfehlungen neu laden</button><button class="mini focusable" id="wlLogout">Abmelden</button></div></div>`;
  } else {
    html += `<div class="form-grid">
      <input class="focusable field" id="wlMail" type="email" placeholder="E-Mail (Serien-Watchlist)" autocomplete="off" />
      <input class="focusable field" id="wlPass" type="password" placeholder="Passwort" autocomplete="off" />
    </div><div class="form-actions"><button class="btn primary small focusable" id="wlLogin" type="button">Anmelden</button></div>`;
  }
  html += `<div class="form-grid"><input class="focusable field" id="tmdbKey" placeholder="Eigener TMDB-Schlüssel (optional)" value="${esc(own)}" autocomplete="off" /></div>
    <div class="form-actions"><button class="btn small focusable" id="tmdbSave" type="button">Schlüssel speichern</button></div>`;
  const active = document.activeElement && document.activeElement.closest && document.activeElement.closest('#wlGroup');
  if (active && document.activeElement.tagName === 'INPUT') return; // Eingabe nicht unterbrechen
  $('#wlGroup').innerHTML = html;
}
function renderAll() { renderHome(); renderSearch(); renderFavs(); renderManage(); renderSettings(); renderDiscover(); }
function focusSel(a) {
  const d = a && a.dataset;
  if (!d) return null;
  for (const k of ['card', 'show', 'cat', 'resume']) if (d[k]) return `[data-${k}="${CSS.escape(d[k])}"]`;
  return null;
}
const visibleOf = sel => [...document.querySelectorAll(sel)].find(e => e.getClientRects().length);
function keepFocus(fn) {
  const sel = focusSel(document.activeElement);
  fn();
  if (sel && (!document.activeElement || document.activeElement === document.body)) {
    const el = visibleOf(sel);
    if (el) el.focus({ preventScroll: true });
  }
}
function refresh() { persist(); keepFocus(() => { renderHome(); renderSearch(); renderFavs(); renderManage(); renderSettings(); }); }
let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('off');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('off'), 3500);
}

/* ================= Hero (Top-Serien, sonst Live-Sender) ================= */
let heroItems = [], heroIdx = 0, heroTimer = null;
function setupHero() {
  heroItems = TM.list('top').filter(p => p.backdrop).slice(0, 5);
  heroIdx = 0;
  renderHero();
  clearInterval(heroTimer);
  if (heroItems.length > 1) heroTimer = setInterval(() => {
    if (state.view !== 'home' || playerOpen || sheetOpen || $('#hero').contains(document.activeElement)) return;
    heroIdx = (heroIdx + 1) % heroItems.length;
    renderHero();
  }, 9000);
}
function renderHero() {
  const bg = $('#heroBg'), box = $('#heroContent');
  if (heroItems.length) {
    const p = heroItems[heroIdx];
    const url = `${TM.IMG}w1280${p.backdrop}`;
    const img = new Image();
    img.onload = () => { bg.style.backgroundImage = `url("${url}")`; bg.classList.add('show'); };
    bg.classList.remove('show');
    img.src = url;
    const d = TM.details_[p.type + ':' + p.id];
    const logo = d && TM.pickLogo(d);
    box.innerHTML = `<div class="eyebrow">Top 10 Serien · Platz ${heroIdx + 1}</div>
      ${logo ? `<img class="hero-logo" src="${TM.IMG}w500${logo}" alt="">` : `<h1>${esc(p.title)}</h1>`}
      <div class="meta">${esc(TM.info(p))}</div>
      <p class="ov">${esc(p.overview)}</p>
      <div class="btn-row"><button class="btn primary focusable" data-show="${p.type}:${p.id}">Details</button>
      <button class="btn focusable" data-livesearch="${esc(p.title)}">Im Live-TV suchen</button></div>`;
    $('#heroDots').innerHTML = heroItems.map((_, i) => `<i class="${i === heroIdx ? 'on' : ''}"></i>`).join('');
    if (!d) TM.details(p.type, p.id).then(() => { if (heroItems[heroIdx] === p && !$('#hero').contains(document.activeElement)) renderHero(); }).catch(() => {});
    return;
  }
  bg.classList.remove('show');
  $('#heroDots').innerHTML = '';
  const feat = favList()[0] || recentList()[0] || state.channels[0];
  box.innerHTML = feat
    ? `<div class="eyebrow">Live · ${esc(feat.group)}</div><h1>${esc(feat.name)}</h1>
       <div class="meta">${isFav(feat.id) ? 'Dein Favorit' : 'Jetzt im Programm'}</div>
       <div class="btn-row"><button class="btn primary focusable" data-card="${esc(feat.id)}">▶ Abspielen</button></div>`
    : `<div class="eyebrow">Willkommen</div><h1>StreamTV</h1><p class="ov">Füge unter „Einstellungen“ eine M3U-Playlist oder einen Xtream-Zugang hinzu.</p>
       <div class="btn-row"><button class="btn primary focusable" data-view="settings">Einrichten</button></div>`;
}

/* ================= Entdecken laden ================= */
async function loadDiscover(force) {
  try {
    if (WL.connected) {
      await WL.refreshItems(force).catch(() => {});
      WL.flush().then(n => { if (n) toast(`Watchlist: ${n} gesehene Folge${n > 1 ? 'n' : ''} nachgetragen`); }).catch(() => {});
      if (!TM.key()) await WL.tmdbKey().catch(() => {});
    }
  } catch (e) {}
  if (!TM.key()) { renderDiscover(); renderHero(); return; }
  renderDiscover();
  await Promise.all(TM.tabs().map(t => TM.ensure(t, force).catch(() => {}).then(() => {
    renderDiscover();
    if (t.id === 'top') setupHero();
  })));
}

/* ================= Detailansicht (Serie) ================= */
async function openSheet(key) {
  const p = TM.find(key);
  if (!p) return;
  if (!sheetOpen) { lastFocus = document.activeElement; sheetOpen = true; pushOverlay('sheet'); $('#sheet').classList.add('open'); }
  renderSheet(p, TM.details_[key]);
  if (!TM.details_[key]) {
    try { const d = await TM.details(p.type, p.id); if (sheetOpen && !ip) renderSheet(p, d); } catch (e) {}
  }
}
function renderSheet(p, d) {
  const key = p.type + ':' + p.id;
  const bd = (d && d.backdrop_path) || p.backdrop;
  $('#sheetBd').style.backgroundImage = bd ? `url("${TM.IMG}w1280${bd}")` : 'none';
  const logo = d && TM.pickLogo(d);
  const genres = d ? TM.genres(d).slice(0, 3) : [];
  const seasons = d && d.number_of_seasons ? `${d.number_of_seasons} Staffel${d.number_of_seasons > 1 ? 'n' : ''}`
    : d && d.runtime ? `${Math.floor(d.runtime / 60) ? Math.floor(d.runtime / 60) + ' Std. ' : ''}${d.runtime % 60} Min.` : null;
  const meta = [TM.info(p), seasons, genres.join(', ') || null].filter(Boolean).join(' · ');
  const prov = d ? TM.providersDE(d) : [];
  const onList = WL.connected && WL.keys().has(key);
  const focusedId = document.activeElement && document.activeElement.id;
  $('#sheetInner').innerHTML = `
    ${logo ? `<img class="logo-img" src="${TM.IMG}w500${logo}" alt="">` : `<h1>${esc(p.title)}</h1>`}
    ${p.reason ? `<div class="reason">${esc(p.reason)}</div>` : ''}
    <div class="meta">${esc(meta)}</div>
    <p class="ov">${esc((d && d.overview) || p.overview || 'Keine Beschreibung vorhanden.')}</p>
    ${prov.length ? `<div class="prov">${prov.map(n => `<span>${esc(n)}</span>`).join('')}</div>` : ''}
    <div class="btn-row">
      <button class="btn primary focusable" id="shIptv" data-iptv="${key}">▶ Beim Anbieter suchen</button>
      ${WL.connected ? `<button class="btn focusable" id="shAdd" ${onList ? 'disabled' : ''}>${onList ? '✓ Auf deiner Watchlist' : '+ Auf die Watchlist'}</button>` : ''}
      <button class="btn focusable" id="shLive" data-livesearch="${esc(p.title)}">Im Live-TV suchen</button>
      <button class="btn focusable" id="shClose">Schließen</button>
    </div>`;
  const add = $('#shAdd');
  if (add && !onList) add.onclick = async () => {
    add.disabled = true; add.textContent = 'Speichere …';
    try {
      const det = d || await TM.details(p.type, p.id);
      await WL.addPlanned(p.type, det);
      toast(`„${p.title}“ steht jetzt auf deiner Watchlist`);
      renderSheet(p, det); renderDiscover();
      $('#shLive').focus();
    } catch (e) { toast(e.message); add.disabled = false; add.textContent = '+ Auf die Watchlist'; }
  };
  $('#shClose').onclick = () => closeSheet();
  const target = (focusedId && $('#' + focusedId)) || $('#sheet .btn:not(:disabled)');
  if (target) target.focus({ preventScroll: true });
}
function closeSheet(fromPop) {
  if (!sheetOpen) return;
  if (ip) {   // IPTV-Seite liegt noch auf dem Verlauf
    const i = overlays.lastIndexOf('iptv');
    if (i >= 0) overlays.splice(i, 1);
    ip = null; $('#sheet').classList.remove('iptv');
    if (!fromPop) { const j = overlays.lastIndexOf('sheet'); if (j >= 0) overlays.splice(j, 1); skipPops++; history.go(-2); fromPop = true; }
  }
  sheetOpen = false;
  $('#sheet').classList.remove('open');
  if (!fromPop) popOverlay('sheet');
  if (lastFocus && lastFocus.isConnected) lastFocus.focus({ preventScroll: true });
}
function liveSearch(title) {
  if (sheetOpen) closeSheet();
  show('search');
  $('#q').value = title;
  renderSearch(); searchShows();
}

/* ================= Serie beim IPTV-Anbieter ================= */
let ip = null;   // { p, d, status, msg, hits, sel, info, season, token }
async function openIptv(key) {
  const p = TM.find(key);
  if (!p || !sheetOpen) return;
  const d = TM.details_[key] || null;
  ip = { p, d, status: 'loading', msg: '', hits: [], sel: null, info: null, season: null, token: Date.now() };
  pushOverlay('iptv');
  $('#sheet').classList.add('iptv');
  renderIptv();
  const tok = ip.token;
  try {
    const det = d || await TM.details(p.type, p.id).catch(() => null);
    const hits = await XS.find(p, det);
    if (!ip || ip.token !== tok) return;
    ip.d = det; ip.hits = hits;
    if (!hits.length) { ip.status = 'empty'; renderIptv(); return; }
    const strong = hits.filter(h => h.s >= 90);
    if (hits[0].s >= 90 && strong.length === 1) return selectHit(0);
    ip.status = 'list'; renderIptv();
  } catch (e) {
    if (!ip || ip.token !== tok) return;
    ip.status = 'error'; ip.msg = e.message; renderIptv();
  }
}
async function selectHit(i) {
  const h = ip && ip.hits[i];
  if (!h) return;
  ip.sel = h; ip.status = 'loadingShow'; ip.info = null;
  renderIptv();
  const tok = ip.token;
  try {
    const info = ip.p.type === 'movie' ? await XS.movie(h.acc, h.it) : await XS.info(h.acc, h.it.sid);
    if (!ip || ip.token !== tok || ip.sel !== h) return;
    ip.info = info; ip.status = 'show';
    ip.season = resumeEp(info) ? resumeEp(info).season : info.seasons[0].num;
    renderIptv(true);
  } catch (e) {
    if (!ip || ip.token !== tok) return;
    ip.status = 'error'; ip.msg = e.message; renderIptv();
  }
}
/** Zuletzt gesehene, nicht beendete Folge – sonst die nächste danach. */
function resumeEp(info) {
  const all = info.seasons.flatMap(s => s.eps);
  let best = null, idx = -1;
  all.forEach((e, i) => { const v = VP.get(e.id); if (v && (!best || v.at > best.at)) { best = v; idx = i; } });
  if (idx < 0) return null;
  return VP.done(all[idx].id) ? all[idx + 1] || null : all[idx];
}
function renderIptv(focusResume) {
  if (!ip) return;
  const { p } = ip;
  const focusedKey = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.ipk;
  const accNames = [...new Set(XS.accounts().map(a => a.name))].join(', ');
  const film = p.type === 'movie';
  let body = '', sub = '';
  if (ip.status === 'loading') sub = `Durchsuche den ${film ? 'Filmkatalog' : 'Serienkatalog'} von ${accNames || 'deinem Anbieter'} … (beim ersten Mal etwas länger)`;
  else if (ip.status === 'error') sub = ip.msg;
  else if (ip.status === 'empty') sub = `${film ? 'Dieser Film' : 'Diese Serie'} wurde im Katalog deines Anbieters nicht gefunden.`;
  else if (ip.status === 'list') sub = `${ip.hits.length} mögliche Treffer – bitte auswählen`;
  else if (ip.status === 'loadingShow') sub = `Lade ${film ? 'Film' : 'Folgen von'} „${ip.sel.it.name}“ …`;
  else if (ip.status === 'show' && ip.info.movie) {
    const e = ip.info.seasons[0].eps[0];
    sub = [ip.sel.it.name, ip.sel.it.year, e.dur ? Math.round(e.dur / 60) + ' Min.' : '', ip.sel.acc.name].filter(Boolean).join(' · ');
  } else if (ip.status === 'show') {
    const n = ip.info.seasons.reduce((a, s) => a + s.eps.length, 0);
    sub = `${ip.sel.it.name} · ${ip.info.seasons.length} Staffel${ip.info.seasons.length > 1 ? 'n' : ''} · ${n} Folgen · ${ip.sel.acc.name}`;
  }
  const btns = [`<button class="btn small focusable" data-ipk="back" data-ip="back">‹ Zurück</button>`];
  if (ip.sel && ip.hits.length > 1) btns.push(`<button class="btn small focusable" data-ipk="hits" data-ip="hits">Andere Treffer (${ip.hits.length})</button>`);
  if (['error', 'empty'].includes(ip.status)) btns.push(`<button class="btn small focusable" data-ipk="retry" data-ip="retry">Erneut versuchen</button>`,
    `<button class="btn small focusable" data-ipk="live" data-livesearch="${esc(p.title)}">Im Live-TV suchen</button>`);

  if (ip.status === 'list') {
    body = `<div class="group ip-list">${ip.hits.map((h, i) => `
      <button class="row-btn focusable" data-ipk="hit${i}" data-ip="hit" data-i="${i}">
        <span class="lbl"><b>${esc(h.it.name)}</b><small>${esc([h.it.cat, h.it.year, h.acc.name].filter(Boolean).join(' · '))}</small></span><span class="chev">›</span>
      </button>`).join('')}</div>`;
  } else if (ip.status === 'show') {
    const season = ip.info.seasons.find(s => s.num === ip.season) || ip.info.seasons[0];
    const chips = ip.info.seasons.length > 1 ? `<div class="ip-seasons">${ip.info.seasons.map(s =>
      `<button class="chip focusable ${s.num === season.num ? 'active' : ''}" data-ipk="s${s.num}" data-ip="season" data-s="${s.num}">${s.num ? 'Staffel ' + s.num : 'Extras'}</button>`).join('')}</div>` : '';
    body = chips + `<div class="group ip-list">${season.eps.map((e, i) => {
      const v = VP.get(e.id), done = VP.done(e.id);
      const dur = e.dur || (v && v.dur) || 0;
      const right = done ? '<span class="ip-done">✓ Gesehen</span>' : v && v.pos > 30 ? `<span class="ip-resume">Weiter bei ${fmtTime(v.pos)}</span>` : '<span class="chev">▶</span>';
      const pct = v && v.dur ? Math.min(100, v.pos / v.dur * 100) : 0;
      return `<button class="row-btn ip-ep focusable" data-ipk="e${e.id}" data-ip="ep" data-s="${season.num}" data-i="${i}">
        <span class="lbl"><b>${e.movie ? '▶ Film abspielen' : `${e.num}. ${esc(e.title)}`}</b><small>${esc([dur ? Math.round(dur / 60) + ' Min.' : '', e.plot].filter(Boolean).join(' · '))}</small>
        ${pct > 0 && !done ? `<span class="ip-pbar"><i style="width:${pct.toFixed(1)}%"></i></span>` : ''}</span>${right}
      </button>`;
    }).join('')}</div>`;
  } else if (ip.status === 'loading' || ip.status === 'loadingShow') {
    body = `<div class="group ip-list">${'<div class="row-item ip-skel"></div>'.repeat(4)}</div>`;
  }
  $('#sheetInner').innerHTML = `
    <div class="ip-head">
      <div class="eyebrow">Beim Anbieter · ${film ? 'IPTV-Filme' : 'IPTV-Serien'}</div>
      <h1>${esc(p.title)}</h1>
      <div class="meta ${ip.status === 'error' ? 'err' : ''}">${esc(sub)}</div>
      <div class="btn-row">${btns.join('')}</div>
    </div>
    <div class="ip-body">${body}</div>`;
  const same = ip.shown === ip.status;
  ip.shown = ip.status;
  let target = same && focusedKey && $(`#sheet [data-ipk="${CSS.escape(focusedKey)}"]`);
  if (!target && ip.status === 'show' && (focusResume || !same)) {
    const r = resumeEp(ip.info);
    target = (r && $(`#sheet [data-ipk="e${CSS.escape(r.id)}"]`)) || $('#sheet .ip-ep');
  }
  if (!target) target = $('#sheet .ip-list .focusable') || $('#sheet .ip-head .focusable');
  if (target) { target.focus({ preventScroll: true }); target.scrollIntoView({ block: 'nearest' }); }
}
function closeIptv(fromPop) {
  if (!ip) return;
  const p = ip.p;
  ip = null;
  $('#sheet').classList.remove('iptv');
  if (!fromPop) popOverlay('iptv');
  if (sheetOpen) { renderSheet(p, TM.details_[p.type + ':' + p.id]); const b = $('#shIptv'); if (b) b.focus({ preventScroll: true }); }
}
function iptvClick(el) {
  const a = el.dataset.ip;
  if (a === 'back') return closeIptv();
  if (a === 'retry') { const key = ip.p.type + ':' + ip.p.id; closeIptv(); return openIptv(key); }
  if (a === 'hits') { ip.sel = null; ip.info = null; ip.status = 'list'; return renderIptv(); }
  if (a === 'hit') return selectHit(Number(el.dataset.i));
  if (a === 'season') { ip.season = Number(el.dataset.s); renderIptv(); const c = $(`#sheet [data-ipk="s${ip.season}"]`); if (c) c.focus({ preventScroll: true }); return; }
  if (a === 'ep') {
    const all = ip.info.seasons.flatMap(s => s.eps);
    const ep = ip.info.seasons.find(s => s.num === Number(el.dataset.s)).eps[Number(el.dataset.i)];
    const p = ip.p, h = ip.sel;
    const img = p.backdrop ? `${TM.IMG}w780${p.backdrop}` : p.poster ? `${TM.IMG}w500${p.poster}` : h.it.cover || '';
    openVod(all, all.indexOf(ep), h.it.name, { acc: h.acc.key, sid: (ep.movie ? 'm' : '') + h.it.sid, img, src: h.acc.name, name: p.title, tmdb: p.type + ':' + p.id });
  }
}

/* ================= Overlays & Zurück-Taste ================= */
const overlays = [];
let skipPops = 0;
function pushOverlay(name) { overlays.push(name); history.pushState({ ov: name }, ''); }
function popOverlay(name) {
  const i = overlays.lastIndexOf(name);
  if (i >= 0) overlays.splice(i, 1);
  skipPops++; history.back();
}
window.addEventListener('popstate', () => {
  if (skipPops > 0) { skipPops--; return; }
  const top = overlays.pop();
  if (top === 'player') closePlayer(true);
  else if (top === 'iptv') closeIptv(true);
  else if (top === 'sheet') closeSheet(true);
});
// Wird von der App aufgerufen, wenn kein Overlay offen ist: erst zur Startseite, dann beenden
function handleBack() {
  if (state.view !== 'home') { show('home'); return true; }
  return false;
}

/* ================= Ansichten ================= */
function show(view) {
  state.view = view;
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view));
  $$('.tabbar [data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  window.scrollTo(0, 0);
  EPG.scan();
  const tab = $(`.tabbar [data-view="${view}"]`);
  if (tab) tab.focus({ preventScroll: true });
}

/* ================= Player ================= */
const video = $('#video');
let hls = null, tsPlayer = null, engine = null, failCb = null, playToken = 0, startTimer = null;

function enginesFor(url) {
  const u = url.split('?')[0].toLowerCase();
  if (u.endsWith('.m3u8')) return ['hls', 'ts'];
  if (u.endsWith('.ts')) return ['ts', 'hls'];
  if (/\.(mp4|mkv|webm|mov)$/.test(u)) return ['native'];
  return ['hls', 'ts', 'native'];
}
function stopStream() {
  engine = null; failCb = null;
  clearTimeout(startTimer);
  if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
  if (tsPlayer) { try { tsPlayer.pause(); tsPlayer.unload(); tsPlayer.detachMediaElement(); tsPlayer.destroy(); } catch (e) {} tsPlayer = null; }
  video.pause();
  video.removeAttribute('src');
  video.load();
}
function safePlay(p) { try { const r = p.play(); if (r && r.catch) r.catch(() => {}); } catch (e) {} }
function startEngine(name, url, fail) {
  engine = name; failCb = fail;
  startTimer = setTimeout(() => fail(), 20000);
  if (name === 'hls') {
    if (!window.Hls || !Hls.isSupported()) return fail();
    hls = new Hls({ enableWorker: true });
    hls.on(Hls.Events.MANIFEST_PARSED, () => safePlay(video));
    hls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) fail(); });
    hls.loadSource(url);
    hls.attachMedia(video);
  } else if (name === 'ts') {
    if (!window.mpegts || !mpegts.getFeatureList().mseLivePlayback) return fail();
    tsPlayer = mpegts.createPlayer({ type: 'mpegts', isLive: !vod, url }, { enableWorker: false, lazyLoad: false, liveBufferLatencyChasing: !vod });
    tsPlayer.on(mpegts.Events.ERROR, () => fail());
    tsPlayer.attachMediaElement(video);
    tsPlayer.load();
    safePlay(tsPlayer);
  } else {
    video.src = url;
    safePlay(video);
  }
}
function loadStream(url) {
  stopStream();
  const token = ++playToken;
  const list = enginesFor(url);
  const next = () => {
    if (token !== playToken) return;
    const e = list.shift();
    stopStream();
    if (!e) { setStatus('Stream nicht abspielbar'); return; }
    let done = false;
    startEngine(e, url, () => { if (!done && token === playToken) { done = true; next(); } });
  };
  setStatus('Lädt …');
  next();
}
function setStatus(t) { $('#status').textContent = t; }
function showOsd() {
  const o = $('#osd');
  o.classList.remove('hide');
  clearTimeout(osdTimer);
  osdTimer = setTimeout(() => o.classList.add('hide'), 4500);
}
function openPlayer(id) {
  const ch = byId(id);
  if (!ch) return;
  if (state.settings.vpnReq && bridge) {
    const v = vpn();
    if (v && v.installed && !v.active) { toast('Kein VPN – ProtonVPN wird geöffnet'); setTimeout(() => bridge.openVpn(), 900); return; }
  }
  enterPlayer();
  setVod(null);
  currentId = id;
  state.recent = [id, ...state.recent.filter(x => x !== id)].slice(0, 12);
  persist();
  $('#pTitle').textContent = ch.name;
  $('#pGroup').textContent = ch.group;
  $('#pFav').textContent = isFav(id) ? '★' : '☆';
  $('#pLogo').innerHTML = ch.logo ? `<img src="${esc(ch.logo)}" alt="" onerror="this.remove()">` : esc(initials(ch.name));
  EPG.want(ch, true);
  renderOsdEpg();
  loadStream(ch.url);
  showOsd();
}
function enterPlayer() {
  if (playerOpen) return;
  playerFocus = document.activeElement;
  playerOpen = true;
  pushOverlay('player');
  $('#player').classList.add('open');
  if (document.activeElement) document.activeElement.blur();
}
/* ---------- Serienfolgen (VOD) ---------- */
function setVod(v) {
  if (vod && vod !== v) saveVodPos();
  vod = v;
  $('#player').classList.toggle('vod', !!v);
  $('#pProg').classList.toggle('hidden', !v);
  if (v) $('#pEpg').classList.add('hidden');
  $('#pFav').classList.toggle('hidden', !!v);
  $('#pSub').textContent = v ? (v.ep.movie ? '◀▶ Spulen · OK Pause · Zurück schließen' : '◀▶ Spulen · ▲▼ Folge wechseln · OK Pause · Zurück schließen')
    : '▲▼ Sender wechseln · OK Pause · Zurück schließen';
}
/** ctx = Herkunft für „Weiterschauen“: { acc, sid, img, src } */
function openVod(list, idx, show, ctx) {
  const ep = list[idx];
  if (!ep) return;
  if (state.settings.vpnReq && bridge) {
    const v = vpn();
    if (v && v.installed && !v.active) { toast('Kein VPN – ProtonVPN wird geöffnet'); setTimeout(() => bridge.openVpn(), 900); return; }
  }
  enterPlayer();
  setVod({ list, idx, show, ep, ctx: ctx || null, resumed: false, synced: false });
  currentId = null;
  $('#pTitle').textContent = ep.movie ? (ctx && ctx.name) || show : `${ep.num}. ${ep.title}`;
  $('#pGroup').textContent = ep.movie ? 'Film' + (ctx && ctx.src ? ' · ' + ctx.src : '') : `${show} · Staffel ${ep.season}`;
  $('#pLogo').textContent = ep.movie ? 'FILM' : `S${ep.season}`;
  updateProg();
  loadStream(ep.url);
  showOsd();
}
function saveVodPos() {
  if (!vod || !video.duration || !isFinite(video.duration) || video.currentTime < 5) return;
  const e = vod.ep, c = vod.ctx;
  VP.set(e.id, video.currentTime, video.duration, c ? {
    show: (c && c.name) || vod.show, movie: !!e.movie, season: e.season, num: e.num, title: e.title, url: e.url, img: c.img || '', acc: c.acc, sid: c.sid, src: c.src || '', tmdb: c.tmdb || ''
  } : null);
}
/* ---------- Watchlist-Sync (ab 90 % gesehen) ---------- */
async function syncWatched(v) {
  v.synced = true;
  const t = v.ctx && v.ctx.tmdb ? String(v.ctx.tmdb).split(':') : null;
  if (!t || !t[1] || !WL.connected) return;
  const job = { type: t[0] === 'movie' ? 'movie' : 'tv', id: Number(t[1]), season: Number(v.ep.season) || 0, num: Number(v.ep.num) || 0 };
  try {
    const st = await WL.markWatched(job.type, job.id, job.season, job.num);
    if (st) toast(job.type === 'movie' ? '✓ Watchlist: Film als gesehen markiert'
      : `✓ Watchlist: S${job.season} E${job.num} gesehen${st === 'done' ? ' – Serie abgeschlossen' : ''}`);
  } catch (e) {
    WL.queue(job);
    toast('Watchlist nicht erreichbar – wird später übertragen');
  }
}
/* ---------- Weiterschauen ---------- */
let resumeBusy = false;
async function playResume(id) {
  const v = VP.get(id);
  if (!v || !v.m || resumeBusy) return;
  const m = v.m;
  let list = [{ id, num: m.num, season: m.season, title: m.title, url: m.url, dur: v.dur, plot: '' }], idx = 0;
  const acc = XS.accounts().find(a => a.key === m.acc);
  if (m.movie) list[0].movie = true;
  else if (acc) {   // komplette Folgenliste holen, damit ▲▼ und „Nächste Folge“ funktionieren
    resumeBusy = true;
    const cached = XS.info_[acc.key + ':' + m.sid];
    if (!cached) toast('Lade Folgen …');
    try {
      const info = cached || await Promise.race([XS.info(acc, m.sid), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 8000))]);
      const all = info.seasons.flatMap(s => s.eps), i = all.findIndex(e => e.id === id);
      if (i >= 0) { list = all; idx = i; }
    } catch (e) {} finally { resumeBusy = false; }
  }
  if (playerOpen) return;
  openVod(list, idx, m.show, { acc: m.acc, sid: m.sid, img: m.img, src: m.src, name: m.show, tmdb: m.tmdb });
}
function hideResume(id) {
  VP.hide(id);
  const tiles = $$('[data-resume]'), i = tiles.findIndex(t => t.dataset.resume === id);
  renderHome();
  const rest = $$('[data-resume]');
  const next = rest[Math.min(i, rest.length - 1)] || $('#homeTop .focusable') || $('.tabbar .active');
  if (next) next.focus({ preventScroll: true });
  toast('Aus „Weiterschauen“ entfernt');
}
function updateProg() {
  if (!vod) return;
  const d = isFinite(video.duration) ? video.duration : 0, t = video.currentTime || 0;
  $('#pBar').style.width = d ? (t / d * 100).toFixed(2) + '%' : '0';
  $('#pTime').textContent = d ? `${fmtTime(t)} / ${fmtTime(d)}` : '';
}
function seek(sec) {
  if (!vod || !isFinite(video.duration)) return;
  video.currentTime = Math.max(0, Math.min(video.duration - 2, video.currentTime + sec));
  updateProg();
}
video.addEventListener('loadedmetadata', () => {
  if (!vod || vod.resumed) return;
  vod.resumed = true;
  const v = VP.get(vod.ep.id);
  if (v && v.pos > 30 && !VP.done(vod.ep.id) && isFinite(video.duration)) {
    video.currentTime = v.pos;
    toast('Fortgesetzt bei ' + fmtTime(v.pos));
  }
});
let vodSaveAt = 0;
video.addEventListener('timeupdate', () => {
  if (!vod) return;
  updateProg();
  if (!vod.synced && isFinite(video.duration) && video.duration > 60 && video.currentTime / video.duration >= 0.9) syncWatched(vod);
  if (Date.now() - vodSaveAt > 10000) { vodSaveAt = Date.now(); saveVodPos(); }
});
video.addEventListener('ended', () => {
  if (!vod) return;
  saveVodPos();
  if (!vod.synced) syncWatched(vod);
  if (vod.idx + 1 < vod.list.length) { toast('Nächste Folge'); openVod(vod.list, vod.idx + 1, vod.show, vod.ctx); }
  else closePlayer();
});
function closePlayer(fromPop) {
  if (!playerOpen) return;
  const wasVod = !!vod;
  setVod(null);
  playerOpen = false;
  playToken++;
  stopStream();
  setStatus('');
  $('#player').classList.remove('open');
  if (!fromPop) popOverlay('player');
  if (wasVod && ip && ip.status === 'show') { renderHome(); renderIptv(true); return; }
  const sel = focusSel(playerFocus), wasResume = !!(playerFocus && playerFocus.dataset && playerFocus.dataset.resume);
  renderHome();
  const target = playerFocus && playerFocus.isConnected ? playerFocus
    : (sel && visibleOf(sel)) || (wasResume && visibleOf('[data-resume]')) || null;
  if (target) target.focus({ preventScroll: true });
}
function zap(step) {
  if (vod) {
    if (vod.ep.movie) return;
    const i = vod.idx + step;
    if (i < 0 || i >= vod.list.length) { toast(step > 0 ? 'Letzte Folge' : 'Erste Folge'); return; }
    return openVod(vod.list, i, vod.show, vod.ctx);
  }
  const list = state.channels;
  if (!list.length) return;
  const i = list.findIndex(c => c.id === currentId);
  openPlayer(list[(i + step + list.length) % list.length].id);
}
function togglePlay() { video.paused ? safePlay(video) : video.pause(); }
function playerKey(e) {
  const k = e.key;
  if (['Escape', 'Backspace', 'GoBack', 'BrowserBack'].includes(k)) { e.preventDefault(); closePlayer(); return; }
  if (vod && ['ArrowLeft', 'MediaRewind'].includes(k)) seek(k === 'MediaRewind' ? -30 : -10);
  else if (vod && ['ArrowRight', 'MediaFastForward'].includes(k)) seek(k === 'MediaFastForward' ? 30 : 10);
  else if (['ArrowUp', 'ChannelUp', 'PageUp'].includes(k)) zap(-1);
  else if (['ArrowDown', 'ChannelDown', 'PageDown'].includes(k)) zap(1);
  else if (['Enter', ' ', 'MediaPlayPause'].includes(k)) togglePlay();
  else if (['f', 'F', 'ContextMenu'].includes(k)) toggleFav(currentId);
  else return;
  e.preventDefault();
  showOsd();
}
video.addEventListener('waiting', () => { if (engine) setStatus('Puffern …'); });
video.addEventListener('playing', () => { clearTimeout(startTimer); setStatus(''); });
video.addEventListener('error', () => { if (engine === 'native' && failCb) failCb(); });
$('#player').addEventListener('click', e => { if (!e.target.closest('#osd')) { togglePlay(); showOsd(); } });

/* ================= Navigation per Fernbedienung ================= */
function navigate(dir) {
  const scope = sheetOpen ? $('#sheet') : document;
  const all = [...scope.querySelectorAll('.focusable')].filter(el => el.getClientRects().length && !el.disabled && !(sheetOpen ? false : el.closest('.sheet')));
  if (!all.length) return;
  const cur = document.activeElement;
  if (!all.includes(cur)) { all[0].focus({ preventScroll: true }); return; }
  // Sticky-Kopfzeile: für Hoch/Runter an ihrer echten Position am Seitenanfang werten
  const vert = dir === 'ArrowUp' || dir === 'ArrowDown';
  const rectOf = el => {
    const r = el.getBoundingClientRect();
    if (!vert || sheetOpen || !el.closest('header')) return r;
    return { left: r.left, right: r.right, top: r.top - window.scrollY, bottom: r.bottom - window.scrollY };
  };
  const c = rectOf(cur);
  const ccx = (c.left + c.right) / 2, ccy = (c.top + c.bottom) / 2;
  const cands = [];
  for (const el of all) {
    if (el === cur) continue;
    const r = rectOf(el);
    const rcx = (r.left + r.right) / 2, rcy = (r.top + r.bottom) / 2;
    let main, gap, align;
    if (vert) {
      if (dir === 'ArrowUp' ? rcy >= ccy - 2 : rcy <= ccy + 2) continue;
      main = dir === 'ArrowUp' ? c.top - r.bottom : r.top - c.bottom;
      gap = Math.max(0, r.left - c.right, c.left - r.right);
      align = Math.abs(rcx - ccx);
    } else {
      if (dir === 'ArrowLeft' ? rcx >= ccx - 2 : rcx <= ccx + 2) continue;
      main = dir === 'ArrowLeft' ? c.left - r.right : r.left - c.right;
      gap = Math.max(0, r.top - c.bottom, c.top - r.bottom);
      align = Math.abs(rcy - ccy);
    }
    cands.push({ el, main: Math.max(main, 0), gap, align });
  }
  // 1. nur die direkt angrenzende Zeile/Spalte  2. darin das am besten passende Element
  let best = null;
  if (cands.length) {
    const sameLine = cands.filter(x => x.gap === 0);
    const pool = !vert && sameLine.length ? sameLine : cands;
    const nearest = Math.min(...pool.map(x => x.main));
    const band = pool.filter(x => x.main <= nearest + 24);
    band.sort((x, y) => x.gap - y.gap || x.align - y.align);
    best = band[0].el;
  }
  if (!best) return;
  best.focus({ preventScroll: true });
  if (best.closest('header')) return;
  best.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  // Zeilenüberschrift mit sichtbar halten (nicht unter der Kopfzeile verstecken)
  const sec = best.closest('.rail') ? best.closest('section') : null;
  const hb = $('header').getBoundingClientRect().bottom, br = (sec || best).getBoundingClientRect();
  if (!sheetOpen && br.top < hb + 12) window.scrollBy({ top: br.top - hb - 16, behavior: 'smooth' });
}
document.addEventListener('keydown', e => {
  if (playerOpen) { playerKey(e); return; }
  const a = document.activeElement;
  const typing = a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA');
  if (sheetOpen && ['Escape', 'Backspace'].includes(e.key) && !typing) { e.preventDefault(); ip ? closeIptv() : closeSheet(); return; }
  if (typing && !['ArrowUp', 'ArrowDown', 'Escape'].includes(e.key)) return;
  if (NAV_KEYS.includes(e.key)) { e.preventDefault(); navigate(e.key); return; }
  if (e.key === 'Enter' && a && a.classList.contains('tile')) { e.preventDefault(); a.click(); return; }
  if ((e.key === 'f' || e.key === 'ContextMenu') && a && a.dataset.card) { e.preventDefault(); toggleFav(a.dataset.card); }
  if (e.key === 'ContextMenu' && a && a.dataset.resume) { e.preventDefault(); hideResume(a.dataset.resume); }
});

/* ================= Klicks ================= */
document.addEventListener('click', e => {
  const t = e.target;
  const fav = t.closest('[data-fav]');
  if (fav) { e.stopPropagation(); toggleFav(fav.dataset.fav); return; }
  const ipb = t.closest('[data-ip]');
  if (ipb && ip) { iptvClick(ipb); return; }
  const ipo = t.closest('[data-iptv]');
  if (ipo) { openIptv(ipo.dataset.iptv); return; }
  const ls = t.closest('[data-livesearch]');
  if (ls) { liveSearch(ls.dataset.livesearch); return; }
  const shw = t.closest('[data-show]');
  if (shw) { openSheet(shw.dataset.show); return; }
  const cat = t.closest('[data-cat]');
  if (cat) {
    state.cat = cat.dataset.cat;
    renderHome();
    const chip = $(`.chip[data-cat="${CSS.escape(state.cat)}"]`);
    if (chip) { chip.focus({ preventScroll: true }); chip.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' }); }
    return;
  }
  const view = t.closest('[data-view]');
  if (view) { show(view.dataset.view); return; }
  const act = t.closest('[data-act]');
  if (act) { manageAction(act.dataset.act, act.dataset.id); return; }
  const sa = t.closest('[data-src-act]');
  if (sa) {
    const s = state.sources.find(x => x.id === sa.dataset.id);
    if (sa.dataset.srcAct === 'refresh' && s && !s.loading) refreshSource(s);
    if (sa.dataset.srcAct === 'del') removeSource(sa.dataset.id);
    return;
  }
  const card = t.closest('[data-card]');
  if (card) { openPlayer(card.dataset.card); return; }
  const rs = t.closest('[data-resume]');
  if (rs) { playResume(rs.dataset.resume); return; }
  // Serien-Watchlist & TMDB (dynamisch gerendert)
  if (t.closest('#wlLogin')) return wlLogin();
  if (t.closest('#wlLogout')) { WL.logout(); TM.clear(); renderSettings(); loadDiscover(true); toast('Abgemeldet'); return; }
  if (t.closest('#wlReload')) { toast('Lade Empfehlungen …'); loadDiscover(true); return; }
  if (t.closest('#tmdbSave')) {
    state.settings.tmdbKey = $('#tmdbKey').value.trim(); persist(); TM.clear();
    toast(state.settings.tmdbKey ? 'TMDB-Schlüssel gespeichert' : 'Eigener Schlüssel entfernt');
    loadDiscover(true); return;
  }
});
$('#q').addEventListener('input', () => { renderSearch(); searchShows(); });
$('#mq').addEventListener('input', renderManage);
$('#vpnBadge').addEventListener('click', () => { if (bridge) bridge.openVpn(); });

async function wlLogin() {
  const mail = $('#wlMail').value.trim(), pass = $('#wlPass').value;
  if (!mail || !pass) return toast('E-Mail und Passwort eingeben');
  const b = $('#wlLogin'); b.disabled = true; b.textContent = 'Anmelden …';
  try {
    await WL.login(mail, pass);
    toast('Angemeldet – lade Empfehlungen …');
    TM.clear(); renderSettings(); loadDiscover(true);
  } catch (e) { toast(e.message); b.disabled = false; b.textContent = 'Anmelden'; }
}

/* ================= Kanäle (manuell) ================= */
const fld = n => $(`#chForm [name="${n}"]`);
function resetForm() { $('#chForm').reset(); editId = null; $('#formTitle').textContent = 'Kanal manuell hinzufügen'; }
function manageAction(act, id) {
  const c = byId(id);
  if (!c) return;
  if (act === 'fav') return toggleFav(id);
  if (act === 'del') {
    if (!confirm(`„${c.name}“ löschen?`)) return;
    state.channels = state.channels.filter(x => x.id !== id);
    pruneRefs(); return refresh();
  }
  if (act === 'edit') {
    editId = id;
    fld('name').value = c.name; fld('group').value = c.group; fld('url').value = c.url; fld('logo').value = c.logo || '';
    $('#formTitle').textContent = 'Kanal bearbeiten';
    fld('name').focus(); fld('name').scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}
$('#chForm').addEventListener('submit', e => {
  e.preventDefault();
  const f = new FormData(e.target);
  const data = { name: (f.get('name') || '').trim(), group: (f.get('group') || '').trim() || 'Sonstige', url: (f.get('url') || '').trim(), logo: (f.get('logo') || '').trim() };
  if (!data.name || !data.url) return;
  if (editId) { const c = byId(editId); if (c) Object.assign(c, data); }
  else state.channels.push({ id: 'manual_' + uid(), src: 'manual', ...data });
  resetForm(); refresh(); toast('Kanal gespeichert');
});
$('#formCancel').addEventListener('click', resetForm);

/* ================= Einstellungen ================= */
function setType(t) {
  $('#formM3u').classList.toggle('hidden', t !== 'm3u');
  $('#formXt').classList.toggle('hidden', t !== 'xt');
  $('#typeM3u').classList.toggle('sel', t === 'm3u');
  $('#typeXt').classList.toggle('sel', t === 'xt');
}
$('#typeM3u').addEventListener('click', () => setType('m3u'));
$('#typeXt').addEventListener('click', () => setType('xt'));
$$('[data-fmt]').forEach(b => b.addEventListener('click', () => {
  xtFmt = b.dataset.fmt;
  $$('[data-fmt]').forEach(x => x.classList.toggle('sel', x === b));
}));
$('#m3uAdd').addEventListener('click', async e => {
  const url = $('#m3uUrl').value.trim();
  if (!/^https?:\/\//i.test(url)) return toast('Bitte einen gültigen http(s)-Link eingeben');
  const btn = e.currentTarget; btn.disabled = true; btn.textContent = 'Lädt …';
  $('#m3uErr').textContent = '';
  const src = { id: 's' + uid(), type: 'm3u', name: $('#m3uName').value.trim() || 'M3U-Playlist', url };
  const ok = await addSource(src);
  btn.disabled = false; btn.textContent = 'Hinzufügen & laden';
  if (ok) { $('#m3uName').value = ''; $('#m3uUrl').value = ''; }
  else $('#m3uErr').textContent = 'Fehler: ' + (src.error || 'unbekannt');
});
$('#xtAdd').addEventListener('click', async e => {
  let server = $('#xtServer').value.trim(), user = $('#xtUser').value.trim(), pass = $('#xtPass').value.trim();
  const link = parseXtreamLink(server);
  if (link) { server = link.server; user = user || link.user; pass = pass || link.pass; }
  if (!server || !user || !pass) return toast('Server, Benutzername und Passwort ausfüllen');
  const btn = e.currentTarget; btn.disabled = true; btn.textContent = 'Anmelden …';
  $('#xtErr').textContent = '';
  const src = { id: 's' + uid(), type: 'xtream', name: $('#xtName').value.trim() || 'Xtream', server: normServer(server), user, pass, format: xtFmt };
  const ok = await addSource(src);
  btn.disabled = false; btn.textContent = 'Anmelden & laden';
  if (ok) ['#xtName', '#xtServer', '#xtUser', '#xtPass'].forEach(s => $(s).value = '');
  else $('#xtErr').textContent = 'Fehler: ' + (src.error || 'unbekannt') + ' (Server: ' + src.server + ')';
});
function toggleSetting(key) { state.settings[key] = !state.settings[key]; persist(); renderSettings(); }
$('#swAuto').addEventListener('click', () => toggleSetting('autoRefresh'));
$('#swVpnAuto').addEventListener('click', () => toggleSetting('vpnAuto'));
$('#swVpnReq').addEventListener('click', () => toggleSetting('vpnReq'));
$('#vpnOpen').addEventListener('click', () => {
  if (!bridge) return toast('Nur in der Fire-TV-App verfügbar');
  if (!bridge.openVpn()) toast('ProtonVPN ist nicht installiert');
});
$('#demoAdd').addEventListener('click', () => {
  const ids = new Set(state.channels.map(c => c.id));
  state.channels.push(...DEMO.filter(c => !ids.has(c.id)).map(c => ({ ...c })));
  refresh(); toast('Demo-Kanäle hinzugefügt');
});
$('#resetAll').addEventListener('click', () => {
  if (!confirm('Alle Quellen, Kanäle, Favoriten und Einstellungen löschen?')) return;
  state.channels = []; state.favs = []; state.recent = []; state.sources = []; state.settings = { ...DEFAULT_SETTINGS }; state.cat = 'Alle';
  WL.logout(); TM.clear(); heroItems = [];
  refresh(); renderDiscover(); renderHero(); toast('Zurückgesetzt');
});

/* ================= ProtonVPN ================= */
function vpn() {
  if (!bridge) return null;
  try { return { installed: !!bridge.vpnInstalled(), active: !!bridge.vpnActive() }; } catch (e) { return null; }
}
function renderVpn() {
  const v = vpn(), b = $('#vpnBadge');
  if (!v || !v.installed) {
    b.classList.add('hidden');
    $('#vpnFoot').textContent = !bridge ? 'Nur in der Fire-TV-App verfügbar.' : 'ProtonVPN ist auf diesem Gerät nicht installiert.';
    return;
  }
  b.classList.remove('hidden');
  b.classList.toggle('on', v.active);
  b.classList.toggle('off', !v.active);
  $('#vpnText').textContent = v.active ? 'VPN aktiv' : 'Kein VPN';
  $('#vpnFoot').textContent = v.active ? 'Status: VPN verbunden.' : 'Status: nicht verbunden. In ProtonVPN auf „Verbinden“ drücken und mit Zurück zu StreamTV wechseln.';
}
function vpnOnStart() {
  renderVpn();
  const v = vpn();
  if (state.settings.vpnAuto && v && v.installed && !v.active) {
    toast('Starte ProtonVPN … danach mit Zurück zu StreamTV');
    setTimeout(() => { const w = vpn(); if (w && !w.active) bridge.openVpn(); }, 1500);
  }
}
window.onAppResume = () => { renderVpn(); setTimeout(renderVpn, 2500); };

/* ================= Uhr ================= */
function tick() { $('#clock').textContent = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }); }

/* ================= Start ================= */
load();
EPG.load();
EPG.onUpdate(epgPatch);
document.addEventListener('scroll', () => EPG.scan(), true);
setInterval(() => {   // laufende Sendung aktuell halten
  const ids = new Set($$('.tile[data-card]').map(t => t.dataset.card));
  ids.forEach(epgPatch);
  if (playerOpen && !vod) { renderOsdEpg(); EPG.want(byId(currentId)); }
  EPG.scan();
}, 60000);
WL.load();
TM.load();
persist();
renderAll();
show('home');
tick(); setInterval(tick, 15000);
setInterval(renderVpn, 15000);
try { if (bridge) $('#appVersion').textContent = 'Version ' + bridge.appVersion(); } catch (e) {}
vpnOnStart();
setupHero();
loadDiscover(false);
if (state.settings.autoRefresh) {
  const stale = state.sources.filter(s => !s.updated || Date.now() - s.updated > 6 * 3600 * 1000);
  (async () => { for (const s of stale) await refreshSource(s, true); })();
}

/* ================= Zugangsdaten vom Laptop (per ADB übertragen) ================= */
// Aufruf durch die App: importConfig("<Inhalt von zugang.txt>")
async function importConfig(text) {
  const cfg = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/i);
    if (m && !line.trim().startsWith('#')) cfg[m[1].toUpperCase()] = m[2];
  }
  const done = [];
  show('settings');
  // Xtream
  let server = cfg.SERVER || '', user = cfg.BENUTZER || '', pass = cfg.PASSWORT || '';
  const link = parseXtreamLink(server);
  if (link) { server = link.server; user = user || link.user; pass = pass || link.pass; }
  if (server && user && pass) {
    server = normServer(server);
    let src = state.sources.find(s => s.type === 'xtream' && s.server === server && s.user === user);
    const fmt = /ts/i.test(cfg.FORMAT || '') ? 'ts' : 'm3u8';
    if (src) {
      Object.assign(src, { pass, format: fmt, name: cfg.NAME || src.name });
      done.push((await refreshSource(src)) ? `Xtream „${src.name}“ aktualisiert` : `Xtream: ${src.error}`);
    } else {
      src = { id: 's' + uid(), type: 'xtream', name: cfg.NAME || 'Xtream', server, user, pass, format: fmt };
      const ok = await addSource(src);
      done.push(ok ? `Xtream „${src.name}“ hinzugefügt` : `Xtream: ${src.error}`);
      if (!ok) $('#xtErr').textContent = 'Fehler: ' + src.error + ' (Server: ' + server + ')';
    }
  }
  // M3U
  if (/^https?:\/\//i.test(cfg.M3U || '') && !state.sources.some(s => s.type === 'm3u' && s.url === cfg.M3U)) {
    const src = { id: 's' + uid(), type: 'm3u', name: cfg.M3U_NAME || 'M3U-Playlist', url: cfg.M3U };
    done.push((await addSource(src)) ? `M3U „${src.name}“ hinzugefügt` : `M3U: ${src.error}`);
  }
  // Serien-Watchlist
  if (cfg.WATCHLIST_EMAIL && cfg.WATCHLIST_PASSWORT && !WL.connected) {
    try { await WL.login(cfg.WATCHLIST_EMAIL, cfg.WATCHLIST_PASSWORT); TM.clear(); loadDiscover(true); done.push('Watchlist angemeldet'); }
    catch (e) { done.push('Watchlist: ' + e.message); }
  }
  if (cfg.TMDB_KEY) { state.settings.tmdbKey = cfg.TMDB_KEY; persist(); TM.clear(); loadDiscover(true); done.push('TMDB-Schlüssel gespeichert'); }
  renderSettings();
  toast(done.length ? done.join(' · ') : 'Keine Zugangsdaten in zugang.txt gefunden');
  return done;
}
