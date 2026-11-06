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
let navY = 0, navYAt = 0;   // Ziel des laufenden Seiten-Scrollens (siehe pageScrollTo)
const DEFAULT_SETTINGS = { autoRefresh: true, vpnAuto: true, vpnReq: false, tmdbKey: '', hideLive: [], hideSeries: [], hideVod: [], lite: false, theme: 'graphite', saver: 5, nativeVod: true };

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
/** Sender ohne ausgeblendete Kategorien. */
function visibleChannels() {
  const h = state.settings.hideLive || [];
  if (!h.length) return state.channels;
  const H = new Set(h);
  return state.channels.filter(c => !H.has(c.group));
}
function groups(list = visibleChannels()) {
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
    resetCatalogs(); setTimeout(bgCatalogs, 500);
    if (!quiet) toast(`${src.name}: ${list.length} Kanäle geladen`);
    setTimeout(() => SYNC.run(true), 1000);   // Fortschritt/Favoriten dieser Quelle aus der Cloud übernehmen
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
  resetCatalogs(); setTimeout(bgCatalogs, 500);
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
  if (clistOpen && cl.ids.includes(id)) renderClist();
  if (sheetOpen && spSheet) { clearTimeout(spEpgT); spEpgT = setTimeout(() => { if (sheetOpen && spSheet) renderSportSheet(); }, 300); }
}
let spEpgT = null;
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
  const m = v.m, pct = v.dur && !v.next ? Math.min(100, v.pos / v.dur * 100) : 0;
  const left = v.dur ? Math.max(1, Math.round((v.dur - v.pos) / 60)) : 0;
  return `<div class="tile show cont focusable" tabindex="0" data-resume="${esc(v.id)}">
    <div class="art">${m.img ? `<img class="bd" src="${esc(m.img)}" alt="" loading="lazy" onerror="this.remove()">` : `<span class="ini">${esc(initials(m.show))}</span>`}
      <div class="shade"></div><span class="ep-badge">${m.movie ? 'Film' : `S${esc(m.season)} E${esc(m.num)}`}</span>
      <div class="t">${esc(m.show)}</div><span class="pbar"><i style="width:${pct.toFixed(1)}%"></i></span></div>
    <div class="caption">${esc([v.next ? 'Als Nächstes' : '', m.movie ? '' : m.title, left && !v.next ? `noch ${left} Min.` : ''].filter(Boolean).join(' · ')) || '&nbsp;'}</div>
  </div>`;
}
function continueRail() {
  const list = VP.continueList();
  return list.length ? railHTML('Weiterschauen', list.map(resumeTileHTML).join(''), 'OK gedrückt halten zum Entfernen') : '';
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
const FAV_CAT = 'Favoriten';
/** Start: nur Ausschnitte – Weiterschauen, Lieblingssender, Zuletzt gesehen, ein paar Empfehlungen. */
function renderHome() {
  $('#homeTop').innerHTML = continueRail() + channelRail('Lieblingssender', favList(), FAV_CAT);
  if (VP.needNext().length && !nextBusy) setTimeout(fillNext, 300);
  EPG.scan();
  if (!heroItems.length) renderHero();
}
/** Live-TV: alle Sender, „Favoriten“ ist der erste Chip. */
function renderLive() {
  const g = groups(), favs = favList();
  if (state.cat === FAV_CAT ? !favs.length : state.cat !== 'Alle' && !g.has(state.cat)) state.cat = 'Alle';
  const names = [...(favs.length ? [FAV_CAT] : []), 'Alle', ...g.keys()];
  $('#chips').innerHTML = names.map(n => `<button class="chip focusable ${state.cat === n ? 'active' : ''}" data-cat="${esc(n)}">${n === FAV_CAT ? '★ ' : ''}${esc(n)}</button>`).join('');
  const vis = visibleChannels().length;
  $('#liveCount').textContent = state.channels.length ? vis + ' Sender' + (vis !== state.channels.length ? ` (${state.channels.length - vis} ausgeblendet)` : '') : '';
  let rows = '';
  if (state.cat === 'Alle') {
    let n = 0;
    for (const [name, list] of g) { if (n++ >= ROWS_MAX) break; rows += channelRail(name, list, name); }
    if (g.size > ROWS_MAX) rows += `<p class="empty">Weitere ${g.size - ROWS_MAX} Kategorien oben in der Leiste.</p>`;
  } else {
    const list = state.cat === FAV_CAT ? favs : g.get(state.cat) || [];
    rows = `<div class="grid">${list.slice(0, GRID_MAX).map(tileHTML).join('')}</div>` +
      (list.length > GRID_MAX ? `<p class="empty">Weitere ${list.length - GRID_MAX} Sender über die Suche.</p>` : '');
  }
  $('#liveRows').innerHTML = rows || `<p class="empty">Noch keine Sender. Unter „Einstellungen“ eine M3U-Playlist oder einen Xtream-Zugang hinzufügen.</p>`;
  EPG.scan();
}

/* ---------- Empfehlungen: nur Titel, die dein Anbieter hat ---------- */
/** 'all' = ohne Xtream nicht prüfbar, 'filter' = Katalog da, 'wait' = lädt noch, 'none' = Katalog nicht verfügbar */
function availMode(type) {
  if (!XS.accounts().length) return 'all';
  const S = CAT[type === 'movie' ? 'vod' : 'series'];
  if (S.status === 'ready') return 'filter';
  return S.status === 'error' || S.status === 'none' ? 'none' : 'wait';
}
function availList(id, type) {
  const mode = availMode(type), raw = TM.list(id);
  if (mode === 'none') return [];
  if (mode === 'all') return raw;
  if (mode === 'wait') return null;
  return raw.filter(p => XS.has(p));
}
function recRowHTML(t, moreView, used) {
  const raw = TM.list(t.id);
  if (!raw.length && (TM.loading.has(t.id) || !TM.cache[t.id])) return t.genre ? '' : railHTML(t.label, skeletons(5));
  let list = availList(t.id, t.type);
  if (!list) return t.genre ? '' : railHTML(t.label, skeletons(5));
  // Genre-Reihen: nichts zeigen, was weiter oben schon steht → mehr Abwechslung
  if (used && t.genre) list = list.filter(p => !used.has(p.type + ':' + p.id));
  list = t.rank ? list.slice(0, 10) : list.slice(0, RAIL_MAX);
  if (t.genre && list.length < 4) return '';
  if (used) for (const p of list) used.add(p.type + ':' + p.id);
  const items = list.map(p => showTileHTML(p, t.rank ? raw.indexOf(p) + 1 : 0));
  if (!items.length) return '';
  const more = moreView ? `<div class="tile show more focusable" tabindex="0" data-view="${moreView}"><div class="art"><span>Alle ${moreView === 'movies' ? 'Filme' : 'Serien'} →</span></div><div class="caption">&nbsp;</div></div>` : '';
  return railHTML(t.label, items.join('') + more);
}
/* ---------- Watchlist (Serien-Watchlist-Konto): am Schauen zuerst, dann geplant ---------- */
function wlPicks(type) {
  if (!WL.connected) return [];
  const rank = { watching: 0, planned: 1 };
  const own = state.settings.wlOrder || [], pos = new Map(own.map((k, i) => [k, i]));
  const list = (WL.s.items || []).filter(o => o.status in rank && (o.media_type === 'tv' || o.media_type === 'movie') && (!type || o.media_type === type))
    .sort((a, b) => rank[a.status] - rank[b.status]
      || (a.status === 'watching' ? String(b.updated_at || '').localeCompare(String(a.updated_at || '')) : (Number(a.position) || 0) - (Number(b.position) || 0)));
  // eigene Reihenfolge (verschoben mit OK gedrückt halten); neue Titel hinten
  const ix = o => { const k = o.media_type + ':' + o.tmdb_id; return pos.has(k) ? pos.get(k) : own.length + list.indexOf(o); };
  if (own.length) list.sort((a, b) => ix(a) - ix(b));
  return list.map(o => ({
      type: o.media_type, id: o.tmdb_id, title: o.title || '', orig: '', backdrop: o.backdrop_path || null, poster: o.poster_path || null,
      overview: '', year: String((o.meta && o.meta.year) || ''), vote: 0, reason: o.status === 'watching' ? 'Am Schauen' : 'Auf der Watchlist'
    }));
}
function wlRowHTML(type) {
  const all = wlPicks(type);
  if (!all.length) return '';
  const list = all.filter(p => { const m = availMode(p.type); return m === 'all' || (m === 'filter' && XS.has(p)); });
  if (!list.length) return all.some(p => availMode(p.type) === 'wait') ? railHTML('Meine Watchlist', skeletons(4)) : '';
  return railHTML('Meine Watchlist', list.map(p => showTileHTML(p)).join(''), 'OK gedrückt halten zum Verschieben').replace('<section>', `<section class="wl-row" data-wltype="${type || ''}">`);
}
/* ---------- Watchlist sortieren: OK halten → ◀▶ verschieben → OK speichern ---------- */
const WLM = { on: false, el: null };
function startMove(el) {
  WLM.on = true; WLM.el = el;
  el.classList.add('moving');
  el.closest('.wl-row').classList.add('sorting');
  toast('◀ ▶ verschieben · OK speichern');
}
function moveStep(dir) {
  const el = WLM.el, sib = dir < 0 ? el.previousElementSibling : el.nextElementSibling;
  if (!sib || !sib.dataset.show) return;
  if (dir < 0) sib.before(el); else sib.after(el);
  el.focus({ preventScroll: true });
  scrollInRow(el);
}
function endMove() {
  if (!WLM.on) return;
  const el = WLM.el, row = el.closest('.wl-row'), key = el.dataset.show;
  WLM.on = false; WLM.el = null;
  const sub = [...row.querySelectorAll('[data-show]')].map(t => t.dataset.show), set = new Set(sub);
  let j = 0;
  const merged = wlPicks().map(p => p.type + ':' + p.id).map(k => set.has(k) ? sub[j++] : k);
  state.settings.wlOrder = merged; persist();
  renderRecs();
  const t = visibleOf(`.wl-row [data-show="${CSS.escape(key)}"]`);
  if (t) t.focus({ preventScroll: true });
  toast('Reihenfolge gespeichert');
  // geplante Titel auch im Watchlist-Konto umsortieren (wie in der Watchlist-App)
  const planned = merged.map(k => (WL.s.items || []).find(o => o.media_type + ':' + o.tmdb_id === k)).filter(o => o && o.status === 'planned');
  const changes = planned.map((o, i) => ({ type: o.media_type, id: o.tmdb_id, position: i + 1 })).filter((x, i) => Number(planned[i].position) !== x.position);
  WL.setPositions(changes).catch(e => toast(e.message));
}
function renderRecs() {
  keepFocus(() => {
    if (!TM.key()) {
      const setup = `<div class="pad"><div class="group"><div class="row-item"><div class="meta"><b>Empfehlungen einrichten</b>
        <small>Melde dich mit deinem Serien-Watchlist-Konto an oder hinterlege einen TMDB-Schlüssel.</small></div>
        <div class="actions"><button class="btn primary small focusable" data-view="settings">Zu den Einstellungen</button></div></div></div></div>`;
      $('#homeRecs').innerHTML = '';
      $('#serRecs').innerHTML = setup; $('#movRecs').innerHTML = setup;
      return;
    }
    const tabs = TM.tabs();
    $('#homeRecs').innerHTML = wlRowHTML() + tabs.filter(t => ['forYou', 'top', 'mTop'].includes(t.id)).map(t => recRowHTML(t, t.type === 'movie' ? 'movies' : 'series')).join('');
    const view = type => {
      const used = new Set(), own = tabs.filter(t => (t.type === 'movie') === (type === 'movie'));
      const top = own.filter(t => !t.genre).map(t => recRowHTML(t, null, used)).join('');
      const gen = own.filter(t => t.genre).map(t => recRowHTML(t, null, used)).join('');
      return wlRowHTML(type) + top + (gen ? `<div class="section-label cat-label">Nach Genre</div>` + gen : '');
    };
    $('#serRecs').innerHTML = view('tv');
    $('#movRecs').innerHTML = view('movie');
  });
}

/* ---------- Suche: eine Stelle für Sender, Serien und Filme ---------- */
const SEARCH_MAX = 30;
function catalogHits(kind, q) {
  const S = CAT[kind];
  if (S.status !== 'ready' || !q) return [];
  const H = new Set(state.settings[S.hide] || []), out = [];
  for (let i = 0; i < S.items.length; i++) {
    const it = S.items[i].it;
    if (!it.n.includes(q) || (H.size && H.has(it.cat))) continue;
    out.push([i, it.n.startsWith(q) ? 0 : 1, it.n.length]);
  }
  return out.sort((a, b) => a[1] - b[1] || a[2] - b[2]).slice(0, SEARCH_MAX).map(x => x[0]);
}
function catalogRail(kind, q) {
  const S = CAT[kind];
  if (S.status === 'loading' || S.status === 'idle') return railHTML(S.word, `<div class="tile poster skeleton"><div class="art"></div><div class="caption">&nbsp;</div></div>`.repeat(4));
  const hits = catalogHits(kind, q);
  return hits.length ? railHTML(S.word, hits.map(i => serTileHTML(kind, S.items[i], i)).join(''), hits.length >= SEARCH_MAX ? SEARCH_MAX + '+' : hits.length) : '';
}
function renderSearch() {
  const raw = $('#q').value.trim(), q = raw.toLowerCase();
  if (!q) {
    $('#searchInfo').textContent = '';
    $('#searchGrid').innerHTML = `<p class="empty">Mit der Tastatur links lostippen – Sender, Serien und Filme erscheinen sofort.</p>`;
    $('#searchShows').innerHTML = '';
    return;
  }
  const res = visibleChannels().filter(c => (c.name + ' ' + c.group).toLowerCase().includes(q));
  let html = res.length ? railHTML('Sender', res.slice(0, SEARCH_MAX).map(tileHTML).join(''), res.length) : '';
  const xt = XS.accounts().length > 0;
  if (xt) { const n = XS.norm(raw); html += catalogRail('series', n) + catalogRail('vod', n); }
  $('#searchInfo').textContent = '';
  keepFocus(() => {
    $('#searchGrid').innerHTML = html || (xt || !TM.key() ? `<p class="empty">Nichts gefunden zu „${esc(raw)}“.</p>` : '');
    if (xt) $('#searchShows').innerHTML = '';
  });
  EPG.scan();
}
let searchTimer = null;
/** Ohne Xtream-Zugang: TMDB-Treffer als Ersatz. */
function searchShows() {
  clearTimeout(searchTimer);
  const q = $('#q').value.trim();
  if (q.length < 2 || !TM.key() || XS.accounts().length) { if (!XS.accounts().length) $('#searchShows').innerHTML = ''; return; }
  searchTimer = setTimeout(async () => {
    try {
      const res = await TM.search(q);
      if ($('#q').value.trim() !== q) return;
      keepFocus(() => { $('#searchShows').innerHTML = res.length ? railHTML('Serien & Filme', res.slice(0, 20).map(p => showTileHTML(p)).join(''), res.length) : ''; });
    } catch (e) { $('#searchShows').innerHTML = ''; }
  }, 450);
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
  $('#swLite').classList.toggle('on', !!s.lite);
  $('#swNative').classList.toggle('on', s.nativeVod !== false);
  $('#swNative').classList.toggle('hidden', !(bridge && typeof bridge.nvPlay === 'function'));
  const liveNat = !!(bridge && typeof bridge.nvPlayLive === 'function');
  $('#swNativeLive').classList.toggle('on', s.nativeLive !== false);
  $('#swNativeLive').classList.toggle('hidden', !liveNat);
  $$('#bufSeg [data-buf]').forEach(b => b.classList.toggle('sel', Number(b.dataset.buf) === liveBuf()));
  $('#addSrcBody').classList.toggle('hidden', !addSrcOpen && state.sources.length > 0);
  $('#addSrcChev').textContent = addSrcOpen || !state.sources.length ? '⌄' : '›';
  $$('#saverSeg [data-saver]').forEach(b => b.classList.toggle('sel', Number(b.dataset.saver) === Number(s.saver)));
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
        ${x.type === 'xtream' ? `<button class="mini focusable" data-src-act="fmt" data-id="${esc(x.id)}">Format: ${x.format === 'ts' ? 'MPEG-TS' : 'HLS'}</button>` : ''}
        <button class="mini focusable" data-src-act="refresh" data-id="${esc(x.id)}">Aktualisieren</button>
        <button class="mini focusable" data-src-act="del" data-id="${esc(x.id)}">Entfernen</button>
      </div>
    </div>`).join('') : `<div class="row-item"><span class="hint">Noch keine Quelle – unten „Quelle hinzufügen“ öffnen.</span></div>`;
  renderWlGroup();
  renderVpn();
  renderUpdate();
  const nl = (s.hideLive || []).length, ns = (s.hideSeries || []).length, nv = (s.hideVod || []).length;
  $('#catOpenSub').textContent = nl || ns || nv ? `Live-TV: ${nl} · Serien: ${ns} · Filme: ${nv} ausgeblendet` : 'Alle Kategorien sichtbar';
  $('#manageOpenSub').textContent = `${state.channels.length} Kanäle · ${state.favs.length} Favoriten`;
}
function renderWlGroup() {
  const own = (state.settings.tmdbKey || '').trim();
  let html = '';
  if (WL.connected) {
    const n = (WL.s.items || []).length;
    html += `<div class="row-item"><div class="meta"><b>Serien-Watchlist: ${esc(WL.s.email || 'angemeldet')}</b>
      <small>${n} Titel auf der Watchlist · TMDB-Schlüssel ${WL.s.tmdb ? '✓' : 'fehlt im Konto'} · Sync ${SYNC.meta().pulledAt ? 'zuletzt ' + new Date(SYNC.meta().pulledAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : 'ausstehend'}</small></div>
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
function renderAll() { renderHome(); renderLive(); renderSearch(); renderManage(); renderSettings(); renderRecs(); }
function focusSel(a) {
  const d = a && a.dataset;
  if (!d) return null;
  for (const k of ['card', 'show', 'cat', 'resume', 'ev', 'spc', 'ser', 'view']) if (d[k]) return `[data-${k}="${CSS.escape(d[k])}"]`;
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
function refresh() { persist(); keepFocus(() => { renderHome(); renderLive(); renderSearch(); renderManage(); renderSettings(); }); }
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
  // Billboard: abwechselnd Top-Serien und Top-Filme der Woche (nur, was der Anbieter hat)
  const tv = (availList('top', 'tv') || []).filter(p => p.backdrop).slice(0, 4);
  const mv = (availList('mTop', 'movie') || []).filter(p => p.backdrop).slice(0, 3);
  heroItems = [];
  for (let i = 0; i < Math.max(tv.length, mv.length); i++) { if (tv[i]) heroItems.push(tv[i]); if (mv[i]) heroItems.push(mv[i]); }
  heroIdx = 0;
  renderHero();
  clearInterval(heroTimer);
  if (heroItems.length > 1) heroTimer = setInterval(() => {
    if (state.view !== 'home' || playerOpen || sheetOpen || $('#hero').contains(document.activeElement)) return;
    heroIdx = (heroIdx + 1) % heroItems.length;
    renderHero();
  }, 9000);
}
let heroFlipAt = 0;
/** Billboard per Fernbedienung weiterblättern; Fokus bleibt auf dem gleichen Button. */
function heroFlip(step, from) {
  heroFlipAt = Date.now();
  const which = from && from.dataset && from.dataset.play ? 'play' : 'show';
  heroIdx = (heroIdx + step + heroItems.length) % heroItems.length;
  renderHero();
  const b = $(`#heroContent [data-${which}]`);
  if (b) b.focus({ preventScroll: true });
}
let heroLayer = 0, heroShown = '', heroAnimKey = '';
/** Hintergrund weich überblenden (zwei Ebenen, Ken-Burns-Zoom). */
function heroBackdrop(url) {
  if (url === heroShown) return;
  heroShown = url;
  const layers = [$('#heroBg'), $('#heroBg2')];
  if (!url) { layers.forEach(l => l.classList.remove('show')); return; }
  const img = new Image();
  img.onload = () => {
    if (heroShown !== url) return;
    heroLayer = 1 - heroLayer;
    const on = layers[heroLayer], off = layers[1 - heroLayer];
    on.style.backgroundImage = `url("${url}")`;
    on.classList.remove('show'); void on.offsetWidth;
    on.classList.add('show'); off.classList.remove('show');
  };
  img.src = url;
}
function heroEnter(key) {
  if (key === heroAnimKey) return;
  heroAnimKey = key;
  const box = $('#heroContent');
  box.classList.remove('enter'); void box.offsetWidth; box.classList.add('enter');
}
function renderHero() {
  const box = $('#heroContent');
  if (heroItems.length) {
    const p = heroItems[heroIdx];
    heroBackdrop(`${TM.IMG}w1280${p.backdrop}`);
    const d = TM.details_[p.type + ':' + p.id];
    const logo = d && TM.pickLogo(d);
    const film = p.type === 'movie';
    box.innerHTML = `<div class="eyebrow"><span class="t10">TOP<b>10</b></span>Platz ${TM.list(film ? 'mTop' : 'top').indexOf(p) + 1} der ${film ? 'Filme' : 'Serien'} diese Woche</div>
      ${logo ? `<img class="hero-logo" src="${TM.IMG}w500${logo}" alt="">` : `<h1>${esc(p.title)}</h1>`}
      <div class="meta">${esc(TM.info(p))}</div>
      <p class="ov">${esc(p.overview)}</p>
      <div class="btn-row"><button class="btn primary focusable" data-play="${p.type}:${p.id}">▶ Abspielen</button>
      <button class="btn focusable" data-show="${p.type}:${p.id}">Details</button></div>`;
    $('#heroDots').innerHTML = heroItems.map((_, i) => `<i class="${i === heroIdx ? 'on' : ''}"></i>`).join('');
    heroEnter('tmdb:' + p.id);
    if (!d) TM.details(p.type, p.id).then(() => {
      if (heroItems[heroIdx] !== p) return;
      const f = document.activeElement, w = f && f.closest && f.closest('#hero') ? (f.dataset.play ? 'play' : 'show') : null;
      renderHero();
      if (w) { const b = $(`#heroContent [data-${w}]`); if (b) b.focus({ preventScroll: true }); }
    }).catch(() => {});
    return;
  }
  heroBackdrop('');
  $('#heroDots').innerHTML = '';
  // Kein Sender als Billboard: solange die Top-Titel laden, ein ruhiger Platzhalter
  const ready = TM.key() && (state.sources.length || !XS.accounts().length);
  box.innerHTML = ready
    ? `<div class="eyebrow"><span class="t10">TOP<b>10</b></span>Serien &amp; Filme diese Woche</div><h1 class="hero-wait">Lade Top-Titel …</h1>`
    : `<div class="eyebrow">Willkommen</div><h1>StreamTV</h1><p class="ov">${TM.key() ? 'Füge unter „Einstellungen“ eine M3U-Playlist oder einen Xtream-Zugang hinzu.' : 'Melde dich unter „Einstellungen“ mit deinem Watchlist-Konto an oder hinterlege einen TMDB-Schlüssel, um die Top-Serien und -Filme zu sehen.'}</p>
       <div class="btn-row"><button class="btn primary focusable" data-view="settings">Einrichten</button></div>`;
  heroEnter(ready ? 'wait' : 'setup');
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
  if (!TM.key()) { renderRecs(); renderHero(); return; }
  renderRecs();
  const tabs = TM.tabs();
  await Promise.all(tabs.filter(t => !t.genre).map(t => TM.ensure(t, force).catch(() => {}).then(() => {
    renderRecsSoon();
    if (t.id === 'top' || t.id === 'mTop') setupHero();
  })));
  // Genre-Reihen in kleinen Paketen (schont Fernseher und TMDB)
  const gen = tabs.filter(t => t.genre);
  for (let i = 0; i < gen.length; i += 4) {
    await Promise.all(gen.slice(i, i + 4).map(t => TM.ensure(t, force).catch(() => {})));
    renderRecsSoon();
  }
}
let recsTimer = null;
function renderRecsSoon() { clearTimeout(recsTimer); recsTimer = setTimeout(renderRecs, 250); }

/* ================= Detailansicht (Serie) ================= */
async function openSheet(key) {
  const p = TM.find(key);
  if (!p) return;
  if (!sheetOpen) { lastFocus = document.activeElement; sheetOpen = true; pushOverlay('sheet'); $('#sheet').classList.add('open'); sheetAnim(); }
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
  const wlo = onList ? WL.item(p.type, p.id) : null;
  const wlLbl = !wlo ? '' : wlo.status === 'watching' ? '✓ Am Schauen' : wlo.status === 'done' ? '✓ Gesehen' : wlo.status === 'dropped' ? '✓ Abgebrochen' : '✓ Auf deiner Watchlist';
  const focusedId = document.activeElement && document.activeElement.id;
  $('#sheetInner').innerHTML = `
    ${logo ? `<img class="logo-img" src="${TM.IMG}w500${logo}" alt="">` : `<h1>${esc(p.title)}</h1>`}
    ${p.reason || wlLbl ? `<div class="reason">${esc(p.reason || '')}${wlLbl ? `<span class="wl-tag">${wlLbl}</span>` : ''}</div>` : ''}
    <div class="meta">${esc(meta)}</div>
    <p class="ov">${esc((d && d.overview) || p.overview || 'Keine Beschreibung vorhanden.')}</p>
    ${prov.length ? `<div class="prov">${prov.map(n => `<span>${esc(n)}</span>`).join('')}</div>` : ''}
    <div class="btn-row">
      <button class="btn primary focusable" id="shIptv" data-iptv="${key}">▶ Beim Anbieter suchen</button>
      ${WL.connected ? `<button class="btn focusable ${onList ? 'on' : ''}" id="shAdd">${onList ? '✓ Watchlist' : '+ Auf die Watchlist'}</button>` : ''}
      <button class="btn focusable" id="shLive" data-livesearch="${esc(p.title)}">Suchen</button>
      <button class="btn focusable" id="shClose">Schließen</button>
    </div>`;
  const add = $('#shAdd');
  if (add) add.onclick = async () => {
    if (add.dataset.busy) return;
    if (onList && !add.dataset.ask) {   // erst nachfragen, dann entfernen
      add.dataset.ask = '1'; add.textContent = 'Wirklich entfernen? OK';
      setTimeout(() => { if (add.isConnected && add.dataset.ask && !add.dataset.busy) { delete add.dataset.ask; add.textContent = '✓ Watchlist'; } }, 4000);
      return;
    }
    add.dataset.busy = '1'; add.textContent = onList ? 'Entferne …' : 'Speichere …';
    try {
      const det = d || await TM.details(p.type, p.id);
      if (onList) { await WL.remove(p.type, p.id); toast(`„${p.title}“ von der Watchlist entfernt`); }
      else { await WL.addPlanned(p.type, det); toast(`„${p.title}“ steht jetzt auf deiner Watchlist`); }
      if (sheetOpen && !ip) { renderSheet(p, det); const b = $('#shAdd'); if (b) b.focus({ preventScroll: true }); }
      renderRecs();
    } catch (e) { toast(e.message); delete add.dataset.busy; delete add.dataset.ask; add.textContent = onList ? '✓ Watchlist' : '+ Auf die Watchlist'; }
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
  if (spSheet) { spSheet = null; $('#sheet').classList.remove('sport'); }
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
async function openIptv(key, autoplay) {
  const p = TM.find(key);
  if (!p || !sheetOpen) return;
  const d = TM.details_[key] || null;
  ip = { p, d, status: 'loading', msg: '', hits: [], sel: null, info: null, season: null, token: Date.now(), autoplay: autoplay || null };
  pushOverlay('iptv');
  $('#sheet').classList.add('iptv');
  sheetAnim();
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
    if (!(ip.p.id > 0) && TM.key()) {
      const tm = await guessTmdb(h.it.name, ip.p.type === 'movie');
      if (!ip || ip.token !== tok || ip.sel !== h) return;
      if (tm) { ip.p.id = Number(tm.split(':')[1]); if (!h.it.tmdb) h.it.tmdb = ip.p.id; }
    }
    ip.season = resumeEp(info) ? resumeEp(info).season : info.seasons[0].num;
    // Fortschritt aus der Watchlist-App (z. B. woanders gesehen) frisch holen
    if (WL.connected) { const cur = ip; WL.refreshItems(false).then(() => { if (ip === cur && ip.status === 'show') renderIptv(); }).catch(() => {}); }
    renderIptv(true);
    if (ip.autoplay) autoPlayIptv();
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
  let local = idx < 0 ? -1 : VP.done(all[idx].id) ? idx + 1 : idx;
  // Watchlist-Fortschritt (auch woanders gesehen): nach der letzten gesehenen Folge weiter, wenn das weiter ist
  let wl = -1;
  all.forEach((e, i) => { if (wlSeenEp(e)) wl = i + 1; });
  const at = Math.max(local, wl);
  return at >= 0 ? all[at] || null : null;
}
/** Folge laut StreamTV oder Watchlist gesehen? */
const wlSeenEp = e => !!(ip && ip.p && WL.connected && ip.p.id > 0 && WL.seen(ip.p.type, ip.p.id, e.season, e.num));
const epDone = e => VP.done(e.id) || wlSeenEp(e);
const GENERIC_EP = /^(folge|episode|ep\.?)\s*\d+$/i;
/** Folge mit TMDB-Infos anreichern (Standbild, Titel, Beschreibung). */
function epView(e) {
  const t = ip && ip.tm && ip.tm[e.season] && ip.tm[e.season][e.num];
  const title = t && t.name && !GENERIC_EP.test(t.name) && (GENERIC_EP.test(e.title) || !e.title) ? t.name : e.title || (t && t.name) || `Folge ${e.num}`;
  const img = t && t.still ? `${TM.IMG}w300${t.still}` : e.img || '';
  return { title, img, plot: e.plot || (t && t.ov) || '' };
}
function loadSeasonTm(n) {
  if (!ip || ip.p.type !== 'tv' || !(ip.p.id > 0) || !TM.key()) return;
  ip.tm = ip.tm || {};
  if (ip.tm[n] || (ip.tmBusy || {})[n]) return;
  (ip.tmBusy = ip.tmBusy || {})[n] = true;
  const tok = ip.token;
  TM.season(ip.p.id, n).then(m => { if (ip && ip.token === tok) { ip.tm[n] = m; if (ip.status === 'show' && ip.season === n) renderIptv(); } }).catch(() => {});
}
function renderIptv(focusResume) {
  if (!ip) return;
  const { p } = ip;
  const focusedKey = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.ipk;
  const accNames = [...new Set(XS.accounts().map(a => a.name))].join(', ');
  const film = p.type === 'movie';
  const d = ip.d || TM.details_[p.type + ':' + p.id] || null;
  let body = '', sub = '', ov = '';
  const btns = [];
  if (ip.status === 'loading') sub = `Durchsuche den ${film ? 'Filmkatalog' : 'Serienkatalog'} von ${accNames || 'deinem Anbieter'} … (beim ersten Mal etwas länger)`;
  else if (ip.status === 'error') sub = ip.msg;
  else if (ip.status === 'empty') sub = `${film ? 'Dieser Film' : 'Diese Serie'} wurde im Katalog deines Anbieters nicht gefunden.`;
  else if (ip.status === 'list') sub = `${ip.hits.length} mögliche Treffer – bitte auswählen`;
  else if (ip.status === 'loadingShow') sub = `Lade ${film ? 'Film' : 'Folgen von'} „${cleanName(ip.sel.it.name)}“ …`;
  else if (ip.status === 'show') {
    const year = ip.sel.it.year || (d && String(d.first_air_date || d.release_date || '').slice(0, 4)) || '';
    ov = (d && d.overview) || '';
    if (ip.info.movie) {
      const e = ip.info.seasons[0].eps[0], v = VP.get(e.id), dur = e.dur || (v && v.dur) || 0;
      sub = [year, dur ? (Math.floor(dur / 3600) ? Math.floor(dur / 3600) + ' Std. ' : '') + Math.round(dur % 3600 / 60) + ' Min.' : '', ip.sel.acc.name].filter(Boolean).join(' · ');
      ov = ov || e.plot;
      const resume = v && v.pos > 30 && !VP.done(e.id);
      btns.push(`<button class="btn primary focusable" data-ipk="play" data-ip="ep" data-s="0" data-i="0">▶ ${resume ? 'Weiterschauen ab ' + fmtTime(v.pos) : 'Abspielen'}</button>`);
      if (resume) btns.push(`<button class="btn focusable" data-ipk="restart" data-ip="restart" data-s="0" data-i="0">↺ Von vorne</button>`);
      if (resume) body = `<div class="ep-moviebar"><span class="ip-pbar"><i style="width:${Math.min(100, v.pos / v.dur * 100).toFixed(1)}%"></i></span><small>noch ${Math.max(1, Math.round((v.dur - v.pos) / 60))} Min.</small></div>`;
    } else {
      const n = ip.info.seasons.reduce((a, s) => a + s.eps.length, 0), ns = ip.info.seasons.filter(s => s.num).length;
      sub = [year, ns ? `${ns} Staffel${ns > 1 ? 'n' : ''}` : '', `${n} Folgen`, ip.sel.acc.name].filter(Boolean).join(' · ');
      const all = ip.info.seasons.flatMap(s => s.eps), r = resumeEp(ip.info) || all[0];
      const rv = VP.get(r.id), cont = rv && rv.pos > 30 && !epDone(r);
      const si = ip.info.seasons.find(s => s.num === r.season).eps.indexOf(r);
      btns.push(`<button class="btn primary focusable" data-ipk="play" data-ip="ep" data-s="${r.season}" data-i="${si}">▶ ${cont ? 'Weiterschauen' : 'Abspielen'} · ${r.season ? 'S' + r.season + ':' : ''}F${r.num}</button>`);
      if (cont) btns.push(`<button class="btn focusable" data-ipk="restart" data-ip="restart" data-s="${r.season}" data-i="${si}">↺ Folge von vorne</button>`);
      // Staffeln links, Folgen rechts
      const season = ip.info.seasons.find(s => s.num === ip.season) || ip.info.seasons[0];
      loadSeasonTm(season.num);
      const col = ip.info.seasons.length > 1 ? `<div class="ep-seasons">${ip.info.seasons.map(s => {
        const seen = s.eps.filter(epDone).length;
        return `<button class="ep-season focusable ${s.num === season.num ? 'active' : ''}" data-ipk="s${s.num}" data-ip="season" data-s="${s.num}">
          <b>${s.num ? 'Staffel ' + s.num : 'Extras'}</b><small>${s.eps.length} Folgen${seen ? ` · ${seen} gesehen` : ''}</small></button>`;
      }).join('')}</div>` : '';
      const rows = season.eps.map((e, i) => {
        const v = VP.get(e.id), done = epDone(e), x = epView(e);
        const dur = e.dur || (v && v.dur) || 0, pct = v && v.dur ? Math.min(100, v.pos / v.dur * 100) : 0;
        const state = done ? '<span class="ep-st ok">✓ Gesehen</span>' : v && v.pos > 30 ? `<span class="ep-st go">Weiter bei ${fmtTime(v.pos)}</span>` : '';
        return `<button class="ep focusable ${done ? 'seen' : ''}" data-ipk="e${e.id}" data-ip="ep" data-s="${season.num}" data-i="${i}">
          <span class="ep-thumb">${x.img ? `<img src="${esc(x.img)}" alt="" loading="lazy" onerror="this.remove()">` : ''}<span class="ep-n">${e.num}</span><span class="ep-play">▶</span>
            ${pct > 0 && !done ? `<span class="ep-bar"><i style="width:${pct.toFixed(1)}%"></i></span>` : ''}</span>
          <span class="ep-txt"><span class="ep-top"><b>${e.num}. ${esc(x.title)}</b>${dur ? `<span class="ep-dur">${Math.round(dur / 60)} Min.</span>` : ''}</span>
            ${x.plot ? `<span class="ep-plot">${esc(x.plot)}</span>` : ''}${state}</span>
        </button>`;
      }).join('');
      body = `<div class="ep-cols ${col ? '' : 'single'}">${col}<div class="ep-list">${rows}</div></div>`;
    }
  }
  let wlTag = '';
  if (ip.status === 'show' && WL.connected) {
    const o = p.id > 0 ? WL.item(p.type, p.id) : null;
    if (o) wlTag = `<span class="wl-tag">✓ ${o.status === 'watching' ? 'Am Schauen' : o.status === 'done' ? 'Gesehen' : o.status === 'dropped' ? 'Abgebrochen' : 'Auf deiner Watchlist'}</span>`;
    const lbl = ip.wlBusy ? (o ? 'Entferne …' : 'Speichere …') : o ? (ip.wlAsk ? 'Wirklich entfernen? OK' : '✓ Watchlist') : '+ Watchlist';
    btns.push(`<button class="btn focusable ${o ? 'on' : ''}" data-ipk="wl" data-ip="wl">${lbl}</button>`);
  }
  if (ip.sel && ip.hits.length > 1) btns.push(`<button class="btn focusable" data-ipk="hits" data-ip="hits">Andere Treffer (${ip.hits.length})</button>`);
  if (['error', 'empty'].includes(ip.status)) btns.push(`<button class="btn focusable" data-ipk="retry" data-ip="retry">Erneut versuchen</button>`,
    `<button class="btn focusable" data-ipk="live" data-livesearch="${esc(p.title)}">Suchen</button>`);
  if (ip.status !== 'show') btns.push(`<button class="btn focusable" data-ipk="back" data-ip="back">‹ Zurück</button>`);

  if (ip.status === 'list') {
    body = `<div class="group ip-list">${ip.hits.map((h, i) => `
      <button class="row-btn focusable" data-ipk="hit${i}" data-ip="hit" data-i="${i}">
        <span class="lbl"><b>${esc(h.it.name)}</b><small>${esc([h.it.cat, h.it.year, h.acc.name].filter(Boolean).join(' · '))}</small></span><span class="chev">›</span>
      </button>`).join('')}</div>`;
  } else if (ip.status === 'loading' || ip.status === 'loadingShow') {
    body = `<div class="ep-cols single"><div class="ep-list">${'<div class="ep skel"><span class="ep-thumb"></span><span class="ep-txt"></span></div>'.repeat(3)}</div></div>`;
  }
  const logo = d && TM.pickLogo(d);
  $('#sheetInner').innerHTML = `
    <div class="ip-head">
      <div class="eyebrow">${film ? 'Film' : 'Serie'} · bei deinem Anbieter${wlTag}</div>
      ${logo ? `<img class="ep-logo" src="${TM.IMG}w500${logo}" alt="">` : `<h1>${esc(p.title)}</h1>`}
      <div class="meta ${ip.status === 'error' ? 'err' : ''}">${esc(sub)}</div>
      ${ov ? `<p class="ep-ov">${esc(ov)}</p>` : ''}
      <div class="btn-row">${btns.join('')}</div>
    </div>
    <div class="ip-body">${body}</div>`;
  if (ip.status === 'show' && !ip.d && p.id > 0 && !ip.dBusy && TM.key()) {   // Beschreibung & Logo nachladen
    ip.dBusy = true; const tok = ip.token;
    TM.details(p.type, p.id).then(det => { if (ip && ip.token === tok) { ip.d = det; renderIptv(); } }).catch(() => {});
  }
  const same = ip.shown === ip.status;
  ip.shown = ip.status;
  let target = same && focusedKey && $(`#sheet [data-ipk="${CSS.escape(focusedKey)}"]`);
  if (!target && ip.status === 'show' && (focusResume || !same)) target = $('#sheet [data-ipk="play"]');
  if (!target) target = $('#sheet .ip-list .focusable') || $('#sheet .ip-head .focusable');
  if (target) {
    target.focus({ preventScroll: true });
    if (target.closest('.ip-head')) $('#sheetInner').scrollTop = 0; else target.scrollIntoView({ block: 'nearest' });
  }
}
/** Titel aus der Anbieter-Ansicht auf die Watchlist setzen. */
async function ipWatchlist() {
  if (!ip || ip.wlBusy) return;
  const cur = ip, p = ip.p;
  if (p.id > 0 && WL.item(p.type, p.id)) {   // schon drauf → nach Rückfrage entfernen
    if (!cur.wlAsk) {
      cur.wlAsk = true; renderIptv();
      setTimeout(() => { if (cur.wlAsk && !cur.wlBusy) { cur.wlAsk = false; if (ip === cur) renderIptv(); } }, 4000);
      return;
    }
    cur.wlAsk = false; cur.wlBusy = true; renderIptv();
    try { await WL.remove(p.type, p.id); toast(`„${p.title}“ von der Watchlist entfernt`); renderRecs(); }
    catch (e) { toast('Watchlist: ' + e.message); }
    cur.wlBusy = false;
    if (ip === cur) renderIptv();
    return;
  }
  cur.wlBusy = true; renderIptv();
  try {
    if (!(p.id > 0)) {
      const tm = await guessTmdb(cur.sel ? cur.sel.it.name : p.title, p.type === 'movie');
      if (!tm) throw new Error('Titel bei TMDB nicht gefunden');
      p.id = Number(tm.split(':')[1]);
    }
    const det = cur.d || await TM.details(p.type, p.id);
    if (!cur.d) cur.d = det;
    await WL.addPlanned(p.type, det);
    toast(`„${p.title}“ steht jetzt auf deiner Watchlist`);
    renderRecs();
  } catch (e) { toast('Watchlist: ' + e.message); }
  cur.wlBusy = false;
  if (ip === cur) renderIptv();
}
function closeIptv(fromPop) {
  if (!ip) return;
  if (ip.cat) {   // aus dem Serien-Reiter geöffnet: gleich ganz schließen
    if (fromPop) { ip = null; $('#sheet').classList.remove('iptv'); }
    return closeSheet();
  }
  const p = ip.p;
  ip = null;
  $('#sheet').classList.remove('iptv');
  if (!fromPop) popOverlay('iptv');
  if (sheetOpen) { renderSheet(p, TM.details_[p.type + ':' + p.id]); const b = $('#shIptv'); if (b) b.focus({ preventScroll: true }); }
}
function iptvClick(el, epArg) {
  const a = epArg ? 'ep' : el.dataset.ip;
  if (a === 'back') return closeIptv();
  if (a === 'retry') {
    if (ip.cat) { ip.token = Date.now(); return selectHit(0); }
    const key = ip.p.type + ':' + ip.p.id; closeIptv(); return openIptv(key);
  }
  if (a === 'wl') return ipWatchlist();
  if (a === 'hits') { ip.sel = null; ip.info = null; ip.status = 'list'; return renderIptv(); }
  if (a === 'hit') return selectHit(Number(el.dataset.i));
  if (a === 'season') { ip.season = Number(el.dataset.s); renderIptv(); const c = $(`#sheet [data-ipk="s${ip.season}"]`); if (c) c.focus({ preventScroll: true }); return; }
  if (a === 'restart') {
    const ep = ip.info.seasons.find(s => s.num === Number(el.dataset.s)).eps[Number(el.dataset.i)];
    const v = VP.get(ep.id); if (v) VP.set(ep.id, 0, v.dur);
    return iptvClick(el, ep);
  }
  if (a === 'ep') {
    const all = ip.info.seasons.flatMap(s => s.eps);
    const ep = epArg || ip.info.seasons.find(s => s.num === Number(el.dataset.s)).eps[Number(el.dataset.i)];
    const p = ip.p, h = ip.sel;
    const img = p.backdrop ? `${TM.IMG}w780${p.backdrop}` : p.poster ? `${TM.IMG}w500${p.poster}` : h.it.cover || '';
    openVod(all, all.indexOf(ep), h.it.name, { acc: h.acc.key, sid: (ep.movie ? 'm' : '') + h.it.sid, img, src: h.acc.name, name: p.title, tmdb: p.id ? p.type + ':' + p.id : '' });
  }
}

/* ================= Serien- & Film-Katalog des Anbieters ================= */
const mkCat = (kind, view, pre, hide, word, one) => ({ kind, view, pre, hide, word, one, items: null, cats: [], cat: 'Alle', list: [], shown: 0, status: 'idle', msg: '', loading: null });
const CAT = { series: mkCat('series', 'series', 'ser', 'hideSeries', 'Serien', 'Serie'), vod: mkCat('vod', 'movies', 'mov', 'hideVod', 'Filme', 'Film') };
const SER = CAT.series;   // Bildschirmschoner nutzt die Serien-Cover
const CAT_BATCH = 60;
const cleanName = n => String(n || '').replace(/^\s*((\||\[)[^|\]]{1,12}(\||\])\s*|[A-Z]{2,4}\s*[-:|]\s+)+/, '').trim() || n;
function resetCatalogs() { for (const k in CAT) { if (!CAT[k].loading) { CAT[k].items = null; CAT[k].status = 'idle'; } } XS.idx = {}; }
/** Beide Kataloge im Hintergrund laden (für Empfehlungen, Suche und Reiter). */
function bgCatalogs() { if (XS.accounts().length) { loadCatalog('series', false); loadCatalog('vod', false); } }
function loadCatalog(kind, force) {
  const S = CAT[kind];
  if (S.loading) return S.loading;
  if (!force && S.items) { if (state.view === S.view) renderCatalog(kind, false); return Promise.resolve(); }
  const accs = XS.accounts();
  if (!accs.length) { S.status = 'none'; S.items = null; afterCatalog(kind); return Promise.resolve(); }
  S.status = 'loading';
  if (state.view === S.view) renderCatalog(kind, true);
  S.loading = (async () => {
    const errors = [], items = [], cats = [];
    await Promise.all(accs.map(async acc => {
      try {
        const c = await XS.catalog(acc, force, kind);
        for (const it of c.list) items.push({ acc, it });
        for (const n of c.cats) if (!cats.includes(n)) cats.push(n);
      } catch (e) { errors.push(`${acc.name}: ${e.message}`); }
    }));
    if (!items.length) {
      S.items = null; S.status = 'error';
      S.msg = errors.length ? errors.join(' · ') : `Dein Anbieter bietet keine ${S.word} an.`;
      delete XS.idx[kind];
    } else {
      S.items = items; S.status = 'ready';
      const used = new Set(items.map(x => x.it.cat).filter(Boolean));
      S.cats = cats.filter(n => used.has(n)).concat([...used].filter(n => !cats.includes(n)));
      if (S.cat !== 'Alle' && !used.has(S.cat)) S.cat = 'Alle';
      XS.buildIndex(kind, items);
      if (errors.length && state.view === S.view) toast(errors.join(' · '));
    }
  })().finally(() => { S.loading = null; afterCatalog(kind); });
  return S.loading;
}
function afterCatalog(kind) {
  const S = CAT[kind];
  if (state.view === S.view) renderCatalog(kind, true);
  if (state.view === 'search') renderSearch();
  renderRecs();
  setupHero();
}
function serTileHTML(kind, x, i) {
  const it = x.it;
  return `<div class="tile poster focusable" tabindex="0" data-ser="${kind}:${i}">
    <div class="art"><span class="ini">${esc(initials(cleanName(it.name)))}</span>
      ${it.cover ? `<img class="cov" src="${esc(it.cover)}" alt="" loading="lazy" onerror="this.remove()">` : ''}</div>
    <div class="caption">${esc(cleanName(it.name))}</div>
    <div class="sub">${esc([it.year, it.cat].filter(Boolean).join(' · '))}</div>
  </div>`;
}
function renderCatalog(kind, reset) {
  const S = CAT[kind], body = $(`#${S.pre}Body`), chips = $(`#${S.pre}Chips`), count = $(`#${S.pre}Count`);
  const box = (title, sub, btn) => `<div class="pad"><div class="group"><div class="row-item"><div class="meta"><b>${title}</b><small${btn === 'retry' ? ' class="err"' : ''}>${esc(sub)}</small></div>
    <div class="actions">${btn === 'retry' ? `<button class="btn small focusable" data-ser-act="retry" data-kind="${kind}">Erneut versuchen</button>` : `<button class="btn primary small focusable" data-view="settings">Zu den Einstellungen</button>`}</div></div></div></div>`;
  if (S.status !== 'ready') { chips.innerHTML = ''; count.textContent = ''; }
  if (S.status === 'none') { body.innerHTML = box('Keine Xtream-Quelle', `Der Katalog kommt von deinem IPTV-Anbieter. Unter „Einstellungen“ einen Xtream-Zugang hinzufügen.`); return; }
  if (S.status === 'loading' || S.status === 'idle') {
    body.innerHTML = `<p class="hint pad">Lade den Katalog deines Anbieters … (beim ersten Mal etwas länger)</p>
      <div class="grid posters">${Array.from({ length: 12 }, () => '<div class="tile poster skeleton"><div class="art"></div><div class="caption">&nbsp;</div></div>').join('')}</div>`;
    return;
  }
  if (S.status === 'error') { body.innerHTML = box(`${S.word}-Katalog nicht verfügbar`, S.msg, 'retry'); return; }
  if (!reset && body.querySelector('.grid')) return;
  const all = S.items, HS = new Set(state.settings[S.hide] || []);
  if (HS.has(S.cat)) S.cat = 'Alle';
  S.list = [];
  let visAll = 0;
  for (let i = 0; i < all.length; i++) {
    const it = all[i].it;
    if (HS.size && HS.has(it.cat)) continue;
    visAll++;
    if (S.cat !== 'Alle' && it.cat !== S.cat) continue;
    S.list.push(i);
  }
  count.textContent = S.list.length.toLocaleString('de-DE') + (S.list.length !== visAll ? ' von ' + visAll.toLocaleString('de-DE') : '')
    + (visAll !== all.length ? ` · ${(all.length - visAll).toLocaleString('de-DE')} ausgeblendet` : '');
  chips.innerHTML = ['Alle', ...S.cats.filter(n => !HS.has(n))].map(n => `<button class="chip focusable ${S.cat === n ? 'active' : ''}" data-scat="${esc(n)}" data-kind="${kind}">${esc(n)}</button>`).join('');
  S.shown = 0;
  body.innerHTML = S.list.length ? `<div class="grid posters" id="${S.pre}Grid"></div>` : `<p class="empty">Keine ${S.word} gefunden.</p>`;
  catalogMore(kind, true);
}
/** Nächsten Block anhängen, sobald das Ende in Sichtweite ist. */
function catalogMore(kind, force) {
  const S = CAT[kind], g = $(`#${S.pre}Grid`);
  if (!g || S.shown >= S.list.length) return;
  if (!force) {
    const last = g.lastElementChild;
    if (last && last.getBoundingClientRect().top > window.innerHeight * 2.5) return;
  }
  const n = Math.min(S.list.length, S.shown + CAT_BATCH);
  let html = '';
  for (let k = S.shown; k < n; k++) html += serTileHTML(kind, S.items[S.list[k]], S.list[k]);
  g.insertAdjacentHTML('beforeend', html);
  S.shown = n;
}
/** Katalog-Titel in der bestehenden Staffel-/Folgen- bzw. Filmansicht öffnen. */
function openCatalogItem(kind, i) {
  const x = CAT[kind].items && CAT[kind].items[i];
  if (!x || sheetOpen) return;
  lastFocus = document.activeElement; sheetOpen = true;
  pushOverlay('sheet');
  $('#sheet').classList.add('open');
  sheetAnim();
  $('#sheetBd').style.backgroundImage = x.it.cover ? `url("${x.it.cover.replace(/"/g, '%22')}")` : 'none';
  const p = { type: kind === 'vod' ? 'movie' : 'tv', id: x.it.tmdb || 0, title: cleanName(x.it.name), backdrop: null, poster: null };
  ip = { p, d: null, status: 'loadingShow', msg: '', hits: [{ acc: x.acc, it: x.it, s: 100 }], sel: null, info: null, season: null, token: Date.now(), cat: true };
  pushOverlay('iptv');
  $('#sheet').classList.add('iptv');
  selectHit(0);
}

/* ================= Kategorien ausblenden ================= */
let catKind = 'live';
/** Sprach-/Länder-Präfix eines Kategorienamens, z. B. „DE | Sport“, „|AR| News“, „[TR] Film“, „UK: Sky“. */
function catPrefix(n) {
  const m = String(n || '').match(/^\s*[\[|(]?\s*([A-Za-zÄÖÜ]{2,4})\s*[\]|):\-–]/);
  return m ? m[1].toUpperCase() : null;
}
function catNames(kind) {
  if (kind === 'live') return [...groups(state.channels).keys()];
  return CAT[kind].status === 'ready' ? CAT[kind].cats.slice() : null;
}
const hideKey = kind => kind === 'live' ? 'hideLive' : CAT[kind].hide;
function openCats() {
  show('cats');
  setCatKind(catKind, true);
}
function closeCats() {
  show('settings');
  const b = $('#catOpen');
  if (b) { b.focus({ preventScroll: true }); b.scrollIntoView({ block: 'center' }); }
}
function setCatKind(k, focusSeg) {
  catKind = k;
  $$('#catSeg [data-ckind]').forEach(b => b.classList.toggle('sel', b.dataset.ckind === k));
  if (k !== 'live' && CAT[k].status !== 'ready') loadCatalog(k, false).then(() => { if (state.view === 'cats' && catKind === k) renderCats(); });
  renderCats();
  if (focusSeg) { const b = $(`#catSeg [data-ckind="${k}"]`); if (b) b.focus({ preventScroll: true }); }
}
function renderCats() {
  const names = catNames(catKind), body = $('#catBody');
  const keep = focusSel(document.activeElement) || (document.activeElement && document.activeElement.dataset && ['hcat', 'hpre', 'hall'].map(k => document.activeElement.dataset[k] != null ? `[data-${k}="${CSS.escape(document.activeElement.dataset[k])}"]` : null).find(Boolean));
  if (!names) {
    const S = CAT[catKind];
    body.innerHTML = `<p class="group-foot" style="margin-top:1rem">${S.status === 'error' ? esc(S.msg) : S.status === 'none' ? 'Keine Xtream-Quelle eingerichtet.' : 'Lade Kategorien …'}</p>`;
    return;
  }
  if (!names.length) { body.innerHTML = `<p class="group-foot" style="margin-top:1rem">Keine Kategorien vorhanden.</p>`; return; }
  const H = new Set(state.settings[hideKey(catKind)] || []);
  const pre = new Map();
  for (const n of names) { const p = catPrefix(n); if (p) pre.set(p, (pre.get(p) || []).concat([n])); }
  const preList = [...pre].filter(([, l]) => l.length >= 2).sort((a, b) => b[1].length - a[1].length);
  const sw = (attr, val, on, title, sub) => `<button class="switch focusable ${on ? 'on' : ''}" type="button" data-${attr}="${esc(val)}"><span class="lbl"><b>${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span><span class="knob"></span></button>`;
  let html = `<div class="cat-actions"><button class="mini focusable" data-hall="show">Alle einblenden</button><button class="mini focusable" data-hall="hide">Alle ausblenden</button>
    <span class="hint">${names.length - [...H].filter(n => names.includes(n)).length} von ${names.length} sichtbar</span></div>`;
  if (preList.length >= 2) {
    html += `<div class="group-title">Nach Sprache / Land</div><div class="group">${preList.map(([p, l]) => {
      const vis = l.filter(n => !H.has(n)).length;
      return sw('hpre', p, vis > 0, p, `${l.length} Kategorien${vis && vis < l.length ? ` · ${vis} sichtbar` : vis ? '' : ' · ausgeblendet'}`);
    }).join('')}</div>`;
  }
  html += `<div class="group-title">Einzelne Kategorien</div><div class="group">${names.map(n => sw('hcat', n, !H.has(n), n, '')).join('')}</div>`;
  body.innerHTML = html;
  if (keep) { const el = visibleOf(keep); if (el) el.focus({ preventScroll: true }); }
}
function setHidden(kind, list) {
  state.settings[hideKey(kind)] = [...new Set(list)];
  persist();
  if (kind === 'live') keepFocus(() => { renderLive(); renderSearch(); });
  else if (CAT[kind].status === 'ready') renderCatalog(kind, true);
  renderSettings();
  renderCats();
}
function catClick(el) {
  const names = catNames(catKind) || [], H = new Set(state.settings[hideKey(catKind)] || []);
  if (el.dataset.hall) return setHidden(catKind, el.dataset.hall === 'hide' ? names : []);
  if (el.dataset.hcat != null) { const n = el.dataset.hcat; H.has(n) ? H.delete(n) : H.add(n); return setHidden(catKind, [...H]); }
  if (el.dataset.hpre) {
    const l = names.filter(n => catPrefix(n) === el.dataset.hpre);
    const anyVis = l.some(n => !H.has(n));
    l.forEach(n => anyVis ? H.add(n) : H.delete(n));
    setHidden(catKind, [...H]);
    toast(`${el.dataset.hpre}: ${l.length} Kategorien ${anyVis ? 'ausgeblendet' : 'eingeblendet'}`);
  }
}
document.addEventListener('click', e => {
  const t = e.target;
  if (t.closest('#catOpen')) return openCats();
  const k = t.closest('[data-ckind]');
  if (k) return setCatKind(k.dataset.ckind, true);
  const c = t.closest('#catBody [data-hcat], #catBody [data-hpre], #catBody [data-hall]');
  if (c) catClick(c);
});

/* ================= Sport ================= */
const SPV = { cat: 'Alle' };
const SP_CHIPS = [['Alle', null], ['Fußball', e => SP.COMP[e.comp].sport === 'fb'], ['Motorsport', e => SP.COMP[e.comp].sport === 'ms'],
  ...Object.keys(SP.COMP).map(k => [SP.COMP[k].name, e => e.comp === k])];
const dayKey = t => { const d = new Date(t); return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); };
const hm = t => new Date(t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
function dayLabel(t) {
  const today = new Date(), d = new Date(t), diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 864e5);
  if (diff === 0) return 'Heute';
  if (diff === 1) return 'Morgen';
  return d.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
}
function crest(url, name) {
  return `<span class="ev-crest"><span>${esc(initials(name || '?'))}</span>${url ? `<img src="${esc(url)}" alt="" loading="lazy" onerror="this.remove()">` : ''}</span>`;
}
function evTileHTML(e) {
  const c = SP.COMP[e.comp], live = SP.isLive(e), rem = SP.isRem(e.id);
  const top = `<span class="ev-comp">${esc(c.short)}${e.round ? ' · ' + esc(e.round.replace(/\.?\s*Spieltag/, '. Sp.')) : ''}</span>
    ${live ? '<span class="ev-live">LIVE</span>' : ''}${rem ? '<span class="ev-bell" title="Vorgemerkt">🔔</span>' : ''}`;
  const mid = e.home
    ? `<div class="ev-teams">${crest(e.homeIcon, e.home)}<span class="ev-mid">${live && e.score ? esc(e.score) : esc(hm(e.start))}</span>${crest(e.awayIcon, e.away)}</div>`
    : `<div class="ev-ms"><span class="ev-series">${esc(c.short)}</span><b>${esc(e.title)}</b><small>${esc(e.gp)}</small></div><span class="ev-time">${e.weekend ? 'Wochenende' : esc(hm(e.start))}</span>`;
  return `<div class="tile ev focusable" tabindex="0" data-ev="${esc(e.id)}">
    <div class="art ev-art" style="--c1:${c.c[0]};--c2:${c.c[1]}">${top}${mid}</div>
    <div class="caption">${esc(SP.title(e))}</div>
    <div class="sub">${esc(e.home ? c.name : e.place || c.name)}${live ? ' · läuft' : ''}</div>
  </div>`;
}
function renderSport() {
  keepFocus(() => {
    const now = Date.now();
    const chips = SP_CHIPS.filter(([n, f]) => !f || SP.events.some(f));
    if (!chips.some(([n]) => n === SPV.cat)) SPV.cat = 'Alle';
    const filt = (SP_CHIPS.find(([n]) => n === SPV.cat) || [])[1];
    const list = SP.events.filter(e => e.end > now && (!filt || filt(e)));
    $('#spChips').innerHTML = chips.map(([n]) => `<button class="chip focusable ${SPV.cat === n ? 'active' : ''}" data-spc="${esc(n)}">${esc(n)}</button>`).join('');
    $('#spInfo').textContent = SP.loading && !SP.events.length ? '' : list.length ? list.length + ' Events' : '';
    let html = '';
    const remd = Object.values(SP.rems()).map(x => x.ev).filter(e => e.end > now && (!filt || filt(e))).sort((a, b) => a.start - b.start);
    if (remd.length) html += railHTML('🔔 Vorgemerkt', remd.map(evTileHTML).join(''), remd.length);
    const live = list.filter(e => SP.isLive(e, now));
    if (live.length) html += railHTML('Jetzt live', live.map(evTileHTML).join(''), live.length);
    const days = new Map();
    for (const e of list) { if (SP.isLive(e, now) || e.weekend && e.start < now) continue; const k = dayKey(e.start); if (!days.has(k)) days.set(k, []); days.get(k).push(e); }
    let n = 0;
    for (const [, evs] of days) { if (n++ >= 10) break; html += railHTML(dayLabel(evs[0].start), evs.slice(0, 40).map(evTileHTML).join(''), evs.length); }
    if (!html) html = SP.loading ? railHTML('Lade Spielpläne …', skeletons(4))
      : `<p class="empty">${SP.errors.length >= 8 ? 'Sportdaten gerade nicht erreichbar. Internetverbindung prüfen.' : 'Keine Events in den nächsten 14 Tagen.'}</p>`;
    $('#spRows').innerHTML = html;
    $('#spFoot').innerHTML = (SP.errors.length ? `Nicht erreichbar: ${esc(SP.errors.join(', '))} · <button class="mini focusable" id="spRetry">Erneut laden</button><br>` : '')
      + 'Daten: OpenLigaDB, Jolpica-F1, MotoGP, TheSportsDB · Sender sind Vorschläge aus deiner Senderliste. ≡ auf einem Event = vormerken.';
  });
}
let spSheet = null;
function openSportSheet(id) {
  const e = SP.byId(id);
  if (!e) return;
  if (!sheetOpen) { lastFocus = document.activeElement; sheetOpen = true; pushOverlay('sheet'); $('#sheet').classList.add('open'); sheetAnim(); }
  spSheet = e;
  $('#sheet').classList.add('sport');
  const c = SP.COMP[e.comp];
  $('#sheetBd').style.backgroundImage = `radial-gradient(ellipse at 75% 35%, ${c.c[0]}, ${c.c[1]} 60%, #000)`;
  SP.channelsFor(e, 12).forEach(x => EPG.want(x.ch, true));
  renderSportSheet(true);
}
function renderSportSheet(first) {
  const e = spSheet;
  if (!e) return;
  const c = SP.COMP[e.comp], live = SP.isLive(e), rem = SP.isRem(e.id), now = Date.now();
  const mins = Math.round((e.start - now) / 60000);
  const rel = live ? 'Läuft gerade' : mins < 60 ? `in ${mins} Min.` : mins < 1440 ? `in ${Math.round(mins / 60)} Std.` : '';
  const when = e.weekend ? dayLabel(e.start) + ' (Rennwochenende)' : `${dayLabel(e.start)} · ${hm(e.start)} Uhr`;
  const chans = SP.channelsFor(e, 8);
  const keep = document.activeElement && document.activeElement.id;
  const keepCard = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.card;
  const head = e.home
    ? `<div class="sp-match">${crest(e.homeIcon, e.home)}<div class="sp-vs">${live && e.score ? esc(e.score) : 'vs'}</div>${crest(e.awayIcon, e.away)}</div><h1>${esc(e.homeFull || e.home)} – ${esc(e.awayFull || e.away)}</h1>`
    : `<div class="sp-series">${esc(c.short)}</div><h1>${esc(e.title)} · ${esc(e.gp)}</h1>`;
  $('#sheetInner').innerHTML = `
    <div class="ip-head">
      <div class="eyebrow">${esc(c.name)}${e.round ? ' · ' + esc(e.round) : ''}${live ? ' · <span class="ev-live">LIVE</span>' : ''}</div>
      ${head}
      <div class="meta">${esc(when)}${rel ? ' · ' + esc(rel) : ''}${e.place && e.home ? ' · ' + esc(e.place) : ''}</div>
      <div class="btn-row">
        <button class="btn primary focusable" id="spRem" data-id="${esc(e.id)}">${rem ? '✓ Vorgemerkt' : '🔔 Vormerken'}</button>
        <button class="btn focusable" id="spSearch" data-livesearch="${esc(e.home || c.name)}">Im Live-TV suchen</button>
        <button class="btn focusable" id="spClose">Schließen</button>
      </div>
    </div>
    <div class="ip-body">
      <div class="group-title">Passende Sender</div>
      ${chans.length ? `<div class="group ip-list">${chans.map(x => `
        <button class="row-btn sp-ch focusable" data-card="${esc(x.ch.id)}">
          <span class="cl-logo"><span>${esc(initials(cleanName(x.ch.name)))}</span>${x.ch.logo ? `<img src="${esc(x.ch.logo)}" alt="" onerror="this.remove()">` : ''}</span>
          <span class="lbl"><b>${esc(x.ch.name)}</b><small>${esc(x.prog || x.ch.group)}</small></span>
          ${x.epg ? '<span class="ip-resume">Laut EPG ▶</span>' : '<span class="chev">▶</span>'}
        </button>`).join('')}</div>`
      : `<p class="group-foot">Keine passenden Sender gefunden – über „Im Live-TV suchen“ selbst suchen.</p>`}
      <p class="group-foot">Vorschläge nach Sendernamen und Programm (EPG). Welcher Sender überträgt, kann je nach Spiel abweichen.</p>
    </div>`;
  const t = (keep && $('#' + keep)) || (keepCard && $(`#sheet [data-card="${CSS.escape(keepCard)}"]`)) || (first && $('#spRem'));
  if (t) t.focus({ preventScroll: true });
}
function toggleRemind(id) {
  const e = SP.byId(id);
  if (!e) return;
  const on = SP.toggleRem(e);
  toast(on ? `🔔 Vorgemerkt – Hinweis 5 Min. vor Beginn` : 'Nicht mehr vorgemerkt');
  if (state.view === 'sport') renderSport();
  if (sheetOpen && spSheet) renderSportSheet();
}
/* ---------- Erinnerung ---------- */
let remEv = null, remT = null;
function checkReminders() {
  const due = SP.due();
  if (due.length && !remEv) showReminder(due[0]);
}
function showReminder(e) {
  remEv = e;
  const c = SP.COMP[e.comp], mins = Math.max(0, Math.round((e.start - Date.now()) / 60000));
  const best = SP.channelsFor(e, 1)[0];
  $('#remind').innerHTML = `<div class="rm-ico" style="--c1:${c.c[0]};--c2:${c.c[1]}">${esc(c.short)}</div>
    <div class="rm-txt"><b>${mins ? `In ${mins} Min.` : 'Jetzt'}: ${esc(SP.title(e))}</b>
    <small>${esc(c.name)}${best ? ' · ' + esc(cleanName(best.ch.name)) : ''}</small></div>
    <div class="rm-keys"><span>OK</span> ${best ? 'Umschalten' : 'Anzeigen'} · <span>Zurück</span> Schließen</div>`;
  $('#remind').classList.remove('off');
  if (saverOpen) closeSaver();
  pushOverlay('remind');
  clearTimeout(remT);
  remT = setTimeout(() => hideReminder(), 25000);
}
function hideReminder(fromPop) {
  if (!remEv) return;
  remEv = null;
  clearTimeout(remT);
  $('#remind').classList.add('off');
  if (fromPop) return;
  if (overlays[overlays.length - 1] === 'remind') popOverlay('remind');
  else { const i = overlays.lastIndexOf('remind'); if (i >= 0) overlays.splice(i, 1); }
}
/** Erst ausführen, wenn alle angestoßenen history.back() verarbeitet sind (sonst überholen sich Zurück und neuer Eintrag). */
function afterPops(fn, n = 0) {
  if (skipPops <= 0 || n > 50) return fn();
  setTimeout(() => afterPops(fn, n + 1), 20);
}
function actReminder() {
  const e = remEv;
  hideReminder();
  if (!e) return;
  const best = SP.channelsFor(e, 1)[0];
  if (best) {
    if (sheetOpen && !playerOpen) closeSheet();
    afterPops(() => openPlayer(best.ch.id));
    return;
  }
  if (playerOpen) closePlayer();
  afterPops(() => { show('sport'); openSportSheet(e.id); });
}

/* ================= Bildschirmschoner ================= */
let saverOpen = false, saverT = null, saverItems = [], saverIdx = 0, saverLayer = 0, lastInput = Date.now();
function saverPool() {
  const seen = new Set(), out = [];
  for (const id in TM.cache) for (const p of TM.cache[id].items || []) {
    const k = p.type + ':' + p.id;
    if (p.poster && p.backdrop && !seen.has(k)) { seen.add(k); out.push({ title: p.title, poster: TM.IMG + 'w780' + p.poster, bg: TM.IMG + 'w1280' + p.backdrop, info: TM.info(p), ov: p.overview, key: k, type: p.type, id: p.id }); }
  }
  if (!out.length && SER.items) for (const x of SER.items) { if (x.it.cover && out.length < 60) out.push({ title: cleanName(x.it.name), poster: x.it.cover, bg: x.it.cover, info: [x.it.year, x.it.cat].filter(Boolean).join(' · '), ov: '' }); }
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}
function openSaver() {
  if (saverOpen) return;
  saverItems = saverPool(); saverIdx = 0;
  saverFocus = document.activeElement;
  saverOpen = true;
  pushOverlay('saver');
  $('#saver').classList.remove('hidden');
  if (document.activeElement) document.activeElement.blur();
  saverTick(); saverShow();
  clearInterval(saverT);
  saverT = setInterval(() => { saverTick(); if (saverItems.length > 1 && Date.now() - saverShownAt > 12000) { saverIdx = (saverIdx + 1) % saverItems.length; saverShow(); } }, 1000);
}
let saverShownAt = 0, saverFocus = null;
function saverTick() {
  const d = new Date();
  $('#svClock').innerHTML = `<b>${d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</b><span>${d.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' })}</span>`;
}
function saverShow() {
  saverShownAt = Date.now();
  const it = saverItems[saverIdx], st = $('#svStage');
  if (!it) { st.innerHTML = '<div class="sv-empty">StreamTV</div>'; return; }
  const d = it.key && TM.details_[it.key], logo = d && TM.pickLogo(d);
  if (it.key && !d) TM.details(it.type, it.id).catch(() => {});
  const img = new Image();
  img.onload = () => {
    if (!saverOpen || saverItems[saverIdx] !== it) return;
    saverLayer = 1 - saverLayer;
    const on = saverLayer ? $('#svBg2') : $('#svBg'), off = saverLayer ? $('#svBg') : $('#svBg2');
    on.style.backgroundImage = `url("${it.bg.replace(/"/g, '%22')}")`;
    on.classList.remove('show'); void on.offsetWidth; on.classList.add('show'); off.classList.remove('show');
    st.classList.remove('in'); void st.offsetWidth;
    st.innerHTML = `<div class="sv-poster"><img src="${esc(it.poster)}" alt=""></div>
      <div class="sv-info">${logo ? `<img class="sv-logo" src="${TM.IMG}w500${logo}" alt="">` : `<h1>${esc(it.title)}</h1>`}
        <div class="meta">${esc(it.info || '')}</div>${it.ov ? `<p>${esc(it.ov)}</p>` : ''}</div>`;
    st.classList.add('in');
  };
  img.onerror = () => { if (saverItems.length > 1) { saverItems.splice(saverIdx, 1); saverIdx %= saverItems.length; saverShow(); } };
  img.src = it.bg;
}
function closeSaver(fromPop) {
  if (!saverOpen) return;
  saverOpen = false;
  clearInterval(saverT);
  $('#saver').classList.add('hidden');
  $('#svStage').innerHTML = '';
  lastInput = Date.now();
  if (!fromPop) popOverlay('saver');
  // Fokus zurück, wo er war
  const t = saverFocus && saverFocus.isConnected ? saverFocus : null;
  if (t && !playerOpen) t.focus({ preventScroll: true });
}
// jede Eingabe: Bildschirmschoner schließen (Taste wird verschluckt) bzw. Zeit zurücksetzen
document.addEventListener('keydown', e => {
  lastInput = Date.now();
  if (saverOpen) { e.preventDefault(); e.stopImmediatePropagation(); closeSaver(); return; }
  if (remEv) {
    if (['Enter', ' '].includes(e.key)) { e.preventDefault(); e.stopImmediatePropagation(); actReminder(); }
    else if (['Escape', 'Backspace', 'GoBack', 'BrowserBack'].includes(e.key)) { e.preventDefault(); e.stopImmediatePropagation(); hideReminder(); }
  }
}, true);
['click', 'mousemove', 'wheel', 'touchstart'].forEach(ev => document.addEventListener(ev, () => { lastInput = Date.now(); if (saverOpen && ev !== 'mousemove') closeSaver(); }, true));
$('#saver').addEventListener('click', () => closeSaver());
$('#remind').addEventListener('click', () => actReminder());
setInterval(() => {
  const m = Number(state.settings.saver) || 0;
  if (!m || saverOpen || remEv || document.hidden) return;
  if (playerOpen && !video.paused) { lastInput = Date.now(); return; }
  if (Date.now() - lastInput > m * 60000) openSaver();
}, 5000);

/** Vom Launcher „abspielen“: angefangene Folge, sonst gewünschte (s/e), sonst erste. */
function autoPlayIptv() {
  const a = ip.autoplay;
  ip.autoplay = null;
  const all = ip.info.seasons.flatMap(s => s.eps);
  let ep = resumeEp(ip.info);
  if (!ep && a.s) ep = all.find(e => e.season === a.s && e.num === a.e) || null;
  if (!ep) ep = all[0];
  if (!ep) return;
  const p = ip.p, h = ip.sel;
  const img = p.backdrop ? `${TM.IMG}w780${p.backdrop}` : p.poster ? `${TM.IMG}w500${p.poster}` : h.it.cover || '';
  openVod(all, all.indexOf(ep), h.it.name, { acc: h.acc.key, sid: (ep.movie ? 'm' : '') + h.it.sid, img, src: h.acc.name, name: p.title, tmdb: p.id ? p.type + ':' + p.id : '' });
}

/* ================= Deep Links (TV-Launcher) ================= */
// streamtv://resume/<Folge>          → Folge an der gespeicherten Stelle fortsetzen
// streamtv://title/<tv|movie>/<id>   → Detailansicht; ?play=1[&s=2&e=5] → beim Anbieter suchen und abspielen
// streamtv://sport · streamtv://series · streamtv://home
async function openDeep(uri) {
  let u;
  try { u = new URL(String(uri).replace(/^streamtv:\/\//i, 'http://x/')); } catch (e) { return; }
  const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent), q = u.searchParams;
  // offene Ebenen schließen
  if (saverOpen) closeSaver();
  if (remEv) hideReminder();
  if (playerOpen) closePlayer();
  if (sheetOpen) closeSheet();
  await new Promise(r => afterPops(r));
  const route = parts[0] || 'home';
  // streamtv://search?q=…&ai=1  (Sprach-/Claude-Suche aus dem TV-Launcher)
  if (route === 'search') {
    const text = (q.get('q') || '').trim();
    if (q.get('voice') === '1' && !text) { show('search'); return startVoice(); }
    if (q.get('ai') === '1' && text) return onVoice(text);
    show('search'); const el = $('#q'); el.value = text.slice(0, 80); el.dispatchEvent(new Event('input'));
    return;
  }
  if (route === 'resume' && parts[1]) {
    show('home');
    if (VP.entry(parts[1])) return playResume(parts[1]);
    toast('Folge nicht mehr in „Weiterschauen“');
    return;
  }
  if (route === 'title' && parts[2]) {
    const type = parts[1] === 'movie' ? 'movie' : 'tv', id = Number(parts[2]), key = type + ':' + id;
    show(type === 'movie' ? 'movies' : 'series');
    if (!TM.key()) { toast('Für Serien-Links bitte zuerst das Watchlist-Konto oder einen TMDB-Schlüssel einrichten'); return; }
    let p = TM.find(key);
    if (!p) {
      try {
        const d = await TM.details(type, id);
        p = TM.pick(d, type);
        TM.extra = [p].concat((TM.extra || []).filter(x => x.type + ':' + x.id !== key)).slice(0, 30);
      } catch (e) { toast('Titel konnte nicht geladen werden'); return; }
    }
    await openSheet(key);
    if (q.get('play') === '1') openIptv(key, { s: Number(q.get('s')) || 0, e: Number(q.get('e')) || 0 });
    return;
  }
  if (['sport', 'series', 'movies', 'live', 'discover', 'search', 'favorites', 'settings'].includes(route)) { show(route); return; }
  show('home');
}
window.openDeep = openDeep;

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
  if (top === 'saver') closeSaver(true);
  else if (top === 'remind') hideReminder(true);
  else if (top === 'pmenu') closeMenu(true);
  else if (top === 'clist') closeClist(true);
  else if (top === 'player') closePlayer(true);
  else if (top === 'iptv') closeIptv(true);
  else if (top === 'sheet') closeSheet(true);
});
// Wird von der App aufgerufen, wenn kein Overlay offen ist: erst zur Startseite, dann beenden
function handleBack() {
  if (WLM.on) { endMove(); return true; }
  if (state.view === 'cats') { closeCats(); return true; }
  if (state.view === 'manage') { closeManage(); return true; }
  if (state.view !== 'home') { show('home'); return true; }
  return false;
}
function openManage() { show('manage'); const f = $('#manageList .focusable') || $('#view-manage .focusable'); if (f) f.focus({ preventScroll: true }); }
function closeManage() {
  show('settings');
  const b = $('#manageOpen');
  if (b) { b.focus({ preventScroll: true }); b.scrollIntoView({ block: 'center' }); }
}

/* ================= Ansichten ================= */
const TAB_OF = { manage: 'settings', cats: 'settings' };   // Unterseiten der Einstellungen
function show(view) {
  if (view === 'discover') view = 'series';                  // alte Links (Launcher)
  if (view === 'favorites') { view = 'live'; if (favList().length) { state.cat = FAV_CAT; renderLive(); } }
  state.view = view;
  if (view === 'series') loadCatalog('series', false);
  if (view === 'movies') loadCatalog('vod', false);
  if (view === 'search') bgCatalogs();
  if (view === 'sport') { renderSport(); SP.refresh(false); }
  const tabView = TAB_OF[view] || view;
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view));
  $$('.tabbar [data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === tabView));
  window.scrollTo(0, 0); navY = 0; navYAt = 0;
  EPG.scan();
  updateHeader(); moveTabInd();
  const tab = $(`.tabbar [data-view="${tabView}"]`);
  if (tab && !TAB_OF[view]) tab.focus({ preventScroll: true });
}

/* ================= Player ================= */
const video = $('#video');
let hls = null, tsPlayer = null, engine = null, failCb = null, playToken = 0, startTimer = null;

/* ---------- Nativer Player (Media3, nur Fire-TV-App) ----------
   Serien/Filme laufen nativ (Dolby-Ton, MKV, alle Spuren). Das <video>-Element bleibt die
   Schnittstelle für die ganze Oberfläche: currentTime, duration, paused … werden umgeleitet. */
const NV = { on: false, t: 0, d: NaN, paused: true, seeking: false, seekAt: 0, tracks: [] };
window.NV = NV;   // die App ruft window.NV.ev(...) / NV.cue(...) auf
const nvOk = () => { try { return !!(bridge && typeof bridge.nvPlay === 'function') && state.settings.nativeVod !== false; } catch (e) { return false; } };
// Live-TV ebenfalls nativ (ExoPlayer mit großem Puffer) – viel stabiler als hls.js/mpegts.js in der WebView
const nvLiveOk = () => { try { return !!(bridge && typeof bridge.nvPlayLive === 'function') && state.settings.nativeLive !== false; } catch (e) { return false; } };
const liveBuf = () => [1, 2, 3].includes(Number(state.settings.liveBuf)) ? Number(state.settings.liveBuf) : 2;
(() => {
  const P = HTMLMediaElement.prototype, d = n => Object.getOwnPropertyDescriptor(P, n);
  const ct = d('currentTime'), du = d('duration'), pa = d('paused'), se = d('seeking');
  Object.defineProperty(video, 'currentTime', { configurable: true,
    get() { return NV.on ? NV.t : ct.get.call(video); },
    set(v) {
      if (!NV.on) return ct.set.call(video, v);
      NV.t = Math.max(0, Number(v) || 0); NV.seeking = true; NV.seekAt = Date.now();
      bridge.nvSeek(NV.t * 1000);
      video.dispatchEvent(new Event('seeking'));
    } });
  Object.defineProperty(video, 'duration', { configurable: true, get() { return NV.on ? NV.d : du.get.call(video); } });
  Object.defineProperty(video, 'paused', { configurable: true, get() { return NV.on ? NV.paused : pa.get.call(video); } });
  Object.defineProperty(video, 'seeking', { configurable: true, get() { return NV.on ? NV.seeking : se.get.call(video); } });
  video.play = function () { if (!NV.on) return P.play.call(video); NV.paused = false; bridge.nvResume(); return Promise.resolve(); };
  video.pause = function () { if (!NV.on) return P.pause.call(video); NV.paused = true; bridge.nvPause(); };
})();
NV.ev = (type, pos, dur, paused, msg) => {
  if (!NV.on) return;
  if (type !== 'timeupdate') dbg('nv', type, Math.round(pos / 1000), paused ? 'paused' : '', msg || '');
  NV.t = pos / 1000; NV.d = dur > 0 ? dur / 1000 : NaN; NV.paused = !!paused;
  if (NV.seeking && (type === 'playing' || (type === 'pause' && paused) || Date.now() - NV.seekAt > 30000)) { NV.seeking = false; video.dispatchEvent(new Event('seeked')); }
  if (type === 'error') { console.warn('Nativer Player:', msg); if (failCb) failCb(); return; }
  if (type === 'tracks') {
    try { NV.tracks = JSON.parse(bridge.nvTracks() || '[]'); } catch (e) { NV.tracks = []; }
    const au = NV.tracks.filter(t => t.type === 'audio');
    if (au.length && !au.some(t => t.ok)) toast('Tonspur wird von diesem Gerät nicht unterstützt');
    applyTrackPref();
    if (menuOpen) renderMenu();
    return;
  }
  video.dispatchEvent(new Event(type));
};
NV.cue = text => {
  const el = $('#nvCue');
  el.innerHTML = text ? text.split('\n').map(l => `<span>${esc(l)}</span>`).join('<br>') : '';
};
function nvStop() {
  if (!NV.on) return;
  NV.on = false; NV.tracks = [];
  try { bridge.nvStop(); } catch (e) {}
  NV.cue('');
  document.documentElement.classList.remove('nv');
}

function enginesFor(url) {
  const u = url.split('?')[0].toLowerCase();
  if (u.endsWith('.m3u8')) return ['hls', 'ts'];
  if (u.endsWith('.ts')) return ['ts', 'hls'];
  if (/\.(mp4|mkv|webm|mov)$/.test(u)) return ['native'];
  return ['hls', 'ts', 'native'];
}
function stopStream() {
  engine = null; failCb = null;
  nvStop();
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
  if (name === 'exo') {
    Object.assign(NV, { on: true, t: 0, d: NaN, paused: false, seeking: false, tracks: [] });
    document.documentElement.classList.add('nv');
    try {
      if (vod) bridge.nvPlay(url, 0, 'IPTVSmartersPlayer');
      else bridge.nvPlayLive(url, 'IPTVSmartersPlayer', liveBuf());
    } catch (e) { nvStop(); return fail(); }
  } else if (name === 'hls') {
    if (!window.Hls || !Hls.isSupported()) return fail();
    // Mehr Vorrat und Abstand zur Live-Kante, mehr Wiederholungen bei Aussetzern
    hls = new Hls({
      enableWorker: true, lowLatencyMode: false,
      maxBufferLength: 30, maxMaxBufferLength: 60, backBufferLength: 30,
      liveSyncDurationCount: 3 + liveBuf(), liveMaxLatencyDurationCount: 12,
      manifestLoadingMaxRetry: 4, levelLoadingMaxRetry: 4, fragLoadingMaxRetry: 6
    });
    let mediaFix = 0;
    hls.on(Hls.Events.MANIFEST_PARSED, () => safePlay(video));
    hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => applyTrackPref());
    hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => applyTrackPref());
    hls.on(Hls.Events.ERROR, (_, d) => {
      if (!d.fatal) return;
      if (d.type === Hls.ErrorTypes.MEDIA_ERROR && mediaFix++ < 2) { try { hls.recoverMediaError(); return; } catch (e) {} }
      fail();
    });
    hls.loadSource(url);
    hls.attachMedia(video);
  } else if (name === 'ts') {
    if (!window.mpegts || !mpegts.getFeatureList().mseLivePlayback) return fail();
    tsPlayer = mpegts.createPlayer({ type: 'mpegts', isLive: !vod, url }, { enableWorker: false, lazyLoad: false, liveBufferLatencyChasing: false, enableStashBuffer: true, stashInitialSize: 1024 * 1024 });
    tsPlayer.on(mpegts.Events.ERROR, () => fail());
    tsPlayer.attachMediaElement(video);
    tsPlayer.load();
    safePlay(tsPlayer);
  } else {
    video.src = url;
    safePlay(video);
  }
}
/* ---------- Auto-Reconnect ---------- */
// Bricht ein laufender Stream ab (Fehler, Hänger, Netz weg), wird still neu verbunden –
// mit wachsenden Pausen; Serien/Filme setzen an derselben Stelle fort.
const RC = { url: '', played: false, loadPlayed: false, tries: 0, rounds: 0, eng: null, timer: null, waiting: false, dead: false,
  resumeAt: 0, lastT: -1, lastMove: 0, MAX: 6, WAIT: [1, 2, 4, 8, 15, 30], STALL: 15000 };
