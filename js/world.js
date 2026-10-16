/* PedalPace — world model: geometry, zones, player profile, real-calendar day cycle.
 * Zones are real shapes (GeoJSON, [lng, lat]) so they line up exactly with the
 * route you walked or rode. Distances and speeds use a local metre projection
 * around ORIGIN (x = east, y = north), set to wherever the player is. */
(function () {
  'use strict';
  const R = window.Rules;
  const T = window.turf;

  const ORIGIN = { lat: 0, lng: 0 };
  const M_LAT = 111320;
  let M_LNG = 111320;

  const Geo = {
    ORIGIN,
    /** Re-centre the metre projection (call before a trip starts). */
    setOrigin(o) {
      ORIGIN.lat = o.lat; ORIGIN.lng = o.lng;
      M_LNG = 111320 * Math.cos(ORIGIN.lat * Math.PI / 180);
    },
    toLL: (x, y) => [ORIGIN.lat + y / M_LAT, ORIGIN.lng + x / M_LNG],
    toXY: (lat, lng) => [(lng - ORIGIN.lng) * M_LNG, (lat - ORIGIN.lat) * M_LAT],
    dist: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]),
    /** Metres between two [lat, lng] points (haversine). */
    distLL(a, b) {
      const r = Math.PI / 180, dLat = (b[0] - a[0]) * r, dLng = (b[1] - a[1]) * r;
      const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLng / 2) ** 2;
      return 2 * 6371000 * Math.asin(Math.sqrt(h));
    },
  };

  const COLORS = {
    cyan:    { neon: '#00E5FF', sun: '#006E99', name: 'Cyan' },
    magenta: { neon: '#FF2BD6', sun: '#A8007F', name: 'Magenta' },
    violet:  { neon: '#A98BFF', sun: '#5329D1', name: 'Violet' },
    orange:  { neon: '#FF9A1F', sun: '#A65000', name: 'Orange' },
    red:     { neon: '#FF3B5C', sun: '#C0002A', name: 'Red' },
    yellow:  { neon: '#FFE600', sun: '#7A6A00', name: 'Yellow' },
    lime:    { neon: '#B6FF00', sun: '#3A7300', name: 'Lime' },
  };
  const PLAYER_COLORS = Object.keys(COLORS);
  const colorHex = (c, theme) => (COLORS[c] || COLORS.cyan)[theme || 'neon'];

  const BADGES = {
    first_claim: { name: 'Flag Planter', desc: 'Claim your first zone', icon: '🚩' },
    raider:      { name: 'Raider', desc: 'Break a rival zone', icon: '⚔️' },
    defender:    { name: 'Defender', desc: 'Heal a damaged zone', icon: '🛡️' },
    explorer:    { name: 'Explorer', desc: 'Claim 0.05 km² in total', icon: '🧭' },
    combo:       { name: 'Squad Goals', desc: 'Trip with a friend nearby', icon: '👥' },
    clean:       { name: 'Fair Play', desc: 'Finish a trip with no flags', icon: '✅' },
    streak3:     { name: 'On a Roll', desc: '3-day streak', icon: '🔥' },
    streak7:     { name: 'Week Warrior', desc: '7-day streak', icon: '🏆' },
    rested:      { name: 'Smart Recovery', desc: 'Use a rest token', icon: '😴' },
  };

  // ---------------------------------------------------------------- calendar

  /** Local calendar day as an integer (days since 1970-01-01 in the player's timezone). */
  function dayIndex(t) {
    const d = new Date(t == null ? Date.now() : t);
    return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5);
  }
  /** Week number, weeks start on Monday (day 0 was a Thursday). */
  const weekIndex = (day) => Math.floor((day + 3) / 7);

  // ---------------------------------------------------------------- profile

  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  function newCode() {
    let c = '';
    for (let n = 0; n < 6; n++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    return c;
  }

  function newProfile(opts) {
    const today = dayIndex();
    return {
      v: 2,
      onboarded: false,
      name: (opts && opts.name) || 'Player',
      color: (opts && opts.color) || 'cyan',
      photo: (opts && opts.photo) || '',
      code: newCode(),
      friends: [],
      stats: {
        totalPoints: 0, damageDealt: 0, weeklyDamage: 0, pointsLost: 0,
        streak: 0, bestStreak: 0, missedDays: 0, restTokens: R.REST_TOKENS_PER_WEEK,
        activities: 0, zonesBroken: 0, areaClaimedM2: 0, areaM2: 0, km: 0,
      },
      today: { day: today, walkMin: 0, cycleKm: 0 },
      metDay: -1,          // last day the daily minimum was met (or a rest token used)
      activeDay: today,    // last day with an activity: drives zone decay
      lastTickDay: today,  // last day the overnight rules were applied
      week: weekIndex(today),
      badges: {},
      history: [],
      settings: { sunlight: false, notifications: true, mapStyle: 'satellite' },
    };
  }

  /**
   * Apply every overnight rule since the last time the app was opened:
   * missed-day penalties, streak reset, weekly reset. Mutates the profile.
   */
  function tickDays(p, today) {
    const st = p.stats, rep = { penalty: 0, missed: 0, newWeek: false };
    today = today == null ? dayIndex() : today;
    if (p.lastTickDay >= today) return rep;
    for (let d = p.lastTickDay; d < today; d++) {
      if (p.metDay === d) { st.missedDays = 0; continue; }
      st.missedDays++; rep.missed++;
      const pen = Math.min(R.inactivityPenalty(st.missedDays), st.totalPoints);
      st.totalPoints -= pen; st.pointsLost += pen; rep.penalty += pen;
      st.streak = 0;
    }
    if (weekIndex(today) !== p.week) {
      p.week = weekIndex(today); st.weeklyDamage = 0; st.restTokens = R.REST_TOKENS_PER_WEEK; rep.newWeek = true;
    }
    p.today = { day: today, walkMin: 0, cycleKm: 0 };
    p.lastTickDay = today;
    return rep;
  }

  /** Adds a trip's progress to today; may meet the daily minimum. */
  function addDailyProgress(p, walkMin, cycleKm) {
    const st = p.stats, today = p.today.day;
    p.today.walkMin += walkMin;
    p.today.cycleKm += cycleKm;
    if (p.metDay !== today && R.minimumProgress(p.today.walkMin, p.today.cycleKm) >= 1) {
      const avoided = R.inactivityPenalty(st.missedDays + 1);
      p.metDay = today;
      st.streak += 1; st.bestStreak = Math.max(st.bestStreak, st.streak); st.missedDays = 0;
      return { justMet: true, avoided };
    }
    return { justMet: false, avoided: 0 };
  }

  /** Spend a rest token on today. Returns '' on success or the reason it can't. */
  function useRestToken(p) {
    if (p.metDay === p.today.day) return 'Today is already covered.';
    if (p.stats.restTokens < 1) return 'No rest token left this week.';
    p.stats.restTokens--; p.metDay = p.today.day; p.stats.missedDays = 0;
    p.badges.rested = p.badges.rested || p.today.day;
    return '';
  }

  // ---------------------------------------------------------------- zones
  // zone: { id, owner, ownerName, color, name, geo (GeoJSON geometry), areaM2,
  //         maxHp, hp, ownerActiveDay, clat, clng, bbox: [w, s, e, n] }

  function ownerInactiveDays(z, today) {
    const t = today == null ? dayIndex() : today;
    return z.ownerActiveDay == null ? 0 : Math.max(0, t - z.ownerActiveDay - 1);
  }
  /** HP after decay. A zone at 0 or below is broken and counts as free ground. */
  const effHp = (z, today) => z.hp - R.decayTotal(z.maxHp, ownerInactiveDays(z, today));
  const isDecaying = (z, today) => ownerInactiveDays(z, today) >= R.DECAY_START_DAY;
  const feature = (z) => T.feature(z.geo);

  function inBbox(b, lng, lat) { return lng >= b[0] && lng <= b[2] && lat >= b[1] && lat <= b[3]; }
  const bboxOverlap = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

  /** The standing zone containing [lat, lng], or null. */
  function zoneAt(zones, lat, lng, today) {
    for (const z of zones) {
      if (!inBbox(z.bbox, lng, lat) || effHp(z, today) <= 0) continue;
      if (T.booleanPointInPolygon([lng, lat], z.geo)) return z;
    }
    return null;
  }

  /**
   * Label position: the point deepest inside the shape (furthest from any edge,
   * holes included), so labels of a ring-shaped zone don't sit on the zone it surrounds.
   */
  function labelPoint(geo) {
    const f = T.feature(geo);
    const edges = T.flatten(T.polygonToLine(f)).features;
    const depth = (pt) => Math.min(...edges.map((e) => T.pointToLineDistance(pt, e, { units: 'meters' })));
    let best = T.centerOfMass(f), bestD = T.booleanPointInPolygon(best, f) ? depth(best) : -1;
    const [w, s, e, n] = T.bbox(f), N = 12;
    for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
      const pt = T.point([w + (e - w) * i / N, s + (n - s) * j / N]);
      if (!T.booleanPointInPolygon(pt, f)) continue;
      const d = depth(pt);
      if (d > bestD * 1.15) { best = pt; bestD = d; } // prefer the centre unless clearly shallower
    }
    if (bestD < 0) best = T.pointOnFeature(f);
    const [lng, lat] = best.geometry.coordinates;
    return [lat, lng];
  }

  /** Drop slivers and round coordinates (≈10 cm) so shapes stay small to store. */
  function tidy(f) {
    if (!f) return null;
    const g = f.geometry;
    let polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    polys = polys.filter((c) => T.area(T.polygon(c)) >= R.MIN_PART_M2);
    if (!polys.length) return null;
    const out = polys.length === 1 ? T.polygon(polys[0]) : T.multiPolygon(polys);
    return T.truncate(out, { precision: 6, mutate: true });
  }

  /**
   * The area a trip encloses: the route, closed with a straight line from the
   * end back to the start. A full loop gives the loop's shape; an open arc
   * (e.g. a semicircle) is filled as if you'd ridden straight back.
   * Self-crossing routes (figure-eights, laps) are split and merged.
   * @param {Array<[number, number]>} pts  [lat, lng] points of the route
   * @returns GeoJSON Feature (Polygon | MultiPolygon) or null
   */
  function tripShape(pts) {
    if (!pts || pts.length < 3) return null;
    let line = T.lineString(pts.map(([lat, lng]) => [lng, lat]));
    try { line = T.cleanCoords(T.simplify(line, { tolerance: 0.00002, highQuality: true })); } catch (e) { /* keep raw */ }
    const ring = line.geometry.coordinates.slice();
    if (ring.length < 3) return null;
    ring.push(ring[0]);
    let poly;
    try { poly = T.polygon([ring]); } catch (e) { return null; }
    let parts = [poly];
    try { if (T.kinks(poly).features.length) parts = T.unkinkPolygon(poly).features; } catch (e) { /* fall back to the raw ring */ }
    let shape = parts[0];
    try { if (parts.length > 1) shape = T.union(T.featureCollection(parts)); } catch (e) { /* first part only */ }
    return tidy(shape);
  }

  /**
   * Work out what ending a trip claims.
   * - Rival zones with HP left are protected: the new zone is cut around them.
   * - Rival zones broken by decay are free ground and get removed.
   * - Your own zones that touch the new one merge into it (back to full HP).
   * @returns {{ shape, areaM2, newAreaM2, protectedNames, merged, dead, reason }}
   */
  function planClaim(zones, pts, me, today) {
    const res = { shape: null, areaM2: 0, newAreaM2: 0, protectedNames: [], merged: [], dead: [], reason: '' };
    let shape = tripShape(pts);
    if (!shape || T.area(shape) < R.MIN_ZONE_M2) { res.reason = 'small'; return res; }
    const box = () => T.bbox(shape);
    for (const z of zones) {
      if (z.owner === me || !bboxOverlap(box(), z.bbox)) continue;
      if (!T.booleanIntersects(shape, feature(z))) continue;
      if (effHp(z, today) <= 0) { res.dead.push(z); continue; }
      shape = tidy(T.difference(T.featureCollection([shape, feature(z)])));
      res.protectedNames.push(z.name);
      if (!shape) { res.reason = 'blocked'; return res; }
    }
    let ownArea = 0;
    for (const z of zones) {
      if (z.owner !== me || !bboxOverlap(box(), z.bbox)) continue;
      if (!T.booleanIntersects(shape, feature(z))) continue;
      shape = tidy(T.union(T.featureCollection([shape, feature(z)])));
      res.merged.push(z); ownArea += T.area(feature(z));
    }
    res.areaM2 = T.area(shape);
    res.newAreaM2 = Math.max(0, res.areaM2 - ownArea);
    if (res.newAreaM2 < R.MIN_ZONE_M2 && !res.merged.length) { res.reason = res.protectedNames.length ? 'blocked' : 'small'; return res; }
    res.shape = shape;
    return res;
  }

  /** Build the zone record for a claimed shape. */
  function makeZone(shape, owner, profile, name, today) {
    const areaM2 = T.area(shape);
    const [clat, clng] = labelPoint(shape.geometry);
    const maxHp = R.zoneMaxHp(areaM2);
    return {
      owner, ownerName: profile.name, color: profile.color, name,
      geo: shape.geometry, areaM2: Math.round(areaM2), maxHp, hp: maxHp,
      ownerActiveDay: today, clat, clng, bbox: T.bbox(shape),
    };
  }

  const areaKm2 = (m2) => m2 / 1e6;
  const fmtArea = (m2) => (m2 >= 100000 ? (m2 / 1e6).toFixed(2) + ' km²' : Math.round(m2).toLocaleString('en-US') + ' m²');

  window.World = {
    Geo, COLORS, PLAYER_COLORS, BADGES, colorHex,
    dayIndex, weekIndex, newProfile, newCode, tickDays, addDailyProgress, useRestToken,
    ownerInactiveDays, effHp, isDecaying, zoneAt, labelPoint, tripShape, planClaim, makeZone,
    areaKm2, fmtArea,
  };
})();
