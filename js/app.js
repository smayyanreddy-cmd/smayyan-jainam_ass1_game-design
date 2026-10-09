/* PedalPace — UI controller: map rendering, screens, recording loop. */
(function () {
  'use strict';
  const R = window.Rules, W = window.World, Sim = window.Sim, Geo = W.Geo;
  const $ = (sel, el) => (el || document).querySelector(sel);
  const $$ = (sel, el) => [...(el || document).querySelectorAll(sel)];
  const fmt = (n) => Math.round(n).toLocaleString('en-US');
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const reducedMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  let S = W.load();
  const ui = { tab: 'map', scenario: 'claim', mode: 'auto', group: 1, speed: S.settings.playback || 20, hr: S.player.hr };

  // ================================================================ map

  const map = L.map('map', { zoomControl: false, preferCanvas: true, attributionControl: true })
    .setView(Geo.toLL(250, 150), 15);
  const renderer = L.canvas({ padding: 0.3 });
  map.createPane('labels').style.zIndex = 450; // street names above territory fills
  map.getPane('labels').style.pointerEvents = 'none';
  // Esri Canvas basemaps: free, keyless, muted, so neon territory pops.
  const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/';
  const TILES = {
    neon: ['World_Dark_Gray_Base', 'World_Dark_Gray_Reference'],
    sun: ['World_Light_Gray_Base', 'World_Light_Gray_Reference'],
  };
  let tiles = [];
  function setTiles() {
    tiles.forEach((t) => map.removeLayer(t));
    const opts = { maxNativeZoom: 16, maxZoom: 19 };
    tiles = [
      L.tileLayer(ESRI + TILES[theme()][0] + '/MapServer/tile/{z}/{y}/{x}', { ...opts, attribution: 'Tiles &copy; Esri, HERE, Garmin, &copy; OpenStreetMap contributors' }),
      L.tileLayer(ESRI + TILES[theme()][1] + '/MapServer/tile/{z}/{y}/{x}', { ...opts, pane: 'labels', opacity: theme() === 'sun' ? 1 : 0.75 }),
    ];
    tiles.forEach((t) => t.addTo(map));
  }
  const zoneLayer = L.layerGroup().addTo(map);
  const labelLayer = L.layerGroup().addTo(map);
  const trackLayer = L.layerGroup().addTo(map);
  const fxLayer = L.layerGroup().addTo(map);
  const zoneViews = {};

  const theme = () => (S.settings.sunlight ? 'sun' : 'neon');
  const colorOf = (ownerId) => {
    const p = S.players[ownerId];
    return W.COLORS[(p && p.color) || 'cyan'][theme()];
  };
  const myColor = () => colorOf('you');

  function zoneStatus(z) {
    const owner = S.players[z.owner];
    const decaying = owner && owner.inactiveDays >= R.DECAY_START_DAY;
    return { decaying, damaged: z.hp < z.maxHp, friendly: W.isFriendly(S, z.owner), mine: z.owner === 'you' };
  }

  function renderTerritory() {
    zoneLayer.clearLayers(); labelLayer.clearLayers();
    for (const k in zoneViews) delete zoneViews[k];
    const sun = theme() === 'sun';

    // Neutral cells
    const neutralKeys = Object.keys(S.neutral);
    for (const k of neutralKeys) {
      const [i, j] = Geo.parse(k);
      L.rectangle(Geo.cellBoundsLL(i, j), { renderer, stroke: false, fillColor: sun ? '#555' : '#8A93A6', fillOpacity: sun ? 0.22 : 0.18, interactive: false }).addTo(zoneLayer);
    }
    if (neutralKeys.length) {
      const set = new Set(neutralKeys);
      L.polyline(outline(set), { renderer, color: sun ? '#333' : '#AEB6C6', weight: 2, dashArray: '4 6', interactive: false }).addTo(zoneLayer);
    }

    for (const z of Object.values(S.zones)) {
      const col = colorOf(z.owner), st = zoneStatus(z);
      const rects = z.cells.map((k) => {
        const [i, j] = Geo.parse(k);
        return L.rectangle(Geo.cellBoundsLL(i, j), { renderer, stroke: false, fillColor: col, fillOpacity: fillFor(z), interactive: false }).addTo(zoneLayer);
      });
      const segs = outline(new Set(z.cells));
      if (!sun) L.polyline(segs, { renderer, color: col, weight: 10, opacity: 0.22, interactive: false }).addTo(zoneLayer);
      else L.polyline(segs, { renderer, color: '#000', weight: 6, opacity: 0.85, interactive: false }).addTo(zoneLayer);
      L.polyline(segs, { renderer, color: col, weight: sun ? 3.5 : 3, dashArray: st.decaying ? '8 7' : null, interactive: false }).addTo(zoneLayer);

      const icon = L.divIcon({ className: 'zl-wrap', html: labelHtml(z), iconSize: null });
      const m = L.marker(centroid(z), { icon, keyboard: false, interactive: false }).addTo(labelLayer);
      zoneViews[z.id] = { rects, marker: m };
    }
    renderLegend();
  }

  const hpColor = (pct) => (pct > 60 ? '#3DFF9A' : pct > 30 ? '#FFC531' : '#FF3B5C');

  function fillFor(z) { return (theme() === 'sun' ? 0.18 : 0.10) + 0.32 * Math.max(0, z.hp) / z.maxHp; }

  function labelHtml(z) {
    const st = zoneStatus(z), p = S.players[z.owner];
    const pct = Math.max(0, Math.round(100 * z.hp / z.maxHp));
    const who = z.owner === 'you' ? 'You' : esc(p.name) + (st.friendly ? ' · clan' : '');
    const tags = (st.decaying ? '<em class="tag-decay">⏳ decaying</em>' : '') + (st.friendly && st.damaged ? '<em class="tag-hit">⚔ damaged</em>' : '');
    return `<div class="zl ${st.friendly ? 'zl-friend' : 'zl-enemy'}" data-zone="${z.id}" style="--c:${colorOf(z.owner)}">
      <div class="zl-name"><i class="dot"></i>${esc(z.name)}</div>
      <div class="zl-who">${who}</div>
      <div class="hpbar" role="img" aria-label="Health ${pct}%"><i style="width:${pct}%;--hp:${hpColor(pct)}"></i></div>
      <div class="zl-hp">${fmt(Math.max(0, z.hp))} / ${fmt(z.maxHp)} HP</div>${tags}</div>`;
  }

  function updateZoneVisual(z) {
    const v = zoneViews[z.id];
    if (!v) return;
    const op = fillFor(z);
    for (const r of v.rects) r.setStyle({ fillOpacity: op });
    const el = v.marker.getElement();
    if (el) el.innerHTML = labelHtml(z);
  }

  /** Boundary segments of a set of cells (edges whose neighbour isn't in the set). */
  function outline(set) {
    const segs = [];
    for (const k of set) {
      const [i, j] = Geo.parse(k);
      const x0 = j * Geo.CELL, x1 = (j + 1) * Geo.CELL, y0 = i * Geo.CELL, y1 = (i + 1) * Geo.CELL;
      if (!set.has(Geo.key(i + 1, j))) segs.push([Geo.toLL(x0, y1), Geo.toLL(x1, y1)]);
      if (!set.has(Geo.key(i - 1, j))) segs.push([Geo.toLL(x0, y0), Geo.toLL(x1, y0)]);
      if (!set.has(Geo.key(i, j + 1))) segs.push([Geo.toLL(x1, y0), Geo.toLL(x1, y1)]);
      if (!set.has(Geo.key(i, j - 1))) segs.push([Geo.toLL(x0, y0), Geo.toLL(x0, y1)]);
    }
    return segs;
  }

  function centroid(z) {
    let sx = 0, sy = 0;
    for (const k of z.cells) { const [i, j] = Geo.parse(k); sx += (j + 0.5) * Geo.CELL; sy += (i + 0.5) * Geo.CELL; }
    return Geo.toLL(sx / z.cells.length, sy / z.cells.length);
  }

  function renderLegend() {
    const rows = [['you', 'Your territory'], ...Object.values(S.players).filter((p) => p.id !== 'you').map((p) => [p.id, `${p.name} (${W.isFriendly(S, p.id) ? 'clan mate' : 'rival'})`])];
    $('#legend').innerHTML = '<b>Legend</b>' + rows.map(([id, t]) => `<div class="lg-row"><i style="background:${colorOf(id)}"></i>${esc(t)}</div>`).join('') +
      '<div class="lg-row"><i class="lg-neutral"></i>Neutral: claim it with a loop</div><div class="lg-row"><i class="lg-dash"></i>Dashed edge = decaying</div><div class="lg-row small muted">Brighter fill = more HP</div>';
  }

  map.on('zoomend', () => $('#app').classList.toggle('far', map.getZoom() < 15));

  // ================================================================ theme

  function applyTheme() {
    document.documentElement.dataset.theme = theme();
    document.documentElement.style.setProperty('--me', myColor());
    $('meta[name=theme-color]').setAttribute('content', theme() === 'sun' ? '#FFFFFF' : '#0B0F17');
    $('#btn-sun').setAttribute('aria-pressed', String(S.settings.sunlight));
    setTiles(); renderTerritory();
  }

  // ================================================================ top bar & nav

  function renderTopbar() {
    const st = S.stats;
    $('#tb-points').textContent = fmt(st.totalPoints);
    $('#tb-streak').textContent = st.streak;
    const p = Math.min(1, R.minimumProgress(st.todayWalkMin, st.todayCycleKm));
    $('#tb-ring').style.strokeDashoffset = String(94.25 * (1 - p));
    $('#tb-daily-txt').textContent = st.todayMet ? '✓' : Math.round(p * 100) + '%';
    $('#tb-daily').classList.toggle('met', st.todayMet);
    const unread = S.notifications.filter((n) => !n.read).length;
    const b = $('#bell-badge'); b.hidden = !unread; b.textContent = unread;
  }

  function showTab(tab) {
    ui.tab = tab;
    $$('#tabbar [role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    for (const id of ['ranks', 'clan', 'profile']) $('#screen-' + id).hidden = tab !== id;
    $('#screen-summary').hidden = true;
    if (tab === 'ranks') renderRanks();
    if (tab === 'clan') renderClan();
    if (tab === 'profile') renderProfile();
    if (tab === 'map') setTimeout(() => map.invalidateSize(), 0);
    setChrome('nav');
  }

  /** Which overlay chrome is visible: 'nav' (map + tabs), 'rec', 'draw', 'none'. */
  function setChrome(mode) {
    const nav = mode === 'nav';
    $('#topbar').hidden = !nav; $('#tabbar').hidden = !(nav);
    $('#map-tools').hidden = !(nav && ui.tab === 'map');
    if (!nav) $('#legend').hidden = true;
    $('#rec').hidden = mode !== 'rec';
    $('#drawbar').hidden = mode !== 'draw';
  }

  // ================================================================ toasts & notifications

  function toast(text, kind) {
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = text;
    const box = $('#toasts');
    while (box.children.length >= 3) box.firstChild.remove();
    box.appendChild(el);
    setTimeout(() => el.classList.add('out'), 3200);
    setTimeout(() => el.remove(), 3700);
  }

  const NOTIF_ICON = { attack: '⚔️', decay: '⏳', streak: '🔥', penalty: '➖', info: 'ℹ️', badge: '🏅' };
  function renderNotifs() {
    $('#notif-list').innerHTML = S.notifications.length
      ? S.notifications.map((n) => `<li class="${n.read ? '' : 'unread'} n-${n.type}"><span class="n-ico" aria-hidden="true">${NOTIF_ICON[n.type] || '•'}</span><div><p>${esc(n.text)}</p><small>Day ${n.day}</small></div></li>`).join('')
      : '<li class="muted">Nothing yet.</li>';
  }
  function openNotifs() {
    renderNotifs();
    $('#drawer-notifs').hidden = false;
    S.notifications.forEach((n) => (n.read = true));
    W.save(S); renderTopbar();
  }
  function pushNotify(type, text) {
    W.notify(S, type, text);
    if (S.player.notifications) toast((NOTIF_ICON[type] || '') + ' ' + text, type);
    renderTopbar();
  }

  // ================================================================ start sheet

  function renderStartSheet() {
    const list = Sim.SCENARIOS.map((sc) => `
      <button class="scenario ${ui.scenario === sc.id ? 'on' : ''}" data-sc="${sc.id}" aria-pressed="${ui.scenario === sc.id}">
        <span class="sc-ico" aria-hidden="true">${sc.icon}</span>
        <span class="sc-txt"><b>${esc(sc.name)}</b><small>${esc(sc.desc)}</small></span>
        <span class="tag">${sc.mode === 'walk' ? '🚶 walk' : '🚴 ride'}</span>
      </button>`).join('') + `
      <button class="scenario" data-sc="draw"><span class="sc-ico" aria-hidden="true">✏️</span>
        <span class="sc-txt"><b>Draw your own route</b><small>Tap waypoints on the map, set a speed, and go.</small></span></button>`;
    $('#scenario-list').innerHTML = list;
    const sc = Sim.SCENARIOS.find((x) => x.id === ui.scenario);
    if (sc && sc.declared) ui.mode = sc.declared;
    setSeg('#opt-mode', ui.mode); setSeg('#opt-group', String(ui.group)); setSeg('#opt-speed', String(ui.speed));
    $('#opt-hr').checked = ui.hr;
    $('#mode-hint').textContent = ui.mode === 'auto'
      ? 'Auto detects walking vs cycling from your speed. Override it if it gets it wrong.'
      : `Locked to ${ui.mode === 'walk' ? 'walking' : 'cycling'}. Speeds that don’t match will be flagged.`;
  }
  function setSeg(sel, v) { $$(sel + ' button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === v))); }

  function openStart() { $('#toasts').innerHTML = ''; renderStartSheet(); $('#sheet-start').hidden = false; }
  function closeSheets() { $('#sheet-start').hidden = true; $('#drawer-notifs').hidden = true; }

  // ================================================================ draw your own route

  const draw = { pts: [], line: null, dots: L.layerGroup() };
  function startDraw() {
    closeSheets(); setChrome('draw');
    draw.pts = []; draw.dots.clearLayers().addTo(map);
    draw.line = L.polyline([], { color: myColor(), weight: 4, dashArray: '6 8' }).addTo(map);
    updateDraw();
    map.on('click', onDrawClick);
  }
  function onDrawClick(e) { draw.pts.push(Geo.toXY(e.latlng.lat, e.latlng.lng)); updateDraw(); }
  function updateDraw() {
    draw.line.setLatLngs(draw.pts.map((p) => Geo.toLL(...p)));
    draw.dots.clearLayers();
    draw.pts.forEach((p, n) => L.circleMarker(Geo.toLL(...p), { radius: n ? 5 : 8, color: '#000', weight: 2, fillColor: myColor(), fillOpacity: 1 }).addTo(draw.dots));
    let m = 0; for (let n = 1; n < draw.pts.length; n++) m += Geo.dist(draw.pts[n - 1], draw.pts[n]);
    $('#draw-count').textContent = draw.pts.length;
    $('#draw-km').textContent = (m / 1000).toFixed(2);
    $('#draw-go').disabled = draw.pts.length < 2;
  }
  function endDraw() {
    map.off('click', onDrawClick);
    if (draw.line) map.removeLayer(draw.line);
    map.removeLayer(draw.dots);
  }

  // ================================================================ recording

  let run = null;

  function startActivity(sc) {
    closeSheets();
    S.settings.playback = ui.speed; S.player.hr = ui.hr;
    const declared = sc.declared || ui.mode;
    const group = sc.group && ui.group === 1 ? sc.group : ui.group;
    const sampler = Sim.createSampler(sc, { hr: ui.hr });
    trackLayer.clearLayers(); fxLayer.clearLayers();
    run = {
      sc, sampler, declared, group, paused: false, carry: 0, acc: 0, accHit: 0, lastCtx: 'neutral',
      line: null, lineValid: null, glow: null, popups: 0, minimumToastShown: S.stats.todayMet,
    };
    run.rec = Sim.createRecorder(S, { declared, group, hr: ui.hr }, onEvent);
    run.me = L.marker(Geo.toLL(...sc.start), { icon: L.divIcon({ className: 'me-wrap', html: '<div class="me-dot"><span></span></div>', iconSize: [34, 34], iconAnchor: [17, 17] }), interactive: false, zIndexOffset: 1000 }).addTo(fxLayer);
    if (group > 1) {
      run.mates = [];
      for (let n = 1; n < group; n++) {
        run.mates.push(L.marker(Geo.toLL(...sc.start), { icon: L.divIcon({ className: 'me-wrap', html: `<div class="mate">${n === 1 ? 'M' : 'R'}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] }), interactive: false }).addTo(fxLayer));
      }
    }
    map.setView(Geo.toLL(...sc.start), 16, { animate: false });
    setChrome('rec');
    $('#rec-flag').hidden = true;
    $('#r-speedbtn').textContent = '×' + ui.speed;
    $('#r-pause').textContent = '❚❚'; $('#r-pause').setAttribute('aria-label', 'Pause');
    renderHud();
    banner('GO! ' + (sc.mode === 'walk' ? '🚶' : '🚴'), 'go');
    run.timer = setInterval(tick, 100);
  }

  function tick() {
    if (!run || run.paused) return;
    run.carry += ui.speed / 10;
    let n = Math.floor(run.carry); run.carry -= n;
    let last = null;
    while (n-- > 0) {
      const smp = run.sampler.next();
      if (!smp) { finishActivity(); return; }
      run.rec.push(smp); last = smp;
      drawTrack(smp);
    }
    if (!last) return;
    const ll = Geo.toLL(last.x, last.y);
    run.me.setLatLng(ll);
    if (run.mates) run.mates.forEach((m, k) => m.setLatLng(Geo.toLL(last.x - 9 * (k + 1), last.y - 7 * (k + 1))));
    map.panTo(ll, { animate: false });
    renderHud();
  }

  function drawTrack(smp) {
    const r = run.rec, s = r.samples[r.samples.length - 1];
    const ll = Geo.toLL(smp.x, smp.y);
    if (s.jump) { run.line = null; return; } // never draw a line across a GPS jump
    if (!run.line || run.lineValid !== s.valid) {
      const start = run.line ? [run.line.getLatLngs().slice(-1)[0], ll] : [ll];
      if (s.valid) {
        run.glow = theme() === 'neon' ? L.polyline(start, { renderer, color: myColor(), weight: 12, opacity: 0.25, interactive: false }).addTo(trackLayer) : null;
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

  function onEvent(ev) {
    if (!run) return;
    switch (ev.type) {
      case 'damage': {
        run.acc += ev.amount; run.accHit += ev.zoneHit;
        if (ev.zone) updateZoneVisual(ev.zone);
        if (ev.ctx !== run.lastCtx) { run.lastCtx = ev.ctx; }
        if (run.acc >= (ui.speed >= 60 ? 9 : 5)) { popDamage(ev); run.acc = 0; run.accHit = 0; }
        maybeMinimumToast();
        break;
      }
      case 'claim': {
        renderTerritory();
        const res = ev.res;
        const flash = L.polygon(ev.pts.map((p) => Geo.toLL(...p)), { renderer, color: '#fff', weight: 3, fillColor: '#fff', fillOpacity: 0.55, interactive: false }).addTo(fxLayer);
        let op = 0.55; const fade = setInterval(() => { op -= 0.05; flash.setStyle({ fillOpacity: Math.max(0, op), opacity: Math.max(0, op * 1.8) }); if (op <= 0) { clearInterval(fade); fxLayer.removeLayer(flash); } }, 60);
        if (res.claimed.length) banner(`AREA CLAIMED<br><small>${res.claimed.length} cells · ${W.areaKm2(res.claimed.length).toFixed(3)} km² · +${ev.bonus} pts</small>`, 'claim');
        else if (res.reinforced.some((r) => r.healed > 0)) banner(`ZONE REINFORCED<br><small>${esc(res.reinforced.filter((r) => r.healed > 0).map((r) => r.name).join(', '))} back to full HP</small>`, 'defend');
        else if (!res.protectedCells) toast('🔁 Loop closed: that area is already yours.');
        if (res.protectedCells) toast(`🛡 ${res.protectedCells} enemy cells resisted (${res.protectedZones.join(', ')}). Break a zone to 0 HP before you claim it.`, 'attack');
        break;
      }
      case 'neutralise':
        renderTerritory();
        banner(`ZONE BROKEN! 💥<br><small>${esc(ev.zone.name)} is neutral · +${R.NEUTRALISE_PTS} pts<br>Close a loop around it to claim it</small>`, 'break');
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
    const st = S.stats, r = run.rec;
    if (R.minimumProgress(st.todayWalkMin + r.walkSec / 60, st.todayCycleKm + r.cycleKm) >= 1) {
      run.minimumToastShown = true;
      toast(`✅ Daily minimum met. Tonight’s −${R.inactivityPenalty(st.missedDays + 1)} penalty avoided!`, 'good');
    }
  }

  function popDamage(ev) {
    if (reducedMotion || run.popups > 14) return;
    const amt = Math.round(run.acc);
    let cls = 'pop', txt = '+' + amt;
    if (ev.ctx === 'attack') { cls += ' pop-attack'; txt = '⚔ ' + Math.round(run.accHit); }
    else if (ev.ctx === 'defend') { cls += ' pop-defend'; txt = '🛡 +' + amt; }
    const jitter = (Math.random() - 0.5) * 30;
    const m = L.marker(Geo.toLL(ev.x + jitter, ev.y + 10), { icon: L.divIcon({ className: 'pop-wrap', html: `<div class="${cls}">${txt}</div>`, iconSize: null }), interactive: false, keyboard: false }).addTo(fxLayer);
    run.popups++;
    setTimeout(() => { fxLayer.removeLayer(m); if (run) run.popups--; }, 950);
  }

  function banner(html, kind) {
    const b = $('#rec-banner');
    b.innerHTML = `<div class="bn bn-${kind}">${html}</div>`;
    clearTimeout(banner.t);
    banner.t = setTimeout(() => (b.innerHTML = ''), kind === 'go' ? 900 : 2600);
  }

  function renderHud() {
    const r = run.rec, st = S.stats;
    $('#r-damage').textContent = fmt(r.damage);
    $('#r-points').textContent = fmt(r.totalPoints());
    $('#r-dist').textContent = (r.dist / 1000).toFixed(2);
    const t = r.time; $('#r-time').textContent = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
    $('#r-speed').textContent = r.kmh.toFixed(1);
    const zone = r.samples.length ? W.zoneAt(S, r.samples[r.samples.length - 1].x, r.samples[r.samples.length - 1].y) : null;
    const ctx = $('#r-ctx');
    if (r.flagActive) { ctx.className = 'rec-ctx ctx-flag'; ctx.textContent = 'Damage paused'; }
    else if (zone && !W.isFriendly(S, zone.owner)) { ctx.className = 'rec-ctx ctx-attack'; ctx.innerHTML = `⚔ Attacking<br><b>${esc(zone.name)}</b>`; }
    else if (zone && zone.hp < zone.maxHp) { ctx.className = 'rec-ctx ctx-defend'; ctx.innerHTML = `🛡 Defending<br><b>${esc(zone.name)}</b>`; }
    else if (zone) { ctx.className = 'rec-ctx'; ctx.innerHTML = `Patrolling<br><b>${esc(zone.name)}</b>`; }
    else { ctx.className = 'rec-ctx'; ctx.textContent = S.neutral[Geo.key(...Geo.cellOf(r.samples.length ? r.samples[r.samples.length - 1].x : 0, r.samples.length ? r.samples[r.samples.length - 1].y : 0))] ? 'Neutral ground' : 'Free roam'; }

    const chips = [];
    const modeTxt = r.mode === 'walk' ? '🚶 Walking' : '🚴 Cycling';
    chips.push(`<span class="c">${run.declared === 'auto' ? 'Auto: ' : ''}${modeTxt}</span>`);
    let why = r.mode === 'walk'
      ? (r.intensity >= R.WALK.UPHILL ? 'uphill' : r.intensity >= R.WALK.BRISK ? 'brisk' : 'base')
      : (r.intensity > R.CYCLE.BASE ? 'effort bonus' : 'base');
    chips.push(`<span class="c c-int">×${r.intensity.toFixed(2)} ${why}</span>`);
    if (ui.hr && r.hr) chips.push(`<span class="c">♥ ${r.hr} · Z${r.hrZone}</span>`);
    if (st.streak) chips.push(`<span class="c">🔥 ×${R.streakMult(st.streak).toFixed(2)}</span>`);
    if (run.group > 1) chips.push(`<span class="c c-combo">COMBO ×${R.groupMult(run.group)}</span>`);
    if (r.grade >= R.UPHILL_GRADE) chips.push(`<span class="c">⛰ ${(r.grade * 100).toFixed(0)}%</span>`);
    $('#r-chips').innerHTML = chips.join('');

    const p = Math.min(1, R.minimumProgress(st.todayWalkMin + r.walkSec / 60, st.todayCycleKm + r.cycleKm));
    $('#r-daily-fill').style.width = (p * 100) + '%';
    $('#r-daily-txt').textContent = p >= 1 ? 'Daily minimum met ✓ penalty avoided' : `Daily minimum ${Math.round(p * 100)}%`;
  }

  function finishActivity() {
    if (!run) return;
    clearInterval(run.timer);
    const r = run.rec, st = S.stats, sc = run.sc;
    const pts = r.totalPoints();
    st.totalPoints += pts;
    st.damageDealt += r.damage;
    st.weeklyDamage += r.damage;
    st.cellsClaimed += r.claimedCells; st.virginClaimed += r.virgin;
    st.zonesNeutralised += r.neutralised.length;
    st.activities++;
    const wasMet = st.todayMet;
    const daily = W.addDailyProgress(S, r.walkSec / 60, r.cycleKm);

    const unlocked = [];
    const award = (id, cond) => { if (cond && !S.badges[id]) { S.badges[id] = S.day; unlocked.push(id); } };
    award('first_claim', r.claimedCells > 0);
    award('raider', r.neutralised.length > 0);
    award('defender', r.healed > 0);
    award('explorer', st.virginClaimed >= 50);
    award('combo', run.group > 1);
    award('clean', r.flags.length === 0 && r.dist > 300);
    award('streak3', st.streak >= 3);
    award('streak7', st.streak >= 7);
    unlocked.forEach((id) => W.notify(S, 'badge', `Badge unlocked: ${W.BADGES[id].name}`));

    const summary = {
      name: sc.name, mode: r.cycleKm * 1000 > r.validDist / 2 ? 'cycle' : 'walk', day: S.day,
      km: r.dist / 1000, validKm: r.validDist / 1000, flaggedKm: r.flaggedDist / 1000, sec: r.time,
      damage: r.damage, zoneDamage: r.zoneDamage, healed: r.healed, parts: { ...r.parts },
      cells: r.claimedCells, virgin: r.virgin, neutral: r.neutral, claimBonus: r.claimBonus,
      neutralised: r.neutralised.slice(), neutraliseBonus: r.neutraliseBonus, reinforced: [...new Set(r.claims.flatMap((c) => c.reinforced.filter((x) => x.healed > 0).map((x) => x.name)))],
      points: pts, flags: r.flags.map((f) => ({ kind: f.kind, text: f.text, km: f.km })),
      daily: { justMet: daily.justMet, avoided: daily.avoided, wasMet, progress: R.minimumProgress(st.todayWalkMin, st.todayCycleKm) },
      group: run.group, unlocked, streak: st.streak,
    };
    S.history.unshift({ day: S.day, name: sc.name, mode: summary.mode, km: summary.km, points: Math.round(pts), cells: r.claimedCells, flags: r.flags.length });
    S.history = S.history.slice(0, 20);
    W.save(S);
    run = null;
    renderSummary(summary);
  }

  // ================================================================ summary screen

  function renderSummary(x) {
    setChrome('none');
    const el = $('#screen-summary');
    const mins = Math.floor(x.sec / 60), secs = x.sec % 60;
    const avg = x.sec ? x.km / (x.sec / 3600) : 0;
    const area = W.areaKm2(x.cells);
    const st = S.stats;
    let pen;
    if (x.daily.justMet) pen = { big: '−' + x.daily.avoided, cls: 'good', sub: `Avoided ✓ Streak is now ${x.streak} day${x.streak === 1 ? '' : 's'}` };
    else if (x.daily.wasMet) pen = { big: '✓', cls: 'good', sub: 'Already safe today' };
    else {
      const left = Math.max(0, 1 - x.daily.progress);
      pen = { label: 'Penalty at risk', big: '−' + R.inactivityPenalty(st.missedDays + 1), cls: 'warn', sub: `At risk tonight: ${Math.ceil(left * R.MIN_WALK_MIN)} more min walking or ${(left * R.MIN_CYCLE_KM).toFixed(1)} km cycling` };
    }
    const row = (label, v, cls) => v ? `<li class="${cls || ''}"><span>${label}</span><b>+${fmt(v)}</b></li>` : '';
    el.innerHTML = `
      <div class="screen-inner">
        <p class="eyebrow">${x.mode === 'cycle' ? '🚴 Ride' : '🚶 Walk'} complete · Day ${x.day}</p>
        <h1 id="sum-title">${esc(x.name)}</h1>
        <p class="muted">${x.km.toFixed(2)} km · ${mins}:${String(secs).padStart(2, '0')} · ${avg.toFixed(1)} km/h avg${x.group > 1 ? ' · group of ' + x.group : ''}</p>

        <div class="tiles">
          <div class="tile t-dmg"><span class="lbl">Damage dealt</span><b class="num">${fmt(x.damage)}</b><small>${x.zoneDamage ? fmt(x.zoneDamage) + ' HP removed from rivals' : 'no rival zones hit'}</small></div>
          <div class="tile t-area"><span class="lbl">Area claimed</span><b class="num">${area.toFixed(3)}<em>km²</em></b><small>${x.cells} cells${x.cells ? ` · ${x.virgin} new · ${x.neutral} retaken` : ''}</small></div>
          <div class="tile t-pts"><span class="lbl">Points earned</span><b class="num">+${fmt(x.points)}</b><small>total ${fmt(st.totalPoints)}</small></div>
          <div class="tile t-pen ${pen.cls}"><span class="lbl">${pen.label || 'Penalty avoided'}</span><b class="num">${pen.big}</b><small>${pen.sub}</small></div>
        </div>

        <h2>Points breakdown</h2>
        <ul class="breakdown">
          ${row('Base damage (distance × intensity)', x.parts.base)}
          ${row('Streak bonus', x.parts.streak)}
          ${row('Group combo', x.parts.group)}
          ${row('Defend bonus (×1.25 in damaged own zones)', x.parts.defend)}
          ${row('New-ground claim bonus', x.claimBonus)}
          ${row('Zone broken bonus', x.neutraliseBonus)}
          <li class="total"><span>Total</span><b>+${fmt(x.points)}</b></li>
        </ul>

        ${(x.neutralised.length || x.healed || x.reinforced.length) ? `<h2>Territory</h2><ul class="events">
          ${x.neutralised.map((n) => `<li>💥 Broke <b>${esc(n)}</b>. It's neutral now</li>`).join('')}
          ${x.healed ? `<li>🛡 Healed your zones by <b>${fmt(x.healed)} HP</b></li>` : ''}
          ${x.reinforced.map((n) => `<li>🔁 Reinforced <b>${esc(n)}</b> to full HP</li>`).join('')}
        </ul>` : ''}

        <h2>Anti-cheat</h2>
        ${x.flags.length ? `<ul class="events flags">${x.flags.map((f) => `<li>⚠ ${esc(f.text.replace(/\. Damage paused$/, ''))}</li>`).join('')}
          <li class="muted">${x.flaggedKm.toFixed(2)} km excluded from damage and claims.</li></ul>` : '<p class="ok">✅ Clean activity. All distance counted.</p>'}

        ${x.unlocked.length ? `<h2>Badges unlocked</h2><div class="badges">${x.unlocked.map((id) => badgeHtml(id, true)).join('')}</div>` : ''}

        <div class="row gap stick">
          <button class="btn btn-block" id="sum-map">View map</button>
          <button class="btn btn-primary btn-block" id="sum-ranks">Leaderboard</button>
        </div>
      </div>`;
    el.hidden = false; el.scrollTop = 0;
    $('#sum-map').onclick = () => { trackLayer.clearLayers(); fxLayer.clearLayers(); showTab('map'); };
    $('#sum-ranks').onclick = () => { trackLayer.clearLayers(); fxLayer.clearLayers(); showTab('ranks'); };
    renderTopbar();
  }

  function badgeHtml(id, got) {
    const b = W.BADGES[id];
    return `<div class="badge-card ${got ? 'got' : 'locked'}"><span aria-hidden="true">${b.icon}</span><b>${esc(b.name)}</b><small>${esc(b.desc)}</small>${got ? '' : '<em class="sr">locked</em>'}</div>`;
  }

  // ================================================================ leaderboards

  const RANK_TABS = [
    { id: 'friends', name: 'Friends', key: 'points', unit: 'pts', filter: (r) => r.friend },
    { id: 'city', name: 'City', key: 'points', unit: 'pts' },
    { id: 'weekly', name: 'Weekly damage', key: 'weekly', unit: 'dmg' },
    { id: 'territory', name: 'Biggest territory', key: 'cells', unit: 'km²' },
    { id: 'clans', name: 'Clans', key: 'points', unit: 'pts' },
  ];
  ui.rankTab = 'friends';
  function renderRanks() {
    const tab = RANK_TABS.find((t) => t.id === ui.rankTab);
    let rows = W.leaderboardRows(S);
    if (tab.id === 'clans') {
      const agg = {};
      for (const r of rows) {
        if (!r.clan) continue;
        const c = agg[r.clan] || (agg[r.clan] = { name: W.CLANS[r.clan].name, tag: W.CLANS[r.clan].tag, points: 0, weekly: 0, cells: 0, members: 0, me: false });
        c.points += r.points; c.weekly += r.weekly; c.cells += r.cells; c.members++; c.me = c.me || r.clan === S.player.clan;
      }
      rows = Object.values(agg);
    }
    if (tab.filter) rows = rows.filter(tab.filter);
    rows.sort((a, b) => b[tab.key] - a[tab.key]);
    const val = (r) => tab.key === 'cells' ? W.areaKm2(r.cells).toFixed(2) : fmt(r[tab.key]);
    const sub = (r) => tab.id === 'clans' ? `${r.members} members · ${W.areaKm2(r.cells).toFixed(2)} km²` : (r.clan ? W.CLANS[r.clan].tag : 'solo');
    $('#screen-ranks').innerHTML = `<div class="screen-inner">
      <h1 id="ranks-title">Leaderboards</h1>
      <div class="tabs" role="tablist">${RANK_TABS.map((t) => `<button role="tab" aria-selected="${t.id === tab.id}" data-rt="${t.id}">${t.name}</button>`).join('')}</div>
      <p class="muted small">${tab.id === 'weekly' ? 'Resets every 7 days.' : tab.id === 'territory' ? 'Area currently held.' : tab.id === 'clans' ? 'Clan members combine points, damage and territory.' : tab.id === 'city' ? 'Chicago, all players.' : 'You and the people you follow.'}</p>
      <ol class="ranks">${rows.map((r, n) => `<li class="${r.me ? 'me' : ''}"><span class="rk">${n < 3 ? ['🥇', '🥈', '🥉'][n] : n + 1}</span>
        <span class="av" style="--c:${r.id && S.players[r.id] ? colorOf(r.id) : 'var(--muted)'}">${esc((r.tag || r.name)[0])}</span>
        <span class="nm"><b>${esc(r.name)}${r.me && tab.id !== 'clans' ? ' (you)' : ''}</b><small>${sub(r)}</small></span>
        <span class="val"><b>${val(r)}</b><small>${tab.unit}</small></span></li>`).join('')}</ol>
    </div>`;
    $$('#screen-ranks [data-rt]').forEach((b) => (b.onclick = () => { ui.rankTab = b.dataset.rt; renderRanks(); }));
  }

  // ================================================================ clan

  function renderClan() {
    const el = $('#screen-clan');
    const clan = S.player.clan && W.CLANS[S.player.clan];
    if (!clan) {
      el.innerHTML = `<div class="screen-inner"><h1 id="clan-title">Clans</h1>
        <p>Clans share territory: clan mates' zones are friendly, you heal them instead of hurting them, and moving together triggers a combo multiplier.</p>
        <button class="btn btn-primary btn-block" id="join-clan">Join Neon Spokes (with Mira &amp; Ravi)</button></div>`;
      $('#join-clan').onclick = () => { S.player.clan = 'neon'; S.players.you.clan = 'neon'; W.save(S); renderTerritory(); renderClan(); toast('Joined Neon Spokes 👥'); };
      return;
    }
    const rows = W.leaderboardRows(S).filter((r) => r.clan === clan.id).sort((a, b) => b.weekly - a.weekly);
    const zones = Object.values(S.zones).filter((z) => W.isFriendly(S, z.owner));
    const cells = zones.reduce((a, z) => a + z.cells.length, 0);
    el.innerHTML = `<div class="screen-inner">
      <p class="eyebrow">Your clan · ${clan.tag}</p>
      <h1 id="clan-title">${esc(clan.name)}</h1>
      <div class="tiles three">
        <div class="tile"><span class="lbl">Territory</span><b class="num">${W.areaKm2(cells).toFixed(2)}<em>km²</em></b></div>
        <div class="tile"><span class="lbl">Weekly dmg</span><b class="num">${fmt(rows.reduce((a, r) => a + r.weekly, 0))}</b></div>
        <div class="tile"><span class="lbl">Members</span><b class="num">${rows.length}</b></div>
      </div>
      <h2>Shared zones</h2>
      <ul class="zone-list">${zones.map((z) => { const pct = Math.round(100 * z.hp / z.maxHp); return `<li><button data-fly="${z.id}">
        <span class="av" style="--c:${colorOf(z.owner)}">${esc(S.players[z.owner].name[0])}</span>
        <span class="nm"><b>${esc(z.name)}</b><small>${z.owner === 'you' ? 'You' : esc(S.players[z.owner].name)} · ${z.cells.length} cells</small>
        <span class="hpbar ${pct < 40 ? 'low' : ''}"><i style="width:${pct}%;--hp:${hpColor(pct)}"></i></span></span>
        <span class="val"><b>${pct}%</b><small>${pct < 100 ? 'defend →' : 'HP'}</small></span></button></li>`; }).join('') || '<li class="muted">No zones yet. Close a loop!</li>'}</ul>
      <h2>Members this week</h2>
      <ol class="ranks">${rows.map((r, n) => `<li class="${r.me ? 'me' : ''}"><span class="rk">${n + 1}</span><span class="av" style="--c:${S.players[r.id] ? colorOf(r.id) : 'var(--muted)'}">${esc(r.name[0])}</span>
        <span class="nm"><b>${esc(r.name)}</b><small>${W.areaKm2(r.cells).toFixed(2)} km²</small></span><span class="val"><b>${fmt(r.weekly)}</b><small>dmg</small></span></li>`).join('')}</ol>
      <div class="note"><b>How clans work</b><ul>
        <li>Clan mates' zones count as friendly: walking or riding through them heals them (×1.25 defend bonus).</li>
        <li>Move together for a combo: 2 players ×1.2, 3 players ×1.35, 4+ ×1.5.</li>
        <li>Clan leaderboards combine everyone's points, damage and territory.</li></ul></div>
    </div>`;
    $$('#screen-clan [data-fly]').forEach((b) => (b.onclick = () => { const z = S.zones[b.dataset.fly]; showTab('map'); map.setView(centroid(z), 16); }));
  }

  // ================================================================ profile

  function renderProfile() {
    const st = S.stats, el = $('#screen-profile');
    const myCells = W.ownedCells(S, 'you');
    const nextPen = R.inactivityPenalty(st.missedDays + 1);
    el.innerHTML = `<div class="screen-inner">
      <div class="prof-head"><span class="av big" style="--c:${myColor()}">${esc(S.player.name[0])}</span>
        <div><h1 id="prof-title">${esc(S.player.name)}</h1><p class="muted">${S.player.clan ? esc(W.CLANS[S.player.clan].name) : 'Solo'} · Day ${S.day}</p></div></div>
      <div class="tiles">
        <div class="tile"><span class="lbl">Total points</span><b class="num">${fmt(st.totalPoints)}</b></div>
        <div class="tile"><span class="lbl">Damage dealt</span><b class="num">${fmt(st.damageDealt)}</b></div>
        <div class="tile warn"><span class="lbl">Lost to inactivity</span><b class="num">${st.pointsLost ? '−' + fmt(st.pointsLost) : '0'}</b></div>
        <div class="tile"><span class="lbl">Streak</span><b class="num">${st.streak}<em>days</em></b><small>best ${st.bestStreak}</small></div>
        <div class="tile"><span class="lbl">Territory</span><b class="num">${W.areaKm2(myCells).toFixed(2)}<em>km²</em></b><small>${myCells} cells</small></div>
        <div class="tile"><span class="lbl">Rest tokens</span><b class="num">${st.restTokens}</b><small>1 per week</small></div>
      </div>

      <h2>Badges</h2>
      <div class="badges">${Object.keys(W.BADGES).map((id) => badgeHtml(id, !!S.badges[id])).join('')}</div>

      <h2>Recent activity</h2>
      <ul class="events">${S.history.length ? S.history.slice(0, 6).map((h) => `<li>${h.mode === 'cycle' ? '🚴' : '🚶'} <b>${esc(h.name)}</b> · ${h.km.toFixed(2)} km · +${fmt(h.points)} pts${h.cells ? ` · ${h.cells} cells` : ''}${h.flags ? ` · ⚠ ${h.flags}` : ''} <small class="muted">day ${h.day}</small></li>`).join('') : '<li class="muted">No activities yet. Tap GO.</li>'}</ul>

      <h2>Time machine <small class="muted">(prototype)</small></h2>
      <div class="note">
        <p>Today: ${st.todayMet ? '<b class="ok">daily minimum met ✓</b>' : `<b>${Math.round(100 * Math.min(1, R.minimumProgress(st.todayWalkMin, st.todayCycleKm)))}%</b> of daily minimum. Skipping today costs <b>−${nextPen}</b>.`}</p>
        <p class="small muted">Penalty ladder: −5, −10, −20, −40, then −50/day max. Your zones start decaying after ${R.DECAY_START_DAY} inactive days.</p>
        <div class="row gap wrap">
          ${st.todayMet ? '<button class="btn btn-primary" data-day="met">End day ▶</button>' : `
            <button class="btn btn-danger" data-day="skip">Skip day (inactive)</button>
            <button class="btn" data-day="token" ${st.restTokens ? '' : 'disabled'}>Use rest token 😴</button>`}
        </div>
      </div>

      <h2>Settings</h2>
      <div class="settings">
        <label class="switch-row"><span>☀️ Sunlight mode (high contrast)</span><input type="checkbox" id="set-sun" ${S.settings.sunlight ? 'checked' : ''}/><i aria-hidden="true"></i></label>
        <label class="switch-row"><span>Heart-rate monitor</span><input type="checkbox" id="set-hr" ${S.player.hr ? 'checked' : ''}/><i aria-hidden="true"></i></label>
        <label class="switch-row"><span>Notifications</span><input type="checkbox" id="set-notif" ${S.player.notifications ? 'checked' : ''}/><i aria-hidden="true"></i></label>
        <div class="opt-row"><span class="opt-label">Colour</span><div class="swatches">${W.PLAYER_COLORS.map((c) => `<button class="sw ${S.player.color === c ? 'on' : ''}" data-col="${c}" style="--c:${W.COLORS[c][theme()]}" aria-label="${W.COLORS[c].name}" aria-pressed="${S.player.color === c}"></button>`).join('')}</div></div>
        <button class="btn btn-block" id="set-reset">Reset prototype</button>
      </div>
    </div>`;
    $$('#screen-profile [data-day]').forEach((b) => (b.onclick = () => endDay(b.dataset.day === 'token')));
    $('#set-sun').onchange = (e) => { S.settings.sunlight = e.target.checked; W.save(S); applyTheme(); renderProfile(); };
    $('#set-hr').onchange = (e) => { S.player.hr = ui.hr = e.target.checked; W.save(S); };
    $('#set-notif').onchange = (e) => { S.player.notifications = e.target.checked; W.save(S); };
    $$('#screen-profile [data-col]').forEach((b) => (b.onclick = () => { S.player.color = S.players.you.color = b.dataset.col; W.save(S); applyTheme(); renderProfile(); }));
    $('#set-reset').onclick = () => { if (confirm('Reset all progress and replay onboarding?')) { S = W.reset(); boot(); } };
  }

  function endDay(useToken) {
    const seen = new Set(S.notifications.map((n) => n.id));
    const rep = W.endDay(S, useToken);
    W.save(S);
    renderTerritory(); renderTopbar(); renderProfile();
    const fresh = S.notifications.filter((n) => !seen.has(n.id));
    const order = { attack: 0, penalty: 1, decay: 2, info: 3, streak: 4 };
    fresh.sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9));
    toast(`🌅 Day ${S.day}${rep.penalty ? ` · −${rep.penalty} pts for missing yesterday` : rep.tokenUsed ? ' · rest token used' : ''}`, rep.penalty ? 'penalty' : 'good');
    if (S.player.notifications) fresh.slice(0, 2).forEach((n) => toast((NOTIF_ICON[n.type] || '') + ' ' + n.text, n.type));
    if (rep.lost.length) toast('Zones lost to decay: ' + rep.lost.join(', '), 'decay');
  }

  // ================================================================ onboarding

  function renderOnboarding(step) {
    const el = $('#screen-onboarding');
    const steps = [
      `<div class="ob-art art-map" aria-hidden="true"><i class="z z1"></i><i class="z z2"></i><i class="z z3"></i><i class="trail"></i></div>
       <p class="eyebrow">Welcome to</p><h1 class="logo">PEDAL<span>PACE</span></h1>
       <p class="lead">Walk it. Ride it. <b>Own it.</b></p>
       <p>Every walk and ride draws your route on the real map. <b>Close a loop</b> and the area inside becomes your territory, in your colour.</p>`,
      `<div class="ob-art art-fight" aria-hidden="true"><span class="hp"><i></i></span><span class="pop">⚔ 12</span></div>
       <h1>Attack &amp; defend</h1>
       <p>Moving through a rival's zone <b>deals damage</b>. Break it to 0 HP and it turns <b>neutral</b>, then loop around it to take it.</p>
       <div class="formula">Damage = distance × intensity</div>
       <ul class="ticks"><li>🚶 Walking: 1.0× base · 1.3× brisk · 1.5× uphill</li><li>🚴 Cycling: 0.4× base + effort-zone bonuses</li><li>Balanced so a 30-min walk and a 30-min ride score about the same</li></ul>`,
      `<div class="ob-art art-ladder" aria-hidden="true"><span>−5</span><span>−10</span><span>−20</span><span>−40</span><span>−50</span></div>
       <h1>Stay active, not overtrained</h1>
       <p>Days without activity cost points, starting small and <b>capped at −50/day</b>. Inactive players' zones decay.</p>
       <ul class="ticks"><li>✅ Daily minimum: <b>15 min walking</b> or <b>5 km cycling</b></li><li>😴 <b>1 rest token per week</b>: recovery days are never punished</li><li>🔥 Streaks add up to +20% damage</li></ul>`,
      `<h1>Make your player</h1>
       <label class="field"><span>Name</span><input id="ob-name" maxlength="14" value="${esc(S.player.name === 'You' ? '' : S.player.name)}" placeholder="e.g. Sam" autocomplete="nickname"/></label>
       <div class="field"><span>Territory colour</span><div class="swatches">${W.PLAYER_COLORS.map((c) => `<button class="sw ${S.player.color === c ? 'on' : ''}" data-col="${c}" style="--c:${W.COLORS[c].neon}" aria-label="${W.COLORS[c].name}" aria-pressed="${S.player.color === c}"></button>`).join('')}</div></div>
       <div class="field"><span>Clan</span><div class="seg" id="ob-clan" role="radiogroup">
         <button role="radio" data-v="neon" aria-checked="${S.player.clan === 'neon'}">👥 Join Neon Spokes</button><button role="radio" data-v="" aria-checked="${!S.player.clan}">Go solo</button></div></div>
       <label class="switch-row"><span>Heart-rate monitor (simulated)</span><input type="checkbox" id="ob-hr" ${S.player.hr ? 'checked' : ''}/><i aria-hidden="true"></i></label>
       <label class="switch-row"><span>Notifications (attacks, decay, streaks)</span><input type="checkbox" id="ob-notif" ${S.player.notifications ? 'checked' : ''}/><i aria-hidden="true"></i></label>
       <p class="small muted">📍 Location: this prototype uses <b>simulated GPS</b>, so no permission is needed.</p>`,
    ];
    el.innerHTML = `<div class="screen-inner ob">
      ${steps[step]}
      <div class="ob-nav">
        <div class="dots" aria-label="Step ${step + 1} of ${steps.length}">${steps.map((_, n) => `<i class="${n === step ? 'on' : ''}"></i>`).join('')}</div>
        <div class="row gap">
          ${step ? '<button class="btn" id="ob-back">Back</button>' : '<button class="btn btn-ghost" id="ob-skip">Skip</button>'}
          <button class="btn btn-primary" id="ob-next">${step === steps.length - 1 ? 'Let’s go' : 'Next'}</button>
        </div>
      </div></div>`;
    el.hidden = false;
    const save = () => {
      if (step !== 3) return;
      const name = $('#ob-name').value.trim();
      S.player.name = name || 'You';
      S.player.hr = ui.hr = $('#ob-hr').checked;
      S.player.notifications = $('#ob-notif').checked;
    };
    if (step === 3) {
      $$('#screen-onboarding [data-col]').forEach((b) => (b.onclick = () => { save(); S.player.color = S.players.you.color = b.dataset.col; renderOnboarding(3); }));
      $$('#ob-clan button').forEach((b) => (b.onclick = () => { save(); S.player.clan = S.players.you.clan = b.dataset.v || null; renderOnboarding(3); }));
    }
    $('#ob-next').onclick = () => { save(); if (step < steps.length - 1) renderOnboarding(step + 1); else finishOnboarding(); };
    if ($('#ob-back')) $('#ob-back').onclick = () => { save(); renderOnboarding(step - 1); };
    if ($('#ob-skip')) $('#ob-skip').onclick = () => renderOnboarding(3);
  }

  function finishOnboarding() {
    S.onboarded = true;
    S.players.you.name = S.player.name;
    W.save(S);
    $('#screen-onboarding').hidden = true;
    applyTheme(); renderTopbar(); showTab('map');
    map.setView(Geo.toLL(250, 150), 15);
    setTimeout(() => toast('⚔️ Home Turf is under attack! Tap GO and try “Defend patrol”.', 'attack'), 400);
  }

  // ================================================================ wiring

  function wire() {
    $$('#tabbar [role=tab]').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
    $('#btn-start').onclick = openStart;
    $('#btn-bell').onclick = openNotifs;
    $('#btn-sun').onclick = () => { S.settings.sunlight = !S.settings.sunlight; W.save(S); applyTheme(); if (ui.tab !== 'map') showTab(ui.tab); };
    $('#tb-daily').onclick = () => { const st = S.stats; toast(st.todayMet ? 'Daily minimum met ✓ No penalty tonight.' : `Daily minimum: ${st.todayWalkMin.toFixed(0)}/15 min walking or ${st.todayCycleKm.toFixed(1)}/5 km cycling. Skipping costs −${R.inactivityPenalty(st.missedDays + 1)}.`); };
    $('#btn-locate').onclick = () => map.setView(Geo.toLL(250, 150), 15);
    $('#btn-legend').onclick = () => { const l = $('#legend'); l.hidden = !l.hidden; $('#btn-legend').setAttribute('aria-expanded', String(!l.hidden)); };
    $$('[data-close]').forEach((b) => (b.onclick = closeSheets));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheets(); });

    $('#scenario-list').addEventListener('click', (e) => {
      const b = e.target.closest('[data-sc]'); if (!b) return;
      if (b.dataset.sc === 'draw') { startDraw(); return; }
      const prev = Sim.SCENARIOS.find((x) => x.id === ui.scenario);
      if (prev && prev.declared) ui.mode = 'auto';
      ui.scenario = b.dataset.sc;
      const sc = Sim.SCENARIOS.find((x) => x.id === ui.scenario);
      ui.group = sc.group || 1;
      renderStartSheet();
    });
    const seg = (sel, fn) => $(sel).addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { fn(b.dataset.v); renderStartSheet(); } });
    seg('#opt-mode', (v) => (ui.mode = v));
    seg('#opt-group', (v) => (ui.group = +v));
    seg('#opt-speed', (v) => (ui.speed = +v));
    $('#opt-hr').onchange = (e) => (ui.hr = e.target.checked);
    $('#btn-go').onclick = () => {
      const sc = Sim.SCENARIOS.find((x) => x.id === ui.scenario);
      if (sc.declared && ui.mode !== sc.declared) ui.mode = sc.declared;
      startActivity(sc);
    };

    $('#draw-speed').oninput = (e) => ($('#draw-speed-v').textContent = e.target.value);
    $('#draw-undo').onclick = () => { draw.pts.pop(); updateDraw(); };
    $('#draw-cancel').onclick = () => { endDraw(); setChrome('nav'); };
    $('#draw-go').onclick = () => {
      const kmh = +$('#draw-speed').value;
      const sc = Sim.customScenario(draw.pts.slice(), kmh > 9 ? 'cycle' : 'walk', kmh);
      endDraw(); startActivity(sc);
    };

    $('#r-pause').onclick = () => {
      if (!run) return;
      run.paused = !run.paused;
      $('#r-pause').textContent = run.paused ? '▶' : '❚❚';
      $('#r-pause').setAttribute('aria-label', run.paused ? 'Resume' : 'Pause');
    };
    $('#r-speedbtn').onclick = () => {
      const order = [5, 20, 60]; ui.speed = order[(order.indexOf(ui.speed) + 1) % order.length];
      $('#r-speedbtn').textContent = '×' + ui.speed;
    };
    $('#r-finish').onclick = finishActivity;
  }

  function boot() {
    ui.hr = S.player.hr; ui.speed = S.settings.playback || 20;
    applyTheme(); renderTopbar();
    if (!S.onboarded) { setChrome('none'); renderOnboarding(0); }
    else { $('#screen-onboarding').hidden = true; showTab('map'); }
  }

  wire();
  boot();
  // Expose for debugging / automated checks.
  window.PedalPace = { get state() { return S; }, map, startActivity, finishActivity, endDay, showTab };
})();