function loadStream(url, keep) {
  if (menuOpen) closeMenu();
  clearTimeout(RC.timer);
  RC.waiting = false; RC.dead = false;
  if (!keep) Object.assign(RC, { url, played: false, tries: 0, rounds: 0, eng: null, resumeAt: 0 });
  RC.loadPlayed = false; RC.lastT = -1; RC.lastMove = Date.now();
  stopStream();
  const token = ++playToken;
  let list = enginesFor(url);
  if (vod && nvOk()) list = ['exo', ...list];   // Serien & Filme: zuerst nativ (Dolby-Ton)
  else if (!vod && nvLiveOk()) list = ['exo', ...list];   // Live-TV: zuerst nativ (großer Puffer)
  if (keep && RC.eng) list = [RC.eng, ...list.filter(x => x !== RC.eng)];   // zuerst die Engine, die schon lief
  const next = () => {
    if (token !== playToken) return;
    const e = list.shift();
    stopStream();
    if (!e) return streamFailed(url);
    let done = false;
    startEngine(e, url, () => {
      if (done || token !== playToken) return;
      done = true;
      if (RC.loadPlayed) return reconnect('Verbindung unterbrochen');   // lief schon → neu verbinden statt Engine wechseln
      next();
    });
  };
  if (!keep) setStatus('Lädt …');
  next();
}
/** Keine Engine konnte starten. */
function streamFailed(url) {
  if (RC.played) return reconnect('Verbindung unterbrochen');
  if (RC.rounds < 1) {   // z. B. Anbieter meldet kurz „max. Verbindungen“ beim schnellen Umschalten
    RC.rounds++;
    setStatus('Erneuter Versuch …');
    const tok = playToken;
    RC.timer = setTimeout(() => { if (playerOpen && tok === playToken && RC.url === url) loadStream(url, true); }, 2000);
    return;
  }
  stopStream();
  RC.dead = true;
  setStatus('Stream nicht abspielbar – OK für neuen Versuch');
}
function reconnect(reason) {
  if (!playerOpen || !RC.url || RC.waiting) return;
  dbg('reconnect', reason, 't', Math.round(video.currentTime || 0));
  const n = ++RC.tries;
  if (vod && video.currentTime > 1) RC.resumeAt = video.currentTime;
  playToken++;   // laufende Versuche abbrechen
  stopStream();
  if (n > RC.MAX) { RC.dead = true; setStatus('Verbindung verloren – OK für neuen Versuch'); return; }
  const wait = RC.WAIT[Math.min(n, RC.WAIT.length) - 1] * 1000, url = RC.url, tok = playToken;
  RC.waiting = true;
  setStatus(`${reason} – neuer Versuch in ${wait / 1000} s (${n}/${RC.MAX})`);
  RC.timer = setTimeout(() => {
    if (!playerOpen || tok !== playToken || RC.url !== url) return;
    setStatus('Verbinde neu …');
    loadStream(url, true);
  }, wait);
}
function retryNow() {
  if (!RC.url) return;
  clearTimeout(RC.timer);
  RC.tries = 0; RC.rounds = 0;
  setStatus('Verbinde neu …');
  loadStream(RC.url, true);
}
// Hänger erkennen: Wiedergabe läuft, aber die Zeit bewegt sich nicht mehr
setInterval(() => {
  if (!playerOpen || !RC.loadPlayed || RC.waiting || RC.dead || video.paused || video.seeking && vod) return;
  const t = video.currentTime;
  if (t !== RC.lastT) { RC.lastT = t; RC.lastMove = Date.now(); return; }
  if (Date.now() - RC.lastMove > (vod ? 40000 : RC.STALL)) reconnect('Stream hängt');
}, 1000);
window.addEventListener('online', () => { if (playerOpen && (RC.waiting || RC.dead)) retryNow(); });
window.addEventListener('offline', () => { if (playerOpen && RC.loadPlayed && !vod) setStatus('Keine Internetverbindung …'); });
function setStatus(t) { $('#status').textContent = t; }
const osdEl = () => vod ? $('#vosd') : $('#osd');
const osdShown = () => !osdEl().classList.contains('hide');
function showOsd() {
  const o = osdEl();
  if (clistOpen) { o.classList.add('hide'); return; }
  o.classList.remove('hide');
  clearTimeout(osdTimer);
  if (vod) renderVosd();
  osdTimer = setTimeout(hideOsdSoon, 4500);
  checkSkip();
}
/** Ausblenden – nicht beim Spulen und (wie bei Netflix) nicht im Pause-Zustand. */
function hideOsdSoon() {
  clearTimeout(osdTimer);
  if (vod && (SC.on || video.paused)) { osdTimer = setTimeout(hideOsdSoon, 4500); return; }
  osdEl().classList.add('hide');
  if (vod) { VC.zone = skipKind ? 'skip' : 'bar'; renderVosd(); }
  checkSkip();
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
  hideSkip();
  scrubCancel(); VC.zone = 'bar';
  $('#vosd').classList.add('hide');
  if (vod && vod !== v) settleBurst(true);
  if (vod && vod !== v) saveVodPos();
  vod = v;
  $('#player').classList.toggle('vod', !!v);
  $('#pProg').classList.toggle('hidden', !v);
  if (v) $('#pEpg').classList.add('hidden');
  $('#pFav').classList.toggle('hidden', !!v);
  $('#pSub').textContent = v ? '' 
    : '◀ Senderliste · ▲▼ Sender · OK Pause · ≡ Optionen · Zurück';
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
  setVod({ list, idx, show, ep, ctx: ctx || null, resumed: false, synced: false, segs: [], segReady: false, used: {}, hid: {}, burst: null });
  currentId = null;
  $('#pTitle').textContent = ep.movie ? (ctx && ctx.name) || show : `${ep.num}. ${ep.title}`;
  $('#pGroup').textContent = ep.movie ? 'Film' + (ctx && ctx.src ? ' · ' + ctx.src : '') : `${(ctx && ctx.name) || show} · Staffel ${ep.season}`;
  $('#pLogo').textContent = ep.movie ? 'FILM' : `S${ep.season}`;
  $('#vTitle').innerHTML = ep.movie ? `<b>${esc((ctx && ctx.name) || show)}</b>`
    : `<b>${esc((ctx && ctx.name) || show)}</b>S${esc(ep.season)}:F${esc(ep.num)} „${esc(ep.title)}“`;
  updateProg();
  loadStream(ep.url);
  showOsd();
}
function saveVodPos(asDone) {
  asDone = asDone || !!(vod && vod.doneMark);
  if (!vod || !video.duration || !isFinite(video.duration) || (video.currentTime < 5 && !asDone)) return;
  const e = vod.ep, c = vod.ctx;
  VP.set(e.id, asDone ? video.duration : video.currentTime, video.duration, c ? {
    show: (c && c.name) || vod.show, movie: !!e.movie, season: e.season, num: e.num, title: e.title, url: e.url, img: c.img || '', acc: c.acc, sid: c.sid, src: c.src || '', tmdb: c.tmdb || '',
    next: e.movie ? null : nextOf(vod.list[vod.idx + 1])
  } : null);
}
const nextOf = n => n ? { id: n.id, season: n.season, num: n.num, title: n.title, url: n.url, dur: n.dur || 0 } : null;
/** Ältere Einträge: nächste Folge beim Anbieter nachschlagen (im Hintergrund). */
let nextBusy = false;
async function fillNext() {
  if (nextBusy) return;
  const ids = VP.needNext().slice(0, 6);
  if (!ids.length) return;
  nextBusy = true;
  let changed = false;
  for (const id of ids) {
    const v = VP.get(id), acc = XS.accounts().find(a => a.key === v.m.acc);
    if (!acc) { v.m.next = null; changed = true; continue; }
    try {
      const all = (await XS.info(acc, v.m.sid)).seasons.flatMap(s => s.eps), i = all.findIndex(e => e.id === id);
      v.m.next = i >= 0 ? nextOf(all[i + 1]) : null;
      changed = true;
    } catch (e) {}
  }
  nextBusy = false;
  if (changed) { VP.save(); VP.share(); if (!playerOpen) keepFocus(renderHome); }
}
/* ---------- Intro, Rückblick, Abspann überspringen ---------- */
// Quellen: TheIntroDB → selbst gelernt pro Serie → Faustregel (siehe skip.js)
// INTRO_SKIP bewusst knapp: lieber noch im Intro landen als schon in der Folge
// AUTO_NEXT: Sekunden bis „Nächste Folge“ automatisch ausgelöst wird (Auto-Play)
// SKIP_HIDE: „Intro/Rückblick überspringen“ verschwindet nach 10 s, ▲▼ holt den Button zurück
const INTRO_WINDOW = 300, INTRO_SKIP = 60, LEARN_MARGIN = 4, AUTO_NEXT = 10, SKIP_HIDE = 10000;
let skipKind = null, skipSeg = null, skipTimer = null, skipShownAt = 0, autoTimer = null, autoLeft = 0;
const outroLen = d => Math.max(60, Math.min(150, d * 0.04));
/** Schlüssel zum Lernen: TMDB-Serie, sonst Anbieter-Serie. */
const serKey = v => !v || v.ep.movie ? null : v.ctx && v.ctx.tmdb ? v.ctx.tmdb : v.ctx && v.ctx.acc ? 'xs:' + v.ctx.acc + '|' + v.ctx.sid : 'show:' + v.show;
async function loadSegments(v) {
  const d = video.duration;
  if (!isFinite(d) || d <= 0) return;
  const t = v.ctx && v.ctx.tmdb ? String(v.ctx.tmdb).split(':') : null;
  const db = t && Number(t[1]) > 0 ? await SK.fromDb(t[0] === 'movie' ? 'movie' : 'tv', Number(t[1]), v.ep.season, v.ep.num, d) : null;
  if (vod !== v) return;
  const L = SK.learned(serKey(v)), segs = [];
  if (db && db.recap && db.recap.e) segs.push({ kind: 'recap', from: db.recap.s, to: db.recap.e, target: db.recap.e, src: 'db' });
  if (db && db.intro) segs.push({ kind: 'intro', from: db.intro.s, to: db.intro.e || d, target: db.intro.e || d, src: 'db' });
  else if (!v.ep.movie && L.intro) segs.push({ kind: 'intro', from: Math.max(0, L.intro.s - 10), to: L.intro.e, target: Math.max(L.intro.s, L.intro.e - LEARN_MARGIN), src: 'learn' });
  else if (!v.ep.movie && d > 180) segs.push({ kind: 'intro', from: 0, to: Math.min(INTRO_WINDOW, d * 0.3), target: null, src: 'auto' });
  if (db && db.credits) {
    const post = db.credits.e && db.credits.e < d - 10;   // Szene nach dem Abspann
    segs.push({ kind: 'outro', from: db.credits.s, to: post ? db.credits.e : d, target: post ? db.credits.e : null, src: 'db' });
  } else if (L.outro && !v.ep.movie && L.outro < d * 0.5) segs.push({ kind: 'outro', from: d - L.outro, to: d, target: null, src: 'learn' });
  else if (d > 120) segs.push({ kind: 'outro', from: d - outroLen(d), to: d, target: null, src: 'auto' });
  v.segs = segs; v.segReady = true;
  // Fortgesetzt hinter Intro/Rückblick → dafür nicht mehr fragen
  if (v.startAt > 0) for (const sg of segs) if (sg.kind !== 'outro' && v.startAt > sg.from + 2) v.used[sg.kind] = true;
  checkSkip();
}
function showSkip(seg) {
  const b = $('#pSkip');
  skipSeg = seg; skipKind = seg.kind; skipShownAt = Date.now();
  const next = seg.kind === 'outro' && vod && !vod.ep.movie && vod.idx + 1 < vod.list.length && seg.target == null;
  b.innerHTML = seg.kind === 'intro' ? (seg.src === 'auto' ? 'Intro überspringen <span>⏩</span>' : 'Intro überspringen <span>⏭</span>')
    : seg.kind === 'recap' ? 'Rückblick überspringen <span>⏭</span>'
    : next ? nextLabel(AUTO_NEXT) : 'Abspann überspringen <span>⏭</span>';
  b.dataset.src = seg.src;
  b.classList.remove('hidden');
  if (vod && VC.zone !== 'btns' && !SC.on) VC.zone = 'skip';
  if (vod) renderVosd();
  clearTimeout(skipTimer);
  // Intro/Rückblick: nie automatisch springen – nur ausblenden (▲▼ zeigt ihn wieder)
  if (seg.kind !== 'outro') skipTimer = setTimeout(() => { if (vod && skipSeg === seg) { vod.hid[seg.kind] = true; hideSkip(); } }, SKIP_HIDE);
  clearInterval(autoTimer);
  if (next) startAutoNext(seg);
}
const nextLabel = n => `Nächste Folge in ${n} s <span>▶</span>`;
/** Auto-Play: „Nächste Folge“ nach AUTO_NEXT Sekunden selbst auslösen (pausiert mit dem Video). */
function startAutoNext(seg) {
  autoLeft = AUTO_NEXT;
  autoTimer = setInterval(() => {
    if (!vod || skipSeg !== seg) { clearInterval(autoTimer); return; }
    if (video.paused || menuOpen || SC.on) return;
    autoLeft--;
    if (autoLeft <= 0) { clearInterval(autoTimer); dbg('auto-next'); doSkip(); }
    else $('#pSkip').innerHTML = nextLabel(autoLeft);
  }, 1000);
}
function hideSkip() {
  clearTimeout(skipTimer); clearInterval(autoTimer);
  skipKind = null; skipSeg = null;
  $('#pSkip').classList.add('hidden');
  if (typeof VC !== 'undefined' && VC.zone === 'skip') { VC.zone = 'bar'; if (vod) renderVosd(); }
}
function checkSkip() {
  if (!vod || menuOpen || !vod.segReady) return;
  const t = video.currentTime || 0;
  const cur = vod.segs.filter(s => t >= s.from && t < s.to - 1 && !vod.used[s.kind] && !vod.hid[s.kind]).sort((a, b) => b.from - a.from)[0] || null;
  if (cur && skipSeg !== cur) showSkip(cur);
  else if (!cur && skipSeg) hideSkip();
}
/** ▲▼: ausgeblendeten „Intro/Rückblick überspringen“-Button wieder einblenden. true = wieder da. */
function reshowSkip() {
  if (!vod || !vod.segReady || skipSeg) return false;
  const t = video.currentTime || 0;
  const seg = vod.segs.find(s => s.kind !== 'outro' && vod.hid[s.kind] && !vod.used[s.kind] && t >= s.from && t < s.to - 1);
  if (!seg) return false;
  delete vod.hid[seg.kind];
  showSkip(seg);
  VC.zone = 'skip';
  return true;
}
function seekTo(abs) {
  dbg('seekTo', Math.round(abs), 'dur', video.duration, 'seeking', video.seeking);
  if (!vod || !isFinite(video.duration)) return;
  video.currentTime = Math.max(0, Math.min(video.duration - 2, abs));
  updateProg();
}
/** Spulen merken, um daraus das Intro einer Serie zu lernen. */
function noteSeek(from, to, src) {
  if (!vod || vod.ep.movie) return;
  const b = vod.burst, win = b && b.src !== 'user' ? 15000 : 4000;
  if (b && Date.now() - b.at < win) { b.to = to; b.at = Date.now(); if (!src) b.adjusted = true; }
  else vod.burst = { from, to, at: Date.now(), src: src || 'user', adjusted: false };
}
function settleBurst(force) {
  const b = vod && vod.burst;
  if (!b || (!force && Date.now() - b.at < SK.SETTLE)) return;
  vod.burst = null;
  const dbIntro = (vod.segs || []).some(s => s.kind === 'intro' && s.src === 'db');
  const net = b.to - b.from;
  const d = isFinite(video.duration) ? video.duration : 0;
  // Intro: 30 s bis 3 Min. Sprung, Ende in den ersten 15 Min. und im ersten Drittel der Folge
  if (dbIntro || !d || net < 30 || net > 180 || b.to > Math.min(900, d * 0.3)) return;
  if (b.src === 'user' || b.adjusted) SK.learnIntro(serKey(vod), b.from, b.to);
}
/** Am Ende abgebrochen bzw. zur nächsten Folge gesprungen → Abspann-Beginn lernen. */
function noteOutro(v) {
  if (!v || v.ep.movie || !isFinite(video.duration)) return;
  const d = video.duration, P = video.currentTime || 0, off = d - P;
  if ((v.segs || []).some(s => s.kind === 'outro' && s.src === 'db')) return;
  if (P / d >= 0.85 && off >= 15 && off <= 600) SK.learnOutro(serKey(v), off);
}
const dbg = (...a) => { try { console.log('[player]', ...a); } catch (e) {} };
function doSkip() {
  const seg = skipSeg;
  dbg('skip', seg && seg.kind, seg && seg.src, 'at', Math.round(video.currentTime || 0), 'nv', NV.on);
  hideSkip();
  if (!vod || !seg) return;
  vod.used[seg.kind] = true;
  if (seg.kind !== 'outro' || seg.target != null) {
    const from = video.currentTime || 0, to = seg.target != null ? seg.target : from + INTRO_SKIP;
    seekTo(to);
    if (seg.kind === 'intro' && seg.src !== 'db') noteSeek(from, to, 'btn');
    showOsd();
    return;
  }
  // Abspann: zu spät erschienener Button → tatsächlichen Beginn lernen
  if (seg.src !== 'db' && Date.now() - skipShownAt > 5000) noteOutro(vod);
  vod.doneMark = true;
  saveVodPos(true);
  if (!vod.synced) syncWatched(vod);
  if (!vod.ep.movie && vod.idx + 1 < vod.list.length) { const v = vod; openVod(v.list, v.idx + 1, v.show, v.ctx); }
  else closePlayer();
}
$('#pSkip').addEventListener('click', e => { e.stopPropagation(); doSkip(); });

