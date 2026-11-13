/* =====================================================================
   StreamTV – PIN-Tresor (optional, Einstellungen → Datenschutz)
   Ist er an, liegen ALLE StreamTV-Daten auf dem Gerät nur verschlüsselt vor
   (IPTV-Zugang, Kanallisten mit Stream-Adressen, Watchlist-Sitzung, Fortschritt …):
   gzip + AES-GCM 256, Schlüssel aus der PIN per PBKDF2-SHA256 (600.000 Runden).
   Entsperrt liegen die Daten nur im Sitzungsspeicher (weg, sobald App/Tab geschlossen wird);
   nach 15 Min. im Hintergrund sperrt StreamTV wieder.
   Muss als ERSTES Skript laden: ersetzt localStorage für alle anderen Skripte.
   ===================================================================== */
const VAULT = (() => {
  const LS = window.localStorage, SS = window.sessionStorage;
  const META = 'streamtv.vault', P = 'stv~', KEY = 'stv~#key', HID = 'stv~#hidden';
  const LOCK_MIN = 15, ITER = 600000, MIN_PIN = 4;
  const te = new TextEncoder(), td = new TextDecoder();
  const supported = !!(window.crypto && crypto.subtle && window.CompressionStream && window.DecompressionStream);

  let meta = null;
  try { meta = JSON.parse(LS.getItem(META) || 'null'); } catch (e) {}
  const on = !!(meta && meta.data);
  const unlocked = on && SS.getItem(KEY) != null;

  /* ---------- Krypto ---------- */
  const b64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = s => { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
  async function gz(u8, T) { return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new T('gzip'))).arrayBuffer()); }
  async function derive(pin, salt, iter) {
    const base = await crypto.subtle.importKey('raw', te.encode(pin), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  }
  async function seal(obj, key, salt, iter) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const z = await gz(te.encode(JSON.stringify(obj)), CompressionStream);
    const c = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, z));
    return { v: 1, iter, salt: b64(salt), iv: b64(iv), data: b64(c), at: Date.now() };
  }
  async function unseal(m, key) {
    const z = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(m.iv) }, key, unb64(m.data)));
    return JSON.parse(td.decode(await gz(z, DecompressionStream)));
  }
  const rawKey = async k => b64(new Uint8Array(await crypto.subtle.exportKey('raw', k)));
  const sessionKey = () => crypto.subtle.importKey('raw', unb64(SS.getItem(KEY)), 'AES-GCM', true, ['encrypt', 'decrypt']);

  /* ---------- Speicher-Ersatz (Daten im Sitzungsspeicher, verschlüsselte Kopie im Gerätespeicher) ---------- */
  const names = () => { const out = []; for (let i = 0; i < SS.length; i++) { const k = SS.key(i); if (k && k.startsWith(P) && k[P.length] !== '#') out.push(k.slice(P.length)); } return out; };
  const entries = () => { const o = {}; for (const k of names()) o[k] = SS.getItem(P + k); return o; };
  let timer = null, chain = Promise.resolve();
  function dirty() { clearTimeout(timer); timer = setTimeout(flush, 700); }
  function flush() {
    clearTimeout(timer);
    if (!unlocked) return chain;
    chain = chain.then(async () => {
      try {
        const key = await sessionKey();
        LS.setItem(META, JSON.stringify(await seal(entries(), key, unb64(meta.salt), meta.iter)));
      } catch (e) { console.warn('Tresor: Speichern fehlgeschlagen', e && e.message); }
    });
    return chain;
  }
  function shim(open) {
    return {
      __vault: true,
      get length() { return open ? names().length : 0; },
      key(i) { return open ? (names()[i] ?? null) : null; },
      getItem(k) { return open ? SS.getItem(P + k) : null; },
      setItem(k, v) { if (!open) return; SS.setItem(P + k, String(v)); dirty(); },
      removeItem(k) { if (!open) return; SS.removeItem(P + k); dirty(); },
      clear() { if (!open) return; names().forEach(k => SS.removeItem(P + k)); dirty(); }
    };
  }
  let broken = false;
  if (on) {
    const S = shim(unlocked);
    try { Object.defineProperty(window, 'localStorage', { configurable: true, get: () => S }); } catch (e) {}
    broken = window.localStorage !== S;
  }

  /* ---------- Aktionen ---------- */
  const wipeSession = () => { for (let i = SS.length - 1; i >= 0; i--) { const k = SS.key(i); if (k && k.startsWith(P)) SS.removeItem(k); } };
  async function enable(pin) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await derive(pin, salt, ITER);
    const data = {};
    for (let i = 0; i < LS.length; i++) { const k = LS.key(i); if (k && k !== META) data[k] = LS.getItem(k); }
    const m = await seal(data, key, salt, ITER);
    const back = await unseal(m, key);   // Probe: lässt sich alles wieder öffnen?
    if (JSON.stringify(back) !== JSON.stringify(data)) throw new Error('Probe fehlgeschlagen');
    wipeSession();
    for (const k in data) SS.setItem(P + k, data[k]);
    SS.setItem(KEY, await rawKey(key));
    try { LS.setItem(META, JSON.stringify(m)); }
    catch (e) {   // Speicher voll: Klartext zuerst entfernen
      for (const k in data) LS.removeItem(k);
      try { LS.setItem(META, JSON.stringify(m)); }
      catch (e2) { for (const k in data) LS.setItem(k, data[k]); wipeSession(); throw new Error('Speicher voll'); }
    }
    for (const k in data) LS.removeItem(k);
    location.reload();
  }
  async function check(pin) {
    const key = await derive(pin, unb64(meta.salt), meta.iter);
    return { key, data: await unseal(meta, key) };   // wirft bei falscher PIN
  }
  async function unlock(pin) {
    const { key, data } = await check(pin);
    wipeSession();
    for (const k in data) SS.setItem(P + k, data[k]);
    SS.setItem(KEY, await rawKey(key));
    location.reload();
  }
  async function disable(pin) {
    await check(pin);
    await flush();
    const data = entries();
    LS.removeItem(META);
    try { for (const k in data) LS.setItem(k, data[k]); }
    catch (e) { LS.setItem(META, JSON.stringify(meta)); throw new Error('Speicher voll'); }
    wipeSession();
    location.reload();
  }
  async function changePin(oldPin, pin) {
    await check(oldPin);
    await flush();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await derive(pin, salt, ITER);
    const m = await seal(entries(), key, salt, ITER);
    LS.setItem(META, JSON.stringify(m));
    meta = m;
    SS.setItem(KEY, await rawKey(key));
  }
  async function lock() {
    await flush();
    wipeSession();
    location.reload();
  }
  function reset() {
    LS.removeItem(META);
    wipeSession();
    location.reload();
  }

  // Automatisch sperren nach LOCK_MIN Minuten im Hintergrund; beim Verlassen sofort sichern
  if (unlocked) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') { SS.setItem(HID, String(Date.now())); flush(); return; }
      const t = Number(SS.getItem(HID) || 0);
      SS.removeItem(HID);
      if (t && Date.now() - t > LOCK_MIN * 60000) lock();
    });
    addEventListener('pagehide', () => flush());
  }

  /* ---------- Oberfläche ---------- */
  const css = `
#vault{position:fixed;inset:0;z-index:9999;display:grid;place-items:center;background:rgba(0,0,0,.86);
  -webkit-backdrop-filter:blur(30px);backdrop-filter:blur(30px);font-family:Inter,system-ui,sans-serif;color:#f5f5f7}
#vault .vbox{width:min(26rem,90vw);display:flex;flex-direction:column;gap:.9rem;text-align:center}
#vault .vic{width:3.4rem;height:3.4rem;margin:0 auto .3rem;border-radius:1rem;display:grid;place-items:center;font-size:1.5rem;
  background:linear-gradient(145deg,#ff375f,#ff453a 50%,#ff9f0a)}
#vault h2{font-size:1.5rem;letter-spacing:-.02em}
#vault p{color:rgba(235,235,245,.64);font-size:.92rem;line-height:1.45}
#vault input{width:100%;padding:.9rem 1rem;border-radius:.8rem;border:1px solid rgba(255,255,255,.15);background:rgba(255,255,255,.08);
  color:#fff;font-size:max(16px,1.2rem);text-align:center;letter-spacing:.3em;outline:none}
#vault input:focus,#vault button:focus{outline:3px solid #fff;outline-offset:2px}
#vault button{padding:.8rem 1rem;border-radius:999px;border:0;font:inherit;font-weight:700;cursor:pointer;background:rgba(255,255,255,.12);color:#fff}
#vault button.pri{background:#fff;color:#000}
#vault button.link{background:none;color:rgba(235,235,245,.6);font-weight:500;font-size:.85rem}
#vault .err{color:#ff453a;min-height:1.2em;font-size:.88rem}
#vault .hidden{display:none}`;
  let box = null, busy = false, fails = 0;
  function close() { if (box) { box.remove(); box = null; } }
  /** Dialog: mode = unlock | set | change | off */
  function dialog(mode) {
    close();
    if (!document.getElementById('vaultCss')) document.head.insertAdjacentHTML('beforeend', `<style id="vaultCss">${css}</style>`);
    const T = {
      unlock: ['StreamTV ist gesperrt', 'PIN eingeben, um deine Daten zu entschlüsseln.', 'Entsperren'],
      set: ['PIN-Schutz einschalten', `Mindestens ${MIN_PIN} Zeichen. Längere PIN = sicherer. Ohne PIN kommst du nicht mehr an die Daten auf diesem Gerät.`, 'Verschlüsseln'],
      change: ['PIN ändern', 'Erst die aktuelle, dann zweimal die neue PIN.', 'PIN ändern'],
      off: ['PIN-Schutz ausschalten', 'Daten werden wieder unverschlüsselt auf diesem Gerät gespeichert.', 'Ausschalten']
    }[mode];
    const needOld = mode === 'change' || mode === 'off' || mode === 'unlock';
    const needNew = mode === 'set' || mode === 'change';
    document.body.insertAdjacentHTML('beforeend', `<div id="vault"><div class="vbox">
      <div class="vic">🔒</div><h2>${T[0]}</h2><p>${T[1]}</p>
      <input id="vOld" data-nolock class="${needOld ? '' : 'hidden'}" type="password" inputmode="numeric" autocomplete="off" placeholder="${mode === 'unlock' ? 'PIN' : 'Aktuelle PIN'}" />
      <input id="vNew" data-nolock class="${needNew ? '' : 'hidden'}" type="password" inputmode="numeric" autocomplete="new-password" placeholder="Neue PIN" />
      <input id="vNew2" data-nolock class="${needNew ? '' : 'hidden'}" type="password" inputmode="numeric" autocomplete="new-password" placeholder="Neue PIN wiederholen" />
      <div class="err" id="vErr"></div>
      <button class="pri" id="vGo" type="button">${T[2]}</button>
      ${mode === 'unlock' ? '<button class="link" id="vReset" type="button">PIN vergessen? Gerät zurücksetzen</button>' : '<button id="vCancel" type="button">Abbrechen</button>'}
    </div></div>`);
    box = document.getElementById('vault');
    const $v = id => document.getElementById(id), err = t => { $v('vErr').textContent = t; };
    const go = async () => {
      if (busy) return;
      const old = $v('vOld').value, n1 = $v('vNew').value, n2 = $v('vNew2').value;
      if (needOld && !old) return err('PIN eingeben');
      if (needNew && n1.length < MIN_PIN) return err(`Neue PIN: mindestens ${MIN_PIN} Zeichen`);
      if (needNew && n1 !== n2) return err('Die neuen PINs stimmen nicht überein');
      busy = true; err(''); $v('vGo').textContent = 'Einen Moment …';
      try {
        if (mode === 'unlock') await unlock(old);
        else if (mode === 'set') await enable(n1);
        else if (mode === 'change') { await changePin(old, n1); close(); window.toast && toast('PIN geändert'); }
        else if (mode === 'off') await disable(old);
      } catch (e) {
        const wrong = e && (e.name === 'OperationError' || /decrypt/i.test(e.message || ''));
        if (wrong) { fails++; await new Promise(r => setTimeout(r, Math.min(30000, 1000 * 2 ** (fails - 1)))); }
        err(wrong ? 'Falsche PIN' : 'Fehler: ' + ((e && e.message) || e));
        $v('vGo').textContent = T[2];
        (needOld ? $v('vOld') : $v('vNew')).select();
      } finally { busy = false; }
    };
    $v('vGo').onclick = go;
    if ($v('vCancel')) $v('vCancel').onclick = close;
    if ($v('vReset')) $v('vReset').onclick = () => {
      if (confirm('Alle StreamTV-Daten auf diesem Gerät löschen? Fortschritt und Favoriten kommen nach dem Watchlist-Login aus der Cloud zurück, den IPTV-Zugang musst du neu eintragen.')) reset();
    };
    setTimeout(() => (needOld ? $v('vOld') : $v('vNew')).focus(), 50);
  }
  // Tasten nicht an die App durchreichen, solange der Dialog offen ist (Fernbedienung: ▲▼ wechselt Felder)
  window.addEventListener('keydown', e => {
    if (!box) return;
    e.stopImmediatePropagation();
    const items = [...box.querySelectorAll('input:not(.hidden),button')], i = items.indexOf(document.activeElement);
    if (e.key === 'Enter' && document.activeElement && document.activeElement.tagName === 'INPUT') { e.preventDefault(); box.querySelector('#vGo').click(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const n = items[Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]; n && n.focus(); }
    else if ((e.key === 'Escape' || e.key === 'GoBack' || e.key === 'BrowserBack') && !on) { e.preventDefault(); close(); }
    else if ((e.key === 'Escape' || e.key === 'GoBack' || e.key === 'BrowserBack') && unlocked) { e.preventDefault(); close(); }
  }, true);

  /** Gruppe „Datenschutz“ in den Einstellungen. */
  function settingsGroup() {
    const anchor = [...document.querySelectorAll('#view-settings .group-title')].find(el => /Allgemein/.test(el.textContent));
    if (!anchor || document.getElementById('vaultGroup')) return;
    const row = (id, b, s) => `<button class="row-btn focusable" id="${id}" type="button"><span class="lbl"><b>${b}</b><small>${s}</small></span><span class="chev">›</span></button>`;
    const rows = !supported ? `<div class="row-item"><div class="meta"><b>PIN-Schutz</b><small>Auf diesem Gerät nicht verfügbar</small></div></div>`
      : on ? row('vLock', 'Jetzt sperren', 'Daten bis zur nächsten PIN-Eingabe verschlüsseln') + row('vChange', 'PIN ändern', '') + row('vOff', 'PIN-Schutz ausschalten', '')
      : row('vOn', 'Daten mit PIN verschlüsseln', 'IPTV-Zugang, Kanäle, Watchlist-Sitzung und Fortschritt nur verschlüsselt speichern');
    anchor.insertAdjacentHTML('beforebegin', `<div class="group-title">Datenschutz${on ? ' · 🔒 aktiv' : ''}</div><div class="group" id="vaultGroup">${rows}</div>
      <p class="group-foot">${on ? `Sperrt sich automatisch, wenn StreamTV geschlossen wird oder ${LOCK_MIN} Min. im Hintergrund war.` : 'AES-256 mit Schlüssel aus deiner PIN. Die PIN wird nirgends gespeichert – vergessen heißt: Gerät zurücksetzen.'}</p>`);
    const bind = (id, f) => { const el = document.getElementById(id); if (el) el.addEventListener('click', e => { e.stopPropagation(); f(); }); };
    bind('vOn', () => dialog('set'));
    bind('vLock', () => lock());
    bind('vChange', () => dialog('change'));
    bind('vOff', () => dialog('off'));
  }
  function ready() {
    if (on && broken) { document.body.insertAdjacentHTML('beforeend', '<div id="vault" style="position:fixed;inset:0;z-index:9999;display:grid;place-items:center;background:#000;color:#fff;font-family:system-ui;padding:2rem;text-align:center">Der PIN-Schutz wird von diesem Browser nicht unterstützt.</div>'); return; }
    if (on && !unlocked) dialog('unlock');
    settingsGroup();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(ready, 0));
  else setTimeout(ready, 0);

  return { get on() { return on; }, get unlocked() { return unlocked; }, supported, lock, flush };
})();
