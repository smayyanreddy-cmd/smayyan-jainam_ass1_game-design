/* PedalPace — GPS input (real and simulated) + the trip recorder (the game loop).
 * The recorder only sees 1 Hz samples {x, y, lat, lng, alt, hr, dt}, so real
 * GPS and the test simulator go through exactly the same rules. */
(function () {
  'use strict';
  const R = window.Rules, W = window.World, Geo = W.Geo;

  // ---------------------------------------------------------------- test routes (simulated GPS)

  /** Route from waypoints tapped on the map ([x, y] metres around Geo.ORIGIN). */
  function customScenario(points, mode, kmh) {
    return { id: 'custom', name: 'Test route', icon: '✏️', mode, start: points[0], legs: points.slice(1).map((p) => ({ to: p, kmh })) };
  }

  function createSampler(sc) {
    let leg = 0, pos = sc.start.slice(), t = 0;
    return {
      next() {
        if (leg >= sc.legs.length) return null;
        const L = sc.legs[leg];
        const kmh = L.kmh * (1 + 0.06 * Math.sin(t / 23) + 0.03 * Math.sin(t / 7));
        const mps = kmh / 3.6, remaining = Geo.dist(pos, L.to);
        if (mps >= remaining) { pos = L.to.slice(); leg++; } else pos = step(pos, L.to, mps);
        t++;
        const [lat, lng] = Geo.toLL(pos[0], pos[1]);
        return { t, x: pos[0], y: pos[1], lat, lng, alt: null, hr: 0, dt: 1 };
      },
    };
  }
  function step(a, b, m) {
    const d = Geo.dist(a, b);
    if (d < 1e-6) return b.slice();
    return [a[0] + (b[0] - a[0]) * m / d, a[1] + (b[1] - a[1]) * m / d];
  }

  // ---------------------------------------------------------------- live GPS

  // Human-readable geolocation errors with the fix.
  const GEO_HELP = {
    1: 'Location is blocked. Click the icon left of the address bar → Location → Allow, then reload. On Windows also check Settings → Privacy & security → Location.',
    2: 'Your device couldn’t find a position. Turn on location services or move to open sky.',
    3: 'Finding your location timed out. Still trying…',
  };

  /**
   * Turns raw GPS fixes (fed in with feed()) into the clean 1 Hz stream the
   * recorder expects:
   *  - fixes worse than ±GPS_MAX_ACC_M are dropped,
   *  - a Kalman filter weighs each fix by its accuracy, so jitter doesn't zig-zag the line,
   *  - standing still doesn't add distance (moves smaller than the GPS noise are held),
   *  - gaps up to 30 s are filled in at 1 Hz; longer gaps become one segment.
   * Nothing is snapped to roads, so campus paths and inner roads are kept as ridden.
   * @param {object} h { onSample(smp) }
   */
  function createLiveSource(h) {
    const MAX_GAP_S = 30, Q_MPS = 4;
    let kf = null, last = null, t = 0, paused = false;

    function filter(x, y, acc, ts) {
      if (!kf) { kf = { x, y, v: acc * acc, ts }; return kf; }
      const dt = Math.max(0, (ts - kf.ts) / 1000);
      kf.v += dt * Q_MPS * Q_MPS;
      const k = kf.v / (kf.v + acc * acc);
      kf.x += k * (x - kf.x); kf.y += k * (y - kf.y);
      kf.v *= 1 - k; kf.ts = ts;
      return kf;
    }

    return {
      /** Feed one navigator.geolocation position. */
      feed(p) {
        const c = p.coords;
        if (paused || c.accuracy > R.GPS_MAX_ACC_M) return;
        const [rx, ry] = Geo.toXY(c.latitude, c.longitude);
        const f = filter(rx, ry, Math.max(3, c.accuracy), p.timestamp);
        let fix = { x: f.x, y: f.y, alt: c.altitude, ts: p.timestamp };
        if (!last) { last = fix; emit(fix, 1); return; }
        const gap = Math.round((fix.ts - last.ts) / 1000);
        if (gap < 1) return;
        const hold = Math.min(12, Math.max(3, c.accuracy * 0.6));
        if (Geo.dist([last.x, last.y], [fix.x, fix.y]) < hold) fix = { ...fix, x: last.x, y: last.y };
        if (gap > MAX_GAP_S) { emit(fix, gap); last = fix; return; }
        for (let k = 1; k <= gap; k++) {
          const q = k / gap;
          emit({
            x: last.x + (fix.x - last.x) * q, y: last.y + (fix.y - last.y) * q,
            alt: last.alt != null && fix.alt != null ? last.alt + (fix.alt - last.alt) * q : null,
          }, 1);
        }
        last = fix;
      },
      // Resume restarts the line (no straight line across the pause).
      pause(v) { paused = v; if (!v) { last = null; kf = null; } },
    };

    function emit(f, dt) {
      t++;
      const [lat, lng] = Geo.toLL(f.x, f.y);
      h.onSample({ t, x: f.x, y: f.y, lat, lng, alt: f.alt, hr: 0, dt });
    }
  }

  // ---------------------------------------------------------------- recorder

  /**
   * @param {object} opts   { declared: 'auto'|'walk'|'cycle', streak, group(): players moving together }
   * @param {object} hooks  {
   *   zoneAt(lat, lng) -> { zone, mine } | null      the zone you're in
   *   hit(zone, hp) -> { broken: bool }               damage a rival zone
   *   heal(zone, hp) -> hp actually healed            heal your own zone
   *   emit(event)                                      UI events
   * }
   */
  function createRecorder(opts, hooks) {
    const emit = hooks.emit || (() => {});
    const rec = {
      samples: [],            // {x, y, lat, lng, valid, jump}
      track: [],              // [lat, lng] of every scored point: becomes the zone at the end
      start: null,
      dist: 0, validDist: 0, flaggedDist: 0, time: 0,
      walkSec: 0, cycleKm: 0,
      mode: opts.declared === 'cycle' ? 'cycle' : 'walk',
      kmh: 0, grade: 0, hr: 0, hrZone: 0, intensity: 1, ctx: 'neutral', zone: null, group: 1, maxGroup: 1,
      damage: 0, parts: { base: 0, streak: 0, group: 0, defend: 0 },
      zoneDamage: 0, healed: 0, hits: {}, healedZones: {},
      broken: [], breakBonus: 0,
      flags: [], flagActive: null, overSec: 0, nearStartAt: -1e9,
    };
    const win = [], sustain = [], altWin = [];
    let prev = null;

    rec.push = function (smp) {
      const dt = smp.dt || 1;
      rec.time += dt;
      if (!prev) {
        prev = smp; rec.start = [smp.lat, smp.lng];
        rec.samples.push({ x: smp.x, y: smp.y, lat: smp.lat, lng: smp.lng, valid: true });
        rec.track.push([smp.lat, smp.lng]);
        return;
      }
      const d = Geo.dist([prev.x, prev.y], [smp.x, smp.y]);

      // --- Anti-cheat 1: GPS jump (teleport)
      if (d > R.GPS_JUMP_M && d / dt > R.GPS_JUMP_MPS) {
        addFlag('gps', `GPS jump of ${Math.round(d)} m ignored`, 0);
        rec.samples.push({ x: smp.x, y: smp.y, lat: smp.lat, lng: smp.lng, valid: false, jump: true });
        prev = smp; win.length = 0;
        return;
      }

      rec.dist += d;
      win.push({ d, dt }); if (win.length > 5) win.shift();
      rec.kmh = win.reduce((a, w) => a + w.d, 0) / win.reduce((a, w) => a + w.dt, 0) * 3.6;

      // Grade over ~10 s (only when the phone reports altitude)
      altWin.push({ alt: smp.alt, d }); if (altWin.length > 10) altWin.shift();
      const run = altWin.slice(1).reduce((a, w) => a + w.d, 0);
      const a0 = altWin[0].alt, a1 = altWin[altWin.length - 1].alt;
      rec.grade = run > 15 && a0 != null && a1 != null ? (a1 - a0) / run : 0;
      if (Math.abs(rec.grade) > 0.25) rec.grade = 0; // GPS altitude glitch, not a real 25 % hill

      rec.hr = smp.hr; rec.hrZone = R.hrZone(smp.hr);

      // --- Mode detection (auto) or manual override
      const prevMode = rec.mode;
      rec.mode = opts.declared === 'auto' ? R.detectMode(rec.kmh, rec.mode) : opts.declared;
      if (rec.mode !== prevMode) emit({ type: 'mode', mode: rec.mode });

      // --- Anti-cheat 2: speed doesn't match the mode / car speed
      const limit = rec.mode === 'walk' ? R.WALK_MAX_KMH : R.CYCLE_MAX_KMH;
      const over = rec.kmh > limit;
      rec.overSec = over ? rec.overSec + dt : 0;
      if (over && rec.overSec >= R.CHEAT_SUSTAIN_SEC && !rec.flagActive) {
        rec.flagActive = rec.mode === 'walk'
          ? addFlag('speed', `“Walking” at ${Math.round(rec.kmh)} km/h. Damage paused`, d)
          : addFlag('car', `Car-speed segment (${Math.round(rec.kmh)} km/h). Damage paused`, d);
      }
      if (!over && rec.flagActive) { rec.flagActive = null; emit({ type: 'flagClear' }); }
      const valid = !over;
      rec.samples.push({ x: smp.x, y: smp.y, lat: smp.lat, lng: smp.lng, valid });
      if (!valid) {
        rec.flaggedDist += d; if (rec.flagActive) rec.flagActive.km += d / 1000;
        prev = smp;
        return;
      }

      rec.validDist += d;
      rec.track.push([smp.lat, smp.lng]);
      if (rec.mode === 'walk') rec.walkSec += dt; else rec.cycleKm += d / 1000;

      // --- Intensity
      sustain.push({ kmh: rec.kmh, zone: rec.hrZone }); if (sustain.length > R.SUSTAIN_SEC) sustain.shift();
      const full = sustain.length >= R.SUSTAIN_SEC;
      rec.intensity = R.intensity(rec.mode, {
        kmh: rec.kmh, grade: rec.grade, hrZone: rec.hrZone, hasHr: false,
        sustainedKmh: full ? Math.min(...sustain.map((v) => v.kmh)) : 0, sustainedHrZone: 0,
      });

      // --- Damage
      rec.group = Math.max(1, opts.group ? opts.group() : 1);
      rec.maxGroup = Math.max(rec.maxGroup, rec.group);
      const here = hooks.zoneAt ? hooks.zoneAt((prev.lat + smp.lat) / 2, (prev.lng + smp.lng) / 2) : null;
      const zone = here && here.zone;
      let ctx = 'neutral';
      if (zone) ctx = !here.mine ? 'attack' : effHpNow(zone) < zone.maxHp ? 'defend' : 'patrol';
      rec.ctx = ctx; rec.zone = zone;
      const km = d / 1000;
      const base = km * R.DAMAGE_PER_KM * rec.intensity;
      const S = R.streakMult(opts.streak || 0), G = R.groupMult(rec.group), C = ctx === 'defend' ? R.DEFEND_MULT : 1;
      const dmg = R.segmentDamage(km, rec.intensity, opts.streak || 0, rec.group, ctx);
      rec.parts.base += base;
      rec.parts.streak += base * (S - 1);
      rec.parts.group += base * S * (G - 1);
      rec.parts.defend += base * S * G * (C - 1);
      rec.damage += dmg;

      let zoneHit = 0;
      if (ctx === 'attack') {
        zoneHit = R.zoneDamage(dmg, W.ownerInactiveDays(zone));
        rec.zoneDamage += zoneHit;
        const hz = rec.hits[zone.id] || (rec.hits[zone.id] = { owner: zone.owner, name: zone.name, hp: 0, broken: false });
        hz.hp += zoneHit;
        const r = hooks.hit(zone, zoneHit);
        if (r && r.broken) {
          hz.broken = true;
          rec.broken.push(zone.name); rec.breakBonus += R.NEUTRALISE_PTS;
          emit({ type: 'break', zone, lat: smp.lat, lng: smp.lng });
        }
      } else if (ctx === 'defend') {
        const h = hooks.heal(zone, dmg) || 0;
        rec.healed += h;
        if (h) rec.healedZones[zone.id] = zone.name;
      }
      emit({ type: 'damage', amount: dmg, zoneHit, ctx, zone, lat: smp.lat, lng: smp.lng });

      // --- Back near the start: remind the player that ending now closes a full loop
      if (rec.validDist >= R.NEAR_START_MIN_PATH_M && rec.time - rec.nearStartAt > 90 &&
          Geo.distLL(rec.start, [smp.lat, smp.lng]) <= R.NEAR_START_M) {
        rec.nearStartAt = rec.time;
        emit({ type: 'nearStart' });
      }
      prev = smp;
    };

    function effHpNow(z) { return W.effHp(z); }

    function addFlag(kind, text, d) {
      const f = { kind, text, km: d / 1000, at: rec.time };
      rec.flags.push(f);
      emit({ type: 'flag', flag: f });
      return f;
    }

    rec.totalPoints = (claimBonus) => rec.damage + rec.breakBonus + (claimBonus || 0);
    return rec;
  }

  /** One-off position, resolves {lat, lng, acc}. */
  function locateOnce() {
    return new Promise((resolve, reject) => {
      if (!('geolocation' in navigator)) return reject(new Error('This browser has no GPS support.'));
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
        (e) => reject(new Error(GEO_HELP[e.code] || 'Could not get your location.')),
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
    });
  }

  window.Sim = { GEO_HELP, customScenario, createSampler, createLiveSource, createRecorder, locateOnce };
})();