/* ---------- Watchlist-Sync (ab 90 % gesehen) ---------- */
/** TMDB-ID zu einem Anbieter-Titel suchen, z. B. „The Terminal List (2022) (US) (DIE ABSCHUSSLISTE)“. */
const tmdbGuess = {};
async function guessTmdb(show, movie) {
  const raw = cleanName(String(show || ''));
  const year = (raw.match(/\((19|20)\d{2}\)/) || [])[0];
  const base = raw.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
  const k = (movie ? 'm:' : 't:') + base.toLowerCase();
  if (k in tmdbGuess) return tmdbGuess[k];
  if (!base || !TM.key()) return null;
  const type = movie ? 'movie' : 'tv';
  try {
    const j = await TM.get('/search/' + type, { query: base, include_adult: 'false', ...(year ? { [movie ? 'year' : 'first_air_date_year']: year.slice(1, 5) } : {}) });
    const list = TM.picks(j, type);
    const want = XS.norm(base);
    const p = list.find(x => XS.norm(x.title) === want || XS.norm(x.orig) === want) || list[0] || null;
    return (tmdbGuess[k] = p ? type + ':' + p.id : null);
  } catch (e) { return null; }
}
/** Fehlende TMDB-ID an Weiterschauen-Einträgen derselben Serie nachtragen. */
function rememberTmdb(acc, sid, tmdb) {
  const all = VP.all(); let n = 0;
  for (const id in all) { const m = all[id].m; if (m && m.acc === acc && m.sid === sid && !m.tmdb) { m.tmdb = tmdb; n++; } }
  if (n) VP.save();
}
/** Bereits fertig geschaute Folgen ohne Watchlist-Eintrag nachträglich übertragen (einmal pro Folge). */
let backfillBusy = false;
async function backfillWatched() {
  if (backfillBusy || !WL.connected || !TM.key()) return;
  backfillBusy = true;
  let n = 0;
  try {
    const all = VP.all();
    const ids = Object.keys(all).filter(id => all[id].m && !all[id].m.wl && VP.done(id)).sort((a, b) => all[a].at - all[b].at);
    for (const id of ids) {
      const e = all[id], m = e.m;
      let tm = m.tmdb;
      if (!tm) { tm = await guessTmdb(m.show, m.movie); if (tm) rememberTmdb(m.acc, m.sid, tm); }
      if (!tm) { m.wl = 'none'; continue; }
      const t = String(tm).split(':');
      try {
        await WL.markWatched(t[0] === 'movie' ? 'movie' : 'tv', Number(t[1]), Number(m.season) || 0, Number(m.num) || 0);
        m.wl = 1; n++;
      } catch (err) { break; }
    }
    VP.save();
    if (n) { toast(`✓ Watchlist: ${n} gesehene Folge${n > 1 ? 'n' : ''} nachgetragen`); renderHome(); }
  } finally { backfillBusy = false; }
}

