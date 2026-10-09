/* PedalPace — world model: geometry, territory grid, zones, players, day cycle.
 * All game logic works in local metres (x = east, y = north) around ORIGIN;
 * only the renderer converts to lat/lng. */
(function () {
  'use strict';
  const R = window.Rules;

  // Generic city with a north-aligned street grid (Chicago, West Town).
  const ORIGIN = { lat: 41.8960, lng: -87.6700 };
  const M_LAT = 111320;
  const M_LNG = 111320 * Math.cos(ORIGIN.lat * Math.PI / 180);
  const CELL = 66; // metres; one territory cell ≈ 0.0044 km²

  const Geo = {
    ORIGIN, CELL,
    toLL: (x, y) => [ORIGIN.lat + y / M_LAT, ORIGIN.lng + x / M_LNG],
    toXY: (lat, lng) => [(lng - ORIGIN.lng) * M_LNG, (lat - ORIGIN.lat) * M_LAT],
    dist: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]),
    cellOf: (x, y) => [Math.floor(y / CELL), Math.floor(x / CELL)],
    key: (i, j) => i + ',' + j,
    parse: (k) => k.split(',').map(Number),
    cellBoundsLL(i, j) {
      return [Geo.toLL(j * CELL, i * CELL), Geo.toLL((j + 1) * CELL, (i + 1) * CELL)];
    },
    /** Terrain height (m) — a park hill north of home and a gentle rise east. */
    elevation(x, y) {
      const hill = (cx, cy, r, h) => h * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (r * r));
      return 180 + hill(100, 650, 190, 28) + hill(1300, 150, 400, 12);
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
  const PLAYER_COLORS = ['cyan', 'magenta', 'violet', 'orange'];

  const CLANS = {
    neon: { id: 'neon', name: 'Neon Spokes', tag: 'NSP' },
    owls: { id: 'owls', name: 'Night Owls', tag: 'OWL' },
    pace: { id: 'pace', name: 'Pace Pack', tag: 'PCK' },
  };

  const BADGES = {
    first_claim: { name: 'Flag Planter', desc: 'Claim your first area', icon: '🚩' },
    raider:      { name: 'Raider', desc: 'Neutralise an enemy zone', icon: '⚔️' },
    defender:    { name: 'Defender', desc: 'Heal a damaged zone', icon: '🛡️' },
    explorer:    { name: 'Explorer', desc: 'Claim 50 never-owned cells', icon: '🧭' },
    combo:       { name: 'Squad Goals', desc: 'Finish a group walk or ride', icon: '👥' },
    clean:       { name: 'Fair Play', desc: 'Finish an activity with no flags', icon: '✅' },
    streak3:     { name: 'On a Roll', desc: '3-day streak', icon: '🔥' },
    streak7:     { name: 'Week Warrior', desc: '7-day streak', icon: '🏆' },
    rested:      { name: 'Smart Recovery', desc: 'Use a rest token', icon: '😴' },
  };

  // ---------------------------------------------------------------- state

  const STORE_KEY = 'pedalpace.v1';

  function rect(i0, i1, j0, j1) {
    const out = [];
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) out.push(Geo.key(i, j));
    return out;
  }

  function newState() {
    const s = {
      v: 1,
      onboarded: false,
      day: 1,
      player: { id: 'you', name: 'You', color: 'cyan', clan: 'neon', hr: true, notifications: true },
      settings: { sunlight: false, playback: 20 },
      players: {
        you:  { id: 'you',  name: 'You',  color: 'cyan',   clan: 'neon', inactiveDays: 0, bot: false },
        mira: { id: 'mira', name: 'Mira', color: 'lime',   clan: 'neon', inactiveDays: 0, bot: true },
        vex:  { id: 'vex',  name: 'Vex',  color: 'red',    clan: 'owls', inactiveDays: 4, bot: true },
        kai:  { id: 'kai',  name: 'Kai',  color: 'yellow', clan: 'owls', inactiveDays: 0, bot: true },
      },
      zones: {},
      cells: {},       // cellKey -> zoneId
      neutral: {},     // cellKey -> 1   (previously owned, now unowned)
      everOwned: {},   // cellKey -> 1
      nextZone: 1,
      stats: {
        totalPoints: 420, damageDealt: 420, pointsLost: 0, weeklyDamage: 140,
        streak: 2, bestStreak: 4, missedDays: 0, restTokens: R.REST_TOKENS_PER_WEEK,
        todayWalkMin: 0, todayCycleKm: 0, todayMet: false,
        cellsClaimed: 49, virginClaimed: 0, zonesNeutralised: 0, activities: 0,
      },
      badges: {},
      history: [],
      notifications: [],
    };
    // Seed territory (prototype data).
    addZone(s, 'you',  'Home Turf',     rect(-3, 3, -3, 3),     0.70);
    addZone(s, 'mira', 'Mira’s Market', rect(-3, 4, -15, -9),   0.90);
    addZone(s, 'vex',  'Vex Yards',     rect(-2, 4, 8, 14),     0.22);
    addZone(s, 'kai',  'Kai’s Kingdom', rect(-14, -7, -4, 7),   1.00);
    notify(s, 'attack', 'Your territory is under attack! Kai hit Home Turf for 100 HP overnight.');
    notify(s, 'info', 'Vex has been inactive for 4 days. Vex Yards is decaying and easier to take.');
    return s;
  }

  function addZone(s, owner, name, cellKeys, hpFrac) {
    const id = 'z' + (s.nextZone++);
    const maxHp = R.zoneMaxHp(cellKeys.length);
    s.zones[id] = { id, owner, name, cells: cellKeys.slice(), maxHp, hp: Math.round(maxHp * (hpFrac == null ? 1 : hpFrac)) };
    for (const k of cellKeys) { s.cells[k] = id; s.everOwned[k] = 1; delete s.neutral[k]; }
    return s.zones[id];
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) { const s = JSON.parse(raw); if (s && s.v === 1) return s; }
    } catch (e) { /* storage unavailable: fall through */ }
    return newState();
  }
  function save(s) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch (e) { /* ignore */ }
  }
  function reset() {
    try { localStorage.removeItem(STORE_KEY); } catch (e) { /* ignore */ }
    return newState();
  }

  function notify(s, type, text) {
    s.notifications.unshift({ id: Date.now() + Math.random(), day: s.day, type, text, read: false });
    s.notifications = s.notifications.slice(0, 40);
  }

  // ---------------------------------------------------------------- relations

  const isFriendly = (s, ownerId) =>
    ownerId === 'you' || (!!s.player.clan && s.players[ownerId] && s.players[ownerId].clan === s.player.clan);

  function zoneAt(s, x, y) {
    const [i, j] = Geo.cellOf(x, y);
    const id = s.cells[Geo.key(i, j)];
    return id ? s.zones[id] : null;
  }

  function neutraliseZone(s, zone) {
    for (const k of zone.cells) { delete s.cells[k]; s.neutral[k] = 1; }
    delete s.zones[zone.id];
  }

  function areaKm2(cellCount) { return cellCount * CELL * CELL / 1e6; }

  function ownedCells(s, ownerId) {
    let n = 0;
    for (const z of Object.values(s.zones)) if (z.owner === ownerId) n += z.cells.length;
    return n;
  }

  // ---------------------------------------------------------------- loop claim

  /**
   * Claim everything enclosed by a closed loop of points (metres).
   * Rasterises the loop into cells, flood-fills from outside the bounding box;
   * every cell the flood can't reach is enclosed (this also handles odd shapes).
   */
  function claimLoop(s, loopPts) {
    const wall = new Set();
    for (let n = 0; n < loopPts.length; n++) {
      const a = loopPts[n], b = loopPts[(n + 1) % loopPts.length];
      const steps = Math.max(1, Math.ceil(Geo.dist(a, b) / 8));
      for (let t = 0; t <= steps; t++) {
        const [i, j] = Geo.cellOf(a[0] + (b[0] - a[0]) * t / steps, a[1] + (b[1] - a[1]) * t / steps);
        wall.add(Geo.key(i, j));
      }
    }
    let i0 = Infinity, i1 = -Infinity, j0 = Infinity, j1 = -Infinity;
    for (const k of wall) { const [i, j] = Geo.parse(k); i0 = Math.min(i0, i); i1 = Math.max(i1, i); j0 = Math.min(j0, j); j1 = Math.max(j1, j); }
    i0--; i1++; j0--; j1++;
    const outside = new Set([Geo.key(i0, j0)]);
    const stack = [[i0, j0]];
    while (stack.length) {
      const [i, j] = stack.pop();
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = i + di, nj = j + dj;
        if (ni < i0 || ni > i1 || nj < j0 || nj > j1) continue;
        const k = Geo.key(ni, nj);
        if (outside.has(k) || wall.has(k)) continue;
        outside.add(k); stack.push([ni, nj]);
      }
    }
    const enclosed = [];
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const k = Geo.key(i, j);
      if (!outside.has(k)) enclosed.push(k);
    }
    const interior = enclosed.filter((k) => !wall.has(k)).length;
    const res = { closed: interior >= 2, claimed: [], virgin: 0, neutral: 0, protectedCells: 0, protectedZones: [], reinforced: [], zone: null };
    if (!res.closed) return res;

    const reinforced = new Set(), prot = new Set();
    for (const k of enclosed) {
      const zid = s.cells[k];
      if (zid) {
        const z = s.zones[zid];
        if (isFriendly(s, z.owner)) reinforced.add(zid);
        else { res.protectedCells++; prot.add(z.name); }
        continue;
      }
      res.claimed.push(k);
      if (s.everOwned[k]) res.neutral++; else res.virgin++;
    }
    for (const zid of reinforced) { const z = s.zones[zid]; res.reinforced.push({ name: z.name, healed: z.maxHp - z.hp }); z.hp = z.maxHp; }
    res.protectedZones = [...prot];
    if (res.claimed.length) {
      const count = Object.values(s.zones).filter((z) => z.owner === 'you').length;
      res.zone = addZone(s, 'you', 'Turf #' + (count + 1), res.claimed, 1);
    }
    return res;
  }

  // ---------------------------------------------------------------- daily cycle

  /** Called when an activity finishes: adds today's progress, may meet the minimum. */
  function addDailyProgress(s, walkMin, cycleKm) {
    const st = s.stats;
    st.todayWalkMin += walkMin;
    st.todayCycleKm += cycleKm;
    if (!st.todayMet && R.minimumProgress(st.todayWalkMin, st.todayCycleKm) >= 1) {
      const avoided = R.inactivityPenalty(st.missedDays + 1);
      st.todayMet = true;
      st.streak += 1;
      st.bestStreak = Math.max(st.bestStreak, st.streak);
      st.missedDays = 0;
      s.players.you.inactiveDays = 0;
      return { justMet: true, avoided };
    }
    return { justMet: false, avoided: 0 };
  }

  /**
   * Advance the simulated clock to the next morning.
   * @param {boolean} useToken  spend a rest token if today's minimum wasn't met
   * @returns {object} report of what happened overnight
   */
  function endDay(s, useToken) {
    const st = s.stats, rep = { penalty: 0, tokenUsed: false, decay: [], attacks: [], lost: [] };
    const you = s.players.you;

    if (!st.todayMet) {
      if (useToken && st.restTokens > 0) {
        st.restTokens--; rep.tokenUsed = true; s.badges.rested = s.badges.rested || s.day;
        notify(s, 'info', 'Rest day logged. Streak kept, no penalty. Recovery is training too.');
      } else {
        st.missedDays++;
        rep.penalty = Math.min(R.inactivityPenalty(st.missedDays), st.totalPoints);
        st.totalPoints -= rep.penalty;
        st.pointsLost += rep.penalty;
        st.streak = 0;
        you.inactiveDays++;
      }
    }

    // Bots: Vex stays idle, Mira patrols, Kai raids a friendly zone.
    s.players.vex.inactiveDays++;
    const mz = Object.values(s.zones).find((z) => z.owner === 'mira');
    if (mz) mz.hp = Math.min(mz.maxHp, mz.hp + 40);
    const targets = Object.values(s.zones).filter((z) => isFriendly(s, z.owner));
    if (targets.length && s.players.kai) {
      const t = targets[(s.day * 7) % targets.length];
      const dmg = 30 + ((s.day * 37) % 31);
      t.hp -= dmg;
      rep.attacks.push({ zone: t.name, dmg, by: 'Kai' });
      if (t.owner === 'you') notify(s, 'attack', `Your territory is under attack! Kai hit ${t.name} for ${dmg} HP.`);
    }

    // Decay every zone whose owner has been inactive.
    for (const z of Object.values(s.zones)) {
      const p = s.players[z.owner];
      const d = R.decayAmount(z.maxHp, p ? p.inactiveDays : 0);
      if (d) { z.hp -= d; rep.decay.push({ zone: z.name, owner: z.owner, d }); }
    }
    if (you.inactiveDays >= R.DECAY_START_DAY) {
      const total = rep.decay.filter((x) => x.owner === 'you').reduce((a, x) => a + x.d, 0);
      if (total) notify(s, 'decay', `Your zones are decaying (−${total} HP overnight). A 15-min walk or 5 km ride stops it.`);
    }
    for (const z of Object.values(s.zones)) {
      if (z.hp <= 0) {
        rep.lost.push(z.name);
        if (z.owner === 'you') notify(s, 'decay', `You lost ${z.name}. It is now neutral and anyone can claim it.`);
        neutraliseZone(s, z);
      }
    }
    if (rep.penalty) notify(s, 'penalty', `Missed day: −${rep.penalty} pts. Tomorrow’s penalty would be −${R.inactivityPenalty(st.missedDays + 1)}.`);

    // New day.
    s.day++;
    if ((s.day - 1) % 7 === 0) { st.restTokens = R.REST_TOKENS_PER_WEEK; st.weeklyDamage = 0; notify(s, 'info', 'New week! Rest token refilled and weekly damage reset.'); }
    st.todayWalkMin = 0; st.todayCycleKm = 0; st.todayMet = false;
    notify(s, 'streak', st.streak > 0
      ? `Keep your ${st.streak}-day streak 🔥 15 min walking or 5 km cycling today.`
      : `Start a new streak today: 15 min walking or 5 km cycling.`);
    return rep;
  }

  // ---------------------------------------------------------------- leaderboards

  const NPCS = [
    { id: 'ravi', name: 'Ravi', clan: 'neon', points: 1310, weekly: 520, cells: 64, friend: true },
    { id: 'ana',  name: 'Ana',  clan: 'pace', points: 2240, weekly: 880, cells: 131, friend: true },
    { id: 'tom',  name: 'Tom',  clan: 'pace', points: 760,  weekly: 210, cells: 22, friend: false },
    { id: 'zoe',  name: 'Zoe',  clan: null,   points: 1890, weekly: 640, cells: 88, friend: true },
    { id: 'luis', name: 'Luis', clan: 'owls', points: 980,  weekly: 330, cells: 40, friend: false },
    { id: 'meg',  name: 'Meg',  clan: 'pace', points: 3050, weekly: 1100, cells: 170, friend: false },
  ];
  const BOT_STATS = {
    mira: { points: 1640, weekly: 590, friend: true },
    vex:  { points: 1190, weekly: 0, friend: false },
    kai:  { points: 2560, weekly: 940, friend: false },
  };

  function leaderboardRows(s) {
    const rows = NPCS.map((n) => ({ ...n }));
    for (const id of ['mira', 'vex', 'kai']) {
      const p = s.players[id];
      rows.push({ id, name: p.name, clan: p.clan, cells: ownedCells(s, id), ...BOT_STATS[id] });
    }
    rows.push({ id: 'you', name: s.player.name, clan: s.player.clan, points: s.stats.totalPoints,
      weekly: Math.round(s.stats.weeklyDamage), cells: ownedCells(s, 'you'), friend: true, me: true });
    return rows;
  }

  window.World = {
    Geo, COLORS, PLAYER_COLORS, CLANS, BADGES,
    load, save, reset, newState, notify,
    isFriendly, zoneAt, neutraliseZone, claimLoop, areaKm2, ownedCells,
    addDailyProgress, endDay, leaderboardRows,
  };
})();
