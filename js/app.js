/* PedalPace — UI controller: map, live GPS, trips, screens, multiplayer. */
(function () {
  'use strict';
  const R = window.Rules, W = window.World, Sim = window.Sim, Store = window.Store, Geo = W.Geo, T = window.turf;
  const $ = (sel, el) => (el || document).querySelector(sel);
  const $$ = (sel, el) => [...(el || document).querySelectorAll(sel)];
  const fmt = (n) => Math.round(n).toLocaleString('en-US');
  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const reducedMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const online = Store.mode === 'cloud';
  // Desk testing (simulated routes) is offered on localhost or with ?test in the URL.
  const TEST = ['localhost', '127.0.0.1', '[::1]', ''].includes(location.hostname) || /[?&]test\b/.test(location.search);
  const SIM_SAMPLES_PER_TICK = 2; // test routes play at ×20

  const LAST_POS = 'pp2.lastPos';
  const readLastPos = () => { try { return JSON.parse(localStorage.getItem(LAST_POS)); } catch (e) { return null; } };
  const writeLastPos = (p) => { try { localStorage.setItem(LAST_POS, JSON.stringify({ lat: p.lat, lng: p.lng })); } catch (e) { /* ignore */ } };
  const pendingAdd = (new URLSearchParams(location.search).get('add') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);

  let user = null;          // { uid, name, email, photo, anonymous }
  let P = null;             // the player's profile (see World.newProfile)
  let isNewProfile = false, obStep = 0, started = false, bootTs = 0;
  let zones = new Map();    // id -> zone, live from the store
  const pending = {};       // id -> { dmg, heal } not yet written
  const brokenIds = new Set();
  let friends = [], live = {}, notifs = [];
  let pos = null, follow = true, lastPosSave = 0;
  const geo = { watch: null, state: 'idle', msg: '' };
  const subs = {};
  let zoneCenter = null, run = null, globalCache = null;
  const ui = { tab: 'map', mode: 'auto', rankTab: 'friends', card: null };

  const settings = () => (P && P.settings) || { sunlight: false, notifications: true, mapStyle: 'satellite' };
  const theme = () => (settings().sunlight ? 'sun' : 'neon');
  const myColor = () => W.colorHex(P ? P.color : 'cyan', theme());
  const zoneColor = (z) => W.colorHex(z.color, theme());
  const zoneList = () => [...zones.values()];
  const isMine = (z) => !!user && z.owner === user.uid;
  const isFriend = (ownerId) => !!P && (P.friends || []).includes(ownerId);
  const kmTxt = (km) => (km || 0) < 10 ? (km || 0).toFixed(1) : fmt(km);
  const areaParts = (m2) => (m2 >= 100000 ? [(m2 / 1e6).toFixed(2), 'km²'] : [fmt(m2), 'm²']);

  // ================================================================ map

  const last = readLastPos();
  const map = L.map('map', { zoomControl: false, maxZoom: 21, preferCanvas: true })
    .setView(last ? [last.lat, last.lng] : [20.6, 78.9], last ? 16 : 4);
  const renderer = L.canvas({ padding: 0.4 });
  map.createPane('labels').style.zIndex = 450; // road and place names above territory fills
  map.getPane('labels').style.pointerEvents = 'none';

  // Free, keyless basemaps. Satellite: Esri World Imagery (sharp down to campus paths)
  // with Esri's road and place-name overlays. Map: OpenStreetMap (has campus inner roads
  // and footpaths). Dark: Esri dark grey canvas.
  const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
  const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  function baseLayers(style) {
    const o = { maxZoom: 21 };
    if (style === 'satellite') return [
      L.tileLayer(ESRI + 'World_Imagery/MapServer/tile/{z}/{y}/{x}', { ...o, maxNativeZoom: 18, attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics' }),
      L.tileLayer(ESRI + 'Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}', { ...o, maxNativeZoom: 18, pane: 'labels', opacity: 0.8 }),
      L.tileLayer(ESRI + 'Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', { ...o, maxNativeZoom: 18, pane: 'labels' }),
    ];
    if (style === 'dark' && theme() !== 'sun') return [
      L.tileLayer(ESRI + 'Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', { ...o, maxNativeZoom: 16, attribution: 'Tiles &copy; Esri, HERE, Garmin, ' + OSM_ATTR }),
      L.tileLayer(ESRI + 'Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', { ...o, maxNativeZoom: 16, pane: 'labels', opacity: 0.75 }),
    ];
    return [L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { ...o, maxNativeZoom: 19, attribution: OSM_ATTR })];
  }
  let tiles = [];
  function setTiles() {
    tiles.forEach((t) => map.removeLayer(t));
    tiles = baseLayers(settings().mapStyle);
    tiles.forEach((t) => t.addTo(map));
    $$('#layers [data-style]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.style === settings().mapStyle)));
  }

  const zoneLayer = L.layerGroup().addTo(map);
  const labelLayer = L.layerGroup().addTo(map);
  const trackLayer = L.layerGroup().addTo(map);
  const fxLayer = L.layerGroup().addTo(map);
  const friendLayer = L.layerGroup().addTo(map);
  const meLayer = L.layerGroup().addTo(map);
  const zoneViews = {};

  const hpColor = (pct) => (pct > 60 ? '#3DFF9A' : pct > 30 ? '#FFC531' : '#FF3B5C');
  const hpOf = (z) => Math.max(0, W.effHp(z));
  function fillFor(z) {
    const base = theme() === 'sun' ? 0.18 : settings().mapStyle === 'satellite' ? 0.2 : 0.12;
    return base + 0.3 * hpOf(z) / z.maxHp;
  }

  function renderTerritory() {
    zoneLayer.clearLayers(); labelLayer.clearLayers();
    for (const k in zoneViews) delete zoneViews[k];
    const sun = theme() === 'sun';
    for (const z of zones.values()) {
      if (W.effHp(z) <= 0) continue; // broken by decay: free ground
      const col = zoneColor(z), dec = W.isDecaying(z);
      const fill = L.geoJSON(z.geo, { renderer, stroke: false, fillColor: col, fillOpacity: fillFor(z) }).addTo(zoneLayer);
      fill.on('click', (e) => { L.DomEvent.stopPropagation(e); openZoneCard(z.id); });
      const edge = { renderer, interactive: false, fill: false };
      if (!sun) L.geoJSON(z.geo, { ...edge, color: col, weight: 10, opacity: 0.25 }).addTo(zoneLayer);
      else L.geoJSON(z.geo, { ...edge, color: '#000', weight: 6, opacity: 0.85 }).addTo(zoneLayer);
      L.geoJSON(z.geo, { ...edge, color: col, weight: sun ? 3.5 : 3, dashArray: dec ? '8 7' : null }).addTo(zoneLayer);
      const icon = L.divIcon({ className: 'zl-wrap', html: labelHtml(z), iconSize: null });
      const m = L.marker([z.clat, z.clng], { icon, keyboard: false, interactive: false }).addTo(labelLayer);
      zoneViews[z.id] = { fill, marker: m };
    }
    renderLegend();
  }

  function labelHtml(z) {
    const pct = Math.round(100 * hpOf(z) / z.maxHp);
    const mine = isMine(z), dec = W.isDecaying(z);
    const who = mine ? 'You' : esc(z.ownerName) + (isFriend(z.owner) ? ' · friend' : '');
    const tags = (dec ? '<em class="tag-decay">⏳ decaying</em>' : '') + (mine && pct < 100 ? '<em class="tag-hit">⚔ damaged</em>' : '');
    return `<div class="zl ${mine ? 'zl-friend' : 'zl-enemy'}" style="--c:${zoneColor(z)}">
      <div class="zl-name"><i class="dot"></i>${esc(z.name)}</div>
      <div class="zl-who">${who}</div>
      <div class="hpbar" role="img" aria-label="Health ${pct}%"><i style="width:${pct}%;--hp:${hpColor(pct)}"></i></div>
      <div class="zl-hp">${fmt(hpOf(z))} / ${fmt(z.maxHp)} HP</div>${tags}</div>`;
  }

  function updateZoneVisual(z) {
    const v = zoneViews[z.id];
    if (!v) return;
    v.fill.setStyle({ fillOpacity: fillFor(z) });
    const el = v.marker.getElement();
    if (el) el.innerHTML = labelHtml(z);
    if (ui.card === z.id) openZoneCard(z.id);
  }

  function renderLegend() {
    $('#legend').innerHTML = `<b>Legend</b>
      <div class="lg-row"><i style="background:${myColor()}"></i>Your zones</div>
      <div class="lg-row"><i class="lg-others"></i>Other players: their colour</div>
      <div class="lg-row"><i class="lg-dash"></i>Dashed edge = decaying</div>
      <div class="lg-row"><i class="lg-close"></i>On a trip: line back to your start</div>
      <div class="lg-row small muted">Brighter fill = more HP. Tap a zone for details.</div>`;
  }

  map.on('zoomend', () => $('#app').classList.toggle('far', map.getZoom() < 16));
  map.on('dragstart', () => { follow = false; });
  map.on('click', hideZoneCard);
  map.on('moveend', () => { if (!run && user && P && P.onboarded) { const c = map.getCenter(); ensureZones(c.lat, c.lng); } });

  // ---------------------------------------------------------------- me + friends on the map

  let meMarker = null, accCircle = null;
  function setMe(lat, lng, acc, heading) {
    const ll = [lat, lng];
    if (!meMarker) {
      accCircle = L.circle(ll, { radius: acc, renderer, color: '#4C8DFF', weight: 1, fillColor: '#4C8DFF', fillOpacity: 0.12, interactive: false }).addTo(meLayer);
      meMarker = L.marker(ll, {
        icon: L.divIcon({ className: 'me-wrap', html: '<div class="gdot"><i class="gdot-cone"></i><span class="gdot-core"></span></div>', iconSize: [48, 48], iconAnchor: [24, 24] }),
        interactive: false, keyboard: false, zIndexOffset: 1000,
      }).addTo(meLayer);
    }
    meMarker.setLatLng(ll);
    accCircle.setLatLng(ll).setRadius(acc);
    const cone = meMarker.getElement() && meMarker.getElement().querySelector('.gdot-cone');
    if (cone) { cone.style.display = heading == null ? 'none' : ''; if (heading != null) cone.style.transform = `rotate(${heading}deg)`; }
  }
  const bearing = (a, b) => {
    const r = Math.PI / 180, y = Math.sin((b[1] - a[1]) * r) * Math.cos(b[0] * r);
    const x = Math.cos(a[0] * r) * Math.sin(b[0] * r) - Math.sin(a[0] * r) * Math.cos(b[0] * r) * Math.cos((b[1] - a[1]) * r);
    return (Math.atan2(y, x) / r + 360) % 360;
  };

  function renderFriendsLive() {
    friendLayer.clearLayers();
    const now = Date.now();
    for (const l of Object.values(live)) {
      if (now - l.ts > 120000) continue;
      const html = `<div class="fdot ${l.recording ? 'rec' : ''}" style="--c:${W.colorHex(l.color, theme())}"><b>${esc((l.name || '?')[0])}</b><small>${esc(l.name)}${l.mode === 'cycle' ? ' 🚴' : l.mode === 'walk' ? ' 🚶' : ''}</small></div>`;
      L.marker([l.lat, l.lng], { icon: L.divIcon({ className: 'me-wrap', html, iconSize: [34, 34], iconAnchor: [17, 17] }), interactive: false, keyboard: false, zIndexOffset: 900 }).addTo(friendLayer);
    }
  }
  setInterval(renderFriendsLive, 20000);

  // ================================================================ location

  function startGeo() {
    if (geo.watch != null) return;
    if (!('geolocation' in navigator)) return setGeo('error', 'This browser has no location support.');
    if (!window.isSecureContext) return setGeo('error', 'Location needs a secure address (https:// or localhost). On your phone, open the https:// (GitHub Pages) link.');
    setGeo('asking', 'Finding your location…');
    geo.watch = navigator.geolocation.watchPosition(onGeo, onGeoErr, { enableHighAccuracy: true, maximumAge: 0, timeout: 27000 });
    // Some browsers only report the watch once you move: ask once too, so the dot appears straight away.
    navigator.geolocation.getCurrentPosition((p) => { if (geo.state !== 'ok') onGeo(p); }, () => {}, { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 });
  }
  function retryGeo() {
    if (geo.watch != null) navigator.geolocation.clearWatch(geo.watch);
    geo.watch = null; startGeo();
  }
  function setGeo(state, msg) { geo.state = state; geo.msg = msg || ''; renderGpsCard(); if (!$('#sheet-start').hidden) renderStartSheet(); }

  function onGeo(p) {
    const c = p.coords, prev = pos, here = [c.latitude, c.longitude];
    let heading = c.heading != null && !isNaN(c.heading) && (c.speed || 0) > 0.6 ? c.heading : null;
    if (heading == null && prev) heading = Geo.distLL([prev.lat, prev.lng], here) > 4 ? bearing([prev.lat, prev.lng], here) : prev.heading;
    pos = { lat: here[0], lng: here[1], acc: c.accuracy, heading, ts: p.timestamp };
    const first = geo.state !== 'ok';
    if (first || geo.msg) setGeo('ok'); else renderGpsCard();
    if (Date.now() - lastPosSave > 30000) { writeLastPos(pos); lastPosSave = Date.now(); }
    if (!(run && run.sim)) {
      setMe(pos.lat, pos.lng, pos.acc, pos.heading);
      if (first) map.setView(here, Math.max(map.getZoom(), 17));
      else if (follow && !run) map.panTo(here, { animate: true });
    }
    if (run && run.live) run.live.feed(p);
    if (!run) ensureZones(pos.lat, pos.lng);
    if (!$('#sheet-start').hidden) renderStartSheet();
  }
  function onGeoErr(e) {
    if (e.code === 1) {
      if (geo.watch != null) navigator.geolocation.clearWatch(geo.watch);
      geo.watch = null;
      setGeo('denied', Sim.GEO_HELP[1]);
      if (run && !run.sim) toast('📍 Location was blocked, so the trip can’t continue.', 'attack');
    } else if (geo.state !== 'ok') setGeo('asking', Sim.GEO_HELP[e.code] || e.message);
  }

  function gpsQuality() {
    if (geo.state !== 'ok' || !pos) return { cls: 'weak', txt: geo.state === 'denied' ? '📍 Location blocked' : '📡 Finding your location…' };
    const a = Math.round(pos.acc);
    if (a <= 15) return { cls: 'good', txt: `📡 GPS ready · ±${a} m` };
    if (a <= R.GPS_MAX_ACC_M) return { cls: 'ok', txt: `📡 GPS ok · ±${a} m` };
    return { cls: 'weak', txt: `📡 Weak GPS · ±${a} m`, tip: `Your route is only recorded once accuracy is under ±${R.GPS_MAX_ACC_M} m. Phones outdoors get ±3–10 m. Laptops locate by Wi-Fi and are usually too rough.` };
  }

  function renderGpsCard() {
    const card = $('#gps-card');
    const show = started && !run && ui.tab === 'map' && (geo.state === 'denied' || geo.state === 'error');
    card.hidden = !show;
    if (!show) return;
    card.innerHTML = `<p>📍 <b>${geo.state === 'denied' ? 'Location is blocked' : 'No location'}</b><br><span class="small">${esc(geo.msg)}</span></p>
      <button class="btn" id="gps-retry">Try again</button>`;
    $('#gps-retry').onclick = retryGeo;
  }

  // ================================================================ zones (live data)

  function ensureZones(lat, lng) {
    if (!user) return;
    if (zoneCenter && Geo.distLL(zoneCenter, [lat, lng]) < 3000) return;
    zoneCenter = [lat, lng];
    if (subs.zones) subs.zones();
    subs.zones = Store.watchZones(lat, lng, onZones);
  }
  function onZones(list) {
    const next = new Map();
    for (const z of list) {
      if (brokenIds.has(z.id)) continue;
      const p = pending[z.id];
      if (p) z.hp += p.heal - p.dmg; // writes still queued on this device
      next.set(z.id, z);
    }
    zones = next;
    renderTerritory();
    if (ui.card) openZoneCard(ui.card);
  }

  function addPending(id, kind, v) { const p = pending[id] || (pending[id] = { dmg: 0, heal: 0 }); p[kind] += v; }
  async function flushPending() {
    for (const id of Object.keys(pending)) {
      const p = pending[id]; delete pending[id];
      if (brokenIds.has(id)) continue;
      try {
        if (p.dmg > 0) await Store.damageZone(id, p.dmg);
        if (p.heal > 0) await Store.healZone(id, p.heal);
      } catch (e) { console.warn('zone write', e); }
    }
  }
  function breakNow(z) {
    brokenIds.add(z.id); delete pending[z.id]; zones.delete(z.id);
    Store.breakZone(z.id).catch((e) => console.warn(e));
    renderTerritory();
  }

  // Recorder hooks: how a trip touches the zones around you.
  const hooks = {
    zoneAt(lat, lng) { const z = W.zoneAt(zoneList(), lat, lng); return z ? { zone: z, mine: isMine(z) } : null; },
    hit(zone, hp) {
      const z = zones.get(zone.id); if (!z || isMine(z)) return { broken: false };
      z.hp -= hp; addPending(z.id, 'dmg', hp);
      if (W.effHp(z) <= 0) { breakNow(z); return { broken: true }; }
      updateZoneVisual(z);
      return { broken: false };
    },
    heal(zone, amount) {
      const z = zones.get(zone.id); if (!z) return 0;
      const h = Math.min(amount, z.maxHp - W.effHp(z));
      if (h <= 0) return 0;
      z.hp += h; addPending(z.id, 'heal', h); updateZoneVisual(z);
      return h;
    },
    emit: (ev) => onEvent(ev),
  };

  /** Owner-side upkeep: remove zones lost to decay; after a trip, mark the rest active (stops decay). */
  async function touchMyZones(active) {
    let mine;
    try { mine = await Store.myZones(user.uid); } catch (e) { console.warn(e); return; }
    const t = W.dayIndex(), lost = [];
    let area = 0;
    for (const z of mine) {
      const eff = W.effHp(z, t);
      if (eff <= 0) { lost.push(z.name); Store.deleteZone(z.id).catch(() => {}); continue; }
      area += z.areaM2;
      if (active && z.ownerActiveDay !== t) Store.updateZone(z.id, { hp: eff, ownerActiveDay: t }).catch((e) => console.warn(e));
    }
    P.stats.areaM2 = Math.round(area);
    if (lost.length) notifySelf('decay', `You lost ${lost.join(', ')} to decay. Zones decay after ${R.DECAY_START_DAY} days without a trip.`);
  }

  // ================================================================ theme

  function applyTheme() {
    document.documentElement.dataset.theme = theme();
    document.documentElement.style.setProperty('--me', myColor());
    $('meta[name=theme-color]').setAttribute('content', theme() === 'sun' ? '#FFFFFF' : '#0B0F17');
    $('#btn-sun').setAttribute('aria-pressed', String(settings().sunlight));
    setTiles(); renderTerritory(); renderFriendsLive();
  }

  // ================================================================ top bar & nav

  function renderTopbar() {
    if (!P) return;
    const st = P.stats, met = P.metDay === P.today.day;
    $('#tb-points').textContent = fmt(st.totalPoints);
    $('#tb-streak').textContent = st.streak;
    const p = Math.min(1, R.minimumProgress(P.today.walkMin, P.today.cycleKm));
    $('#tb-ring').style.strokeDashoffset = String(94.25 * (1 - (met ? 1 : p)));
    $('#tb-daily-txt').textContent = met ? '✓' : Math.round(p * 100) + '%';
    $('#tb-daily').classList.toggle('met', met);
    const unread = notifs.filter((n) => !n.read).length;
    const b = $('#bell-badge'); b.hidden = !unread; b.textContent = unread;
  }

  function showTab(tab) {
    ui.tab = tab;
    $$('#tabbar [role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    for (const id of ['ranks', 'friends', 'profile']) $('#screen-' + id).hidden = tab !== id;
    $('#screen-summary').hidden = true;
    hideZoneCard();
    if (tab === 'ranks') renderRanks();
    if (tab === 'friends') renderFriends();
    if (tab === 'profile') renderProfile();
    if (tab === 'map') setTimeout(() => map.invalidateSize(), 0);
    setChrome('nav');
  }

  /** Which overlay chrome is visible: 'nav' (map + tabs), 'rec', 'draw', 'none'. */
  function setChrome(mode) {
    const nav = mode === 'nav';
    $('#topbar').hidden = !nav; $('#tabbar').hidden = !nav;
    $('#map-tools').hidden = !(nav && ui.tab === 'map');
    if (!nav || ui.tab !== 'map') { $('#legend').hidden = true; $('#layers').hidden = true; }
    $('#rec').hidden = mode !== 'rec';
    $('#drawbar').hidden = mode !== 'draw';
    renderGpsCard();
  }

  // ================================================================ toasts & notifications

  function toast(text, kind) {
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = text;
    const box = $('#toasts');
    while (box.children.length >= 3) box.firstChild.remove();
    box.appendChild(el);
    setTimeout(() => el.classList.add('out'), 3800);
    setTimeout(() => el.remove(), 4300);
  }

  const NOTIF_ICON = { attack: '⚔️', decay: '⏳', streak: '🔥', penalty: '➖', info: 'ℹ️', badge: '🏅', friend: '👥' };
  const ago = (ts) => {
    const s = (Date.now() - ts) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return Math.floor(s / 86400) + ' d ago';
  };
  function renderNotifs() {
    $('#notif-list').innerHTML = notifs.length
      ? notifs.map((n) => `<li class="${n.read ? '' : 'unread'} n-${esc(n.type)}"><span class="n-ico" aria-hidden="true">${NOTIF_ICON[n.type] || '•'}</span><div><p>${esc(n.text)}</p><small>${ago(n.ts)}</small></div></li>`).join('')
      : '<li class="muted">Nothing yet.</li>';
  }
  function openNotifs() {
    renderNotifs();
    $('#drawer-notifs').hidden = false;
    const unread = notifs.filter((n) => !n.read).map((n) => n.id);
    notifs.forEach((n) => (n.read = true));
    Store.markRead(user.uid, unread).catch(() => {});
    renderTopbar();
  }
  function onNotifs(list) {
    const known = new Set(notifs.map((n) => n.id));
    for (const n of list) {
      if (known.has(n.id) || n.read || n.ts < bootTs - 2000) continue;
      if (settings().notifications) toast((NOTIF_ICON[n.type] || '') + ' ' + n.text, n.type);
    }
    notifs = list;
    renderTopbar();
    if (!$('#drawer-notifs').hidden) renderNotifs();
  }
  const notifySelf = (type, text) => Store.sendNotif(user.uid, { type, text }).catch((e) => console.warn(e));

  // ================================================================ start sheet

  function nearbyFriends(at) {
    if (!online || !at) return [];
    const now = Date.now();
    return Object.values(live).filter((l) => l.recording && now - l.ts < R.LIVE_FRESH_SEC * 1000 && Geo.distLL([l.lat, l.lng], at) <= R.GROUP_RADIUS_M);
  }
  const groupNow = () => (run && run.last ? 1 + nearbyFriends(run.last).length : 1);

  function renderStartSheet() {
    setSeg('#opt-mode', ui.mode);
    $('#mode-hint').textContent = ui.mode === 'auto'
      ? 'Auto detects walking vs cycling from your speed. Pick one if it gets it wrong.'
      : `Locked to ${ui.mode === 'walk' ? 'walking' : 'cycling'}. Speeds that don’t match get flagged.`;
    const q = gpsQuality();
    $('#start-gps').className = 'start-gps q-' + q.cls;
    $('#start-gps').innerHTML = `<b>${q.txt}</b>${q.tip ? `<br><small>${esc(q.tip)}</small>` : ''}${geo.state === 'denied' || geo.state === 'error' ? `<br><small>${esc(geo.msg)}</small>` : ''}`;
    const near = nearbyFriends(pos && [pos.lat, pos.lng]);
    $('#start-friends').innerHTML = !online ? ''
      : near.length ? `👥 <b>${near.map((l) => esc(l.name)).join(', ')}</b> ${near.length > 1 ? 'are' : 'is'} on a trip near you: combo ×${R.groupMult(1 + near.length)}`
      : '👥 Friends on a trip within 60 m of you add a combo bonus (2 players ×1.2, 3 ×1.35, 4+ ×1.5).';
    $('#btn-go').disabled = geo.state === 'denied' || geo.state === 'error';
    $('#btn-test').hidden = !TEST;
  }
  function setSeg(sel, v) { $$(sel + ' button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === v))); }

  function openStart() { $('#toasts').innerHTML = ''; hideZoneCard(); startGeo(); renderStartSheet(); $('#sheet-start').hidden = false; }
  function closeSheets() { $('#sheet-start').hidden = true; $('#drawer-notifs').hidden = true; $('#sheet-end').hidden = true; }

  // ================================================================ draw a test route

  const draw = { pts: [], line: null, dots: L.layerGroup() };
  function startDraw() {
    closeSheets(); setChrome('draw');
    draw.pts = []; draw.dots.clearLayers().addTo(map);
    draw.line = L.polyline([], { color: myColor(), weight: 4, dashArray: '6 8' }).addTo(map);
    updateDraw();
    map.off('click', hideZoneCard);
    map.on('click', onDrawClick);
  }
  function onDrawClick(e) { draw.pts.push([e.latlng.lat, e.latlng.lng]); updateDraw(); }
  function updateDraw() {
    draw.line.setLatLngs(draw.pts);
    draw.dots.clearLayers();
    draw.pts.forEach((p, n) => L.circleMarker(p, { radius: n ? 5 : 8, color: '#000', weight: 2, fillColor: myColor(), fillOpacity: 1 }).addTo(draw.dots));
    let m = 0; for (let n = 1; n < draw.pts.length; n++) m += Geo.distLL(draw.pts[n - 1], draw.pts[n]);
    $('#draw-count').textContent = draw.pts.length;
    $('#draw-km').textContent = (m / 1000).toFixed(2);
    $('#draw-go').disabled = draw.pts.length < 2;
  }
  function endDraw() {
    map.off('click', onDrawClick);
    map.on('click', hideZoneCard);
    if (draw.line) map.removeLayer(draw.line);
    map.removeLayer(draw.dots);
  }

  // ================================================================ trips

  function startTrip() {
    if (geo.state === 'denied' || geo.state === 'error') { toast('📍 ' + geo.msg, 'attack'); return; }
    startGeo();
    beginRun({ live: true, start: pos ? [pos.lat, pos.lng] : null });
  }

  function beginRun(o) {
    closeSheets(); hideZoneCard();
    const s0 = o.start || (pos ? [pos.lat, pos.lng] : [map.getCenter().lat, map.getCenter().lng]);
    Geo.setOrigin({ lat: s0[0], lng: s0[1] });
    trackLayer.clearLayers(); fxLayer.clearLayers();
    const declared = o.sim ? o.sc.mode : ui.mode;
    run = {
      sim: !!o.sim, declared, paused: false, acc: 0, accHit: 0, popups: 0,
      line: null, lineValid: null, glow: null, last: null, closeLine: null, preview: null, previewArea: 0,
      minimumToastShown: P.metDay === P.today.day,
    };
    run.rec = Sim.createRecorder({ declared, streak: P.stats.streak, group: groupNow }, hooks);
    follow = true;
    setChrome('rec');
    $('#rec-flag').hidden = true;
    $('#r-pause').textContent = '❚❚'; $('#r-pause').setAttribute('aria-label', 'Pause');
    run.flushT = setInterval(flushPending, 3000);
    run.previewT = setInterval(updatePreview, 3000);
    if (online && !run.sim) { run.liveT = setInterval(publishMe, 5000); }
    if (run.sim) {
      run.sampler = Sim.createSampler(o.sc);
      run.timer = setInterval(simTick, 100);
      banner('GO! 🧪 Simulated', 'go');
    } else {
      run.live = Sim.createLiveSource({ onSample });
      banner(pos && pos.acc <= R.GPS_MAX_ACC_M ? 'GO! ' + (declared === 'cycle' ? '🚴' : '🚶') : 'Waiting for accurate GPS… 📡', pos && pos.acc <= R.GPS_MAX_ACC_M ? 'go' : 'claim');
      requestWake();
    }
    renderHud();
  }

  function requestWake() {
    if (!run || run.sim || !navigator.wakeLock) return;
    navigator.wakeLock.request('screen').then((w) => { if (run) run.wake = w; else w.release(); }).catch(() => {});
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { requestWake(); checkDay(); }
  });

  function publishMe() {
    if (!run || !run.last || !online) return;
    Store.publishLive(user.uid, { lat: run.last[0], lng: run.last[1], name: P.name, color: P.color, mode: run.rec.mode, recording: true }).catch(() => {});
  }

  function onSample(smp) {
    if (!run || run.paused) return;
    const first = !run.rec.samples.length;
    const prevLast = run.last;
    run.rec.push(smp);
    run.last = [smp.lat, smp.lng];
    if (first) {
      placeStart();
      if (!run.sim) banner('GO! ' + (run.declared === 'cycle' ? '🚴' : '🚶'), 'go');
      publishMe();
    }
    if (run.sim) {
      const h = prevLast && Geo.distLL(prevLast, run.last) > 0.5 ? bearing(prevLast, run.last) : null;
      setMe(smp.lat, smp.lng, 4, h);
    }
    drawTrack();
    if (follow) map.panTo(run.last, { animate: false });
    renderHud();
  }

  function simTick() {
    if (!run || run.paused) return;
    for (let n = 0; n < SIM_SAMPLES_PER_TICK; n++) {
      const smp = run.sampler.next();
      if (!smp) { clearInterval(run.timer); run.timer = null; updatePreview(); openEndSheet(); return; }
      onSample(smp);
    }
  }

  function placeStart() {
    const s = run.rec.start;
    L.marker(s, { icon: L.divIcon({ className: 'me-wrap', html: '<div class="start-flag">🏁</div>', iconSize: [30, 30], iconAnchor: [15, 15] }), interactive: false, keyboard: false }).addTo(trackLayer);
    run.closeLine = L.polyline([s, s], { renderer, color: theme() === 'sun' ? '#000' : '#fff', weight: 3, dashArray: '2 9', opacity: 0.9, interactive: false }).addTo(trackLayer);
  }

  function drawTrack() {
    const r = run.rec, s = r.samples[r.samples.length - 1];
    const ll = [s.lat, s.lng];
    if (run.closeLine) run.closeLine.setLatLngs([ll, r.start]);
    if (s.jump) { run.line = null; return; } // never draw a line across a GPS jump
    if (!run.line || run.lineValid !== s.valid) {
      const start = run.line ? [run.line.getLatLngs().slice(-1)[0], ll] : [ll];
      if (s.valid) {
        run.glow = theme() === 'neon' ? L.polyline(start, { renderer, color: myColor(), weight: 13, opacity: 0.3, interactive: false }).addTo(trackLayer) : null;
        run.line = L.polyline(start, { renderer, color: theme() === 'sun' ? '#000' : myColor(), weight: 5, interactive: false }).addTo(trackLayer);
      } else {
        run.glow = null;
        run.line = L.polyline(start, { renderer, color: '#FF3B5C', weight: 4, dashArray: '3 8', interactive: false }).addTo(trackLayer);
      }
      run.lineValid = s.valid;
    } else {
      run.line.addLatLng(ll);
      if (run.glow) run.glow.addLatLng(ll);
    }
  }

  /** Light fill showing the zone you'd get if you ended now. */
  function updatePreview() {
    if (!run) return;
    const shape = W.tripShape(run.rec.track);
    run.previewArea = shape ? T.area(shape) : 0;
    if (run.preview) { trackLayer.removeLayer(run.preview); run.preview = null; }
    if (shape && run.previewArea >= R.MIN_ZONE_M2) {
      run.preview = L.geoJSON(shape, { renderer, interactive: false, stroke: false, fillColor: myColor(), fillOpacity: 0.16 }).addTo(trackLayer);
      run.preview.bringToBack();
    }
    renderHud();
  }

  function onEvent(ev) {
    if (!run) return;
    switch (ev.type) {
      case 'damage': {
        run.acc += ev.amount; run.accHit += ev.zoneHit;
        if (run.acc >= (run.sim ? 9 : 4)) { popDamage(ev); run.acc = 0; run.accHit = 0; }
        maybeMinimumToast();
        break;
      }
      case 'break':
        banner(`ZONE BROKEN! 💥<br><small>${esc(ev.zone.name)} · +${R.NEUTRALISE_PTS} pts<br>Its ground is free: include it in your loop to claim it</small>`, 'break');
        break;
      case 'nearStart':
        toast('🏁 You’re back at your start. Tap End trip now to claim the full loop, or keep going to make it bigger.', 'good');
        break;
      case 'flag': {
        const f = $('#rec-flag');
        f.hidden = false; f.innerHTML = `⚠ <b>Anti-cheat:</b> ${esc(ev.flag.text)}`;
        if (ev.flag.kind === 'gps') setTimeout(() => { if (run && !run.rec.flagActive) f.hidden = true; }, 2500);
        break;
      }
      case 'flagClear':
        $('#rec-flag').innerHTML = '✓ Speed back to normal. Damage resumed';
        setTimeout(() => { if (run && !run.rec.flagActive) $('#rec-flag').hidden = true; }, 2000);
        break;
      case 'mode':
        if (run.declared === 'auto') toast(`Auto-detected: ${ev.mode === 'walk' ? '🚶 Walking' : '🚴 Cycling'}`);
        break;
    }
  }

  function maybeMinimumToast() {
    if (run.minimumToastShown) return;
    const r = run.rec;
    if (R.minimumProgress(P.today.walkMin + r.walkSec / 60, P.today.cycleKm + r.cycleKm) >= 1) {
      run.minimumToastShown = true;
      toast(`✅ Daily minimum met. Tonight’s −${R.inactivityPenalty(P.stats.missedDays + 1)} penalty avoided!`, 'good');
    }
  }

  function popDamage(ev) {
    if (reducedMotion || run.popups > 14) return;
    const amt = Math.round(run.acc);
    let cls = 'pop', txt = '+' + amt;
    if (ev.ctx === 'attack') { cls += ' pop-attack'; txt = '⚔ ' + Math.round(run.accHit); }
    else if (ev.ctx === 'defend') { cls += ' pop-defend'; txt = '🛡 +' + amt; }
    const j = (Math.random() - 0.5) * 0.0003;
    const m = L.marker([ev.lat + 0.0001, ev.lng + j], { icon: L.divIcon({ className: 'pop-wrap', html: `<div class="${cls}">${txt}</div>`, iconSize: null }), interactive: false, keyboard: false }).addTo(fxLayer);
    run.popups++;
    setTimeout(() => { fxLayer.removeLayer(m); if (run) run.popups--; }, 950);
  }

  function banner(html, kind) {
    const b = $('#rec-banner');
    b.innerHTML = `<div class="bn bn-${kind}">${html}</div>`;
    clearTimeout(banner.t);
    banner.t = setTimeout(() => (b.innerHTML = ''), kind === 'go' ? 900 : 2800);
  }

  function renderHud() {
    if (!run) return;
    const r = run.rec;
    $('#r-damage').textContent = fmt(r.damage);
    $('#r-dist').textContent = (r.dist / 1000).toFixed(2);
    const t = Math.round(r.time); $('#r-time').textContent = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
    $('#r-speed').textContent = r.kmh.toFixed(1);
    const [av, au] = areaParts(run.previewArea);
    $('#r-area').textContent = run.previewArea >= R.MIN_ZONE_M2 ? av : '–';
    $('#r-area-u').textContent = run.previewArea >= R.MIN_ZONE_M2 ? au : 'too small yet';
    const ctx = $('#r-ctx'), z = r.zone && zones.get(r.zone.id);
    if (!r.samples.length) { ctx.className = 'rec-ctx'; ctx.textContent = run.sim ? 'Starting…' : 'Waiting for GPS'; }
    else if (r.flagActive) { ctx.className = 'rec-ctx ctx-flag'; ctx.textContent = 'Damage paused'; }
    else if (z && r.ctx === 'attack') { ctx.className = 'rec-ctx ctx-attack'; ctx.innerHTML = `⚔ Attacking<br><b>${esc(z.name)}</b><br><small>${fmt(hpOf(z))} HP left</small>`; }
    else if (z && r.ctx === 'defend') { ctx.className = 'rec-ctx ctx-defend'; ctx.innerHTML = `🛡 Defending<br><b>${esc(z.name)}</b>`; }
    else if (z) { ctx.className = 'rec-ctx'; ctx.innerHTML = `Patrolling<br><b>${esc(z.name)}</b>`; }
    else { ctx.className = 'rec-ctx'; ctx.textContent = 'Free ground'; }

    const chips = [];
    chips.push(`<span class="c">${run.declared === 'auto' ? 'Auto: ' : ''}${r.mode === 'walk' ? '🚶 Walking' : '🚴 Cycling'}</span>`);
    const why = r.mode === 'walk'
      ? (r.intensity >= R.WALK.UPHILL ? 'uphill' : r.intensity >= R.WALK.BRISK ? 'brisk' : 'base')
      : (r.intensity > R.CYCLE.BASE ? 'effort bonus' : 'base');
    chips.push(`<span class="c c-int">×${r.intensity.toFixed(2)} ${why}</span>`);
    if (run.sim) chips.push('<span class="c">🧪 simulated</span>');
    else if (pos) chips.push(`<span class="c ${pos.acc > R.GPS_MAX_ACC_M ? 'c-weak' : ''}">📡 ±${Math.round(pos.acc)} m${pos.acc > R.GPS_MAX_ACC_M ? ' · too rough to record' : ''}</span>`);
    else chips.push('<span class="c c-weak">📡 Searching…</span>');
    if (P.stats.streak) chips.push(`<span class="c">🔥 ×${R.streakMult(P.stats.streak).toFixed(2)}</span>`);
    if (r.group > 1) chips.push(`<span class="c c-combo">COMBO ×${R.groupMult(r.group)}</span>`);
    if (r.grade >= R.UPHILL_GRADE) chips.push(`<span class="c">⛰ ${(r.grade * 100).toFixed(0)}%</span>`);
    if (run.paused) chips.push('<span class="c c-weak">❚❚ paused</span>');
    $('#r-chips').innerHTML = chips.join('');

    const p = Math.min(1, R.minimumProgress(P.today.walkMin + r.walkSec / 60, P.today.cycleKm + r.cycleKm));
    const met = P.metDay === P.today.day || p >= 1;
    $('#r-daily-fill').style.width = (met ? 100 : p * 100) + '%';
    $('#r-daily-txt').textContent = met ? 'Daily minimum met ✓ penalty avoided' : `Daily minimum ${Math.round(p * 100)}%`;
  }

  function openEndSheet() {
    if (!run) return;
    updatePreview();
    const r = run.rec, a = run.previewArea;
    const flagged = r.dist ? r.flaggedDist / r.dist : 0;
    let txt;
    if (r.samples.length < 2) txt = 'Nothing has been recorded yet.';
    else if (flagged > R.MAX_FLAGGED_SHARE) txt = `${Math.round(flagged * 100)}% of this trip was flagged by anti-cheat, so it won’t make a zone. Damage from the clean parts still counts.`;
    else if (a < R.MIN_ZONE_M2) txt = `Joining your end point to your start encloses less than ${fmt(R.MIN_ZONE_M2)} m², so no zone this time. Your damage and points still count.`;
    else txt = `Your route will be closed with a straight line back to your start 🏁 and filled in: about <b>${areaParts(a).join(' ')}</b>. Any part of other players’ zones inside it becomes yours.`;
    $('#end-text').innerHTML = txt;
    $('#sheet-end').hidden = false;
  }

  function stopRun() {
    ['timer', 'flushT', 'previewT', 'liveT'].forEach((k) => run[k] && clearInterval(run[k]));
    if (run.wake) run.wake.release().catch(() => {});
    if (online && !run.sim) Store.publishLive(user.uid, null).catch(() => {});
  }

  async function finishTrip() {
    if (!run || run.finishing) return;
    run.finishing = true;
    closeSheets();
    stopRun();
    await flushPending();
    const r = run.rec, st = P.stats, sim = run.sim;
    if (r.samples.length < 2 || r.dist < 10) {
      run = null; trackLayer.clearLayers(); fxLayer.clearLayers(); restoreMe();
      setChrome('nav'); toast('Nothing recorded, so no trip saved.');
      return;
    }
    const t = W.dayIndex();
    const flagged = r.dist ? r.flaggedDist / r.dist : 0;
    const plan = flagged > R.MAX_FLAGGED_SHARE ? { shape: null, reason: 'flagged', taken: [], merged: [], dead: [], newAreaM2: 0 }
      : W.planClaim(zoneList(), r.track, user.uid, t);
    let zone = null, claimPts = 0;
    if (plan.shape) {
      try {
        for (const z of plan.dead) { brokenIds.add(z.id); zones.delete(z.id); await Store.breakZone(z.id); }
        // Newest claim wins: shrink other players' zones (or remove them if too little is left).
        for (const t of plan.taken) {
          if (!t.rest) { brokenIds.add(t.zone.id); zones.delete(t.zone.id); await Store.breakZone(t.zone.id); continue; }
          const patch = W.shrinkPatch(t.zone, t.rest);
          const cur = zones.get(t.zone.id); if (cur) Object.assign(cur, patch);
          await Store.updateZone(t.zone.id, patch);
        }
        for (const z of plan.merged) { brokenIds.add(z.id); zones.delete(z.id); await Store.deleteZone(z.id); }
        st.zonesMade = (st.zonesMade || 0) + (plan.merged.length ? 0 : 1);
        const name = plan.merged.length ? plan.merged[0].name : `Turf #${st.zonesMade}`;
        zone = W.makeZone(plan.shape, user.uid, P, name, t);
        zone.id = await Store.createZone(zone);
        claimPts = R.claimPoints(plan.newAreaM2);
      } catch (e) { zone = null; toast('⚠ Could not save your zone: ' + e.message, 'attack'); }
    }
    if (online) {
      for (const h of Object.values(r.hits)) {
        if (h.owner === user.uid) continue;
        Store.sendNotif(h.owner, { type: 'attack', text: h.broken ? `${P.name} broke your zone ${h.name}! Its ground is free to claim.` : `${P.name} hit your zone ${h.name} for ${fmt(h.hp)} HP. Ride through it to heal it.` }).catch(() => {});
      }
      if (zone) {
        for (const z of plan.dead) Store.sendNotif(z.owner, { type: 'decay', text: `${z.name} decayed away and ${P.name} claimed the ground.` }).catch(() => {});
        for (const t of plan.taken) Store.sendNotif(t.zone.owner, { type: 'attack', text: t.rest
          ? `${P.name} took ${areaParts(t.takenM2).join(' ')} of your zone ${t.zone.name}. Ride a loop around it to take it back!`
          : `${P.name} took over your whole zone ${t.zone.name}! Ride a loop around it to take it back.` }).catch(() => {});
      }
    }

    const pts = r.totalPoints(claimPts);
    st.totalPoints += pts; st.damageDealt += r.damage; st.weeklyDamage += r.damage;
    st.areaClaimedM2 += zone ? plan.newAreaM2 : 0;
    st.zonesBroken += r.broken.length + (zone ? plan.dead.length : 0);
    st.activities++; st.km = (st.km || 0) + r.dist / 1000;
    const wasMet = P.metDay === P.today.day;
    const daily = W.addDailyProgress(P, r.walkSec / 60, r.cycleKm);
    P.activeDay = t;

    const unlocked = [];
    const award = (id, cond) => { if (cond && !P.badges[id]) { P.badges[id] = t; unlocked.push(id); } };
    award('first_claim', !!zone);
    award('raider', r.broken.length > 0 || (zone && plan.dead.length > 0));
    award('defender', r.healed > 0);
    award('explorer', st.areaClaimedM2 >= 50000);
    award('combo', r.maxGroup > 1);
    award('clean', r.flags.length === 0 && r.dist > 300);
    award('streak3', st.streak >= 3);
    award('streak7', st.streak >= 7);
    unlocked.forEach((id) => notifySelf('badge', `Badge unlocked: ${W.BADGES[id].name}`));

    const mode = r.cycleKm * 1000 > r.validDist / 2 ? 'cycle' : 'walk';
    const summary = {
      sim, mode, km: r.dist / 1000, sec: Math.round(r.time), damage: r.damage, zoneDamage: r.zoneDamage, healed: r.healed,
      parts: { ...r.parts }, zone, plan, claimPts, broken: r.broken.slice(), breakBonus: r.breakBonus, points: pts,
      flags: r.flags.map((f) => ({ kind: f.kind, text: f.text })), flaggedKm: r.flaggedDist / 1000,
      healedNames: Object.values(r.healedZones), maxGroup: r.maxGroup, unlocked, streak: st.streak,
      daily: { justMet: daily.justMet, avoided: daily.avoided, wasMet, progress: R.minimumProgress(P.today.walkMin, P.today.cycleKm) },
    };
    P.history.unshift({ ts: Date.now(), mode, km: +summary.km.toFixed(2), points: Math.round(pts), areaM2: zone ? Math.round(plan.newAreaM2) : 0, flags: r.flags.length, sim });
    P.history = P.history.slice(0, 15);
    await touchMyZones(true);
    saveP();
    run = null;
    restoreMe();
    renderSummary(summary);
  }

  /** Put the blue dot back on the real GPS position after a simulated trip. */
  function restoreMe() { if (pos) setMe(pos.lat, pos.lng, pos.acc, pos.heading); }

  // ================================================================ summary screen

  function renderSummary(x) {
    setChrome('none');
    $('#toasts').innerHTML = '';
    const el = $('#screen-summary');
    const mins = Math.floor(x.sec / 60), secs = x.sec % 60;
    const avg = x.sec ? x.km / (x.sec / 3600) : 0;
    const st = P.stats;
    let pen;
    if (x.daily.justMet) pen = { big: '−' + x.daily.avoided, cls: 'good', sub: `Avoided ✓ Streak is now ${x.streak} day${x.streak === 1 ? '' : 's'}` };
    else if (x.daily.wasMet) pen = { big: '✓', cls: 'good', sub: 'Already safe today' };
    else {
      const left = Math.max(0, 1 - x.daily.progress);
      pen = { label: 'Penalty at risk', big: '−' + R.inactivityPenalty(st.missedDays + 1), cls: 'warn', sub: `${Math.ceil(left * R.MIN_WALK_MIN)} more min walking or ${(left * R.MIN_CYCLE_KM).toFixed(1)} km cycling today avoids it` };
    }
    const [aV, aU] = x.zone ? areaParts(x.zone.areaM2) : ['0', 'm²'];
    const why = { small: `Your route enclosed less than ${fmt(R.MIN_ZONE_M2)} m² (an out-and-back trip encloses almost nothing).`, flagged: 'Too much of the trip was flagged by anti-cheat.' }[x.plan.reason] || '';
    const row = (label, v) => v ? `<li><span>${label}</span><b>+${fmt(v)}</b></li>` : '';
    el.innerHTML = `
      <div class="screen-inner">
        <p class="eyebrow">${x.mode === 'cycle' ? '🚴 Ride' : '🚶 Walk'} complete${x.sim ? ' · 🧪 simulated' : ''}</p>
        <h1 id="sum-title">${x.zone ? esc(x.zone.name) + ' claimed!' : 'Trip saved'}</h1>
        <p class="muted">${x.km.toFixed(2)} km · ${mins}:${String(secs).padStart(2, '0')} · ${avg.toFixed(1)} km/h avg${x.maxGroup > 1 ? ' · with friends' : ''}</p>

        <div class="tiles">
          <div class="tile t-dmg"><span class="lbl">Damage dealt</span><b class="num">${fmt(x.damage)}</b><small>${x.zoneDamage ? fmt(x.zoneDamage) + ' HP removed from rivals' : 'no rival zones hit'}</small></div>
          <div class="tile t-area"><span class="lbl">Zone</span><b class="num">${aV}<em>${aU}</em></b><small>${x.zone ? `${fmt(x.zone.maxHp)} HP${x.plan.merged.length ? ' · merged with your zone' : ''}` : 'no zone this time'}</small></div>
          <div class="tile t-pts"><span class="lbl">Points earned</span><b class="num">+${fmt(x.points)}</b><small>total ${fmt(st.totalPoints)}</small></div>
          <div class="tile t-pen ${pen.cls}"><span class="lbl">${pen.label || 'Penalty avoided'}</span><b class="num">${pen.big}</b><small>${pen.sub}</small></div>
        </div>
        ${!x.zone && why ? `<p class="note small">${why}</p>` : ''}

        <h2>Points breakdown</h2>
        <ul class="breakdown">
          ${row('Base damage (distance × intensity)', x.parts.base)}
          ${row('Streak bonus', x.parts.streak)}
          ${row('Friends combo', x.parts.group)}
          ${row('Defend bonus (×1.25 in your damaged zones)', x.parts.defend)}
          ${row('New ground claimed', x.claimPts)}
          ${row('Zones broken', x.breakBonus)}
          <li class="total"><span>Total</span><b>+${fmt(x.points)}</b></li>
        </ul>

        ${(x.broken.length || x.healed || x.plan.taken.length || x.plan.dead.length) ? `<h2>Territory</h2><ul class="events">
          ${x.broken.map((n) => `<li>💥 Broke <b>${esc(n)}</b></li>`).join('')}
          ${x.zone && x.plan.dead.length ? `<li>⏳ Took over the ground of ${x.plan.dead.map((z) => `<b>${esc(z.name)}</b>`).join(', ')} (decayed)</li>` : ''}
          ${x.healed ? `<li>🛡 Healed ${x.healedNames.map(esc).join(', ')} by <b>${fmt(x.healed)} HP</b></li>` : ''}
          ${x.zone ? x.plan.taken.map((t) => `<li>🏴 Took <b>${areaParts(t.takenM2).join(' ')}</b> of ${esc(t.zone.ownerName)}’s <b>${esc(t.zone.name)}</b>${t.rest ? '' : ' (the whole zone)'}</li>`).join('') : ''}
        </ul>` : ''}

        <h2>Anti-cheat</h2>
        ${x.flags.length ? `<ul class="events flags">${x.flags.map((f) => `<li>⚠ ${esc(f.text.replace(/\. Damage paused$/, ''))}</li>`).join('')}
          <li class="muted">${x.flaggedKm.toFixed(2)} km excluded from damage.</li></ul>` : '<p class="ok">✅ Clean trip. All distance counted.</p>'}

        ${x.unlocked.length ? `<h2>Badges unlocked</h2><div class="badges">${x.unlocked.map((id) => badgeHtml(id, true)).join('')}</div>` : ''}

        <div class="row gap stick">
          <button class="btn btn-block" id="sum-map">View map</button>
          <button class="btn btn-primary btn-block" id="sum-ranks">Leaderboard</button>
        </div>
      </div>`;
    el.hidden = false; el.scrollTop = 0;
    const leave = (tab) => {
      trackLayer.clearLayers(); fxLayer.clearLayers(); showTab(tab);
      if (tab === 'map' && x.zone) { flashZone(x.zone); map.fitBounds([[x.zone.bbox[1], x.zone.bbox[0]], [x.zone.bbox[3], x.zone.bbox[2]]], { padding: [60, 60], maxZoom: 18 }); }
    };
    $('#sum-map').onclick = () => leave('map');
    $('#sum-ranks').onclick = () => leave('ranks');
    renderTopbar();
  }

  function flashZone(z) {
    if (reducedMotion) return;
    const f = L.geoJSON(z.geo, { renderer, interactive: false, color: '#fff', weight: 3, fillColor: '#fff', fillOpacity: 0.55 }).addTo(fxLayer);
    let op = 0.55;
    const t = setInterval(() => { op -= 0.04; f.setStyle({ fillOpacity: Math.max(0, op), opacity: Math.max(0, op * 1.8) }); if (op <= 0) { clearInterval(t); fxLayer.removeLayer(f); } }, 60);
  }

  function badgeHtml(id, got) {
    const b = W.BADGES[id];
    return `<div class="badge-card ${got ? 'got' : 'locked'}"><span aria-hidden="true">${b.icon}</span><b>${esc(b.name)}</b><small>${esc(b.desc)}</small>${got ? '' : '<em class="sr">locked</em>'}</div>`;
  }

  // ================================================================ zone card

  function openZoneCard(id) {
    const z = zones.get(id), el = $('#zone-card');
    if (!z || run || ui.tab !== 'map') return hideZoneCard();
    ui.card = id;
    const pct = Math.round(100 * hpOf(z) / z.maxHp), mine = isMine(z), dec = W.isDecaying(z);
    const [a, u] = areaParts(z.areaM2);
    el.innerHTML = `<div class="zc-head"><span class="av" style="--c:${zoneColor(z)}">${esc((z.ownerName || '?')[0])}</span>
        <div class="nm"><b>${esc(z.name)}</b><small>${mine ? 'Your zone' : esc(z.ownerName) + (isFriend(z.owner) ? ' · friend' : '')} · ${a} ${u}</small></div>
        <button class="icon-btn" id="zc-close" aria-label="Close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <span class="hpbar"><i style="width:${pct}%;--hp:${hpColor(pct)}"></i></span>
      <p class="small"><b>${fmt(hpOf(z))} / ${fmt(z.maxHp)} HP</b>${dec ? ' · <span class="tag-decay">⏳ decaying</span>' : ''}</p>
      <p class="small muted">${mine ? (pct < 100 ? 'Damaged: walk or ride through it to heal it (×1.25 defend bonus).' : 'Full health. Walking or riding through it counts as patrolling.')
        : `Walk or ride through it to deal damage${dec ? ' (decaying zones take ×1.25)' : ''}. At 0 HP it breaks. Or ride a loop around it: the newest claim wins, so the part inside your loop becomes yours.`}</p>
      ${mine ? '<button class="btn" id="zc-rename">Rename</button>' : ''}`;
    el.hidden = false;
    $('#zc-close').onclick = hideZoneCard;
    if ($('#zc-rename')) $('#zc-rename').onclick = () => {
      const name = (prompt('Zone name', z.name) || '').trim().slice(0, 24);
      if (!name || name === z.name) return;
      Store.updateZone(z.id, { name }).then(() => toast('✏️ Renamed to ' + name, 'good')).catch((e) => toast('⚠ ' + e.message, 'attack'));
    };
  }
  function hideZoneCard() { ui.card = null; $('#zone-card').hidden = true; }

  // ================================================================ leaderboards

  const thisWeek = () => W.weekIndex(W.dayIndex());
  const weekly = (u) => (u.week === thisWeek() ? u.stats.weeklyDamage || 0 : 0);
  const RANK_TABS = [
    { id: 'friends', name: 'Friends', val: (u) => u.stats.totalPoints || 0, unit: 'pts' },
    { id: 'weekly', name: 'Weekly damage', val: weekly, unit: 'dmg' },
    { id: 'territory', name: 'Territory', val: (u) => u.stats.areaM2 || 0, unit: 'area' },
    { id: 'global', name: 'Everyone', val: (u) => u.stats.totalPoints || 0, unit: 'pts' },
  ];
  async function renderRanks() {
    const el = $('#screen-ranks'), tab = RANK_TABS.find((t) => t.id === ui.rankTab);
    const me = { ...P, uid: user.uid, me: true };
    let rows;
    if (tab.id === 'global' && online) {
      if (!globalCache || Date.now() - globalCache.at > 60000) {
        el.innerHTML = '<div class="screen-inner"><h1 id="ranks-title">Leaderboards</h1><p class="muted">Loading…</p></div>';
        try { globalCache = { at: Date.now(), rows: await Store.topUsers(50) }; } catch (e) { globalCache = { at: Date.now(), rows: [] }; toast('⚠ ' + e.message, 'attack'); }
        if (ui.tab !== 'ranks' || ui.rankTab !== 'global') return;
      }
      rows = globalCache.rows.map((u) => (u.uid === user.uid ? me : u));
      if (!rows.some((u) => u.me)) rows.push(me);
    } else rows = [me, ...friends];
    rows = rows.filter((u) => u && u.stats).sort((a, b) => tab.val(b) - tab.val(a));
    const val = (u) => tab.unit === 'area' ? areaParts(tab.val(u)) : [fmt(tab.val(u)), tab.unit];
    el.innerHTML = `<div class="screen-inner">
      <h1 id="ranks-title">Leaderboards</h1>
      <div class="tabs" role="tablist">${RANK_TABS.map((t) => `<button role="tab" aria-selected="${t.id === tab.id}" data-rt="${t.id}">${t.name}</button>`).join('')}</div>
      <p class="muted small">${tab.id === 'weekly' ? 'You and your friends. Resets every Monday.' : tab.id === 'territory' ? 'Area held right now, you and your friends.' : tab.id === 'global' ? (online ? 'Top 50 PedalPace players.' : 'Needs online mode (Firebase).') : 'You and your friends.'}</p>
      <ol class="ranks">${rows.map((u, n) => { const [v, unit] = val(u); return `<li class="${u.me ? 'me' : ''}"><span class="rk">${n < 3 ? ['🥇', '🥈', '🥉'][n] : n + 1}</span>
        <span class="av" style="--c:${W.colorHex(u.color, theme())}">${esc((u.name || '?')[0])}</span>
        <span class="nm"><b>${esc(u.name)}${u.me ? ' (you)' : ''}</b><small>${kmTxt(u.stats.km)} km · streak ${u.stats.streak || 0}</small></span>
        <span class="val"><b>${v}</b><small>${unit}</small></span></li>`; }).join('')}</ol>
      ${!friends.length && tab.id !== 'global' ? `<p class="note small">${online ? 'Add friends from the <b>Friends</b> tab to compete with them here.' : 'Friends and shared leaderboards need online mode. See docs/SETUP_FIREBASE.md.'}</p>` : ''}
    </div>`;
    $$('#screen-ranks [data-rt]').forEach((b) => (b.onclick = () => { ui.rankTab = b.dataset.rt; renderRanks(); }));
  }

  // ================================================================ friends

  async function loadFriends() {
    if (!online) return;
    try { friends = P.friends && P.friends.length ? await Store.getUsers(P.friends) : []; } catch (e) { console.warn(e); }
    if (subs.live) subs.live();
    subs.live = P.friends && P.friends.length ? Store.watchLive(P.friends, (l) => { live = l; renderFriendsLive(); }) : null;
    if (!P.friends || !P.friends.length) { live = {}; renderFriendsLive(); }
    if (ui.tab === 'friends') renderFriends();
    if (ui.tab === 'ranks') renderRanks();
    renderTerritory();
  }

  function lastActive(u) {
    const l = live[u.uid];
    if (l && l.recording && Date.now() - l.ts < 120000) return `<span class="live-tag">● on a ${l.mode === 'cycle' ? 'ride' : 'walk'} now</span>`;
    const d = W.dayIndex() - (u.activeDay == null ? -1e9 : u.activeDay);
    return d <= 0 ? 'active today' : d === 1 ? 'active yesterday' : d < 1000 ? `active ${d} days ago` : 'no trips yet';
  }

  function inviteLink() { return `${location.origin}${location.pathname}?add=${P.code}`; }

  function renderFriends() {
    const el = $('#screen-friends');
    if (!online) {
      el.innerHTML = `<div class="screen-inner"><h1 id="friends-title">Friends</h1>
        <div class="note"><p><b>You’re playing offline.</b> Progress is saved on this device only.</p>
        <p>To add friends, see their zones and live positions, and get the combo bonus for riding together, connect the free Firebase back end: follow <b>docs/SETUP_FIREBASE.md</b> and paste your config into <b>js/config.js</b>.</p></div></div>`;
      return;
    }
    const list = friends.slice().sort((a, b) => (b.stats.totalPoints || 0) - (a.stats.totalPoints || 0));
    el.innerHTML = `<div class="screen-inner">
      <h1 id="friends-title">Friends</h1>
      <div class="note code-card">
        <span class="lbl">Your friend code</span>
        <div class="code">${esc(P.code)}</div>
        <div class="row gap wrap"><button class="btn" id="fr-copy">Copy code</button><button class="btn btn-primary" id="fr-share">Share invite link</button></div>
      </div>
      <form class="add-friend" id="fr-form" autocomplete="off">
        <label class="field"><span>Add a friend by code</span>
          <div class="row gap"><input id="fr-code" maxlength="6" placeholder="e.g. K7Q2MX" autocapitalize="characters" value="${esc(pendingAddUsed ? '' : pendingAdd)}"/><button class="btn btn-primary" type="submit">Add</button></div></label>
      </form>
      <h2>Your friends (${list.length})</h2>
      <ul class="zone-list">${list.map((u) => `<li class="friend-row"><span class="av" style="--c:${W.colorHex(u.color, theme())}">${esc((u.name || '?')[0])}</span>
        <span class="nm"><b>${esc(u.name)}</b><small>${lastActive(u)} · ${areaParts(u.stats.areaM2 || 0).join(' ')}</small></span>
        <span class="val"><b>${fmt(u.stats.totalPoints || 0)}</b><small>pts</small></span>
        <button class="icon-btn sm" data-fly="${u.uid}" aria-label="Show ${esc(u.name)} on the map" title="Show on map"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="9" r="2.5"/></svg></button>
        <button class="icon-btn sm" data-rm="${u.uid}" aria-label="Remove ${esc(u.name)}" title="Remove"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></li>`).join('') || '<li class="muted">No friends yet. Share your code!</li>'}</ul>
      <div class="note"><b>Playing with friends</b><ul>
        <li>You see each other’s zones and live position on the map while on a trip.</li>
        <li>Friends are still rivals: walking or riding through their zones damages them, and vice versa.</li>
        <li>Go together: each friend on a trip within ${R.GROUP_RADIUS_M} m of you adds a combo (×1.2, ×1.35, ×1.5).</li></ul></div>
    </div>`;
    $('#fr-copy').onclick = () => copy(P.code, 'Code copied');
    $('#fr-share').onclick = async () => {
      const text = `Play PedalPace with me! Walk or ride to claim territory. My friend code: ${P.code}`;
      if (navigator.share) { try { await navigator.share({ title: 'PedalPace', text, url: inviteLink() }); return; } catch (e) { if (e.name === 'AbortError') return; } }
      copy(inviteLink(), 'Invite link copied');
    };
    $('#fr-form').onsubmit = (e) => { e.preventDefault(); addFriendByCode($('#fr-code').value); };
    $$('#screen-friends [data-rm]').forEach((b) => (b.onclick = async () => {
      const u = friends.find((f) => f.uid === b.dataset.rm);
      if (!u || !confirm(`Remove ${u.name} from your friends?`)) return;
      try { await Store.removeFriend(user.uid, u.uid); P.friends = P.friends.filter((x) => x !== u.uid); loadFriends(); } catch (err) { toast('⚠ ' + err.message, 'attack'); }
    }));
    $$('#screen-friends [data-fly]').forEach((b) => (b.onclick = () => flyToFriend(b.dataset.fly)));
  }
  let pendingAddUsed = false;

  function copy(text, done) {
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast('📋 ' + done, 'good'), () => prompt('Copy this:', text));
    else prompt('Copy this:', text);
  }

  async function addFriendByCode(raw) {
    const code = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length !== 6) { toast('A friend code has 6 letters and numbers.', 'attack'); return; }
    if (code === P.code) { toast('That’s your own code 🙂'); return; }
    try {
      const u = await Store.findUserByCode(code);
      if (!u) { toast(`No player has the code ${code}.`, 'attack'); return; }
      if ((P.friends || []).includes(u.uid)) { toast(`${u.name} is already your friend.`); return; }
      await Store.addFriend(user.uid, u.uid);
      P.friends = [...(P.friends || []), u.uid];
      Store.sendNotif(u.uid, { type: 'friend', text: `${P.name} added you as a friend. You can see each other on the map now.` }).catch(() => {});
      toast(`👥 ${u.name} added!`, 'good');
      loadFriends();
    } catch (e) { toast('⚠ ' + e.message, 'attack'); }
  }

  function flyToFriend(id) {
    const l = live[id];
    if (l && Date.now() - l.ts < 120000) { showTab('map'); follow = false; map.setView([l.lat, l.lng], 17); return; }
    const theirs = zoneList().filter((z) => z.owner === id);
    if (theirs.length) {
      showTab('map'); follow = false;
      const b = theirs.reduce((a, z) => [Math.min(a[0], z.bbox[0]), Math.min(a[1], z.bbox[1]), Math.max(a[2], z.bbox[2]), Math.max(a[3], z.bbox[3])], [180, 90, -180, -90]);
      map.fitBounds([[b[1], b[0]], [b[3], b[2]]], { padding: [50, 50], maxZoom: 18 });
      return;
    }
    toast('They have no zones near you and aren’t on a trip right now.');
  }

  // ================================================================ profile

  function renderProfile() {
    const st = P.stats, el = $('#screen-profile');
    const met = P.metDay === P.today.day;
    const nextPen = R.inactivityPenalty(st.missedDays + 1);
    const [aV, aU] = areaParts(st.areaM2 || 0);
    el.innerHTML = `<div class="screen-inner">
      <div class="prof-head">${P.photo ? `<img class="av big" src="${esc(P.photo)}" alt="" referrerpolicy="no-referrer">` : `<span class="av big" style="--c:${myColor()}">${esc(P.name[0] || '?')}</span>`}
        <div><h1 id="prof-title">${esc(P.name)}</h1><p class="muted">${online ? 'Friend code ' + esc(P.code) : 'Offline mode'} · ${st.activities} trips</p></div></div>
      ${accountCard()}
      <div class="tiles">
        <div class="tile"><span class="lbl">Total points</span><b class="num">${fmt(st.totalPoints)}</b></div>
        <div class="tile"><span class="lbl">Damage dealt</span><b class="num">${fmt(st.damageDealt)}</b></div>
        <div class="tile warn"><span class="lbl">Lost to inactivity</span><b class="num">${st.pointsLost ? '−' + fmt(st.pointsLost) : '0'}</b></div>
        <div class="tile"><span class="lbl">Streak</span><b class="num">${st.streak}<em>days</em></b><small>best ${st.bestStreak}</small></div>
        <div class="tile"><span class="lbl">Territory</span><b class="num">${aV}<em>${aU}</em></b><small>${kmTxt(st.km)} km travelled</small></div>
        <div class="tile"><span class="lbl">Rest tokens</span><b class="num">${st.restTokens}</b><small>1 per week</small></div>
      </div>

      <h2>Today</h2>
      <div class="note">
        <p>${met ? '<b class="ok">Daily minimum met ✓ No penalty tonight.</b>' : `<b>${Math.round(100 * Math.min(1, R.minimumProgress(P.today.walkMin, P.today.cycleKm)))}%</b> of today’s minimum (15 min walking or 5 km cycling). Missing today costs <b>−${nextPen}</b>.`}</p>
        <p class="small muted">Penalty ladder: −5, −10, −20, −40, then −50/day max. Your zones start decaying after ${R.DECAY_START_DAY} days without a trip.</p>
        ${met ? '' : `<button class="btn" id="use-token" ${st.restTokens ? '' : 'disabled'}>😴 Use a rest token for today</button>`}
      </div>

      <h2>Badges</h2>
      <div class="badges">${Object.keys(W.BADGES).map((id) => badgeHtml(id, !!P.badges[id])).join('')}</div>

      <h2>Recent trips</h2>
      <ul class="events">${P.history.length ? P.history.slice(0, 8).map((h) => `<li>${h.mode === 'cycle' ? '🚴' : '🚶'} <b>${h.km.toFixed(2)} km</b> · +${fmt(h.points)} pts${h.areaM2 ? ` · ${areaParts(h.areaM2).join(' ')} claimed` : ''}${h.flags ? ` · ⚠ ${h.flags}` : ''}${h.sim ? ' · 🧪' : ''} <small class="muted">${ago(h.ts)}</small></li>`).join('') : '<li class="muted">No trips yet. Tap GO.</li>'}</ul>

      <h2>Settings</h2>
      <div class="settings">
        <label class="field"><span>Name</span><div class="row gap"><input id="set-name" maxlength="14" value="${esc(P.name)}"/><button class="btn" id="set-name-save">Save</button></div></label>
        <div class="opt-row"><span class="opt-label">Colour</span><div class="swatches">${W.PLAYER_COLORS.map((c) => `<button class="sw ${P.color === c ? 'on' : ''}" data-col="${c}" style="--c:${W.colorHex(c, theme())}" aria-label="${W.COLORS[c].name}" aria-pressed="${P.color === c}"></button>`).join('')}</div></div>
        <div class="opt-row"><span class="opt-label" id="lbl-style">Map type</span><div class="seg" role="radiogroup" aria-labelledby="lbl-style" id="set-style">
          ${['satellite', 'streets', 'dark'].map((s) => `<button role="radio" data-v="${s}" aria-checked="${settings().mapStyle === s}">${{ satellite: 'Satellite', streets: 'Map', dark: 'Dark' }[s]}</button>`).join('')}</div></div>
        <label class="switch-row"><span>☀️ Sunlight mode (high contrast)</span><input type="checkbox" id="set-sun" ${settings().sunlight ? 'checked' : ''}/><i aria-hidden="true"></i></label>
        <label class="switch-row"><span>Notification pop-ups</span><input type="checkbox" id="set-notif" ${settings().notifications ? 'checked' : ''}/><i aria-hidden="true"></i></label>
        ${online ? '<button class="btn btn-block" id="set-out">Sign out</button>' : '<button class="btn btn-block" id="set-reset">Reset all progress</button>'}
      </div>
    </div>`;
    if ($('#use-token')) $('#use-token').onclick = async () => {
      const why = W.useRestToken(P);
      if (why) { toast(why); return; }
      P.activeDay = W.dayIndex();
      await touchMyZones(true);
      saveP(); renderTopbar(); renderProfile();
      toast('😴 Rest day logged. Streak kept, no penalty, zones safe.', 'good');
    };
    $('#set-name-save').onclick = () => {
      const n = $('#set-name').value.trim().slice(0, 14);
      if (!n) return;
      P.name = n; saveP(); updateMyZones({ ownerName: n }); renderProfile(); toast('✏️ Name saved', 'good');
    };
    $$('#screen-profile [data-col]').forEach((b) => (b.onclick = () => { P.color = b.dataset.col; saveP(); updateMyZones({ color: P.color }); applyTheme(); renderProfile(); }));
    $('#set-style').onclick = (e) => { const b = e.target.closest('button'); if (b) { setMapStyle(b.dataset.v); renderProfile(); } };
    $('#set-sun').onchange = (e) => { P.settings.sunlight = e.target.checked; saveP(); applyTheme(); renderProfile(); };
    $('#set-notif').onchange = (e) => { P.settings.notifications = e.target.checked; saveP(); };
    if ($('#set-out')) $('#set-out').onclick = () => { if (!run) Store.signOut(); };
    if ($('#set-reset')) $('#set-reset').onclick = async () => { if (confirm('Delete all your zones and progress on this device?')) { await Store.resetLocal(); location.reload(); } };
    if ($('#acct-link')) $('#acct-link').onclick = linkGoogle;
  }

  function accountCard() {
    if (!online) return '<div class="note account"><div class="acct-txt"><b>Offline mode</b><small>Saved on this device only. Set up Firebase to play with friends (docs/SETUP_FIREBASE.md).</small></div></div>';
    if (user.anonymous) {
      return `<div class="note account col"><div class="acct-txt"><b>Playing as a guest</b><small>Link a Google account to keep your progress if you change phone or clear the browser.</small></div>
        <button class="btn btn-google" id="acct-link">${GOOGLE_G} Link Google account</button></div>`;
    }
    return `<div class="note account">${P.photo ? `<img class="acct-pic" src="${esc(P.photo)}" alt="" referrerpolicy="no-referrer">` : ''}
      <div class="acct-txt"><b>${esc(user.name || P.name)}</b><small>${esc(user.email || '')} · Google</small></div></div>`;
  }

  async function linkGoogle() {
    try {
      const res = await Store.linkGoogle();
      const u = res && res.user;
      if (u) { user = { ...user, anonymous: false, name: u.displayName || '', email: u.email || '' }; if (!P.photo && u.photoURL) P.photo = u.photoURL; saveP(); }
      toast('✅ Google account linked. Your progress is safe.', 'good');
      renderProfile();
    } catch (e) {
      toast(e.code === 'auth/credential-already-in-use' ? 'That Google account already has a PedalPace profile. Sign out, then sign in with Google to use it.' : '⚠ ' + e.message, 'attack');
    }
  }

  /** Copy a name or colour change onto every zone you own. */
  async function updateMyZones(patch) {
    try { for (const z of await Store.myZones(user.uid)) Store.updateZone(z.id, patch).catch((e) => console.warn(e)); } catch (e) { console.warn(e); }
  }
  function setMapStyle(s) { P.settings.mapStyle = s; saveP(); setTiles(); renderTerritory(); $('#layers').hidden = true; }

  function saveP() {
    if (!user || !P) return;
    const first = isNewProfile;
    isNewProfile = false;
    Store.saveProfile(user.uid, P, first).catch((e) => { if (first) isNewProfile = true; toast('⚠ Could not save progress: ' + e.message, 'attack'); });
  }

  // ================================================================ day cycle

  function runDayTick() {
    const today = W.dayIndex();
    if (P.lastTickDay >= today) return;
    const rep = W.tickDays(P, today);
    if (rep.penalty) notifySelf('penalty', `Missed ${rep.missed} day${rep.missed === 1 ? '' : 's'}: −${rep.penalty} pts. Next missed day costs −${R.inactivityPenalty(P.stats.missedDays + 1)}.`);
    if (rep.newWeek) notifySelf('info', 'New week! Rest token refilled and weekly damage reset.');
    notifySelf('streak', P.stats.streak > 0
      ? `Keep your ${P.stats.streak}-day streak 🔥 15 min walking or 5 km cycling today.`
      : 'Start a streak today: 15 min walking or 5 km cycling.');
    saveP(); renderTopbar();
    renderTerritory(); // decay moves on with the calendar
  }
  function checkDay() { if (started && P && !run) runDayTick(); }
  setInterval(checkDay, 60000);

  // ================================================================ sign-in, onboarding, start

  const GOOGLE_G = '<svg class="g" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';

  async function onAuth(u) {
    $('#loading').hidden = true;
    if (!u) { teardown(); user = null; P = null; renderOnboarding(obStep >= 3 ? 3 : 0); return; }
    if (user && user.uid === u.uid && P) { user = u; return; } // token refresh / link
    teardown();
    user = u;
    try { P = await Store.loadProfile(u.uid); } catch (e) { showFatal('Could not load your profile: ' + e.message); return; }
    isNewProfile = !P;
    if (!P) P = W.newProfile({ name: (u.name || '').split(' ')[0].slice(0, 14), color: W.PLAYER_COLORS[Math.floor(Math.random() * 4)], photo: u.photo });
    P.settings = { sunlight: false, notifications: true, mapStyle: 'satellite', ...(P.settings || {}) };
    P.friends = P.friends || [];
    if (!P.photo && u.photo) P.photo = u.photo;
    applyTheme();
    if (!P.onboarded) renderOnboarding(online || obStep >= 2 ? 4 : 0);
    else startGame();
  }

  function teardown() {
    for (const k of Object.keys(subs)) { if (subs[k]) subs[k](); delete subs[k]; }
    started = false; zoneCenter = null; zones = new Map(); friends = []; live = {}; notifs = [];
    renderTerritory(); renderFriendsLive();
  }

  function startGame() {
    $('#screen-onboarding').hidden = true;
    started = true; bootTs = Date.now();
    applyTheme();
    subs.notifs = Store.watchNotifs(user.uid, onNotifs);
    if (online) subs.profile = Store.watchProfile(user.uid, (d) => {
      const f = d.friends || [];
      if (JSON.stringify(f) !== JSON.stringify(P.friends)) { P.friends = f; loadFriends(); }
    });
    runDayTick();
    startGeo();
    const at = pos || readLastPos();
    if (at) ensureZones(at.lat, at.lng); else { const c = map.getCenter(); ensureZones(c.lat, c.lng); }
    touchMyZones(false).then(saveP);
    loadFriends();
    renderTopbar();
    showTab('map');
    if (pendingAdd && online && !pendingAddUsed) { pendingAddUsed = true; showTab('friends'); addFriendByCode(pendingAdd); }
  }

  function renderOnboarding(step) {
    obStep = step;
    const el = $('#screen-onboarding');
    setChrome('none');
    const total = online ? 5 : 4;
    const dotIdx = online ? step : step === 4 ? 3 : step;
    const steps = {
      0: `<div class="ob-art art-map" aria-hidden="true"><i class="z z1"></i><i class="z z2"></i><i class="z z3"></i><i class="trail"></i></div>
       <p class="eyebrow">Welcome to</p><h1 class="logo">PEDAL<span>PACE</span></h1>
       <p class="lead">Walk it. Ride it. <b>Own it.</b></p>
       <p>Start a trip and your route is drawn on the real map behind you. Tap <b>End</b> and the app joins your end point back to your start: the whole shape becomes <b>your zone</b>.</p>`,
      1: `<div class="ob-art art-fight" aria-hidden="true"><span class="hp"><i></i></span><span class="pop">⚔ 12</span></div>
       <h1>Attack &amp; defend</h1>
       <p>Walking or riding through another player’s zone <b>deals damage</b>. Break it to 0 HP and its ground is free, so loop around it to take it.</p>
       <div class="formula">Damage = distance × intensity</div>
       <ul class="ticks"><li>🚶 Walking: 1.0× base · 1.3× brisk · 1.5× uphill</li><li>🚴 Cycling: 0.4× base + sustained-speed bonuses</li><li>Balanced so a 30-min walk and a 30-min ride score about the same</li></ul>`,
      2: `<div class="ob-art art-ladder" aria-hidden="true"><span>−5</span><span>−10</span><span>−20</span><span>−40</span><span>−50</span></div>
       <h1>Stay active, not overtrained</h1>
       <p>Days without a trip cost points, starting small and <b>capped at −50/day</b>. Zones of inactive players decay.</p>
       <ul class="ticks"><li>✅ Daily minimum: <b>15 min walking</b> or <b>5 km cycling</b></li><li>😴 <b>1 rest token per week</b>: recovery days are never punished</li><li>🔥 Streaks add up to +20% damage</li></ul>`,
      3: `<h1>Sign in</h1>
       <p>Your zones, points and friends are saved online, so friends can see and fight over your territory.</p>
       <button class="btn btn-google btn-block" id="ob-google">${GOOGLE_G} Continue with Google</button>
       <button class="btn btn-block" id="ob-guest">Play as a guest</button>
       <p class="small muted">Guests can link a Google account later from Profile.</p>`,
      4: P ? `<h1>Make your player</h1>
       <label class="field"><span>Name</span><input id="ob-name" maxlength="14" value="${esc(P.name === 'Player' ? '' : P.name)}" placeholder="e.g. Sam" autocomplete="nickname"/></label>
       <div class="field"><span>Territory colour</span><div class="swatches">${W.PLAYER_COLORS.map((c) => `<button class="sw ${P.color === c ? 'on' : ''}" data-col="${c}" style="--c:${W.COLORS[c].neon}" aria-label="${W.COLORS[c].name}" aria-pressed="${P.color === c}"></button>`).join('')}</div></div>
       <div class="field"><span>Your location</span>
         <button class="btn" id="ob-loc">📍 Allow location</button>
         <small class="muted" id="ob-loc-note">${geo.state === 'ok' ? '✓ Found you. The map starts where you are.' : 'The map starts where you are, and trips are tracked with GPS. Your position is only shared with friends while you’re on a trip.'}</small></div>` : '',
    };
    el.innerHTML = `<div class="screen-inner ob">
      ${steps[step]}
      <div class="ob-nav">
        <div class="dots" aria-label="Step ${dotIdx + 1} of ${total}">${Array.from({ length: total }, (_, n) => `<i class="${n === dotIdx ? 'on' : ''}"></i>`).join('')}</div>
        <div class="row gap">
          ${step === 0 ? '<button class="btn btn-ghost" id="ob-skip">Skip</button>' : step < 3 || (step === 4 && !online) ? '<button class="btn" id="ob-back">Back</button>' : ''}
          ${step === 3 ? '' : `<button class="btn btn-primary" id="ob-next">${step === 4 ? 'Let’s go' : 'Next'}</button>`}
        </div>
      </div></div>`;
    el.hidden = false;
    const afterIntro = () => renderOnboarding(online && !user ? 3 : 4);
    if ($('#ob-next')) $('#ob-next').onclick = () => { if (step < 2) renderOnboarding(step + 1); else if (step === 2) afterIntro(); else finishOnboarding(); };
    if ($('#ob-back')) $('#ob-back').onclick = () => renderOnboarding(step === 4 ? 2 : step - 1);
    if ($('#ob-skip')) $('#ob-skip').onclick = afterIntro;
    if (step === 3) {
      $('#ob-google').onclick = async () => { try { await Store.signInGoogle(); } catch (e) { if (e.code !== 'auth/popup-closed-by-user') toast('⚠ ' + e.message, 'attack'); } };
      $('#ob-guest').onclick = async () => { try { await Store.signInGuest(); } catch (e) { toast('⚠ ' + (e.code === 'auth/admin-restricted-operation' ? 'Guest sign-in is turned off in Firebase (Authentication → Sign-in method → Anonymous).' : e.message), 'attack'); } };
    }
    if (step === 4) {
      const keep = () => { const n = $('#ob-name').value.trim(); if (n) P.name = n.slice(0, 14); };
      $$('#screen-onboarding [data-col]').forEach((b) => (b.onclick = () => { keep(); P.color = b.dataset.col; applyTheme(); renderOnboarding(4); }));
      $('#ob-loc').onclick = async () => {
        keep();
        $('#ob-loc-note').textContent = '📡 Finding you… (allow location access when the browser asks)';
        try { const p = await Sim.locateOnce(); map.setView([p.lat, p.lng], 17); startGeo(); $('#ob-loc-note').textContent = `✓ Found you (±${Math.round(p.acc)} m). The map starts where you are.`; }
        catch (e) { $('#ob-loc-note').textContent = '⚠ ' + e.message; }
      };
    }
  }

  function finishOnboarding() {
    const n = $('#ob-name') && $('#ob-name').value.trim();
    P.name = (n || P.name || 'Player').slice(0, 14);
    P.onboarded = true;
    saveP();
    startGame();
    setTimeout(() => toast('🚴 Tap GO to start your first trip. Ride or walk a loop, then tap End to claim it.', 'good'), 600);
  }

  function showFatal(msg) {
    $('#loading').hidden = false;
    $('#loading').innerHTML = `<div class="note"><p><b>Something went wrong</b></p><p class="small">${esc(msg)}</p><button class="btn" onclick="location.reload()">Reload</button></div>`;
  }

  // ================================================================ wiring

  function wire() {
    $$('#tabbar [role=tab]').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
    $('#btn-start').onclick = openStart;
    $('#btn-bell').onclick = openNotifs;
    $('#btn-sun').onclick = () => { P.settings.sunlight = !P.settings.sunlight; saveP(); applyTheme(); if (ui.tab !== 'map') showTab(ui.tab); };
    $('#tb-daily').onclick = () => {
      toast(P.metDay === P.today.day ? 'Daily minimum met ✓ No penalty tonight.'
        : `Daily minimum: ${P.today.walkMin.toFixed(0)}/15 min walking or ${P.today.cycleKm.toFixed(1)}/5 km cycling. Missing today costs −${R.inactivityPenalty(P.stats.missedDays + 1)}.`);
    };
    $('#btn-locate').onclick = () => {
      follow = true;
      if (pos) map.setView([pos.lat, pos.lng], Math.max(map.getZoom(), 17));
      else { retryGeo(); toast('📡 Finding your location…'); }
    };
    $('#btn-legend').onclick = () => { const l = $('#legend'); $('#layers').hidden = true; l.hidden = !l.hidden; $('#btn-legend').setAttribute('aria-expanded', String(!l.hidden)); };
    $('#btn-layers').onclick = () => { const l = $('#layers'); $('#legend').hidden = true; l.hidden = !l.hidden; $('#btn-layers').setAttribute('aria-expanded', String(!l.hidden)); };
    $$('#layers [data-style]').forEach((b) => (b.onclick = () => setMapStyle(b.dataset.style)));
    $$('[data-close]').forEach((b) => (b.onclick = closeSheets));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeSheets(); hideZoneCard(); } });

    $('#opt-mode').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { ui.mode = b.dataset.v; renderStartSheet(); } });
    $('#btn-go').onclick = startTrip;
    $('#btn-test').onclick = startDraw;

    $('#draw-speed').oninput = (e) => ($('#draw-speed-v').textContent = e.target.value);
    $('#draw-undo').onclick = () => { draw.pts.pop(); updateDraw(); };
    $('#draw-cancel').onclick = () => { endDraw(); setChrome('nav'); };
    $('#draw-go').onclick = () => {
      const kmh = +$('#draw-speed').value, pts = draw.pts.slice();
      endDraw();
      Geo.setOrigin({ lat: pts[0][0], lng: pts[0][1] });
      const sc = Sim.customScenario(pts.map((p) => Geo.toXY(p[0], p[1])), kmh > 9 ? 'cycle' : 'walk', kmh);
      beginRun({ sim: true, sc, start: pts[0] });
    };

    $('#r-pause').onclick = () => {
      if (!run) return;
      run.paused = !run.paused;
      if (run.live) run.live.pause(run.paused);
      $('#r-pause').textContent = run.paused ? '▶' : '❚❚';
      $('#r-pause').setAttribute('aria-label', run.paused ? 'Resume' : 'Pause');
      renderHud();
    };
    $('#r-center').onclick = () => { follow = true; if (run && run.last) map.panTo(run.last); };
    $('#r-finish').onclick = openEndSheet;
    $('#end-keep').onclick = () => { $('#sheet-end').hidden = true; };
    $('#end-ok').onclick = finishTrip;
  }

  wire();
  applyTheme();
  Store.init(onAuth).catch((e) => showFatal('Could not connect to Firebase. Check your internet connection and js/config.js. (' + e.message + ')'));
  // Exposed for debugging and automated checks.
  window.PedalPace = { get profile() { return P; }, get zones() { return zones; }, get run() { return run; }, map, beginRun, finishTrip, showTab };
})();