async function syncWatched(v) {
  v.synced = true;
  if (!WL.connected) return;
  if (v.ctx && !v.ctx.tmdb) {   // Anbieter-Titel ohne TMDB-ID: per Name suchen
    const tm = await guessTmdb(v.ctx.name || v.show, !!v.ep.movie);
    if (tm) { v.ctx.tmdb = tm; rememberTmdb(v.ctx.acc, v.ctx.sid, tm); }
  }
  const t = v.ctx && v.ctx.tmdb ? String(v.ctx.tmdb).split(':') : null;
  if (!t || !t[1]) return;
  const job = { type: t[0] === 'movie' ? 'movie' : 'tv', id: Number(t[1]), season: Number(v.ep.season) || 0, num: Number(v.ep.num) || 0 };
  try {
    const st = await WL.markWatched(job.type, job.id, job.season, job.num);
    const pe = VP.get(v.ep.id); if (pe && pe.m) { pe.m.wl = 1; VP.save(); }
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
  const v = VP.entry(id);
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
/** Weiterschauen-Kachel: Folgenauswahl der Serie öffnen (Hauptknopf „Weiterschauen“). */
function openResumeSheet(id) {
  const v = VP.entry(id);
  if (!v || !v.m || sheetOpen) return;
  const m = v.m, acc = XS.accounts().find(a => a.key === m.acc);
  if (!acc) return playResume(id);   // Quelle nicht mehr vorhanden → direkt abspielen
  const movie = !!m.movie, kind = movie ? 'vod' : 'series', sid = String(m.sid || '').replace(/^m/, '');
  const hit = CAT[kind].items && CAT[kind].items.find(x => x.acc.key === acc.key && String(x.it.sid) === sid);
  const it = hit ? hit.it : { sid, name: m.show, n: XS.norm(m.show), t: [], year: '', tmdb: 0, cover: m.img || '', cat: '',
    ext: (String(m.url || '').match(/\.(\w+)$/) || [])[1] || 'mp4' };
  const tid = Number(String(m.tmdb || '').split(':')[1]) || it.tmdb || 0;
  lastFocus = document.activeElement; sheetOpen = true;
  pushOverlay('sheet');
  $('#sheet').classList.add('open');
  sheetAnim();
  const bg = m.img || it.cover;
  $('#sheetBd').style.backgroundImage = bg ? `url("${bg.replace(/"/g, '%22')}")` : 'none';
  const p = { type: movie ? 'movie' : 'tv', id: tid, title: m.show, backdrop: null, poster: null };
  ip = { p, d: null, status: 'loadingShow', msg: '', hits: [{ acc, it, s: 100 }], sel: null, info: null, season: null, token: Date.now(), cat: true };
  pushOverlay('iptv');
  $('#sheet').classList.add('iptv');
  selectHit(0);
}
/* OK gedrückt halten auf einer Weiterschauen-Kachel = entfernen, kurz = Folgenauswahl */
const HOLD = { id: null, kind: '', el: null, timer: null, done: false };
document.addEventListener('keyup', e => {
  if (e.key !== 'Enter' || !HOLD.id) return;
  clearTimeout(HOLD.timer);
  const id = HOLD.id, done = HOLD.done;
  HOLD.id = null;
  if (done) return;
  if (HOLD.kind === 'resume') openResumeSheet(id); else openSheet(id);
});
function holdStart(a, kind, id) {
  HOLD.id = id; HOLD.kind = kind; HOLD.el = a; HOLD.done = false;
  HOLD.timer = setTimeout(() => {
    if (!HOLD.id) return;
    HOLD.done = true;
    if (kind === 'resume') hideResume(HOLD.id); else startMove(HOLD.el);
  }, 650);
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
  renderVosd();
  const d = isFinite(video.duration) ? video.duration : 0, t = video.currentTime || 0;
  $('#pBar').style.width = d ? (t / d * 100).toFixed(2) + '%' : '0';
  $('#pTime').textContent = d ? `${fmtTime(t)} / ${fmtTime(d)}` : '';
}
/* ---------- Netflix-Bedienung: Leiste, Vorschau-Spulen, Tastenreihe ---------- */
const VC = { zone: 'bar', sel: 0 };
const SC = { on: false, pos: 0, from: 0, holdStart: 0, last: 0, t: null };
function vButtons() {
  const next = vod && !vod.ep.movie && vod.idx + 1 < vod.list.length;
  $('#vNext').classList.toggle('hidden', !next);
  return $$('#vosd .vb').filter(b => !b.classList.contains('hidden'));
}
function renderVosd() {
  if (!vod) return;
  const o = $('#vosd'), d = isFinite(video.duration) ? video.duration : 0, cur = video.currentTime || 0;
  const t = SC.on ? SC.pos : cur, pct = x => d ? Math.max(0, Math.min(100, x / d * 100)).toFixed(2) + '%' : '0';
  o.classList.toggle('scrub', SC.on);
  o.classList.toggle('zbar', VC.zone === 'bar');
  o.classList.toggle('paused', video.paused && !SC.on);
  $('#vFill').style.width = pct(SC.on ? Math.min(t, cur) : t);
  $('#vGhost').style.width = SC.on ? pct(Math.max(t, cur)) : '0';
  $('#vKnob').style.left = pct(t);
  $('#vRem').textContent = d ? fmtTime(Math.max(0, d - t)) : '';
  if (SC.on) {
    const delta = Math.round(t - SC.from);
    $('#vBubble').innerHTML = `${fmtTime(t)}<small>${delta >= 0 ? '+' : '−'}${fmtTime(Math.abs(delta))}</small>`;
  }
  $('#vCenter').textContent = video.paused && !SC.on && d ? '❚❚' : '';
  $('#vPlay').innerHTML = video.paused ? '<svg viewBox="0 0 24 24"><path d="M7 4l13 8-13 8z" fill="currentColor"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M6 4h4v16H6zM14 4h4v16h-4z" fill="currentColor"/></svg>';
  const btns = vButtons();
  if (VC.sel >= btns.length) VC.sel = btns.length - 1;
  btns.forEach((b, i) => b.classList.toggle('sel', VC.zone === 'btns' && i === VC.sel));
  $('#pSkip').classList.toggle('sel', VC.zone === 'skip' && !!skipKind);
}
/** ◀▶: kurz = 10 s, gedrückt halten = immer schneller. Gesprungen wird erst beim Loslassen. */
function scrubKey(dir, e) {
  const d = video.duration;
  if (!vod || !isFinite(d)) return;
  const now = performance.now();
  const held = SC.on && !!e && (e.repeat || now - SC.last < 160);
  if (!SC.on) { SC.on = true; SC.from = SC.pos = video.currentTime || 0; }
  if (!held) { SC.pos += dir * 10; SC.holdStart = now; }
  else {
    const h = now - SC.holdStart, dt = Math.min(0.25, (now - SC.last) / 1000);
    const vel = h < 1200 ? 30 : h < 3000 ? 90 : Math.max(240, d / 40);   // Sekunden pro Sekunde
    SC.pos += dir * vel * dt;
  }
  SC.last = now;
  SC.pos = Math.max(0, Math.min(d - 2, SC.pos));
  clearTimeout(SC.t);
  SC.t = setTimeout(scrubCommit, 800);
  renderVosd();
}
function scrubCommit() {
  clearTimeout(SC.t);
  if (!SC.on) return;
  dbg('scrub', Math.round(SC.from), '->', Math.round(SC.pos));
  SC.on = false;
  if (vod && isFinite(video.duration) && Math.abs(SC.pos - (video.currentTime || 0)) > 0.5) {
    const from = SC.from;
    video.currentTime = SC.pos;
    noteSeek(from, SC.pos);
  }
  if (skipKind && VC.zone === 'bar') VC.zone = 'skip';
  renderVosd();
  if (vod) showOsd();
}
function scrubCancel() { clearTimeout(SC.t); SC.on = false; }
function vodButton(id) {
  if (id === 'play') togglePlay();
  else if (id === 'rew') seek(-10);
  else if (id === 'fwd') seek(10);
  else if (id === 'next') { zap(1); return; }
  else if (id === 'menu') { openMenu(); return; }
  setTimeout(renderVosd, 50);
}
/** Tasten im Serien-/Film-Player. true = verarbeitet. */
function vodKey(e) {
  const k = e.key, shown = osdShown();
  if (k === 'MediaPlayPause') { togglePlay(); showOsd(); return true; }
  if (k === 'MediaRewind' || k === 'MediaFastForward') { VC.zone = 'bar'; scrubKey(k === 'MediaRewind' ? -1 : 1, e); showOsd(); return true; }
  if (['ChannelUp', 'PageUp', 'ChannelDown', 'PageDown'].includes(k)) { zap(k === 'ChannelUp' || k === 'PageUp' ? -1 : 1); return true; }
  if (['Escape', 'Backspace', 'GoBack', 'BrowserBack'].includes(k) && SC.on) { scrubCancel(); renderVosd(); showOsd(); return true; }
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', ' '].includes(k)) return false;
  // Ausgeblendet: ◀▶ spult sofort, OK pausiert, ▲▼ blendet ein
  if (VC.zone === 'skip' && !skipKind) VC.zone = 'bar';
  if (VC.zone === 'skip') {   // „Intro überspringen“ ist ausgewählt
    if (k === 'ArrowLeft' || k === 'ArrowRight') { VC.zone = 'bar'; scrubKey(k === 'ArrowLeft' ? -1 : 1, e); }
    else if (k === 'ArrowDown') VC.zone = shown ? 'btns' : 'bar';
    if (k === 'ArrowDown' && VC.zone === 'btns') VC.sel = 0;
    showOsd();
    return true;
  }
  if (!shown) {
    VC.zone = 'bar';
    if (k === 'ArrowLeft' || k === 'ArrowRight') scrubKey(k === 'ArrowLeft' ? -1 : 1, e);
    else if (k === 'Enter' || k === ' ') togglePlay();
    showOsd();
    return true;
  }
  if (VC.zone === 'bar') {
    if (k === 'ArrowLeft' || k === 'ArrowRight') scrubKey(k === 'ArrowLeft' ? -1 : 1, e);
    else if (k === 'Enter' || k === ' ') { if (SC.on) scrubCommit(); else togglePlay(); }
    else if (k === 'ArrowDown') { scrubCommit(); VC.zone = 'btns'; VC.sel = 0; }
    else if (k === 'ArrowUp' && skipKind && !SC.on) VC.zone = 'skip';
  } else {
    const btns = vButtons();
    if (k === 'ArrowLeft') VC.sel = Math.max(0, VC.sel - 1);
    else if (k === 'ArrowRight') VC.sel = Math.min(btns.length - 1, VC.sel + 1);
    else if (k === 'ArrowUp') VC.zone = skipKind ? 'skip' : 'bar';
    else if (k === 'Enter' || k === ' ') { const b = btns[VC.sel]; if (b) vodButton(b.dataset.vb); }
  }
  showOsd();
  return true;
}
$('#vosd').addEventListener('click', e => { e.stopPropagation(); const b = e.target.closest('[data-vb]'); if (b) vodButton(b.dataset.vb); else showOsd(); });
$('#vBar').addEventListener('click', e => {
  e.stopPropagation();
  const r = $('#vBar').getBoundingClientRect(), d = video.duration;
  if (!vod || !isFinite(d)) return;
  const from = video.currentTime, to = Math.max(0, Math.min(d - 2, (e.clientX - r.left) / r.width * d));
  video.currentTime = to; noteSeek(from, to); renderVosd(); showOsd();
});
video.addEventListener('play', () => { if (vod) renderVosd(); });
video.addEventListener('pause', () => { if (vod) { renderVosd(); showOsd(); } });
function seek(sec) {
  if (!vod || !isFinite(video.duration)) return;
  const from = video.currentTime;
  video.currentTime = Math.max(0, Math.min(video.duration - 2, video.currentTime + sec));
  noteSeek(from, video.currentTime);
  updateProg();
}
video.addEventListener('loadedmetadata', () => applyTrackPref());
if (video.textTracks) video.textTracks.addEventListener('addtrack', () => applyTrackPref());
if (video.audioTracks) video.audioTracks.addEventListener('addtrack', () => applyTrackPref());
video.addEventListener('loadedmetadata', () => {
  if (!vod || vod.resumed) return;
  vod.resumed = true;
  const v0 = vod;
  const v = VP.get(vod.ep.id);
  const resume = !!(v && v.pos > 30 && !VP.done(vod.ep.id) && isFinite(video.duration));
  v0.startAt = resume ? v.pos : 0;
  setTimeout(() => { if (vod === v0 && !v0.segReady) loadSegments(v0); }, 0);
  if (resume) {
    video.currentTime = v.pos;
    toast('Fortgesetzt bei ' + fmtTime(v.pos));
  }
});
let vodSaveAt = 0;
video.addEventListener('timeupdate', () => {
  if (!vod) return;
  updateProg();
  if (!vod.synced && isFinite(video.duration) && video.duration > 60 && video.currentTime / video.duration >= 0.9) syncWatched(vod);
  checkSkip();
  settleBurst(false);
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
  if (menuOpen || clistOpen) {   // Menü/Senderliste liegt noch auf dem Verlauf → beide Einträge auf einmal entfernen
    const sub = menuOpen ? 'pmenu' : 'clist';
    menuOpen = false; clistOpen = false;
    $('#pMenu').classList.add('hidden'); $('#pList').classList.add('hidden');
    const i = overlays.lastIndexOf(sub); if (i >= 0) overlays.splice(i, 1);
    if (!fromPop) { const j = overlays.lastIndexOf('player'); if (j >= 0) overlays.splice(j, 1); skipPops++; history.go(-2); fromPop = true; }
  }
  const wasVod = !!vod;
  if (vod && !vod.doneMark) noteOutro(vod);
  setVod(null);
  playerOpen = false;
  playToken++;
  clearTimeout(RC.timer); RC.waiting = false; RC.dead = false; RC.url = '';
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
    if (step > 0) noteOutro(vod);
    const i = vod.idx + step;
    if (i < 0 || i >= vod.list.length) { toast(step > 0 ? 'Letzte Folge' : 'Erste Folge'); return; }
    return openVod(vod.list, i, vod.show, vod.ctx);
  }
  const list = visibleChannels();
  if (!list.length) return;
  const i = list.findIndex(c => c.id === currentId);
  openPlayer(list[(i + step + list.length) % list.length].id);
}
function togglePlay() { video.paused ? safePlay(video) : video.pause(); }
function playerKey(e) {
  const k = e.key;
  dbg('key', k, e.repeat ? 'rep' : '', 'zone', typeof VC !== 'undefined' ? VC.zone : '', 'skip', skipKind || '-', 'osd', osdShown());
  if (menuOpen) return menuKey(e);
  if (clistOpen) return clistKey(e);
  if (!vod && currentId && k === 'ArrowLeft') { e.preventDefault(); openClist(); return; }
  // Faustregel-Intro (Zeitpunkt unbekannt): auch ⏩ überspringt
  if (skipSeg && skipSeg.src === 'auto' && k === 'MediaFastForward') { e.preventDefault(); doSkip(); return; }
  if (skipKind && ['Enter', ' '].includes(k) && (!vod || VC.zone === 'skip')) { e.preventDefault(); doSkip(); return; }
  if (vod && k !== 'ContextMenu' && k !== 'm' && k !== 'M') {
    if (['Escape', 'Backspace', 'GoBack', 'BrowserBack'].includes(k) && !SC.on) { e.preventDefault(); closePlayer(); return; }
    if ((k === 'ArrowUp' || k === 'ArrowDown') && !SC.on && reshowSkip()) { e.preventDefault(); vod.touched = true; showOsd(); return; }
    if (vodKey(e)) { e.preventDefault(); vod && (vod.touched = true); checkSkip(); return; }
  }
  if (k === 'ContextMenu' || k === 'm' || k === 'M') { e.preventDefault(); openMenu(); return; }
  if (['Escape', 'Backspace', 'GoBack', 'BrowserBack'].includes(k)) { e.preventDefault(); closePlayer(); return; }
  if (vod && ['ArrowLeft', 'MediaRewind'].includes(k)) seek(k === 'MediaRewind' ? -30 : -10);
  else if (vod && ['ArrowRight', 'MediaFastForward'].includes(k)) seek(k === 'MediaFastForward' ? 30 : 10);
  else if (['ArrowUp', 'ChannelUp', 'PageUp'].includes(k)) zap(-1);
  else if (['ArrowDown', 'ChannelDown', 'PageDown'].includes(k)) zap(1);
  else if (['Enter', ' ', 'MediaPlayPause'].includes(k)) { if (RC.dead || RC.waiting) retryNow(); else togglePlay(); }
  else if (['f', 'F'].includes(k)) toggleFav(currentId);
  else return;
  e.preventDefault();
  if (vod) vod.touched = true;
  showOsd();
}
video.addEventListener('pause', () => checkSkip());
video.addEventListener('play', () => checkSkip());
video.addEventListener('waiting', () => { if (engine && !RC.waiting) setStatus('Puffern …'); });
video.addEventListener('seeking', () => { RC.lastMove = Date.now(); RC.lastT = -1; if (vod && engine && !RC.waiting) setStatus('Lädt …'); });
video.addEventListener('seeked', () => { RC.lastMove = Date.now(); if (vod && !video.paused && /^(Lädt|Puffern)/.test($('#status').textContent)) setTimeout(() => { if (!video.seeking) setStatus(''); }, 300); });
video.addEventListener('playing', () => {
  clearTimeout(startTimer); setStatus('');
  RC.played = RC.loadPlayed = true; RC.eng = engine; RC.tries = 0; RC.rounds = 0; RC.dead = false; RC.lastMove = Date.now();
});
video.addEventListener('loadedmetadata', () => {   // nach Reconnect an derselben Stelle weiter
  if (vod && RC.resumeAt > 1 && isFinite(video.duration)) { video.currentTime = Math.min(RC.resumeAt, video.duration - 3); RC.resumeAt = 0; }
});
video.addEventListener('ended', () => { if (!vod && playerOpen && RC.loadPlayed) reconnect('Stream beendet'); });
video.addEventListener('error', () => { if (engine === 'native' && failCb) failCb(); });
$('#player').addEventListener('click', e => { if (!e.target.closest('#osd')) { togglePlay(); showOsd(); } });

/* ================= Senderliste im Player (◀) ================= */
let clistOpen = false;
const cl = { ids: [], sel: 0, group: '' };
const CL_ROWS = 8;
function openClist() {
  const ch = byId(currentId);
  if (!ch || clistOpen) return;
  cl.group = ch.group;
  cl.ids = state.channels.filter(c => c.group === ch.group).map(c => c.id);   // aktuelle Kategorie, auch wenn ausgeblendet
  cl.sel = Math.max(0, cl.ids.indexOf(currentId));
  clistOpen = true;
  pushOverlay('clist');
  $('#osd').classList.add('hide');
  $('#pList').classList.remove('hidden');
  renderClist();
}
function closeClist(fromPop) {
  if (!clistOpen) return;
  clistOpen = false;
  $('#pList').classList.add('hidden');
  if (!fromPop) popOverlay('clist');
  showOsd();
}
function renderClist() {
  const n = cl.ids.length;
  const a = Math.max(0, Math.min(cl.sel - Math.floor(CL_ROWS / 2), n - CL_ROWS)), b = Math.min(n, a + CL_ROWS);
  let rows = '';
  for (let i = a; i < b; i++) {
    const c = byId(cl.ids[i]);
    if (!c) continue;
    const ep = EPG.now(c.id), prog = ep && ep.cur ? ep.cur.t : '';
    EPG.want(c);
    rows += `<div class="cl-row ${i === cl.sel ? 'on' : ''} ${c.id === currentId ? 'cur' : ''}" data-cl="${i}">
      <div class="cl-logo"><span>${esc(initials(c.name))}</span>${c.logo ? `<img src="${esc(c.logo)}" alt="" onerror="this.remove()">` : ''}</div>
      <div class="cl-txt"><b>${esc(c.name)}</b>${prog ? `<small>${esc(prog)}</small>` : ''}</div>
      ${c.id === currentId ? '<span class="cl-live">LIVE</span>' : ''}
    </div>`;
  }
  $('#pList').innerHTML = `<div class="cl-head"><span class="eyebrow">${esc(cl.group)}</span><span class="cl-pos">${n ? cl.sel + 1 : 0} / ${n}</span></div>
    ${a > 0 ? '<div class="cl-more">▲</div>' : ''}<div class="cl-rows">${rows}</div>${b < n ? '<div class="cl-more">▼</div>' : ''}
    <div class="cl-hint">▲▼ wählen · OK umschalten · ◀ schließen</div>`;
}
function clistMove(d) {
  const n = cl.ids.length;
  if (!n) return;
  cl.sel = Math.max(0, Math.min(n - 1, cl.sel + d));
  renderClist();
}
function clistKey(e) {
  const k = e.key;
  e.preventDefault();
  if (['Escape', 'Backspace', 'GoBack', 'BrowserBack', 'ArrowLeft'].includes(k)) return closeClist();
  if (k === 'ArrowUp') return clistMove(-1);
  if (k === 'ArrowDown') return clistMove(1);
  if (['PageUp', 'ChannelUp', 'MediaRewind'].includes(k)) return clistMove(-CL_ROWS);
  if (['PageDown', 'ChannelDown', 'MediaFastForward'].includes(k)) return clistMove(CL_ROWS);
  if (k === 'Enter' || k === ' ') {
    const id = cl.ids[cl.sel];
    if (id && id !== currentId) openPlayer(id);
    renderClist();
  }
}
$('#pList').addEventListener('click', e => {
  e.stopPropagation();
  const r = e.target.closest('[data-cl]');
  if (!r) return;
  cl.sel = Number(r.dataset.cl);
  const id = cl.ids[cl.sel];
  if (id && id !== currentId) openPlayer(id);
  renderClist();
});

/* ================= Tonspur & Untertitel (Menü-Taste ≡) ================= */
let menuOpen = false;
const TRK = { KEY: 'streamtv.tracks', p: null };
const LANG3 = { ger: 'de', deu: 'de', eng: 'en', fre: 'fr', fra: 'fr', spa: 'es', ita: 'it', tur: 'tr', pol: 'pl', rus: 'ru', ara: 'ar', dut: 'nl', nld: 'nl', por: 'pt', jpn: 'ja', kor: 'ko', chi: 'zh', zho: 'zh' };
const LANGN = { de: 'Deutsch', en: 'Englisch', fr: 'Französisch', es: 'Spanisch', it: 'Italienisch', tr: 'Türkisch', pl: 'Polnisch', ru: 'Russisch', ar: 'Arabisch', nl: 'Niederländisch', pt: 'Portugiesisch', ja: 'Japanisch', ko: 'Koreanisch', zh: 'Chinesisch' };
function langOf(l) { l = String(l || '').toLowerCase().split(/[-_]/)[0]; return LANG3[l] || l; }
function trkPref() { if (!TRK.p) { try { TRK.p = JSON.parse(localStorage.getItem(TRK.KEY) || '{}'); } catch (e) { TRK.p = {}; } } return TRK.p; }
function trkSave(k, v) { trkPref()[k] = v; try { localStorage.setItem(TRK.KEY, JSON.stringify(TRK.p)); } catch (e) {} }
const trkLabel = (name, lang, i) => {
  const l = langOf(lang), n = String(name || '').trim();
  return n && !/^(track|spur|audio|subtitle)?\s*\d*$/i.test(n) ? n : LANGN[l] || (l ? l.toUpperCase() : `Spur ${i + 1}`);
};
/** Verfügbare Spuren der aktuellen Wiedergabe (hls.js oder nativ). */
function getTracks() {
  const audio = [], subs = [];
  if (engine === 'exo') {
    const au = NV.tracks.filter(t => t.type === 'audio'), tx = NV.tracks.filter(t => t.type === 'text');
    au.forEach((t, i) => audio.push({ label: trkLabel(t.label, t.lang, i) + (t.ch > 2 ? ` · ${t.ch === 6 ? '5.1' : t.ch === 8 ? '7.1' : t.ch + ' Kanäle'}` : '') + (t.ok ? '' : ' (nicht unterstützt)'),
      lang: langOf(t.lang), sel: t.sel, set: () => bridge.nvSelect('audio', t.g, t.i) }));
    tx.forEach((t, i) => subs.push({ label: trkLabel(t.label, t.lang, i), lang: langOf(t.lang), sel: t.sel, set: () => bridge.nvSelect('text', t.g, t.i) }));
    return { audio, subs, off: () => { bridge.nvSelect('text', -1, -1); NV.cue(''); }, offSel: !tx.some(t => t.sel) };
  }
  if (engine === 'hls' && hls) {
    (hls.audioTracks || []).forEach((t, i) => audio.push({ label: trkLabel(t.name, t.lang, i), lang: langOf(t.lang), sel: hls.audioTrack === i, set: () => { hls.audioTrack = i; } }));
    (hls.subtitleTracks || []).forEach((t, i) => subs.push({ label: trkLabel(t.name, t.lang, i), lang: langOf(t.lang), sel: hls.subtitleTrack === i && hls.subtitleDisplay !== false,
      set: () => { hls.subtitleTrack = i; hls.subtitleDisplay = true; } }));
    return { audio, subs, off: () => { hls.subtitleTrack = -1; }, offSel: hls.subtitleTrack < 0 };
  }
  const at = video.audioTracks;   // nur wenn die WebView es unterstützt
  if (at && at.length) for (let i = 0; i < at.length; i++) {
    const t = at[i];
    audio.push({ label: trkLabel(t.label, t.language, i), lang: langOf(t.language), sel: t.enabled, set: () => { for (let j = 0; j < at.length; j++) at[j].enabled = j === i; } });
  }
  const tt = [...(video.textTracks || [])].filter(t => t.kind === 'subtitles' || t.kind === 'captions');
  tt.forEach((t, i) => subs.push({ label: trkLabel(t.label, t.language, i), lang: langOf(t.language), sel: t.mode === 'showing',
    set: () => tt.forEach(x => { x.mode = x === t ? 'showing' : 'disabled'; }) }));
  return { audio, subs, off: () => tt.forEach(x => { x.mode = 'disabled'; }), offSel: !tt.some(t => t.mode === 'showing') };
}
/** Gemerkte Sprache automatisch wählen. */
function applyTrackPref() {
  const p = trkPref(), t = getTracks();
  if (p.audio && t.audio.length > 1) { const a = t.audio.find(x => x.lang === p.audio); if (a && !a.sel) a.set(); }
  if (p.sub && t.subs.length) {
    if (p.sub === 'off') { if (!t.offSel) t.off(); }
    else { const s = t.subs.find(x => x.lang === p.sub); if (s && !s.sel) s.set(); }
  }
}
const canExternal = () => { try { return !!(bridge && typeof bridge.openExternal === 'function' && bridge.hasExternalPlayer()); } catch (e) { return false; } };
let menuActs = [];
function renderMenu(focusIdx) {
  const t = getTracks(), rows = [];
  menuActs = [];
  const item = (label, sel, fn, cls = '') => { menuActs.push(fn); return `<button class="pm-item ${sel ? 'sel' : ''} ${cls}" data-pm="${menuActs.length - 1}"><span class="ck">${sel ? '✓' : ''}</span><span>${esc(label)}</span></button>`; };
  if (t.audio.length > 1) {
    rows.push('<div class="pm-h">Tonspur</div>');
    t.audio.forEach(a => rows.push(item(a.label, a.sel, () => { a.set(); trkSave('audio', a.lang); toast('Tonspur: ' + a.label); })));
  }
  if (t.subs.length) {
    rows.push('<div class="pm-h">Untertitel</div>');
    rows.push(item('Aus', t.offSel, () => { t.off(); trkSave('sub', 'off'); toast('Untertitel aus'); }));
    t.subs.forEach(s => rows.push(item(s.label, s.sel, () => { s.set(); trkSave('sub', s.lang); toast('Untertitel: ' + s.label); })));
  }
  if (!t.audio.length && !t.subs.length || (t.audio.length < 2 && !t.subs.length)) {
    rows.push(`<p class="pm-note">${engine === 'native'
      ? 'Ton- und Untertitelspuren in MKV/MP4-Dateien kann der eingebaute Player nicht umschalten.' + (canExternal() ? ' Dafür „In anderem Player öffnen“ wählen.' : '')
      : 'Keine weiteren Ton- oder Untertitelspuren.'}</p>`);
  }
  rows.push('<div class="pm-h">Mehr</div>');
  if (!vod && currentId) rows.push(item(isFav(currentId) ? '★ Aus Favoriten entfernen' : '☆ Zu Favoriten hinzufügen', false, () => toggleFav(currentId)));
  if (vod && canExternal()) rows.push(item('In anderem Player öffnen (z. B. VLC)', false, () => openExternalPlayer()));
  rows.push(item('Schließen', false, () => {}, 'muted'));
  $('#pMenu').innerHTML = `<div class="pm-title">Optionen</div>${rows.join('')}`;
  const btns = $$('#pMenu .pm-item');
  const f = btns[Math.max(0, Math.min(btns.length - 1, focusIdx == null ? btns.findIndex(b => b.classList.contains('sel')) : focusIdx))] || btns[0];
  if (f) { f.focus({ preventScroll: true }); f.scrollIntoView({ block: 'nearest' }); }
}
function openMenu() {
  if (menuOpen) return;
  menuOpen = true;
  pushOverlay('pmenu');
  $('#pMenu').classList.remove('hidden');
  $('#osd').classList.add('hide'); $('#vosd').classList.add('hide');
  renderMenu();
}
function closeMenu(fromPop) {
  if (!menuOpen) return;
  menuOpen = false;
  $('#pMenu').classList.add('hidden');
  if (document.activeElement) document.activeElement.blur();
  if (!fromPop) popOverlay('pmenu');
}
function menuKey(e) {
  const k = e.key, btns = $$('#pMenu .pm-item'), i = btns.indexOf(document.activeElement);
  e.preventDefault();
  if (['Escape', 'Backspace', 'GoBack', 'BrowserBack', 'ContextMenu', 'ArrowLeft', 'm', 'M'].includes(k)) return closeMenu();
  if (k === 'ArrowDown' || k === 'ArrowUp') {
    const n = btns[Math.max(0, Math.min(btns.length - 1, (i < 0 ? 0 : i + (k === 'ArrowDown' ? 1 : -1))))];
    if (n) { n.focus({ preventScroll: true }); n.scrollIntoView({ block: 'nearest' }); }
    return;
  }
  if (k === 'Enter' || k === ' ') {
    const b = document.activeElement && document.activeElement.closest('[data-pm]');
    if (!b) return;
    const fn = menuActs[Number(b.dataset.pm)];
    closeMenu();
    if (fn) fn();
  }
}
function openExternalPlayer() {
  if (!vod) return;
  const name = (vod.ctx && vod.ctx.name) || vod.show;
  const url = vod.ep.url, title = vod.ep.movie ? name : `${name} – S${vod.ep.season} E${vod.ep.num}`;
  const pos = isFinite(video.currentTime) ? video.currentTime * 1000 : 0;
  saveVodPos();
  if (!bridge.openExternal(url, title, pos)) toast('Kein anderer Player gefunden');
}
$('#pMenu').addEventListener('click', e => { const b = e.target.closest('[data-pm]'); if (!b) return; const fn = menuActs[Number(b.dataset.pm)]; closeMenu(); if (fn) fn(); });

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
  // Suche: ▲▼ innerhalb der Ergebnisse bleibt in den Ergebnissen (Sender ↔ Serien ↔ Filme),
  // statt in die Tastatur links zu springen
  let pool0 = all;
  const res = vert && !sheetOpen && cur.closest('.search-res');
  if (res) {
    const inRes = all.filter(el => res.contains(el));
    const ahead = inRes.some(el => { const r = el.getBoundingClientRect(); return dir === 'ArrowUp' ? r.bottom <= c.top + 2 : r.top >= c.bottom - 2; });
    if (ahead) pool0 = inRes;
  }
  const cands = [];
  for (const el of pool0) {
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
  if (best.closest('.tabbar') && !cur.closest('.tabbar')) best = $('.tabbar button.active') || best;
  if (best.closest('.ep-seasons') && cur.closest('.ep-list')) best = $('#sheet .ep-season.active') || best;
  best.focus({ preventScroll: true });
  if (sheetOpen) {
    // Oberstes Element der Detailansicht → ganz nach oben (Titel, Logo, Beschreibung wieder sichtbar)
    const box = best.closest('.inner');
    if (dir === 'ArrowUp' && box && box.scrollHeight > box.clientHeight) {
      const bt = best.getBoundingClientRect().top;
      if (!all.some(el => el !== best && el.getBoundingClientRect().top < bt - 4)) { box.scrollTo({ top: 0, behavior: scrollMode() }); scrollInRow(best); return; }
    }
    best.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: scrollMode() });
    return;
  }
  // In die Kopfzeile oder in die oberste Zeile der Seite → immer ganz nach oben
  if (best.closest('header')) { pageScrollTo(0); return; }
  if (dir === 'ArrowUp') {
    const bt = best.getBoundingClientRect().top;
    if (!all.some(el => el !== best && !el.closest('header') && el.getBoundingClientRect().top < bt - 4)) { scrollInRow(best); pageScrollTo(0); return; }
  }
  // Unterste Zeile erreicht → ganz nach unten (Fußnoten sichtbar)
  if (dir === 'ArrowDown') {
    const bb = best.getBoundingClientRect().bottom;
    if (!all.some(el => el !== best && !el.closest('header') && el.getBoundingClientRect().bottom > bb + 4)) { scrollInRow(best); pageScrollTo(1e9); return; }
  }
  scrollToFocus(best);
}
/* ---------- Scrollen zum Fokus ----------
   Eigene Berechnung statt scrollIntoView + scrollBy: Zwei gleichzeitige weiche Scrollvorgänge haben sich
   gegenseitig abgebrochen (Seite blieb auf halber Strecke stehen, oben nicht ganz sichtbar). Hier wird immer
   vom Ziel des laufenden Scrollvorgangs aus gerechnet und nur ein einziger Scrollbefehl abgesetzt. */
