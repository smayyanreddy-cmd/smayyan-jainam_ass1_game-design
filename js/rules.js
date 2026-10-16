/* PedalPace — scoring rules.
 * Every number here is mirrored in docs/GAME_RULES.md. Pure functions only,
 * so the file runs in the browser (window.Rules) and in Node (tests). */
(function (root) {
  'use strict';

  const R = {
    // ---- Damage ----
    DAMAGE_PER_KM: 100,            // 1 km at 1.0x intensity = 100 damage = 100 points

    WALK: {
      BASE: 1.0,
      BRISK: 1.3,                  // speed >= BRISK_KMH or HR zone >= 3
      UPHILL: 1.5,                 // grade >= UPHILL_GRADE
      BRISK_KMH: 5.5,
    },
    CYCLE: {
      BASE: 0.4,
      // Sustained effort bonus (needs SUSTAIN_SEC continuous seconds in the band)
      HR_ZONE_BONUS: { 3: 0.10, 4: 0.20, 5: 0.25 },
      SPEED_BONUS: [ { kmh: 26, bonus: 0.20 }, { kmh: 20, bonus: 0.10 } ], // when no HR
      UPHILL_BONUS: 0.15,
      MAX: 0.80,
    },
    UPHILL_GRADE: 0.04,
    SUSTAIN_SEC: 120,
    HR_MAX_DEFAULT: 190,

    // ---- Bonuses ----
    STREAK_PER_DAY: 0.02,          // +2% per consecutive active day
    STREAK_MAX: 0.20,              // capped at +20% (10 days)
    DEFEND_MULT: 1.25,             // moving through your/clan's *damaged* zone
    GROUP_MULT: { 1: 1.0, 2: 1.2, 3: 1.35, 4: 1.5 }, // 4+ uses 4
    CLAIM_PTS_PER_1000M2: 2,       // per 1,000 m² of new ground claimed
    NEUTRALISE_PTS: 50,            // per enemy zone you knock to 0 HP

    // ---- Territory ----
    ZONE_HP_BASE: 40,
    ZONE_HP_PER_1000M2: 1.5,
    MIN_ZONE_M2: 500,              // smaller claims (e.g. an out-and-back ride) don't make a zone
    MIN_PART_M2: 50,               // tiny leftover pieces of a zone are dropped...
    SLIVER_M: 4,                   // ...and so are strips narrower than ~8 m (GPS wobble along a shared edge)
    MAX_FLAGGED_SHARE: 0.2,        // more than 20 % of the trip flagged by anti-cheat -> no zone
    DECAY_START_DAY: 2,            // owner inactive this many days -> zone starts decaying
    DECAY_PCT: 0.10,               // 10% of max HP per day
    DECAY_PCT_SEVERE: 0.20,        // from SEVERE_DAY inactive days
    DECAY_SEVERE_DAY: 5,
    VULNERABLE_MULT: 1.25,         // zone damage taken while owner is inactive (decaying)

    // ---- Inactivity ----
    PENALTY_BASE: 5,               // -5, -10, -20, -40, -50 ...
    PENALTY_CAP: 50,
    MIN_WALK_MIN: 15,
    MIN_CYCLE_KM: 5,
    REST_TOKENS_PER_WEEK: 1,

    // ---- Anti-cheat ----
    WALK_MAX_KMH: 10,              // sustained above this while "walking" -> flagged
    CYCLE_MAX_KMH: 45,             // sustained above this -> car-speed segment
    CHEAT_SUSTAIN_SEC: 8,
    GPS_JUMP_M: 80,                // > 80 m between fixes...
    GPS_JUMP_MPS: 40,              // ...at over 40 m/s (144 km/h) -> GPS jump
    GPS_MAX_ACC_M: 30,             // fixes less accurate than ±30 m are not recorded
    AUTO_WALK_BELOW_KMH: 7.5,
    AUTO_CYCLE_ABOVE_KMH: 9.5,

    // ---- Trips ----
    NEAR_START_M: 30,              // "back at the start" hint radius...
    NEAR_START_MIN_PATH_M: 250,    // ...once you've travelled at least this far

    // ---- Multiplayer ----
    GROUP_RADIUS_M: 60,            // friends recording within 60 m count towards the combo
    LIVE_FRESH_SEC: 30,            // a friend's live position older than this is ignored
  };

  /** HR zone 1..5 from bpm (percent of max HR: <60, 60-70, 70-80, 80-90, 90+). */
  R.hrZone = function (bpm, hrMax) {
    if (!bpm) return 0;
    const p = bpm / (hrMax || R.HR_MAX_DEFAULT);
    if (p >= 0.9) return 5;
    if (p >= 0.8) return 4;
    if (p >= 0.7) return 3;
    if (p >= 0.6) return 2;
    return 1;
  };

  /**
   * Intensity multiplier.
   * @param {'walk'|'cycle'} mode
   * @param {object} s  { kmh, grade, hrZone, sustainedHrZone, sustainedKmh }
   *   sustainedHrZone: lowest HR zone held for >= SUSTAIN_SEC (0 if none / no HR)
   *   sustainedKmh:    lowest speed held for >= SUSTAIN_SEC
   */
  R.intensity = function (mode, s) {
    const uphill = (s.grade || 0) >= R.UPHILL_GRADE;
    if (mode === 'walk') {
      let m = R.WALK.BASE;
      if ((s.kmh || 0) >= R.WALK.BRISK_KMH || (s.hrZone || 0) >= 3) m = R.WALK.BRISK;
      if (uphill) m = R.WALK.UPHILL;
      return m;
    }
    let m = R.CYCLE.BASE;
    if (s.sustainedHrZone >= 3) {
      m += R.CYCLE.HR_ZONE_BONUS[Math.min(5, s.sustainedHrZone)];
    } else if (!s.hasHr) {
      for (const b of R.CYCLE.SPEED_BONUS) {
        if ((s.sustainedKmh || 0) >= b.kmh) { m += b.bonus; break; }
      }
    }
    if (uphill) m += R.CYCLE.UPHILL_BONUS;
    return Math.min(R.CYCLE.MAX, +m.toFixed(2));
  };

  R.streakMult = function (streakDays) {
    return 1 + Math.min(R.STREAK_MAX, R.STREAK_PER_DAY * Math.max(0, streakDays));
  };

  R.groupMult = function (groupSize) {
    return R.GROUP_MULT[Math.max(1, Math.min(4, groupSize | 0))];
  };

  /**
   * Damage for one GPS segment. Points earned == damage dealt.
   * ctx: 'attack' | 'defend' | 'neutral'
   */
  R.segmentDamage = function (km, intensity, streakDays, groupSize, ctx) {
    const c = ctx === 'defend' ? R.DEFEND_MULT : 1;
    return km * R.DAMAGE_PER_KM * intensity * R.streakMult(streakDays) * R.groupMult(groupSize) * c;
  };

  /** HP actually removed from an enemy zone (decaying zones take extra). */
  R.zoneDamage = function (damage, ownerInactiveDays) {
    return damage * (ownerInactiveDays >= R.DECAY_START_DAY ? R.VULNERABLE_MULT : 1);
  };

  R.zoneMaxHp = function (areaM2) {
    return Math.round(R.ZONE_HP_BASE + R.ZONE_HP_PER_1000M2 * areaM2 / 1000);
  };

  /** Bonus points for claiming new ground. */
  R.claimPoints = function (newAreaM2) {
    return Math.round(R.CLAIM_PTS_PER_1000M2 * Math.max(0, newAreaM2) / 1000);
  };

  /** Penalty for the n-th consecutive missed day (n >= 1). */
  R.inactivityPenalty = function (n) {
    if (n < 1) return 0;
    return Math.min(R.PENALTY_CAP, R.PENALTY_BASE * Math.pow(2, n - 1));
  };

  /** HP a zone loses overnight given how many days its owner has been inactive. */
  R.decayAmount = function (maxHp, ownerInactiveDays) {
    if (ownerInactiveDays < R.DECAY_START_DAY) return 0;
    const pct = ownerInactiveDays >= R.DECAY_SEVERE_DAY ? R.DECAY_PCT_SEVERE : R.DECAY_PCT;
    return Math.round(maxHp * pct);
  };

  /** Total HP lost to decay after this many inactive days. */
  R.decayTotal = function (maxHp, ownerInactiveDays) {
    let t = 0;
    for (let d = R.DECAY_START_DAY; d <= ownerInactiveDays; d++) t += R.decayAmount(maxHp, d);
    return t;
  };

  /** Daily minimum progress, 0..1+ (walk minutes and cycle km combine). */
  R.minimumProgress = function (walkMin, cycleKm) {
    return walkMin / R.MIN_WALK_MIN + cycleKm / R.MIN_CYCLE_KM;
  };

  /** Auto mode detection from a smoothed speed, with hysteresis. */
  R.detectMode = function (kmh, prevMode) {
    if (kmh < R.AUTO_WALK_BELOW_KMH) return 'walk';
    if (kmh > R.AUTO_CYCLE_ABOVE_KMH) return 'cycle';
    return prevMode || 'walk';
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = R;
  else root.Rules = R;
})(typeof window !== 'undefined' ? window : globalThis);
