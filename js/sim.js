/* PedalPace — simulated GPS routes + the activity recorder (the game loop).
 * The recorder only sees 1 Hz samples {x, y, alt, hr}, exactly like a real
 * phone would, so swapping the simulator for navigator.geolocation is a
 * drop-in change. */
(function () {
  'use strict';
  const R = window.Rules, W = window.World, Geo = W.Geo;

  // ---------------------------------------------------------------- scenarios
  // legs: { to:[x,y], kmh, kind?: 'car' | 'jump' }   coordinates in metres from home

  const SCENARIOS = [
    {
      id: 'claim', name: 'First claim walk', icon: '🚩', mode: 'walk',
      desc: 'Brisk 2.5 km loop over the park hill into never-owned blocks. Close the loop to claim them.',
      start: [0, 0],
      legs: [
        { to: [0, 450], kmh: 5.8 }, { to: [300, 450], kmh: 5.8 }, { to: [300, 850], kmh: 5.6 },
        { to: [-100, 850], kmh: 5.8 }, { to: [-100, 450], kmh: 5.8 }, { to: [0, 450], kmh: 5.8 },
        { to: [0, 0], kmh: 5.4 },
      ],
    },
    {
      id: 'raid', name: 'Raid ride', icon: '⚔️', mode: 'cycle',
      desc: '6.3 km ride. Lap inside Vex’s decaying zone until it breaks, then circle the whole block to take it.',
      start: [0, 0],
      legs: [
        { to: [0, -100], kmh: 16 }, { to: [560, -100], kmh: 23 },
        // two laps inside Vex Yards
        { to: [960, -100], kmh: 23 }, { to: [960, 300], kmh: 22 }, { to: [560, 300], kmh: 23 }, { to: [560, -100], kmh: 22 },
        { to: [960, -100], kmh: 23 }, { to: [960, 300], kmh: 22 }, { to: [560, 300], kmh: 23 }, { to: [560, -100], kmh: 22 },
        // outer loop around the (now neutral) block
        { to: [480, -100], kmh: 16 }, { to: [480, -180], kmh: 16 }, { to: [1040, -180], kmh: 24 },
        { to: [1040, 380], kmh: 22 }, { to: [480, 380], kmh: 24 }, { to: [480, -80], kmh: 22 },
        { to: [250, -80], kmh: 14 },
      ],
    },
    {
      id: 'defend', name: 'Defend patrol', icon: '🛡️', mode: 'walk',
      desc: '1.5 km brisk walk around Home Turf. Heals it with 1.25× defend damage and reinforces it with a loop.',
      start: [0, 0],
      legs: [
        { to: [-150, 0], kmh: 5.9 }, { to: [-150, 200], kmh: 5.9 }, { to: [200, 200], kmh: 5.9 },
        { to: [200, -150], kmh: 5.9 }, { to: [-150, -150], kmh: 5.9 }, { to: [-150, -20], kmh: 5.9 },
        { to: [-150, 0], kmh: 5.6 }, { to: [0, 0], kmh: 5.6 },
      ],
    },
    {
      id: 'group', name: 'Clan walk with Mira', icon: '👥', mode: 'walk', group: 2,
      desc: 'Walk with a clan mate. The ×1.2 combo applies while you move together. Claims the gap between your zones.',
      start: [-260, -250],
      legs: [
        { to: [-480, -250], kmh: 5.6 }, { to: [-480, 250], kmh: 5.6 }, { to: [-260, 250], kmh: 5.6 },
        { to: [-260, -230], kmh: 5.6 }, { to: [-260, -250], kmh: 5.2 },
      ],
    },
    {
      id: 'cheat', name: 'Cheat test', icon: '🚗', mode: 'walk', declared: 'walk',
      desc: 'Logged as a walk, but includes a 28 km/h car ride and a GPS jump. Anti-cheat should strip that damage.',
      start: [0, 0],
      legs: [
        { to: [0, -300], kmh: 5.5 }, { to: [-600, -300], kmh: 5.5 },
        { to: [-600, -1300], kmh: 28, kind: 'car' },
        { to: [-1400, -1300], kind: 'jump' },
        { to: [-1400, -1050], kmh: 5.2 },
      ],
    },
  ];

  /** Custom route from user-tapped waypoints. */
  function customScenario(points, mode, kmh) {
    return {
      id: 'custom', name: 'My route', icon: '✏️', mode, desc: 'Your drawn route.',
      start: points[0], legs: points.slice(1).map((p) => ({ to: p, kmh })),
    };
  }

  // ---------------------------------------------------------------- GPS sampler

  function createSampler(sc, opts) {
    let leg = 0, pos = sc.start.slice(), t = 0, hr = 82;
    const hasHr = !!opts.hr;
    return {
      done: false,
      pos: () => pos,
      next() {
        if (leg >= sc.legs.length) { this.done = true; return null; }
        const L = sc.legs[leg];
        if (L.kind === 'jump') { pos = L.to.slice(); leg++; t++; return sample(); }
        const remaining = Geo.dist(pos, L.to);
        // Speed wobble + slow down on climbs.
        const aheadGrade = (Geo.elevation(...step(pos, L.to, 10)) - Geo.elevation(...pos)) / 10;
        const slow = sc.mode === 'cycle' ? 1 - Math.max(0, aheadGrade) * 4 : 1 - Math.max(0, aheadGrade) * 2.5;
        const kmh = L.kmh * (1 + 0.07 * Math.sin(t / 23) + 0.03 * Math.sin(t / 7)) * Math.max(0.55, slow);
        let mps = kmh / 3.6;
        if (mps >= remaining) { pos = L.to.slice(); leg++; } else { pos = step(pos, L.to, mps); }
        t++;
        // Heart rate model with lag.
        if (hasHr) {
          const g = Math.max(0, aheadGrade);
          const target = L.kind === 'car' ? 78 : (sc.mode === 'cycle' ? 70 + kmh * 3.6 + g * 500 : 75 + kmh * 9 + g * 420);
          hr += (target - hr) * 0.04;
        }
        return sample();
      },
    };
    function sample() {
      return { t, x: pos[0], y: pos[1], alt: Geo.elevation(pos[0], pos[1]), hr: hasHr ? Math.round(hr) : 0 };
    }
  }
  function step(a, b, m) {
    const d = Geo.dist(a, b);
    if (d < 1e-6) return b.slice();
    return [a[0] + (b[0] - a[0]) * m / d, a[1] + (b[1] - a[1]) * m / d];
  }

  // ---------------------------------------------------------------- recorder

  /**
   * @param {object} s     World state (mutated live: zones take damage / get claimed)
   * @param {object} opts  { declared: 'auto'|'walk'|'cycle', group, hr }
   * @param {function} emit  event callback
   */
  function createRecorder(s, opts, emit) {
    const st = s.stats;
    const rec = {
      samples: [],            // {x,y,valid}
      loop: [],               // valid points since the last loop closure / break
      loopDist: [],           // cumulative distance for each loop point
      dist: 0, validDist: 0, flaggedDist: 0, time: 0,
      walkSec: 0, cycleKm: 0,
      mode: opts.declared === 'cycle' ? 'cycle' : 'walk',
      kmh: 0, grade: 0, hr: 0, hrZone: 0, intensity: 1, ctx: 'neutral',
      damage: 0, parts: { base: 0, streak: 0, group: 0, defend: 0 },
      zoneDamage: 0, healed: 0,
      claimedCells: 0, virgin: 0, neutral: 0, claimBonus: 0, neutralised: [], neutraliseBonus: 0,
      flags: [], flagActive: null, overSec: 0,
      claims: [],
      group: opts.group || 1,
    };
    const win = [];          // last 5 samples for smoothing
    const sustain = [];      // last SUSTAIN_SEC {kmh, zone}
    const altWin = [];       // last 10 {alt, d}
    let prev = null;

    function breakLoop() { rec.loop = []; rec.loopDist = []; }

    rec.push = function (smp) {
      rec.time++;
      if (!prev) {
        prev = smp; rec.samples.push({ x: smp.x, y: smp.y, valid: true });
        rec.loop.push([smp.x, smp.y]); rec.loopDist.push(0);
        return;
      }
      const d = Geo.dist([prev.x, prev.y], [smp.x, smp.y]);

      // --- Anti-cheat 1: GPS jump (teleport between consecutive fixes)
      if (d > R.GPS_JUMP_M) {
        addFlag('gps', `GPS jump of ${Math.round(d)} m ignored`, 0);
        rec.samples.push({ x: smp.x, y: smp.y, valid: false, jump: true });
        prev = smp; win.length = 0; breakLoop();
        rec.loop.push([smp.x, smp.y]); rec.loopDist.push(0);
        return;
      }

      rec.dist += d;
      win.push(d); if (win.length > 5) win.shift();
      rec.kmh = (win.reduce((a, b) => a + b, 0) / win.length) * 3.6;

      // Grade over ~10 s
      altWin.push({ alt: smp.alt, d }); if (altWin.length > 10) altWin.shift();
      const run = altWin.slice(1).reduce((a, w) => a + w.d, 0);
      rec.grade = run > 15 ? (altWin[altWin.length - 1].alt - altWin[0].alt) / run : 0;

      rec.hr = smp.hr; rec.hrZone = R.hrZone(smp.hr);

      // --- Mode detection (auto) or manual override
      const prevMode = rec.mode;
      rec.mode = opts.declared === 'auto' ? R.detectMode(rec.kmh, rec.mode) : opts.declared;
      if (rec.mode !== prevMode) emit({ type: 'mode', mode: rec.mode });

      // --- Anti-cheat 2: speed doesn't match the mode / car speed
      const limit = rec.mode === 'walk' ? R.WALK_MAX_KMH : R.CYCLE_MAX_KMH;
      const over = rec.kmh > limit;
      rec.overSec = over ? rec.overSec + 1 : 0;
      if (over && rec.overSec >= R.CHEAT_SUSTAIN_SEC && !rec.flagActive) {
        rec.flagActive = rec.mode === 'walk'
          ? addFlag('speed', `“Walking” at ${Math.round(rec.kmh)} km/h. Damage paused`, d)
          : addFlag('car', `Car-speed segment (${Math.round(rec.kmh)} km/h). Damage paused`, d);
      }
      if (!over && rec.flagActive) { rec.flagActive = null; emit({ type: 'flagClear' }); }
      const valid = !over;
      rec.samples.push({ x: smp.x, y: smp.y, valid });
      if (!valid) {
        rec.flaggedDist += d; if (rec.flagActive) rec.flagActive.km += d / 1000;
        prev = smp; breakLoop(); rec.loop.push([smp.x, smp.y]); rec.loopDist.push(0);
        return;
      }

      rec.validDist += d;
      if (rec.mode === 'walk') rec.walkSec++; else rec.cycleKm += d / 1000;

      // --- Intensity
      sustain.push({ kmh: rec.kmh, zone: rec.hrZone }); if (sustain.length > R.SUSTAIN_SEC) sustain.shift();
      const full = sustain.length >= R.SUSTAIN_SEC;
      rec.intensity = R.intensity(rec.mode, {
        kmh: rec.kmh, grade: rec.grade, hrZone: rec.hrZone, hasHr: !!opts.hr,
        sustainedKmh: full ? Math.min(...sustain.map((v) => v.kmh)) : 0,
        sustainedHrZone: full && opts.hr ? Math.min(...sustain.map((v) => v.zone)) : 0,
      });

      // --- Damage
      const mx = (prev.x + smp.x) / 2, my = (prev.y + smp.y) / 2;
      const zone = W.zoneAt(s, mx, my);
      let ctx = 'neutral';
      if (zone) {
        if (!W.isFriendly(s, zone.owner)) ctx = 'attack';
        else if (zone.hp < zone.maxHp) ctx = 'defend';
      }
      rec.ctx = ctx;
      const km = d / 1000;
      const base = km * R.DAMAGE_PER_KM * rec.intensity;
      const S = R.streakMult(st.streak), G = R.groupMult(rec.group), C = ctx === 'defend' ? R.DEFEND_MULT : 1;
      const dmg = R.segmentDamage(km, rec.intensity, st.streak, rec.group, ctx);
      rec.parts.base += base;
      rec.parts.streak += base * (S - 1);
      rec.parts.group += base * S * (G - 1);
      rec.parts.defend += base * S * G * (C - 1);
      rec.damage += dmg;

      let zoneHit = 0;
      if (ctx === 'attack') {
        zoneHit = R.zoneDamage(dmg, s.players[zone.owner] ? s.players[zone.owner].inactiveDays : 0);
        zone.hp -= zoneHit; rec.zoneDamage += zoneHit;
        if (zone.hp <= 0) {
          zone.hp = 0;
          rec.neutralised.push(zone.name); rec.neutraliseBonus += R.NEUTRALISE_PTS;
          W.neutraliseZone(s, zone);
          emit({ type: 'neutralise', zone, x: smp.x, y: smp.y });
        }
      } else if (ctx === 'defend') {
        const h = Math.min(dmg, zone.maxHp - zone.hp);
        zone.hp += h; rec.healed += h;
      }
      emit({ type: 'damage', amount: dmg, zoneHit, ctx, zone: zone && s.zones[zone.id] ? zone : null, x: smp.x, y: smp.y });

      // --- Loop detection
      rec.loop.push([smp.x, smp.y]);
      rec.loopDist.push(rec.loopDist[rec.loopDist.length - 1] + d);
      checkLoop();
      prev = smp;
    };

    function checkLoop() {
      const n = rec.loop.length - 1, here = rec.loop[n], dNow = rec.loopDist[n];
      for (let k = 0; k < n; k++) {
        if (dNow - rec.loopDist[k] < R.LOOP_MIN_PATH_M) break; // later points are even closer in path terms
        if (Geo.dist(rec.loop[k], here) <= R.LOOP_CLOSE_M) {
          const pts = rec.loop.slice(k);
          const res = W.claimLoop(s, pts);
          if (res.closed) {
            rec.claimedCells += res.claimed.length; rec.virgin += res.virgin; rec.neutral += res.neutral;
            const bonus = res.virgin * R.CLAIM_VIRGIN_PTS + res.neutral * R.CLAIM_NEUTRAL_PTS;
            rec.claimBonus += bonus;
            rec.claims.push({ ...res, bonus, pts });
            emit({ type: 'claim', res, bonus, pts });
            breakLoop(); rec.loop.push(here); rec.loopDist.push(0);
          }
          return;
        }
      }
    }

    function addFlag(kind, text, d) {
      const f = { kind, text, km: d / 1000, at: rec.time };
      rec.flags.push(f);
      emit({ type: 'flag', flag: f });
      return f;
    }

    rec.totalPoints = () => rec.damage + rec.claimBonus + rec.neutraliseBonus;
    return rec;
  }

  window.Sim = { SCENARIOS, customScenario, createSampler, createRecorder };
})();