const scrollMode = () => state.settings.lite ? 'auto' : 'smooth';
function pageScrollTo(y) {
  const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  y = Math.round(Math.max(0, Math.min(max, y)));
  navY = y; navYAt = Date.now();
  if (Math.abs(window.scrollY - y) < 1) return;
  window.scrollTo({ top: y, behavior: scrollMode() });
}
/** Wo die Seite gleich steht (Ziel eines noch laufenden Scrollvorgangs). */
const pageY = () => Date.now() - navYAt < 700 ? navY : window.scrollY;
/** Waagrecht in Reihe/Chips scrollen, mit Rand für Zoom und Schatten. */
function scrollInRow(el) {
  const row = el.closest('.rail, .chips');
  if (!row || row.scrollWidth <= row.clientWidth + 1) return;
  const rr = row.getBoundingClientRect(), er = el.getBoundingClientRect();
  const pad = Math.max(32, rr.width * 0.045);
  const now = row.scrollLeft, base = row._navAt && Date.now() - row._navAt < 700 ? row._navX : now;
  const absL = now + er.left - rr.left, absR = now + er.right - rr.left;
  let x = base;
  if (absL - x < pad) x = absL - pad;
  else if (absR - x > rr.width - pad) x = absR - rr.width + pad;
  x = Math.max(0, Math.min(row.scrollWidth - row.clientWidth, Math.round(x)));
  row._navX = x; row._navAt = Date.now();
  if (Math.abs(x - now) >= 1) row.scrollTo({ left: x, behavior: scrollMode() });
}
function scrollToFocus(el) {
  scrollInRow(el);
  const hb = $('header').getBoundingClientRect().bottom;
  const now = window.scrollY, y0 = pageY();
  // Zeilenüberschrift mit sichtbar halten (nicht unter der Kopfzeile verstecken)
  const sec = el.closest('.rail') ? el.closest('section') : null;
  const top = now + (sec || el).getBoundingClientRect().top, bot = now + el.getBoundingClientRect().bottom;
  const topLim = hb + 16, botLim = window.innerHeight - 28;
  let y = y0;
  if (top - y < topLim) y = top - topLim;
  else if (bot - y > botLim) y = Math.min(bot - botLim, top - topLim);
  if (y !== y0) pageScrollTo(y);
}
/* ---------- Eingabefelder: Tastatur erst nach OK ----------
   Auf dem Fernseher öffnet schon das Fokussieren eines Feldes die Bildschirmtastatur.
   Felder sind deshalb gesperrt (readonly), solange man nur darüber navigiert;
   OK entsperrt das Feld und öffnet die Tastatur, beim Verlassen wird es wieder gesperrt. */
