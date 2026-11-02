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
let playerOpen = false, sheetOpen = false, currentId = null, osdTimer = null, lastFocus = null, editId = null, xtFmt = 'm3u8';

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
async function getText(url, ms = 30000) {
  const r = await request('GET', url, { timeout: ms });
  if ((r.status >= 200 && r.status < 300) || (r.status === 0 && r.text)) return r.text;
  throw new Error('HTTP ' + r.status);
}
async function getJSON(url) {
  const t = await getText(url);
  try { return JSON.parse(t); } catch (e) { throw new Error('Ungültige Antwort vom Server'); }
}
function normServer(s) {
  s = s.trim().replace(/\/+$/, '').replace(/\/player_api\.php.*$/i, '');
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  return s;
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
  const info = await getJSON(api);
  const ui = info && info.user_info;
  if (!ui || Number(ui.auth) === 0) throw new Error('Anmeldung fehlgeschlagen – Zugangsdaten prüfen');
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
  return `<div class="tile focusable" tabindex="0" data-card="${esc(c.id)}">
    <div class="art"><span class="ini">${esc(initials(c.name))}</span>
      ${c.logo ? `<img class="logo" src="${esc(c.logo)}" alt="" loading="lazy" onerror="this.remove()">` : ''}
      <button class="star ${isFav(c.id) ? 'on' : ''}" tabindex="-1" data-fav="${esc(c.id)}" aria-label="Favorit">★</button>
    </div>
    <div class="caption">${esc(c.name)}</div>
  </div>`;
}
function showTileHTML(p, rank) {
  const img = p.backdrop ? `${TM.IMG}w780${p.backdrop}` : p.poster ? `${TM.IMG}w500${p.poster}` : '';
  return `<div class="tile show focusable" tabindex="0" data-show="${p.type}:${p.id}">
    <div class="art">${img ? `<img class="bd" src="${img}" alt="" loading="lazy">` : ''}<div class="shade"></div>
      ${rank ? `<span class="rank">${rank}</span>` : ''}<div class="t">${esc(p.title)}</div></div>
    <div class="caption">${esc(p.reason || TM.info(p))}</div>
  </div>`;
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
  $('#homeTop').innerHTML = channelRail('Meine Favoriten', favList()) + channelRail('Zuletzt gesehen', recentList());

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
  $('#searchGrid').innerHTML = !q ? `<p class="empty">Sender, Kategorie oder Serie eingeben.</p>`
    : res.length ? res.slice(0, GRID_MAX).map(tileHTML).join('') : '';
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
      keepFocus(() => { $('#searchShows').innerHTML = res.length ? railHTML('Serien', res.slice(0, 20).map(p => showTileHTML(p)).join(''), res.length) : ''; });
    } catch (e) { $('#searchShows').innerHTML = ''; }
  }, 450);
}
function renderFavs() {
  const f = favList();
  $('#favGrid').innerHTML = f.length ? f.map(tileHTML).join('')
    : `<p class="empty">Noch keine Favoriten. Auf einem Sender die Menü-Taste (≡) drücken oder im Player ☆ wählen.</p>`;
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
function keepFocus(fn) {
  const a = document.activeElement;
  const sel = a && a.dataset && (a.dataset.card ? `[data-card="${CSS.escape(a.dataset.card)}"]`
    : a.dataset.show ? `[data-show="${CSS.escape(a.dataset.show)}"]` : a.dataset.cat ? `[data-cat="${CSS.escape(a.dataset.cat)}"]` : null);
  fn();
  if (sel && (!document.activeElement || document.activeElement === document.body)) {
    const el = [...document.querySelectorAll(sel)].find(e => e.getClientRects().length);
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
    try { const d = await TM.details(p.type, p.id); if (sheetOpen) renderSheet(p, d); } catch (e) {}
  }
}
function renderSheet(p, d) {
  const key = p.type + ':' + p.id;
  const bd = (d && d.backdrop_path) || p.backdrop;
  $('#sheetBd').style.backgroundImage = bd ? `url("${TM.IMG}w1280${bd}")` : 'none';
  const logo = d && TM.pickLogo(d);
  const genres = d ? TM.genres(d).slice(0, 3) : [];
  const seasons = d && d.number_of_seasons ? `${d.number_of_seasons} Staffel${d.number_of_seasons > 1 ? 'n' : ''}` : null;
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
      ${WL.connected ? `<button class="btn primary focusable" id="shAdd" ${onList ? 'disabled' : ''}>${onList ? '✓ Auf deiner Watchlist' : '+ Auf die Watchlist'}</button>` : ''}
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
    tsPlayer = mpegts.createPlayer({ type: 'mpegts', isLive: true, url }, { enableWorker: false, lazyLoad: false, liveBufferLatencyChasing: true });
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
  if (!playerOpen) {
    lastFocus = document.activeElement;
    playerOpen = true;
    pushOverlay('player');
    $('#player').classList.add('open');
    if (document.activeElement) document.activeElement.blur();
  }
  currentId = id;
  state.recent = [id, ...state.recent.filter(x => x !== id)].slice(0, 12);
  persist();
  $('#pTitle').textContent = ch.name;
  $('#pGroup').textContent = ch.group;
  $('#pFav').textContent = isFav(id) ? '★' : '☆';
  $('#pLogo').innerHTML = ch.logo ? `<img src="${esc(ch.logo)}" alt="" onerror="this.remove()">` : esc(initials(ch.name));
  loadStream(ch.url);
  showOsd();
}
function closePlayer(fromPop) {
  if (!playerOpen) return;
  playerOpen = false;
  playToken++;
  stopStream();
  setStatus('');
  $('#player').classList.remove('open');
  if (!fromPop) popOverlay('player');
  keepFocus(() => renderHome());
  if (lastFocus && lastFocus.isConnected) lastFocus.focus({ preventScroll: true });
}
function zap(step) {
  const list = state.channels;
  if (!list.length) return;
  const i = list.findIndex(c => c.id === currentId);
  openPlayer(list[(i + step + list.length) % list.length].id);
}
function togglePlay() { video.paused ? safePlay(video) : video.pause(); }
function playerKey(e) {
  const k = e.key;
  if (['Escape', 'Backspace', 'GoBack', 'BrowserBack'].includes(k)) { e.preventDefault(); closePlayer(); return; }
  if (['ArrowUp', 'ChannelUp', 'PageUp'].includes(k)) zap(-1);
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
  const c = cur.getBoundingClientRect();
  const cx = c.left + c.width / 2, cy = c.top + c.height / 2;
  let best = null, bestScore = Infinity;
  for (const el of all) {
    if (el === cur) continue;
    const r = el.getBoundingClientRect();
    const dx = (r.left + r.width / 2) - cx, dy = (r.top + r.height / 2) - cy;
    let main, side;
    if (dir === 'ArrowRight') { main = dx; side = dy; }
    else if (dir === 'ArrowLeft') { main = -dx; side = dy; }
    else if (dir === 'ArrowDown') { main = dy; side = dx; }
    else { main = -dy; side = dx; }
    if (main <= 5) continue;
    const score = main + Math.abs(side) * 3;
    if (score < bestScore) { bestScore = score; best = el; }
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
  if (sheetOpen && ['Escape', 'Backspace'].includes(e.key) && !typing) { e.preventDefault(); closeSheet(); return; }
  if (typing && !['ArrowUp', 'ArrowDown', 'Escape'].includes(e.key)) return;
  if (NAV_KEYS.includes(e.key)) { e.preventDefault(); navigate(e.key); return; }
  if (e.key === 'Enter' && a && a.classList.contains('tile')) { e.preventDefault(); a.click(); return; }
  if ((e.key === 'f' || e.key === 'ContextMenu') && a && a.dataset.card) { e.preventDefault(); toggleFav(a.dataset.card); }
});

/* ================= Klicks ================= */
document.addEventListener('click', e => {
  const t = e.target;
  const fav = t.closest('[data-fav]');
  if (fav) { e.stopPropagation(); toggleFav(fav.dataset.fav); return; }
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
  const ok = await addSource({ id: 's' + uid(), type: 'm3u', name: $('#m3uName').value.trim() || 'M3U-Playlist', url });
  btn.disabled = false; btn.textContent = 'Hinzufügen & laden';
  if (ok) { $('#m3uName').value = ''; $('#m3uUrl').value = ''; }
});
$('#xtAdd').addEventListener('click', async e => {
  const server = $('#xtServer').value.trim(), user = $('#xtUser').value.trim(), pass = $('#xtPass').value;
  if (!server || !user || !pass) return toast('Server, Benutzername und Passwort ausfüllen');
  const btn = e.currentTarget; btn.disabled = true; btn.textContent = 'Anmelden …';
  const ok = await addSource({ id: 's' + uid(), type: 'xtream', name: $('#xtName').value.trim() || 'Xtream', server: normServer(server), user, pass, format: xtFmt });
  btn.disabled = false; btn.textContent = 'Anmelden & laden';
  if (ok) ['#xtName', '#xtServer', '#xtUser', '#xtPass'].forEach(s => $(s).value = '');
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