const LOCK_SKIP = new Set(['checkbox', 'radio', 'file', 'range', 'button', 'submit', 'hidden', 'color']);
function lockable(el) {
  return el && el.tagName === 'INPUT' && el.id !== 'q' && !LOCK_SKIP.has((el.type || '').toLowerCase()) && el.dataset.nolock === undefined;
}
function lockField(el) {
  if (!lockable(el)) return;
  el.readOnly = true; el.dataset.locked = '1';
  el.setAttribute('inputmode', 'none');
}
function unlockField(el) {
  if (!el || el.dataset.locked !== '1') return;
  el.readOnly = false; delete el.dataset.locked;
  el.removeAttribute('inputmode');
  el.classList.add('editing');
  // neu fokussieren, damit das System die Tastatur öffnet
  el.blur(); el.focus({ preventScroll: true });
  try { const n = el.value.length; el.setSelectionRange(n, n); } catch (e) {}
}
function lockAll(root) {
  if (!root || !root.querySelectorAll) return;
  if (root.tagName === 'INPUT') lockField(root);
  root.querySelectorAll('input').forEach(lockField);
}
lockAll(document.body);
new MutationObserver(ms => { for (const m of ms) m.addedNodes.forEach(n => n.nodeType === 1 && lockAll(n)); })
  .observe(document.body, { childList: true, subtree: true });
document.addEventListener('focusout', e => {
  const t = e.target;
  if (lockable(t) && t.dataset.locked !== '1') { t.classList.remove('editing'); setTimeout(() => { if (document.activeElement !== t) lockField(t); }, 0); }
}, true);
document.addEventListener('keydown', e => {
  const a = document.activeElement;
  if (playerOpen || !a || a.dataset.locked !== '1') return;
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopImmediatePropagation(); unlockField(a); }
}, true);
document.addEventListener('click', e => { if (e.target && e.target.dataset && e.target.dataset.locked === '1') unlockField(e.target); }, true);

document.addEventListener('keydown', e => {
  if (playerOpen) { playerKey(e); return; }
  const a = document.activeElement;
  const typing = a && ((a.tagName === 'INPUT' && !a.readOnly) || a.tagName === 'TEXTAREA');
  if (sheetOpen && ['Escape', 'Backspace'].includes(e.key) && !typing) { e.preventDefault(); ip ? closeIptv() : closeSheet(); return; }
  if (typing && !['ArrowUp', 'ArrowDown', 'Escape'].includes(e.key)) return;
  if (state.view === 'cats' && ['Escape', 'Backspace'].includes(e.key) && !typing) { e.preventDefault(); closeCats(); return; }
  if (state.view === 'manage' && ['Escape', 'Backspace'].includes(e.key) && !typing) { e.preventDefault(); closeManage(); return; }
  // Reiterleiste: ◀ ▶ wechselt den Reiter sofort, ohne OK
  if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && a && a.closest && a.closest('.tabbar') && !sheetOpen) {
    const tabs = $$('.tabbar [data-view]'), nx = tabs[tabs.indexOf(a) + (e.key === 'ArrowRight' ? 1 : -1)];
    if (nx) { e.preventDefault(); show(nx.dataset.view); return; }
  }
  // Billboard (Top-Empfehlungen): ◀ am ersten / ▶ am letzten Button blättert durch die Titel
  if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && a && a.closest && a.closest('#heroContent') && heroItems.length > 1 && !sheetOpen) {
    const btns = $$('#heroContent .focusable'), i = btns.indexOf(a), right = e.key === 'ArrowRight';
    if (right ? i === btns.length - 1 : i === 0) { e.preventDefault(); if (!e.repeat || Date.now() - heroFlipAt > 350) heroFlip(right ? 1 : -1, a); return; }
  }
  if (WLM.on) {
    e.preventDefault();
    if (e.repeat && e.key === 'Enter') return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') moveStep(e.key === 'ArrowLeft' ? -1 : 1);
    else if (['Enter', ' ', 'Escape', 'Backspace', 'ArrowUp', 'ArrowDown'].includes(e.key)) endMove();
    return;
  }
  if (NAV_KEYS.includes(e.key)) { e.preventDefault(); navigate(e.key); return; }
  if (e.key === 'Enter' && a && a.dataset && (a.dataset.resume || (a.dataset.show && a.closest('.wl-row')))) {
    e.preventDefault();
    if (e.repeat || HOLD.id) return;
    holdStart(a, a.dataset.resume ? 'resume' : 'wl', a.dataset.resume || a.dataset.show);
    return;
  }
  if (e.key === 'Enter' && a && a.classList.contains('tile')) { e.preventDefault(); a.click(); return; }
  if ((e.key === 'f' || e.key === 'ContextMenu') && a && a.dataset.card) { e.preventDefault(); toggleFav(a.dataset.card); }
  if (e.key === 'ContextMenu' && a && a.dataset.resume) { e.preventDefault(); hideResume(a.dataset.resume); }
  if (e.key === 'ContextMenu' && a && a.dataset.ev) { e.preventDefault(); toggleRemind(a.dataset.ev); }
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
  const pl = t.closest('[data-play]');
  if (pl) { const k = pl.dataset.play; openSheet(k).then(() => { if (sheetOpen && !ip) openIptv(k); }); return; }
  const shw = t.closest('[data-show]');
  if (shw) { openSheet(shw.dataset.show); return; }
  const cat = t.closest('[data-cat]');
  if (cat) {
    state.cat = cat.dataset.cat;
    if (state.view !== 'live') show('live');
    renderLive();
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
    if (sa.dataset.srcAct === 'fmt' && s && !s.loading) {
      s.format = s.format === 'ts' ? 'm3u8' : 'ts';
      toast(`Format: ${s.format === 'ts' ? 'MPEG-TS' : 'HLS'} – Kanäle werden neu geladen`);
      refreshSource(s);
    }
    if (sa.dataset.srcAct === 'del') removeSource(sa.dataset.id);
    return;
  }
  const card = t.closest('[data-card]');
  if (card) { openPlayer(card.dataset.card); return; }
  const evt = t.closest('[data-ev]');
  if (evt) { openSportSheet(evt.dataset.ev); return; }
  const spc = t.closest('[data-spc]');
  if (spc) { SPV.cat = spc.dataset.spc; renderSport(); const c = visibleOf(`[data-spc="${CSS.escape(SPV.cat)}"]`); if (c) { c.focus({ preventScroll: true }); c.scrollIntoView({ block: 'nearest', inline: 'center' }); } return; }
  if (t.closest('#spRem')) { const id = $('#spRem').dataset.id; toggleRemind(id); return; }
  if (t.closest('#spClose')) { closeSheet(); return; }
  if (t.closest('#spRetry')) { SP.refresh(true); return; }
  const rs = t.closest('[data-resume]');
  if (rs) { openResumeSheet(rs.dataset.resume); return; }
  const sc = t.closest('[data-scat]');
  if (sc) {
    const k = sc.dataset.kind, S = CAT[k];
    S.cat = sc.dataset.scat; renderCatalog(k, true);
    const c = visibleOf(`[data-scat="${CSS.escape(S.cat)}"][data-kind="${k}"]`);
    if (c) { c.focus({ preventScroll: true }); c.scrollIntoView({ block: 'nearest', inline: 'center' }); }
    return;
  }
  const sr = t.closest('[data-ser]');
  if (sr) { const [k, n] = sr.dataset.ser.split(':'); openCatalogItem(k, Number(n)); return; }
  const sv = t.closest('[data-ser-act]');
  if (sv) { if (sv.dataset.serAct === 'retry') loadCatalog(sv.dataset.kind || 'series', true); return; }
  if (t.closest('#manageOpen')) { openManage(); return; }
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
let searchT = null;
$('#q').addEventListener('input', () => { if ($('#q').value.trim() !== aiQuery) { aiSeq++; aiQuery = ''; $('#searchAi').innerHTML = ''; } clearTimeout(searchT); searchT = setTimeout(renderSearch, 180); searchShows(); });

/* ---------- Smarte Suche mit Claude (Supabase-Funktion smart-search) + Sprache ---------- */
let aiQuery = '', aiSeq = 0;
function startVoice() {
  if (!bridge || typeof bridge.listen !== 'function') return toast('Spracheingabe nur in der TV-App');
  if (!bridge.listen()) toast('Keine Spracherkennung auf diesem Gerät gefunden');
}
// Aufruf durch die App mit dem erkannten Text
window.onVoice = text => {
  text = String(text || '').trim();
  if (!text) return;
  if (state.view !== 'search') show('search');
  const q = $('#q'); q.value = text.slice(0, 80); q.dispatchEvent(new Event('input'));
  aiSearch(text);
};
function aiContext() {
  const wl = (WL.s.items || []).slice(0, 25).map(o => `${o.title} (${o.status})`);
  const seen = VP.continueList(8).map(v => v.m.show);
  return [wl.length ? 'Watchlist: ' + wl.join(', ') : '', seen.length ? 'Zuletzt: ' + seen.join(', ') : ''].filter(Boolean).join(' | ');
}
/** Bester Treffer im Anbieter-Katalog für einen Titel (Original- oder deutscher Titel). */
function aiCatalogHit(it) {
  const kind = it.type === 'movie' ? 'vod' : 'series';
  for (const t of [it.title_de, it.title].filter(Boolean)) {
    const hits = catalogHits(kind, XS.norm(t));
    if (!hits.length) continue;
    const items = CAT[kind].items, want = XS.norm(t);
    // exakter Name zuerst, sonst passendes Jahr, sonst erster Treffer
    const exact = hits.find(i => items[i].it.n === want);
    const year = it.year && hits.find(i => String(items[i].it.year || '').startsWith(String(it.year)));
    return { kind, i: exact != null ? exact : year != null && year !== false ? year : hits[0] };
  }
  return null;
}
async function aiSearch(text) {
  if (!text) return toast('Erst etwas eintippen oder 🎤 drücken');
  if (!WL.connected) return toast('Claude-Suche braucht das Watchlist-Konto (Einstellungen)');
  const seq = ++aiSeq; aiQuery = text;
  const box = $('#searchAi');
  box.innerHTML = railHTML('✨ Claude denkt nach …', skeletons(5));
  try {
    if (!await WL.ensureToken()) throw new Error('Watchlist: bitte neu anmelden');
    const r = await WL.http('POST', '/functions/v1/smart-search', { q: text, context: aiContext() });
    const j = JSON.parse(r.text || '{}');
    if (r.status < 200 || r.status > 299) throw new Error(j.error || ('Fehler ' + r.status));
    if (seq !== aiSeq) return;
    const xt = XS.accounts().length > 0;
    let html = '';
    // Live-Sender
    const chans = [];
    for (const name of j.channels || []) {
      const n = name.toLowerCase();
      visibleChannels().filter(c => c.name.toLowerCase().includes(n)).slice(0, 4).forEach(c => { if (!chans.includes(c)) chans.push(c); });
    }
    if (chans.length) html += railHTML('Sender', chans.slice(0, 12).map(tileHTML).join(''), chans.length);
    // Serien & Filme
    if (xt) {
      const seen = new Set(), tiles = [];
      for (const it of j.items || []) {
        const h = aiCatalogHit(it);
        if (!h || seen.has(h.kind + h.i)) continue;
        seen.add(h.kind + h.i);
        tiles.push(serTileHTML(h.kind, CAT[h.kind].items[h.i], h.i));
      }
      if (tiles.length) html += railHTML('Bei deinem Anbieter', tiles.join(''), tiles.length);
    } else if (TM.key()) {
      const res = await Promise.all((j.items || []).slice(0, 10).map(it => TM.search(it.title_de || it.title).then(l => l.find(p => p.type === it.type) || l[0]).catch(() => null)));
      const tiles = res.filter(Boolean).map(p => showTileHTML(p));
      if (tiles.length) html += railHTML('Serien & Filme', tiles.join(''), tiles.length);
    }
    if (seq !== aiSeq) return;
    const head = `<p class="ai-answer">✨ ${esc(j.answer || 'Vorschläge von Claude')}</p>`;
    keepFocus(() => { box.innerHTML = head + (html || `<p class="empty">Nichts davon gibt es bei deinem Anbieter.</p>`); });
    const first = box.querySelector('.tile.focusable');
    if (first && document.activeElement && document.activeElement.dataset.key === 'ai') first.focus({ preventScroll: true });
  } catch (e) {
    if (seq === aiSeq) box.innerHTML = `<p class="empty">Claude-Suche: ${esc(e.message)}</p>`;
  }
}

/* ---------- Bildschirmtastatur (wie bei Netflix) ---------- */
const KBD_KEYS = 'abcdefghijklmnopqrstuvwxyzäöüß1234567890'.split('');
function renderKbd() {
  $('#kbd').innerHTML =
    `<button class="key wide ai focusable" data-key="voice" type="button" aria-label="Sprechen">🎤 Sprechen</button>` +
    `<button class="key wide ai focusable" data-key="ai" type="button" aria-label="Mit Claude suchen">✨ Claude</button>` +
    `<button class="key wide focusable" data-key=" " type="button" aria-label="Leerzeichen">␣ Leer</button>` +
    `<button class="key wide focusable" data-key="⌫" type="button" aria-label="Löschen">⌫</button>` +
    KBD_KEYS.map(k => `<button class="key focusable" data-key="${k}" type="button">${k}</button>`).join('') +
    `<button class="key full focusable" data-key="clear" type="button">Leeren</button>`;
}
function kbdInput(k) {
  if (k === 'voice') return startVoice();
  if (k === 'ai') return aiSearch($('#q').value.trim());
  const q = $('#q');
  let v = q.value;
  if (k === '⌫') v = v.slice(0, -1);
  else if (k === 'clear') v = '';
  else if (k === ' ') { if (v && !v.endsWith(' ')) v += ' '; }
  else if (v.length < 40) v += k;
  if (v === q.value) return;
  q.value = v;
  q.dispatchEvent(new Event('input'));
}
renderKbd();
$('#kbd').addEventListener('click', e => { const b = e.target.closest('[data-key]'); if (b) kbdInput(b.dataset.key); });
// Hardware-Tastatur (Bluetooth / PC) tippt ebenfalls in die Suche
document.addEventListener('keydown', e => {
  if (state.view !== 'search' || playerOpen || sheetOpen || e.ctrlKey || e.altKey || e.metaKey) return;
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && !a.readOnly) return;
  if (e.key.length === 1 && /[\p{L}\p{N} .\-']/u.test(e.key)) { e.preventDefault(); kbdInput(e.key === ' ' ? ' ' : e.key.toLowerCase()); }
  else if (e.key === 'Backspace' && $('#q').value) { e.preventDefault(); kbdInput('⌫'); }
});
$('#mq').addEventListener('input', renderManage);
$('#vpnBadge').addEventListener('click', () => { if (bridge) bridge.openVpn(); });

async function wlLogin() {
  const mail = $('#wlMail').value.trim(), pass = $('#wlPass').value;
  if (!mail || !pass) return toast('E-Mail und Passwort eingeben');
  const b = $('#wlLogin'); b.disabled = true; b.textContent = 'Anmelden …';
  try {
    await WL.login(mail, pass);
    SYNC.run(true);
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
$('#swLite').addEventListener('click', () => { toggleSetting('lite'); applyLite(); });
$('#swNative').addEventListener('click', () => { state.settings.nativeVod = state.settings.nativeVod === false; persist(); renderSettings(); });
$('#swNativeLive').addEventListener('click', () => { state.settings.nativeLive = state.settings.nativeLive === false; persist(); renderSettings(); });
$('#bufSeg').addEventListener('click', e => { const b = e.target.closest('[data-buf]'); if (!b) return; state.settings.liveBuf = Number(b.dataset.buf); persist(); renderSettings(); });
// „Quelle hinzufügen“ nur bei Bedarf aufklappen – spart Scrollen über die Eingabefelder
var addSrcOpen = false;
$('#addSrcToggle').addEventListener('click', () => {
  addSrcOpen = !addSrcOpen; renderSettings();
  if (addSrcOpen) $('#typeM3u').focus({ preventScroll: false });
});
$$('#saverSeg [data-saver]').forEach(b => b.addEventListener('click', () => { state.settings.saver = Number(b.dataset.saver); persist(); renderSettings(); b.focus({ preventScroll: true }); }));
$('#saverNow').addEventListener('click', () => openSaver());
$$('#themeSeg [data-theme]').forEach(b => b.addEventListener('click', () => { state.settings.theme = b.dataset.theme; persist(); applyTheme(); b.focus({ preventScroll: true }); }));
$('#swVpnAuto').addEventListener('click', () => toggleSetting('vpnAuto'));
$('#swVpnReq').addEventListener('click', () => toggleSetting('vpnReq'));
$('#vpnOpen').addEventListener('click', () => {
  if (!bridge) return toast('Nur in der TV-App verfügbar');
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
  resetCatalogs(); refresh(); renderRecs(); renderHero(); toast('Zurückgesetzt');
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
    $('#vpnFoot').textContent = !bridge ? 'Nur in der TV-App verfügbar.' : 'ProtonVPN ist auf diesem Gerät nicht installiert.';
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
window.onAppResume = () => {
  // Berechtigung „Unbekannte Apps“ gerade erteilt → Update direkt fortsetzen
  if (UPD.inst && UPD.inst.st === 'perm' && bridge && bridge.canInstall && bridge.canInstall()) setTimeout(installUpdate, 400);
  if (UPD.inst && UPD.inst.st === 'confirm') { UPD.inst = null; renderUpdate(); }
  SYNC.run(false); renderVpn(); setTimeout(renderVpn, 2500); if (playerOpen && (RC.waiting || RC.dead)) retryNow();
  if (!playerOpen) setTimeout(() => checkUpdate(false), 1500); };

/* ================= Update-Hinweis (GitHub-Releases) ================= */
const UPD = {
  STORE: 'streamtv.update', EVERY: 30 * 60 * 1000,
  API: 'https://api.github.com/repos/Oventa-cmd/StreamTV/releases/latest',
  APK: 'https://github.com/Oventa-cmd/StreamTV/releases/latest/download/StreamTV.apk',
  s: null, busy: false,
  get() { if (!this.s) { try { this.s = JSON.parse(localStorage.getItem(this.STORE) || '{}'); } catch (e) { this.s = {}; } } return this.s; },
  save() { try { localStorage.setItem(this.STORE, JSON.stringify(this.s)); } catch (e) {} }
};
/** Laufnummer aus „v1.0.42“ bzw. „1.0.42“. */
const runOf = v => { const m = String(v || '').match(/(\d+)\.(\d+)\.(\d+)/); return m ? Number(m[3]) : 0; };
function appVersion() { try { return bridge ? String(bridge.appVersion() || '') : ''; } catch (e) { return ''; } }
function updateAvailable() {
  const u = UPD.get(), cur = runOf(appVersion());
  return !!(cur && u.latest && runOf(u.latest) > cur);
}
async function checkUpdate(manual) {
  const u = UPD.get();
  if (UPD.busy) return;
  if (!bridge && !manual) return;   // nur in der Fire-TV-App
  if (!manual && u.at && Date.now() - u.at < UPD.EVERY) return;
  UPD.busy = true; renderUpdate();
  try {
    const r = await request('GET', UPD.API, { headers: { Accept: 'application/vnd.github+json' }, timeout: 15000 });
    if (r.status !== 200) throw new Error(r.status === 403 ? 'GitHub-Limit erreicht – später erneut versuchen' : 'GitHub antwortet nicht (' + r.status + ')');
    const j = JSON.parse(r.text);
    Object.assign(u, { at: Date.now(), latest: j.tag_name || '', date: j.published_at || '', name: j.name || '', err: '' });
    UPD.save();
    if (updateAvailable()) {
      if (!manual && bridge && typeof bridge.installUpdate === 'function') updPrompt(u.latest.replace(/^v/, ''));
      else toast(`Update verfügbar: Version ${u.latest.replace(/^v/, '')} – unter „Einstellungen → App-Update“ installieren`);
    }
    else if (manual) toast(appVersion() ? 'StreamTV ist aktuell' : 'Neueste Version: ' + (u.latest || '–'));
  } catch (e) {
    u.at = Date.now(); u.err = e.message; UPD.save();
    if (manual) toast('Update-Prüfung fehlgeschlagen: ' + e.message);
  } finally { UPD.busy = false; renderUpdate(); }
}
function renderUpdate() {
  const box = $('#updGroup');
  if (!box) return;
  const u = UPD.get(), cur = appVersion(), avail = updateAvailable();
  const when = u.at ? new Date(u.at).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : 'noch nie';
  const latest = u.latest ? u.latest.replace(/^v/, '') : '';
  let html = `<div class="row-item"><div class="meta">
      <b>${avail ? `Update verfügbar: Version ${esc(latest)}` : cur && latest ? 'StreamTV ist aktuell' : 'Installierte Version'}</b>
      <small>Installiert: ${esc(cur || '– (nur in der TV-App)')}${latest ? ' · Neueste: ' + esc(latest) : ''} · geprüft: ${esc(when)}</small>
      ${u.err ? `<small class="err">${esc(u.err)}</small>` : ''}
    </div><div class="actions"><button class="mini focusable" id="updCheck" ${UPD.busy ? 'disabled' : ''}>${UPD.busy ? 'Prüfe …' : 'Jetzt prüfen'}</button></div></div>`;
  const inApp = !!(bridge && typeof bridge.installUpdate === 'function');
  if (avail && inApp) {
    const I = UPD.inst || {};
    const label = I.st === 'progress' ? (I.pct >= 0 ? `Lade … ${I.pct} %` : 'Lade …')
      : I.st === 'confirm' ? 'Bitte am Fernseher bestätigen …' : 'Jetzt herunterladen & installieren';
    const busy = I.st === 'progress';
    html += `<div class="row-item"><div class="meta"><b>Direkt hier aktualisieren</b>
        <small>${I.st === 'error' ? `<span class="err">${esc(I.msg)}</span>` : I.st === 'perm' ? 'Einmalig erlauben: In den Einstellungen „StreamTV“ das Installieren unbekannter Apps zulassen, dann zurück und erneut drücken.' : 'Lädt die neue Version von GitHub und installiert sie. StreamTV schließt sich dabei kurz – danach einfach wieder öffnen. Einstellungen und Daten bleiben erhalten.'}</small>
        ${busy && I.pct >= 0 ? `<span class="ip-pbar upd-bar"><i style="width:${I.pct}%"></i></span>` : ''}
      </div><div class="actions"><button class="mini primary focusable" id="updInstall" ${busy ? 'disabled' : ''}>${label}</button></div></div>`;
  }
  if (avail) html += `<div class="row-item upd-cmd"><div class="meta"><b>${inApp ? 'Alternativ am PC (ADB)' : 'Am PC aktualisieren (ADB)'}</b>
      <code>curl.exe -L -o StreamTV.apk ${esc(UPD.APK)}\nadb connect &lt;IP-des-Fernsehers&gt;:&lt;Port&gt;\nadb install -r StreamTV.apk</code></div></div>`;
  const hadFocus = document.activeElement && document.activeElement.id;
  box.innerHTML = html;
  if (hadFocus && box.querySelector('#' + hadFocus)) box.querySelector('#' + hadFocus).focus({ preventScroll: true });
  $('#updFoot').textContent = avail ? 'Die IP steht unter Einstellungen → Netzwerk (Fire TV: Mein Fire TV → Info → Netzwerk). Einstellungen und Daten bleiben beim Update erhalten.' : '';
  $$('.tabbar [data-view="settings"]').forEach(b => b.classList.toggle('badge', avail));
}
document.addEventListener('click', e => {
  if (e.target.closest('#updCheck')) checkUpdate(true);
  if (e.target.closest('#updInstall')) installUpdate();
});
/** Update direkt in der App laden und installieren (Android-Seite: Updater.kt). */
function installUpdate() {
  if (!bridge || typeof bridge.installUpdate !== 'function') return;
  if (UPD.inst && UPD.inst.st === 'progress') return;
  if (!bridge.canInstall()) {
    UPD.inst = { st: 'perm' }; renderUpdate();
    toast('Bitte „Unbekannte Apps installieren“ für StreamTV erlauben');
    setTimeout(() => bridge.openInstallPermission(), 700);
    return;
  }
  UPD.inst = { st: 'progress', pct: 0 };
  if (!bridge.installUpdate(UPD.APK)) UPD.inst = { st: 'error', msg: 'Download läuft bereits' };
  renderUpdate();
}
/** Hinweis beim Start: Update direkt anbieten (zur Update-Kachel springen, OK installiert). */
function updPrompt(ver) {
  const u = UPD.get();
  if (u.prompted === ver || playerOpen) { toast(`Update ${ver} verfügbar – Einstellungen → App-Update`); return; }
  u.prompted = ver; UPD.save();
  toast(`Update ${ver} verfügbar – OK auf „Jetzt installieren“ drücken`);
  show('settings');
  setTimeout(() => { const b = $('#updInstall'); if (b) { b.focus({ preventScroll: true }); b.scrollIntoView({ block: 'center' }); } }, 300);
}
// Rückmeldungen der App: progress <%> · confirm · done · error <Text>
window.onUpdState = (st, info) => {
  if (st === 'progress') { const pct = Number(info); if (UPD.inst && UPD.inst.st === 'progress' && UPD.inst.pct === pct) return; UPD.inst = { st, pct }; }
  else if (st === 'error') { UPD.inst = { st, msg: info || 'Fehler' }; toast('Update: ' + (info || 'Fehler')); }
  else if (st === 'done') { UPD.inst = null; toast('Update installiert'); }
  else UPD.inst = { st };
  if (state.view === 'settings') renderUpdate();
};

/* ================= Design: Kopfzeile, Tab-Pill, Übergänge ================= */
function updateHeader() {
  $('header').classList.toggle('scrolled', state.view !== 'home' || window.scrollY > 40);
}
function moveTabInd() {
  const ind = $('.tab-ind'), b = $('.tabbar button.active');
  if (!ind) return;
  if (!b) { ind.style.opacity = '0'; return; }
  ind.style.opacity = '1';
  ind.style.width = b.offsetWidth + 'px';
  ind.style.transform = `translateX(${b.offsetLeft}px)`;
}
let sheetAnimT = null;
function sheetAnim() {
  const s = $('#sheet');
  s.classList.remove('anim'); void s.offsetWidth; s.classList.add('anim');
  clearTimeout(sheetAnimT);
  sheetAnimT = setTimeout(() => s.classList.remove('anim'), 1100);
}
function applyLite() { document.body.classList.toggle('lite', !!state.settings.lite); }
function applyTheme() {
  const t = state.settings.theme || 'graphite';
  document.documentElement.dataset.theme = t;
  $$('#themeSeg [data-theme]').forEach(b => b.classList.toggle('sel', b.dataset.theme === t));
}
window.addEventListener('scroll', updateHeader, { passive: true });
window.addEventListener('resize', moveTabInd);
if (document.fonts && document.fonts.ready) document.fonts.ready.then(moveTabInd);
// Bilder weich einblenden, sobald sie geladen sind
document.addEventListener('load', e => { const t = e.target; if (t && t.tagName === 'IMG') t.classList.add('ok'); }, true);
document.documentElement.classList.add('fx');

/* ================= Uhr ================= */
function tick() { $('#clock').textContent = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }); }

/* ================= Start ================= */
load();
applyLite();
applyTheme();
SP.load();
SP.onUpdate(() => { if (state.view === 'sport') renderSport(); if (sheetOpen && spSheet) renderSportSheet(); });
EPG.load();
EPG.onUpdate(epgPatch);
document.addEventListener('scroll', () => { EPG.scan(); if (state.view === 'series') catalogMore('series'); if (state.view === 'movies') catalogMore('vod'); }, true);
setInterval(() => {   // laufende Sendung aktuell halten
  const ids = new Set($$('.tile[data-card]').map(t => t.dataset.card));
  ids.forEach(epgPatch);
  if (playerOpen && !vod) { renderOsdEpg(); EPG.want(byId(currentId)); }
  EPG.scan();
}, 60000);
WL.load();
TM.load();
persist();
setTimeout(() => SYNC.run(true).finally(() => setTimeout(backfillWatched, 2000)), 3000);   // Cloud-Sync + fehlende Watchlist-Einträge
renderAll();
show('home');
tick(); setInterval(tick, 15000);
setInterval(renderVpn, 15000);
try { if (bridge) $('#appVersion').textContent = 'Version ' + bridge.appVersion(); } catch (e) {}
vpnOnStart();
setTimeout(() => checkUpdate(false), 5000);   // Start nicht blockieren
setTimeout(() => SP.refresh(false), 8000);
VP.share();    // Sportdaten im Hintergrund (für Erinnerungen)
setInterval(checkReminders, 15000);
setTimeout(checkReminders, 3000);
setupHero();
loadDiscover(false);
setTimeout(bgCatalogs, 2500);   // Kataloge für „nur verfügbare“ Empfehlungen
if (state.settings.autoRefresh) {
  const stale = state.sources.filter(s => !s.updated || Date.now() - s.updated > 6 * 3600 * 1000);
  (async () => { for (const s of stale) await refreshSource(s, true); })();
}

/* ================= Zugangsdaten vom Laptop (per ADB übertragen) ================= */
/* ---------- Umzug auf ein anderes Gerät (Sicherung per adb) ----------
 * Export: adb shell am start -n de.oventa.streamtv/.MainActivity --es backup export
 *   -> /sdcard/Android/data/de.oventa.streamtv/files/streamtv-backup.json
 * Import: Datei an dieselbe Stelle kopieren, dann --es backup import
 * Enthält Quellen, Kanäle, Favoriten, Einstellungen, Weiterschauen-Fortschritt,
 * Intro-Marken, Tonspur-Wahl, Erinnerungen und das Watchlist-Konto. Caches nicht. */
const BACKUP_SKIP = ['streamtv.epg', 'streamtv.tmdb', 'streamtv.sport', 'streamtv.update'];
function exportBackup() {
  const data = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith('streamtv.') && !BACKUP_SKIP.includes(k)) data[k] = localStorage.getItem(k);
  }
  let ok = false;
  try { ok = !!(bridge && bridge.writeBackup(JSON.stringify({ app: 'StreamTV', v: 1, at: Date.now(), data }))); } catch (e) {}
  const n = Object.keys(JSON.parse(data['streamtv.vodpos'] || '{}')).length;
  toast(ok ? `Sicherung erstellt · ${n} Folgen/Filme mit Fortschritt` : 'Sicherung fehlgeschlagen');
  return ok;
}
function importBackup(text) {
  let b = null;
  try { b = JSON.parse(text); } catch (e) {}
  if (!b || b.app !== 'StreamTV' || !b.data) { toast('Keine gültige StreamTV-Sicherung gefunden'); return false; }
  for (const [k, v] of Object.entries(b.data)) {
    if (typeof v !== 'string' || !k.startsWith('streamtv.')) continue;
    if (k === VP.STORE) {
      // Fortschritt zusammenführen: pro Titel gewinnt der neuere Stand
      let cur = {}, inc = {};
      try { cur = JSON.parse(localStorage.getItem(k) || '{}'); inc = JSON.parse(v); } catch (e) {}
      for (const id in inc) if (!cur[id] || (inc[id].at || 0) > (cur[id].at || 0)) cur[id] = inc[id];
      localStorage.setItem(k, JSON.stringify(cur));
    } else {
      localStorage.setItem(k, v);
    }
  }
  toast('Daten übernommen – StreamTV startet neu …');
  setTimeout(() => location.reload(), 500);
  return true;
}
window.exportBackup = exportBackup;
window.importBackup = importBackup;

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
  if (cfg.WATCHLIST_EMAIL && cfg.WATCHLIST_PASSWORT && (!WL.connected || (WL.s.email || '').toLowerCase() !== cfg.WATCHLIST_EMAIL.trim().toLowerCase())) {
    try { await WL.login(cfg.WATCHLIST_EMAIL, cfg.WATCHLIST_PASSWORT); TM.clear(); loadDiscover(true); SYNC.run(true); done.push('Watchlist angemeldet'); }
    catch (e) { done.push('Watchlist: ' + e.message); }
  }
  if (cfg.TMDB_KEY) { state.settings.tmdbKey = cfg.TMDB_KEY; persist(); TM.clear(); loadDiscover(true); done.push('TMDB-Schlüssel gespeichert'); }
  renderSettings();
  toast(done.length ? done.join(' · ') : 'Keine Zugangsdaten in zugang.txt gefunden');
  return done;
}
